// The living painterly field: thousands of particles tracing continuous
// flowing lines through a curl-noise field — each stroke is drawn as a
// segment from its previous frame position to its current one (not a
// fixed-length mark redrawn in place), so a particle's path reads as one
// unbroken curving line for its lifetime, the way wet paint would drag.
// Individually slowed, thinned, steered-around, and desaturated by the
// QuietField they sample — no global mask is ever drawn over them.

import { CONFIG } from '../config.js';
import { curlNoise } from './Noise2D.js';
import { clamp, lerp, smoothstep, hexToRgb } from '../utils/math.js';

const PALETTE_RGB = CONFIG.PALETTE.map(hexToRgb);
const NEAR_BLACK = { r: 12, g: 9, b: 14 };
const HIDDEN_RGB = hexToRgb(CONFIG.HIDDEN_MARK_COLOR);

function randRange(a, b) {
  return a + Math.random() * (b - a);
}

class Stroke {
  constructor(width, height) {
    this.reset(width, height, null);
  }

  reset(width, height, quietField) {
    const pos = pickSpawnPosition(width, height, quietField);
    this.x = pos.x;
    this.y = pos.y;
    this.prevX = pos.x;
    this.prevY = pos.y;
    this.angle = Math.random() * Math.PI * 2;
    this.width = randRange(CONFIG.BRUSH_MIN_WIDTH, CONFIG.BRUSH_MAX_WIDTH);
    this.speedMult = randRange(0.6, 1.4);
    this.paletteIdx = Math.floor(Math.random() * PALETTE_RGB.length);
    this.maxLife = randRange(CONFIG.BRUSH_LIFETIME_MIN, CONFIG.BRUSH_LIFETIME_MAX);
    this.age = 0;
    this.noiseOffset = Math.random() * 1000;
  }
}

function pickSpawnPosition(width, height, quietField) {
  let x = Math.random() * width;
  let y = Math.random() * height;
  if (!quietField) return { x, y };

  // Bias spawns away from quiet regions so density visibly thins there,
  // without ever hard-excluding it (a few strokes still wander in).
  for (let i = 0; i < 4; i++) {
    const q = quietField.sampleQuiet(x, y);
    if (q < 0.4 || Math.random() > q) break;
    x = Math.random() * width;
    y = Math.random() * height;
  }
  return { x, y };
}

