// Low-resolution grid simulation of two lagged, SPATIAL layers:
//   calmGrid  - earliest, gentlest signal (drives speed/turbulence easing)
//   grid      - "quietness", a stage later (drives repulsion, density,
//               trail fade, color desaturation)
// darkGrid further lags behind `grid`, so the sequence slow -> quiet ->
// dark reads as one continuous unfolding rather than synced jumps.
//
// This grid is sampled by the brush field to slow/desaturate strokes near
// a still person. It intentionally does NOT know about "darkness" as a
// visual mask — that's left to the brush renderer, so no flat spotlight is
// ever drawn.
//
// The image reveal is spatial: the same quiet area that darkens also opens
// the hidden image, so the portrait particles appear only where the room has
// gone still and black.

import { CONFIG } from '../config.js';
import { clamp } from '../utils/math.js';

const BODY_EDGES = [
  ['left_shoulder', 'right_shoulder'],
  ['left_shoulder', 'left_elbow'],
  ['left_elbow', 'left_wrist'],
  ['right_shoulder', 'right_elbow'],
  ['right_elbow', 'right_wrist'],
];

const ARM_POINTS = new Set(['left_shoulder', 'left_elbow', 'left_wrist', 'right_shoulder', 'right_elbow', 'right_wrist']);
const MASK_POINTS = ARM_POINTS;

export class QuietField {
  constructor(renderWidth, renderHeight) {
    this.cols = CONFIG.QUIET_GRID_COLS;
    this.rows = CONFIG.QUIET_GRID_ROWS;
    this.cellW = renderWidth / this.cols;
    this.cellH = renderHeight / this.rows;

    const n = this.cols * this.rows;
    this.presenceGrid = new Float32Array(n); // current tracked shoulder/arm silhouette for particle attraction
    this.calmGrid = new Float32Array(n);
    this.grid = new Float32Array(n);       // quietness 0-1
    this.darkGrid = new Float32Array(n);    // darkness 0-1 (lags behind quietness)
    this.revealGrid = new Float32Array(n);  // image reveal 0-1, spatial and latest
    this.scratch = new Float32Array(n);
    this.globalReveal = 0;                 // 0-1, retained for debugging/overall progress

    this._bodyMaskCanvas = document.createElement('canvas');
    this._bodyMaskCanvas.width = this.cols;
    this._bodyMaskCanvas.height = this.rows;
    this._bodyMaskCtx = this._bodyMaskCanvas.getContext('2d', { willReadFrequently: true });
  }

  resize(renderWidth, renderHeight) {
    this.cellW = renderWidth / this.cols;
    this.cellH = renderHeight / this.rows;
  }

  idx(cx, cy) {
    return cy * this.cols + cx;
  }

  // people: array from PersonTracker.update() (render-space x/y).
  // Each layer is sourced directly from its own correctly-paced
  // per-person value (calm/quietness/darkness/reveal, each already a
  // smoothstep over its own CONFIG window) — so the seconds in config.js
  // are the single source of truth for pacing, not a second, redundant
  // lag rate here.
  update(people, dt) {
    this._riseAndDecayLayer(this.presenceGrid, people, 'presence', dt, CONFIG.INFLUENCE_RADIUS);
    this._riseAndDecayLayer(this.calmGrid, people, 'calm', dt, CONFIG.INFLUENCE_RADIUS);
    this._riseAndDecayLayer(this.grid, people, 'quietness', dt, CONFIG.INFLUENCE_RADIUS);
    this._riseAndDecayLayer(this.darkGrid, people, 'imageWaitProgress', dt, CONFIG.INFLUENCE_RADIUS);
    const hideImageByMotion = people.some((p) => (
      (p.imageSpeed ?? 0) > CONFIG.IMAGE_HIDE_SPEED_THRESHOLD || p.imageRevealBlocked
    ));
    if (hideImageByMotion) {
      this.revealGrid.fill(0);
    } else {
      this._riseAndDecayLayer(this.revealGrid, people, 'reveal', dt, CONFIG.INFLUENCE_RADIUS);
    }
    this._diffuse(this.presenceGrid);
    this._diffuse(this.calmGrid);
    this._diffuse(this.grid);
    this._diffuse(this.darkGrid);
    this._diffuse(this.revealGrid);

    // Retain an overall scalar for debug/readout purposes. Rendering uses
    // revealGrid so the image stays tied to the local black field.
    let targetReveal = 0;
    for (const p of people) targetReveal = Math.max(targetReveal, p.imageReveal ?? 0);
    if (hideImageByMotion) targetReveal = 0;
    if (targetReveal > this.globalReveal) {
      const revealDuration = Math.max(0.1, CONFIG.IMAGE_GLOBAL_REVEAL_DURATION);
      this.globalReveal = Math.min(targetReveal, this.globalReveal + dt / revealDuration);
    } else {
      this.globalReveal = Math.max(targetReveal, this.globalReveal - CONFIG.QUIET_DECAY_RATE * dt);
    }
  }

