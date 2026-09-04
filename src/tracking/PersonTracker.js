// Turns raw per-frame poses into persistent, smoothed Person states:
// identity across frames, smoothed position, velocity, and accumulated
// stillness. This is the only place stillness math happens.

import { CONFIG } from '../config.js';
import { smoothstep, dist2 } from '../utils/math.js';

const TRACKING_POINTS = [
  'left_shoulder',
  'right_shoulder',
];
const OUTPUT_POINTS = new Set([
  'left_shoulder',
  'right_shoulder',
  'left_elbow',
  'right_elbow',
  'left_wrist',
  'right_wrist',
]);

let nextId = 1;

class Person {
  constructor(id, x, y) {
    this.id = id;
    this.x = x;
    this.y = y;
    this.smoothX = x;
    this.smoothY = y;
    this.vx = 0;
    this.vy = 0;
    this.speed = 0;           // normalized units / sec
    this.imageSpeed = 0;      // slower smoothed speed for image hide/recovery
    this.imageWasOverThreshold = false;
    this.stillTimer = 0;      // seconds
    this.stillness = 0;       // 0-1 eased overall accumulation (STILLNESS_START..REVEAL_FULL)
    this.calm = 0;            // 0-1, earliest gentle slowing (STILLNESS_START..QUIET_FULL)
    this.quietness = 0;       // 0-1, derived (QUIET_START..QUIET_FULL)
    this.darkness = 0;        // 0-1, derived (DARK_START..DARK_FULL)
    this.reveal = 0;          // 0-1, derived (REVEAL_START..REVEAL_FULL)
    this.imageStillTimer = 0;
    this.imageReveal = 0;
    this.imageRecoveryTimer = CONFIG.IMAGE_RECOVERY_WAIT;
    this.imageWaitProgress = 0;
    this.keypoints = [];
    this._keypointState = new Map();
    this.lastSeen = performance.now() / 1000;
    this.confidence = 1;
  }
}

function upperBodyCentroid(keypoints) {
  let sx = 0, sy = 0, n = 0;
  for (const name of TRACKING_POINTS) {
    const kp = keypoints.find((k) => k.name === name);
    if (kp && kp.score >= CONFIG.MIN_POSE_SCORE) {
      sx += kp.x;
      sy += kp.y;
      n++;
    }
  }
  if (n < CONFIG.MIN_TORSO_KEYPOINTS) return null;
  return { x: sx / n, y: sy / n, n };
}

function normalizeKeypoints(keypoints = []) {
  return keypoints
    .filter((kp) => OUTPUT_POINTS.has(kp.name))
    .map((kp) => ({
      name: kp.name,
      x: kp.x,
      y: kp.y,
      score: kp.score ?? 0,
    }));
}

export class PersonTracker {
  constructor() {
    this.people = new Map(); // id -> Person
  }

  // poses: raw output from PoseTracker.estimate(), in tracking-frame pixel space
  // trackingWidth/Height: dims of that space, used to normalize distances
  // renderWidth/Height: dims to map positions into for downstream consumers
  update(poses, trackingWidth, trackingHeight, renderWidth, renderHeight, dt) {
    const now = performance.now() / 1000;
    const diag = Math.hypot(trackingWidth, trackingHeight);

    const detections = [];
    for (const pose of poses) {
      const c = upperBodyCentroid(pose.keypoints);
      if (c) detections.push({ ...c, keypoints: normalizeKeypoints(pose.keypoints) });
    }

    // Greedy nearest-neighbor match against existing people (in tracking space).
    const unmatched = new Set(this.people.keys());
    for (const det of detections) {
      let bestId = null;
      let bestDist = Infinity;
      for (const id of unmatched) {
        const p = this.people.get(id);
        const d2 = dist2(p.smoothX, p.smoothY, det.x, det.y);
        if (d2 < bestDist) {
          bestDist = d2;
          bestId = id;
        }
      }
      const bestDistNorm = Math.sqrt(bestDist) / diag;
      if (bestId !== null && bestDistNorm <= CONFIG.MATCH_MAX_DISTANCE) {
        unmatched.delete(bestId);
        this._applyDetection(this.people.get(bestId), det, diag, dt, now);
      } else {
        const id = nextId++;
        const p = new Person(id, det.x, det.y);
        this.people.set(id, p);
        this._applyDetection(p, det, diag, dt, now, true);
      }
    }

    // Age out people who lost detection beyond the grace period.
    for (const [id, p] of this.people) {
      const sinceSeen = now - p.lastSeen;
      if (sinceSeen > CONFIG.PERSON_GRACE_PERIOD) {
        this.people.delete(id);
      }
    }

    // Map to render space + expose a stable snapshot array.
    const sx = renderWidth / trackingWidth;
    const sy = renderHeight / trackingHeight;
    const result = [];
    for (const p of this.people.values()) {
      const screenX = p.smoothX * sx;
      const screenVx = p.vx * sx;
      result.push({
        id: p.id,
        x: mapScreenX(screenX, renderWidth),
        y: p.smoothY * sy,
        vx: CONFIG.SCREEN_FLIP_HORIZONTAL ? -screenVx : screenVx,
        vy: p.vy * sy,
        speed: p.speed,
        imageSpeed: p.imageSpeed,
        presence: 1,
        stillTimer: p.stillTimer,
        stillness: p.stillness,
        calm: p.calm,
        quietness: p.quietness,
        darkness: p.darkness,
        reveal: p.reveal,
        imageStillTimer: p.imageStillTimer,
        imageReveal: p.imageReveal,
        imageRecoveryTimer: p.imageRecoveryTimer,
        imageWaitProgress: p.imageWaitProgress,
        imageRevealBlocked: p.imageRecoveryTimer > 0,
        keypoints: p.keypoints.map((kp) => ({
          name: kp.name,
          x: mapScreenX(kp.x * sx, renderWidth),
          y: kp.y * sy,
          score: kp.score,
          ok: kp.score >= CONFIG.MIN_POSE_SCORE,
        })),
      });
    }
    return result;
  }