export class BrushField {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.strokes = [];
    for (let i = 0; i < CONFIG.BRUSH_COUNT; i++) {
      const s = new Stroke(width, height);
      s.age = Math.random() * s.maxLife; // desync initial fade cycles
      this.strokes.push(s);
    }
    this.time = 0;
  }

  resize(width, height) {
    this.width = width;
    this.height = height;
  }

  update(dt, people, quietField) {
    this.time += dt * CONFIG.TURBULENCE_TIME_SCALE;
    const w = this.width, h = this.height;

    for (const s of this.strokes) {
      s.age += dt;
      const calm = quietField.sampleCalm(s.x, s.y);
      const quiet = quietField.sampleQuiet(s.x, s.y);

      // aging accelerates in quiet regions -> strokes thin out there
      const lifeDecay = 1 + quiet * 2.2;
      if (s.age >= s.maxLife / lifeDecay) {
        s.reset(w, h, quietField);
        continue;
      }

      // base flow direction from the curl-noise field
      const flow = curlNoise(
        s.x * CONFIG.TURBULENCE_SCALE,
        s.y * CONFIG.TURBULENCE_SCALE,
        this.time + s.noiseOffset
      );
      let desiredAngle = Math.atan2(flow.y, flow.x);

      // gentle steering around still people (arcs, not a hard wall)
      let steerWeight = 0;
      let steerAngle = desiredAngle;
      for (const p of people) {
        if (p.quietness <= 0.03) continue;
        const dx = s.x - p.x;
        const dy = s.y - p.y;
        const dist = Math.hypot(dx, dy);
        if (dist > CONFIG.INFLUENCE_RADIUS || dist < 1) continue;
        const falloff = 1 - dist / CONFIG.INFLUENCE_RADIUS;
        const weight = p.quietness * falloff;
        if (weight > steerWeight) {
          // tangent direction around the person (perpendicular to radius)
          steerAngle = Math.atan2(dx, -dy);
          steerWeight = weight;
        }
      }
      if (steerWeight > 0) {
        desiredAngle = lerpAngle(desiredAngle, steerAngle, clamp(steerWeight, 0, 0.85));
      }

      // calm reduces how eagerly a stroke reorients to the turbulent flow
      // (direction settles) and how fast it drifts (motion settles).
      const turbulenceFactor = lerp(1, 0.12, calm);
      const speedFactor = lerp(1, CONFIG.BRUSH_MIN_SPEED_FACTOR, calm);

      const turnRate = clamp(2.2 * dt * turbulenceFactor, 0, 1);
      s.angle = lerpAngle(s.angle, desiredAngle, turnRate);

      const speed = CONFIG.BRUSH_BASE_SPEED * s.speedMult * speedFactor;
      s.x += Math.cos(s.angle) * speed * dt;
      s.y += Math.sin(s.angle) * speed * dt;

      // wrap around edges softly — and snap prevX/prevY with it so the
      // redrawn segment doesn't streak across the whole canvas
      let wrapped = false;
      if (s.x < -40) { s.x = w + 40; wrapped = true; }
      if (s.x > w + 40) { s.x = -40; wrapped = true; }
      if (s.y < -40) { s.y = h + 40; wrapped = true; }
      if (s.y > h + 40) { s.y = -40; wrapped = true; }
      if (wrapped) { s.prevX = s.x; s.prevY = s.y; }
    }
  }

  draw(ctx, quietField) {
    for (const s of this.strokes) {
      const lifeT = s.age / s.maxLife;
      const fadeIn = clamp(lifeT / 0.08, 0, 1);
      const fadeOut = clamp((1 - lifeT) / 0.2, 0, 1);
      const alpha = Math.min(fadeIn, fadeOut);

      if (alpha > 0.01) {
        const quiet = quietField.sampleQuiet(s.x, s.y);
        const dark = quietField.sampleDark(s.x, s.y);
        const base = PALETTE_RGB[s.paletteIdx];
        const gray = base.r * 0.299 + base.g * 0.587 + base.b * 0.114;

        const desatAmt = clamp(CONFIG.COLOR_DESATURATION * quiet, 0, 1);
        let r = lerp(base.r, gray, desatAmt);
        let g = lerp(base.g, gray, desatAmt);
        let b = lerp(base.b, gray, desatAmt);

        const darkAmt = clamp(CONFIG.DARKNESS_STRENGTH * dark, 0, 1);
        r = lerp(r, NEAR_BLACK.r, darkAmt);
        g = lerp(g, NEAR_BLACK.g, darkAmt);
        b = lerp(b, NEAR_BLACK.b, darkAmt);

        // trace previous position -> current position: a continuous,
        // unbroken line while the stroke lives, like dragged wet paint —
        // not a fixed mark redrawn in place each frame.
        ctx.strokeStyle = `rgba(${r | 0}, ${g | 0}, ${b | 0}, ${(alpha * 0.8).toFixed(3)})`;
        ctx.lineWidth = s.width * (1 - darkAmt * 0.25);
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(s.prevX, s.prevY);
        ctx.lineTo(s.x, s.y);
        ctx.stroke();
      }

      s.prevX = s.x;
      s.prevY = s.y;
    }
  }

  // Image marks: each point knows its true position (tx, ty) on the hidden
  // image. Each point samples the quiet field at that true position, so it
  // only appears inside the locally darkened reveal area. As local reveal
  // rises, scattered particles gather into the portrait.
  drawImageReveal(ctx, imageField, quietField) {
    const points = imageField.getSamplePoints();
    for (const pt of points) {
      const localReveal = quietField.sampleReveal(pt.tx, pt.ty);
      if (localReveal <= 0.015) continue;

      const darkGate = smoothstep(0.04, 0.42, quietField.sampleDark(pt.tx, pt.ty));
      const appear = clamp(localReveal * darkGate, 0, 1);
      if (appear <= 0.015) continue;

      // Let brightness and position settle at different rates: particles
      // first emerge faintly, then gradually gather into the source image.
      const settle = smoothstep(0.05, 0.65, appear);
      const chaos = 1 - settle;
      const alpha = appear * appear * CONFIG.IMAGE_MARK_ALPHA;

      const liveJitterX = Math.sin(this.time * 2.3 + pt.jitterSeed) * 4 * chaos;
      const liveJitterY = Math.cos(this.time * 2.1 + pt.jitterSeed) * 4 * chaos;
      const x = pt.tx + pt.scatterX * chaos + liveJitterX;
      const y = pt.ty + pt.scatterY * chaos + liveJitterY;

      ctx.fillStyle = `rgba(${HIDDEN_RGB.r}, ${HIDDEN_RGB.g}, ${HIDDEN_RGB.b}, ${alpha.toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(x, y, pt.radius, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function lerpAngle(a, b, t) {
  let diff = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (diff < -Math.PI) diff += Math.PI * 2;
  return a + diff * t;
}