  _riseAndDecayLayer(layer, people, personField, dt, radius) {
    const { cols, rows, cellW, cellH } = this;
    const decay = CONFIG.QUIET_DECAY_RATE * dt;
    for (let i = 0; i < layer.length; i++) {
      layer[i] = Math.max(0, layer[i] - decay);
    }

    const riseRate = Math.min(1, this._riseRateForLayer(personField, dt));
    if (CONFIG.BODY_MASK_ENABLED && this._riseFromBodyMasks(layer, people, personField, riseRate)) {
      return;
    }

    for (const p of people) {
      const value = this._personLayerValue(p, personField);
      if (value <= 0) continue;

      const cx0 = Math.max(0, Math.floor((p.x - radius) / cellW));
      const cx1 = Math.min(cols - 1, Math.ceil((p.x + radius) / cellW));
      const cy0 = Math.max(0, Math.floor((p.y - radius) / cellH));
      const cy1 = Math.min(rows - 1, Math.ceil((p.y + radius) / cellH));

      for (let cy = cy0; cy <= cy1; cy++) {
        for (let cx = cx0; cx <= cx1; cx++) {
          const worldX = (cx + 0.5) * cellW;
          const worldY = (cy + 0.5) * cellH;
          const d = Math.hypot(worldX - p.x, worldY - p.y);
          if (d > radius) continue;

          const edge = radius * (1 - CONFIG.INFLUENCE_SOFTNESS);
          let falloff = 1;
          if (d > edge) {
            falloff = 1 - (d - edge) / (radius - edge || 1);
          }
          const target = value * clamp(falloff, 0, 1);
          const i = this.idx(cx, cy);
          if (target > layer[i]) {
            layer[i] = Math.min(1, layer[i] + (target - layer[i]) * riseRate);
          }
        }
      }
    }
  }

  _riseFromBodyMasks(layer, people, personField, riseRate) {
    const ctx = this._bodyMaskCtx;
    ctx.clearRect(0, 0, this.cols, this.rows);
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    let drewAnyBody = false;
    for (const p of people) {
      const value = this._personLayerValue(p, personField);
      if (value <= 0 || !p.keypoints?.length) continue;
      if (!this._drawPersonBodyMask(ctx, p, value)) continue;
      drewAnyBody = true;
    }
    ctx.restore();

    if (!drewAnyBody) return false;

    const { data } = ctx.getImageData(0, 0, this.cols, this.rows);
    for (let i = 0; i < layer.length; i++) {
      const target = data[i * 4 + 3] / 255;
      if (target > layer[i]) {
        layer[i] = Math.min(1, layer[i] + (target - layer[i]) * riseRate);
      }
    }
    return true;
  }

  _personLayerValue(person, personField) {
    if (
      personField === 'reveal' &&
      ((person.imageSpeed ?? 0) > CONFIG.IMAGE_HIDE_SPEED_THRESHOLD || person.imageRevealBlocked)
    ) {
      return 0;
    }
    if (personField === 'reveal') return person.imageReveal ?? 0;
    if (personField === 'imageWaitProgress') return person.imageWaitProgress ?? 0;
    return person[personField] ?? 0;
  }

  _riseRateForLayer(personField, dt) {
    if (personField === 'reveal') return CONFIG.IMAGE_REVEAL_RISE_RATE * dt;
    if (personField === 'presence') return Math.min(1, CONFIG.QUIET_RISE_RATE * dt * 10);
    if (personField === 'imageWaitProgress') return Math.min(1, CONFIG.QUIET_RISE_RATE * dt * 5);
    return CONFIG.QUIET_RISE_RATE * dt * 3;
  }

  _drawPersonBodyMask(ctx, person, value) {
    const points = new Map();
    for (const kp of person.keypoints) {
      if ((kp.score ?? 0) < CONFIG.MIN_POSE_SCORE) continue;
      if (!MASK_POINTS.has(kp.name)) continue;
      points.set(kp.name, {
        name: kp.name,
        x: kp.x / this.cellW,
        y: kp.y / this.cellH,
      });
    }
    if (points.size < CONFIG.MIN_TORSO_KEYPOINTS) return false;

    const avgCell = (this.cellW + this.cellH) * 0.5;
    const lineW = Math.max(1, CONFIG.BODY_MASK_LINE_WIDTH / avgCell);
    const armLineW = Math.max(lineW, CONFIG.BODY_MASK_ARM_LINE_WIDTH / avgCell);
    const jointR = Math.max(1, CONFIG.BODY_MASK_JOINT_RADIUS / avgCell);
    const alpha = clamp(value, 0, 1);
    ctx.strokeStyle = `rgba(255,255,255,${alpha})`;
    ctx.fillStyle = `rgba(255,255,255,${alpha})`;

    this._drawShoulderMask(ctx, points);

    ctx.lineWidth = lineW;
    for (const [a, b] of BODY_EDGES) {
      const pa = points.get(a);
      const pb = points.get(b);
      if (!pa || !pb) continue;
      ctx.lineWidth = this._isArmEdge(a, b) ? armLineW : lineW;
      ctx.beginPath();
      ctx.moveTo(pa.x, pa.y);
      ctx.lineTo(pb.x, pb.y);
      ctx.stroke();
    }

    for (const pt of points.values()) {
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, jointR, 0, Math.PI * 2);
      ctx.fill();
    }

