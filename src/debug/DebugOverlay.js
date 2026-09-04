// All diagnostic drawing lives here so exhibition mode can disable it
// with a single flag and pay zero cost.

import { CONFIG } from '../config.js';

const SKELETON_EDGES = [
  ['left_shoulder', 'right_shoulder'],
  ['left_shoulder', 'left_elbow'],
  ['left_elbow', 'left_wrist'],
  ['right_shoulder', 'right_elbow'],
  ['right_elbow', 'right_wrist'],
];

const ARM_POINTS = new Set(['left_shoulder', 'left_elbow', 'left_wrist', 'right_shoulder', 'right_elbow', 'right_wrist']);
const MASK_POINTS = ARM_POINTS;

export class DebugOverlay {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.enabled = false;
    this._fpsHistory = [];
  }

  toggle() {
    this.enabled = !this.enabled;
    if (!this.enabled) this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  draw({ people, strokeCount, fps, trackingReady }) {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (!this.enabled) return;

    ctx.save();
    ctx.font = '12px monospace';
    ctx.textBaseline = 'top';

    // top-left stats block
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(8, 8, 230, 92);
    ctx.fillStyle = '#7CFC9A';
    const lines = [
      `FPS: ${fps.toFixed(1)}`,
      `strokes: ${strokeCount}`,
      `people: ${people.length}`,
      `camera: ${trackingReady ? 'ok' : 'reconnecting...'}`,
    ];
    lines.forEach((l, i) => ctx.fillText(l, 16, 14 + i * 16));

    // per-person markers
    for (const p of people) {
      this._drawBodyMask(ctx, p);
      this._drawSkeleton(ctx, p);

      // velocity vector
      ctx.strokeStyle = '#FFD37C';
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x + p.vx * 40, p.y + p.vy * 40);
      ctx.stroke();

      const label = [
        `id ${p.id}`,
        `speed ${p.speed.toFixed(3)} img ${p.imageSpeed.toFixed(3)}`,
        `still ${p.stillTimer.toFixed(1)}s`,
        `calm ${p.calm.toFixed(2)} quiet ${p.quietness.toFixed(2)}`,
        `dark ${p.darkness.toFixed(2)} image ${p.imageReveal.toFixed(2)}`,
        `image still ${p.imageStillTimer.toFixed(1)} wait ${p.imageRecoveryTimer.toFixed(1)}s`,
      ];
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(p.x + 10, p.y - 10, 150, label.length * 14 + 6);
      ctx.fillStyle = '#7CFC9A';
      label.forEach((l, i) => ctx.fillText(l, p.x + 14, p.y - 6 + i * 14));
    }

    ctx.restore();
  }

  _drawSkeleton(ctx, person) {
    if (!person.keypoints?.length) return;
    const points = new Map();
    for (const kp of person.keypoints) {
      if (!kp.ok) continue;
      if (!MASK_POINTS.has(kp.name)) continue;
      points.set(kp.name, kp);
    }

    ctx.strokeStyle = 'rgba(0,235,185,0.75)';
    ctx.lineWidth = 4;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const [a, b] of SKELETON_EDGES) {
      const pa = points.get(a);
      const pb = points.get(b);
      if (!pa || !pb) continue;
      ctx.beginPath();
      ctx.moveTo(pa.x, pa.y);
      ctx.lineTo(pb.x, pb.y);
      ctx.stroke();
    }

    for (const pt of points.values()) {
      ctx.fillStyle = '#FFE600';
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, 6.5, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  _drawBodyMask(ctx, person) {
    if (!person.keypoints?.length) return;
    const points = new Map();
    for (const kp of person.keypoints) {
      if (!kp.ok) continue;
      if (!MASK_POINTS.has(kp.name)) continue;
      points.set(kp.name, kp);
    }

    if (points.size < CONFIG.MIN_TORSO_KEYPOINTS) return;

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(0, 235, 185, 0.18)';
    ctx.fillStyle = 'rgba(0, 235, 185, 0.16)';

    this._drawShoulderMask(ctx, points);

    for (const [a, b] of SKELETON_EDGES) {
      const pa = points.get(a);
      const pb = points.get(b);
      if (!pa || !pb) continue;
      ctx.lineWidth = this._isArmEdge(a, b) ? CONFIG.BODY_MASK_ARM_LINE_WIDTH : CONFIG.BODY_MASK_LINE_WIDTH;
      ctx.beginPath();
      ctx.moveTo(pa.x, pa.y);
      ctx.lineTo(pb.x, pb.y);
      ctx.stroke();
    }

    for (const pt of points.values()) {
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, CONFIG.BODY_MASK_JOINT_RADIUS, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  }

  _drawShoulderMask(ctx, points) {
    const left = points.get('left_shoulder');
    const right = points.get('right_shoulder');
    if (!left || !right) return;

    const shoulderW = CONFIG.BODY_MASK_LINE_WIDTH * 1.45;
    const pad = shoulderW * 0.42;
    const leftX = Math.min(left.x, right.x) - pad;
    const rightX = Math.max(left.x, right.x) + pad;
    const topY = Math.min(left.y, right.y) - pad * 0.35;
    const bottomY = this.canvas.height;

    ctx.beginPath();
    ctx.moveTo(leftX, topY);
    ctx.lineTo(rightX, topY);
    ctx.lineTo(rightX, bottomY);
    ctx.lineTo(leftX, bottomY);
    ctx.closePath();
    ctx.fill();

    ctx.lineWidth = shoulderW;
    ctx.beginPath();
    ctx.moveTo(left.x, left.y);
    ctx.lineTo(right.x, right.y);
    ctx.stroke();
  }

  _isArmEdge(a, b) {
    return ARM_POINTS.has(a) && ARM_POINTS.has(b);
  }
}