  _applyDetection(p, det, diag, dt, now, isNew = false) {
    if (isNew) {
      p.smoothX = det.x;
      p.smoothY = det.y;
    } else {
      const a = CONFIG.POSITION_SMOOTHING;
      p.smoothX += (det.x - p.smoothX) * a;
      p.smoothY += (det.y - p.smoothY) * a;
    }

    const dx = det.x - p.x;
    const dy = det.y - p.y;
    const moved = Math.hypot(dx, dy) / diag; // normalized
    p.x = det.x;
    p.y = det.y;
    p.keypoints = this._smoothKeypoints(p, det.keypoints || [], isNew);
    p.lastSeen = now;

    if (dt > 0) {
      const speed = moved / dt; // normalized units per second
      // light smoothing on speed itself so a single noisy frame can't spike it
      p.speed += (speed - p.speed) * 0.35;
      this._smoothImageSpeed(p, speed);
      p.vx += (dx / dt - p.vx) * 0.35;
      p.vy += (dy / dt - p.vy) * 0.35;
    }

    if (p.speed <= CONFIG.MOTION_THRESHOLD) {
      p.stillTimer += dt;
    } else {
      const excess = p.speed - CONFIG.MOTION_THRESHOLD;
      const penalty = excess * CONFIG.MOVEMENT_PENALTY_SCALE * dt;
      p.stillTimer = Math.max(0, p.stillTimer - penalty);
    }

    const imageOverThreshold = p.imageSpeed > CONFIG.IMAGE_HIDE_SPEED_THRESHOLD;
    if (imageOverThreshold && !p.imageWasOverThreshold) {
      p.imageRecoveryTimer = CONFIG.IMAGE_RECOVERY_WAIT;
      p.imageStillTimer = 0;
    }
    p.imageWasOverThreshold = imageOverThreshold;

    if (imageOverThreshold) {
      p.imageStillTimer = 0;
      p.imageWaitProgress = 0;
    } else if (p.imageSpeed <= CONFIG.IMAGE_TRIGGER_SPEED_THRESHOLD) {
      p.imageRecoveryTimer = Math.max(0, p.imageRecoveryTimer - dt);
      p.imageWaitProgress = CONFIG.IMAGE_RECOVERY_WAIT > 0
        ? 1 - p.imageRecoveryTimer / CONFIG.IMAGE_RECOVERY_WAIT
        : 1;
      if (p.imageRecoveryTimer <= 0) {
        p.imageStillTimer += dt;
      } else {
        p.imageStillTimer = 0;
      }
    } else if (p.imageReveal <= 0) {
      p.imageRecoveryTimer = CONFIG.IMAGE_RECOVERY_WAIT;
      p.imageWaitProgress = 0;
      p.imageStillTimer = 0;
    }

    p.stillness = smoothstep(CONFIG.STILLNESS_START, CONFIG.REVEAL_FULL, p.stillTimer);
    p.calm = smoothstep(CONFIG.STILLNESS_START, CONFIG.QUIET_FULL, p.stillTimer);
    p.quietness = smoothstep(CONFIG.QUIET_START, CONFIG.QUIET_FULL, p.stillTimer);
    p.darkness = smoothstep(CONFIG.DARK_START, CONFIG.DARK_FULL, p.stillTimer);
    p.reveal = smoothstep(CONFIG.REVEAL_START, CONFIG.REVEAL_FULL, p.stillTimer);
    p.imageReveal = smoothstep(0, CONFIG.IMAGE_REVEAL_GATHER_DURATION, p.imageStillTimer);
  }

  _smoothImageSpeed(p, speed) {
    p.imageSpeed += (speed - p.imageSpeed) * 0.08;
  }

  _smoothKeypoints(p, keypoints, isNew) {
    const a = isNew ? 1 : CONFIG.KEYPOINT_SMOOTHING;
    const seen = new Set();
    const smoothed = [];
    for (const kp of keypoints) {
      seen.add(kp.name);
      const prev = p._keypointState.get(kp.name);
      const next = prev
        ? {
            name: kp.name,
            x: prev.x + (kp.x - prev.x) * a,
            y: prev.y + (kp.y - prev.y) * a,
            score: prev.score + ((kp.score ?? 0) - prev.score) * a,
          }
        : { ...kp };
      p._keypointState.set(kp.name, next);
      smoothed.push(next);
    }

    for (const name of p._keypointState.keys()) {
      if (!seen.has(name)) p._keypointState.delete(name);
    }
    return smoothed;
  }
}

function mapScreenX(x, renderWidth) {
  return CONFIG.SCREEN_FLIP_HORIZONTAL ? renderWidth - x : x;
}