    return true;
  }

  _drawShoulderMask(ctx, points) {
    const left = points.get('left_shoulder');
    const right = points.get('right_shoulder');
    if (!left || !right) return;

    const avgCell = (this.cellW + this.cellH) * 0.5;
    const shoulderW = Math.max(1, (CONFIG.BODY_MASK_LINE_WIDTH * 1.45) / avgCell);
    const pad = shoulderW * 0.42;
    const leftX = Math.min(left.x, right.x) - pad;
    const rightX = Math.max(left.x, right.x) + pad;
    const topY = Math.min(left.y, right.y) - pad * 0.35;
    const bottomY = this.rows;

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

  _diffuse(layer) {
    const k = CONFIG.QUIET_DIFFUSION;
    if (k <= 0) return;
    const { cols, rows } = this;
    this.scratch.set(layer);
    for (let cy = 0; cy < rows; cy++) {
      for (let cx = 0; cx < cols; cx++) {
        let sum = 0, n = 0;
        for (let oy = -1; oy <= 1; oy++) {
          for (let ox = -1; ox <= 1; ox++) {
            const nx = cx + ox, ny = cy + oy;
            if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) continue;
            sum += this.scratch[this.idx(nx, ny)];
            n++;
          }
        }
        const avg = sum / n;
        const i = this.idx(cx, cy);
        layer[i] = layer[i] + (avg - layer[i]) * k;
      }
    }
  }

  sampleCalm(x, y) {
    return this._sample(this.calmGrid, x, y);
  }

  samplePresence(x, y) {
    return this._sample(this.presenceGrid, x, y);
  }

  sampleQuiet(x, y) {
    return this._sample(this.grid, x, y);
  }

  sampleDark(x, y) {
    return this._sample(this.darkGrid, x, y);
  }

  sampleReveal(x, y) {
    return this._sample(this.revealGrid, x, y);
  }

  _sample(grid, x, y) {
    const gx = clamp(x / this.cellW - 0.5, 0, this.cols - 1);
    const gy = clamp(y / this.cellH - 0.5, 0, this.rows - 1);
    const x0 = Math.floor(gx), y0 = Math.floor(gy);
    const x1 = Math.min(this.cols - 1, x0 + 1);
    const y1 = Math.min(this.rows - 1, y0 + 1);
    const tx = gx - x0, ty = gy - y0;

    const v00 = grid[this.idx(x0, y0)];
    const v10 = grid[this.idx(x1, y0)];
    const v01 = grid[this.idx(x0, y1)];
    const v11 = grid[this.idx(x1, y1)];

    const top = v00 + (v10 - v00) * tx;
    const bottom = v01 + (v11 - v01) * tx;
    return top + (bottom - top) * ty;
  }

  // Draws the accumulated darkness as a soft, blurred bitmap sourced
  // directly from the low-res grid (bilinear upscale = organic edges,
  // not a geometric mask) — used only to deepen trail fade locally,
  // never as a flat overlay over the strokes themselves.
  buildFadeMaskCanvas() {
    if (!this._maskCanvas) {
      this._maskCanvas = document.createElement('canvas');
      this._maskCanvas.width = this.cols;
      this._maskCanvas.height = this.rows;
      this._maskCtx = this._maskCanvas.getContext('2d');
      this._maskImageData = this._maskCtx.createImageData(this.cols, this.rows);
    }
    const data = this._maskImageData.data;
    for (let i = 0; i < this.grid.length; i++) {
      const v = this.darkGrid[i];
      const o = i * 4;
      data[o] = 0;
      data[o + 1] = 0;
      data[o + 2] = 0;
      data[o + 3] = Math.round(clamp(v, 0, 1) * 255);
    }
    this._maskCtx.putImageData(this._maskImageData, 0, 0);
    return this._maskCanvas;
  }

  getDarkMaskCanvas() {
    return this.buildFadeMaskCanvas();
  }
}
