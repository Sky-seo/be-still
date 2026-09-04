import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { curlNoise } from './Noise2D.js';
import { clamp, hexToRgb, lerp, smoothstep } from '../utils/math.js';

const PALETTE_RGB = CONFIG.PALETTE.map(hexToRgb);
const NEAR_BLACK = { r: 12, g: 9, b: 14 };
const HIDDEN_RGB = hexToRgb(CONFIG.HIDDEN_MARK_COLOR);
const RIPPLE_SOURCES = [
  { x: 0.5, y: 0.5, phase: 0.0, strength: 1.0 },
  { x: 0.22, y: 0.32, phase: 1.35, strength: 0.72 },
  { x: 0.76, y: 0.28, phase: 2.4, strength: 0.68 },
  { x: 0.31, y: 0.76, phase: 3.2, strength: 0.62 },
  { x: 0.82, y: 0.68, phase: 4.15, strength: 0.58 },
];
const IDLE_PATTERN_SEQUENCE = [0, 1, 0, 2, 0, 3, 0, 4];

const VERTEX_SHADER = `
attribute vec3 color;
attribute float alpha;
attribute float size;
varying vec3 vColor;
varying float vAlpha;

void main() {
  vColor = color;
  vAlpha = alpha;
  gl_PointSize = size;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAGMENT_SHADER = `
precision mediump float;
uniform float uGlow;
uniform float uCore;
varying vec3 vColor;
varying float vAlpha;

void main() {
  vec2 uv = gl_PointCoord - vec2(0.5);
  float d = length(uv);
  float core = smoothstep(0.5, uCore, d);
  float halo = pow(1.0 - smoothstep(0.0, 0.5, d), 0.72) * uGlow;
  float a = clamp(core + halo, 0.0, 1.0) * vAlpha;
  if (a <= 0.01) discard;
  vec3 glowColor = mix(vColor, vec3(1.0), clamp(halo * 0.42, 0.0, 0.7));
  gl_FragColor = vec4(glowColor, a);
}
`;

const GLOW_FRAGMENT_SHADER = `
precision mediump float;
uniform float uGlow;
varying vec3 vColor;
varying float vAlpha;

void main() {
  vec2 uv = gl_PointCoord - vec2(0.5);
  float d = length(uv);
  float halo = pow(1.0 - smoothstep(0.0, 0.5, d), 2.4);
  float a = halo * vAlpha * uGlow;
  if (a <= 0.004) discard;
  gl_FragColor = vec4(vColor, a);
}
`;

const SILHOUETTE_VERTEX_SHADER = `
varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const SILHOUETTE_FRAGMENT_SHADER = `
precision mediump float;
uniform sampler2D uMask;
uniform float uAlpha;
uniform float uEdge;
varying vec2 vUv;

void main() {
  float mask = texture2D(uMask, vUv).a;
  float a = smoothstep(uEdge, 1.0, mask) * uAlpha;
  if (a <= 0.01) discard;
  gl_FragColor = vec4(0.0, 0.0, 0.0, a);
}
`;

function randRange(a, b) {
  return a + Math.random() * (b - a);
}

function lerpAngle(a, b, t) {
  let diff = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (diff < -Math.PI) diff += Math.PI * 2;
  return a + diff * t;
}

function pickSpawnPosition(width, height, quietField) {
  let x = Math.random() * width;
  let y = Math.random() * height;
  if (!quietField) return { x, y };

  for (let i = 0; i < 4; i++) {
    const q = quietField.sampleQuiet(x, y);
    if (q < 0.4 || Math.random() > q) break;
    x = Math.random() * width;
    y = Math.random() * height;
  }
  return { x, y };
}

function rippleAt(x, y, width, height, time) {
  let bestWave = 0;
  let bestDx = x - width * 0.5;
  let bestDy = y - height * 0.5;

  for (const source of RIPPLE_SOURCES) {
    const dx = x - width * source.x;
    const dy = y - height * source.y;
    const d = Math.max(1, Math.hypot(dx, dy));
    const phase = d * CONFIG.BRUSH_GLOW_WAVE_SCALE
      - time * CONFIG.BRUSH_GLOW_WAVE_SPEED
      + source.phase;
    const raw = 0.5 + 0.5 * Math.sin(phase);
    const clumpEdge = lerp(0.18, 0.62, CONFIG.BRUSH_GLOW_WAVE_CLUMP);
    const wave = smoothstep(clumpEdge, 1, raw) * source.strength;
    if (wave > bestWave) {
      bestWave = wave;
      bestDx = dx;
      bestDy = dy;
    }
  }

  const d = Math.max(1, Math.hypot(bestDx, bestDy));
  return {
    wave: bestWave,
    x: bestDx / d,
    y: bestDy / d,
  };
}

function rippleAtSource(index, x, y, width, height, time) {
  const source = RIPPLE_SOURCES[index % RIPPLE_SOURCES.length];
  const dx = x - width * source.x;
  const dy = y - height * source.y;
  const d = Math.max(1, Math.hypot(dx, dy));
  const phase = d * CONFIG.BRUSH_GLOW_WAVE_SCALE
    - time * CONFIG.BRUSH_GLOW_WAVE_SPEED
    + source.phase;
  const raw = 0.5 + 0.5 * Math.sin(phase);
  const clumpEdge = lerp(0.18, 0.62, CONFIG.BRUSH_GLOW_WAVE_CLUMP);
  const wave = smoothstep(clumpEdge, 1, raw) * source.strength;
  return {
    wave,
    x: dx / d,
    y: dy / d,
  };
}

function fastEaseInOut(t) {
  const x = clamp(t, 0, 1);
  return x < 0.5
    ? 4 * x * x * x
    : 1 - Math.pow(-2 * x + 2, 3) * 0.5;
}

class Stroke {
  constructor(width, height) {
    this.rippleSourceIdx = 0;
    this.reset(width, height, null);
  }

  reset(width, height, quietField) {
    const pos = pickSpawnPosition(width, height, quietField);
    this.x = pos.x;
    this.y = pos.y;
    this.baseX = pos.x;
    this.baseY = pos.y;
    this.angle = Math.random() * Math.PI * 2;
    this.width = randRange(CONFIG.BRUSH_MIN_WIDTH, CONFIG.BRUSH_MAX_WIDTH);
    this.speedMult = randRange(0.6, 1.4);
    this.paletteIdx = Math.floor(Math.random() * PALETTE_RGB.length);
    this.maxLife = randRange(CONFIG.BRUSH_LIFETIME_MIN, CONFIG.BRUSH_LIFETIME_MAX);
    this.age = 0;
    this.noiseOffset = Math.random() * 1000;
    this.silhouetteTargetX = null;
    this.silhouetteTargetY = null;
    this.silhouetteStartDistance = 1;
    this.silhouetteAttached = false;
  }
}

export class WebGLBrushField {
  constructor(canvas, width, height) {
    this.canvas = canvas;
    this.width = width;
    this.height = height;
    this.time = 0;
    this.flowTime = 0;
    this.sparkleSlot = -1;
    this.idlePatternIndex = -1;
    this.idlePatternStep = -1;
    this.idleTransitionTime = 0;
    this.needsRippleLayout = true;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: false,
      antialias: false,
      powerPreference: 'high-performance',
    });
    this.renderer.autoClear = true;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(CONFIG.BACKGROUND_COLOR, 1);

    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(
      -width / 2,
      width / 2,
      height / 2,
      -height / 2,
      0.1,
      10
    );
    this.camera.position.z = 1;

    this.strokes = [];
    for (let i = 0; i < CONFIG.BRUSH_COUNT; i++) {
      const s = new Stroke(width, height);
      s.rippleSourceIdx = i % RIPPLE_SOURCES.length;
      s.age = Math.random() * s.maxLife;
      this.strokes.push(s);
    }
    this._layoutIdlePattern(width, height, 1, true);

    this._initBrushPoints();
    this._initBrushGlowPoints();
    this._initSilhouetteOverlay();
    this._initImagePoints();
    this._initImageGlowPoints();
    this.resize(width, height);
  }

  resize(width, height) {
    this.width = width;
    this.height = height;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(width, height, false);
    this.camera.left = -width / 2;
    this.camera.right = width / 2;
    this.camera.top = height / 2;
    this.camera.bottom = -height / 2;
    this.camera.updateProjectionMatrix();
    this._layoutIdlePattern(width, height, this.idlePatternIndex < 0 ? 1 : this.idlePatternIndex, true);
  }

  update(dt, people, quietField) {
    this.time += dt;
    this.flowTime += dt * CONFIG.TURBULENCE_TIME_SCALE;
    const w = this.width;
    const h = this.height;
    const hasPeople = people.length > 0;
    if (hasPeople) {
      this.needsRippleLayout = true;
    } else if (this.needsRippleLayout) {
      this.idlePatternIndex = -1;
      this.idlePatternStep = -1;
      this.idleTransitionTime = CONFIG.BRUSH_IDLE_PATTERN_TRANSITION;
      this.needsRippleLayout = false;
    }
    const idlePatternStep = Math.floor(this.time / Math.max(1, CONFIG.BRUSH_IDLE_PATTERN_DURATION)) % IDLE_PATTERN_SEQUENCE.length;
    const idlePattern = IDLE_PATTERN_SEQUENCE[idlePatternStep];
    if (!hasPeople && idlePatternStep !== this.idlePatternStep) {
      this.idlePatternStep = idlePatternStep;
      this.idlePatternIndex = idlePattern;
      this.idleTransitionTime = 0;
      this._layoutIdlePattern(w, h, idlePattern, false);
    } else if (!hasPeople) {
      this.idleTransitionTime += dt;
    }

    for (const s of this.strokes) {
      s.age += dt;
      const calm = quietField.sampleCalm(s.x, s.y);
      const quiet = quietField.sampleQuiet(s.x, s.y);
      if (!hasPeople) {
        s.age = s.maxLife * 0.5;
        this._updateIdlePatternStroke(s, w, h, idlePattern, dt);
        continue;
      }

      const lifeDecay = 1 + quiet * 2.2;
      if (s.age >= s.maxLife / lifeDecay) {
        s.reset(w, h, quietField);
        continue;
      }

      const flow = curlNoise(
        s.x * CONFIG.TURBULENCE_SCALE,
        s.y * CONFIG.TURBULENCE_SCALE,
        this.flowTime + s.noiseOffset
      );
      const assignedRipple = rippleAtSource(s.rippleSourceIdx, s.x, s.y, w, h, this.time);
      const rippleAngle = Math.atan2(assignedRipple.y, assignedRipple.x);
      const idlePatternWeight = clamp(CONFIG.BRUSH_RIPPLE_DIRECTION_BLEND * (1 - calm) * 0.18, 0, 0.4);
      let desiredAngle = lerpAngle(Math.atan2(flow.y, flow.x), rippleAngle, idlePatternWeight);

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
          steerAngle = Math.atan2(dx, -dy);
          steerWeight = weight;
        }
      }
      if (steerWeight > 0) {
        desiredAngle = lerpAngle(desiredAngle, steerAngle, clamp(steerWeight, 0, 0.85));
      }

      const turbulenceFactor = lerp(1, 0.12, calm);
      const speedFactor = lerp(1, CONFIG.BRUSH_MIN_SPEED_FACTOR, calm);
      const turnRate = clamp(2.2 * dt * turbulenceFactor, 0, 1);
      s.angle = lerpAngle(s.angle, desiredAngle, turnRate);

      const speed = CONFIG.BRUSH_BASE_SPEED * s.speedMult * speedFactor;
      s.x += Math.cos(s.angle) * speed * dt;
      s.y += Math.sin(s.angle) * speed * dt;

      const idleRipple = CONFIG.BRUSH_RIPPLE_MOTION_STRENGTH * (1 - calm) * 0.2;
      if (idleRipple > 0) {
        const ripplePush = assignedRipple.wave * idleRipple;
        s.x += assignedRipple.x * ripplePush * dt;
        s.y += assignedRipple.y * ripplePush * dt;
      }

      this._applySilhouetteAttraction(s, people, quietField, dt);

      if (s.x < -40) s.x = w + 40;
      if (s.x > w + 40) s.x = -40;
      if (s.y < -40) s.y = h + 40;
      if (s.y > h + 40) s.y = -40;
    }
  }

  _updateIdlePatternStroke(stroke, width, height, pattern, dt) {
    const fromX = stroke.transitionFromX ?? stroke.x;
    const fromY = stroke.transitionFromY ?? stroke.y;
    const transition = fastEaseInOut(
      this.idleTransitionTime / Math.max(0.001, CONFIG.BRUSH_IDLE_PATTERN_TRANSITION)
    );

    if (pattern === 0) {
      let nextX = stroke.x;
      let nextY = stroke.y;
      if (transition >= 1) {
        const flow = curlNoise(
          stroke.x * CONFIG.TURBULENCE_SCALE,
          stroke.y * CONFIG.TURBULENCE_SCALE,
          this.flowTime + stroke.noiseOffset
        );
        stroke.angle = Math.atan2(flow.y, flow.x);
        const speed = CONFIG.BRUSH_BASE_SPEED * stroke.speedMult;
        nextX += flow.x * speed * dt;
        nextY += flow.y * speed * dt;
      } else {
        const flow = curlNoise(
          stroke.baseX * CONFIG.TURBULENCE_SCALE,
          stroke.baseY * CONFIG.TURBULENCE_SCALE,
          this.flowTime + stroke.noiseOffset
        );
        stroke.angle = Math.atan2(flow.y, flow.x);
        nextX = stroke.baseX;
        nextY = stroke.baseY;
      }
      stroke.x = lerp(fromX, nextX, transition);
      stroke.y = lerp(fromY, nextY, transition);
      if (transition >= 1) {
        stroke.transitionFromX = stroke.x;
        stroke.transitionFromY = stroke.y;
      }
      if (stroke.x < -40) stroke.x = width + 40;
      if (stroke.x > width + 40) stroke.x = -40;
      if (stroke.y < -40) stroke.y = height + 40;
      if (stroke.y > height + 40) stroke.y = -40;
      return;
    }

    const baseX = stroke.baseX ?? stroke.x;
    const baseY = stroke.baseY ?? stroke.y;
    let dirX = 0;
    let dirY = 1;
    let wave = 0;

    if (pattern === 1) {
      const ripple = rippleAtSource(stroke.rippleSourceIdx, baseX, baseY, width, height, this.time);
      dirX = ripple.x;
      dirY = ripple.y;
      wave = ripple.wave;
    } else if (pattern === 2) {
      const phase = (baseX + baseY) * CONFIG.BRUSH_GLOW_WAVE_SCALE - this.time * CONFIG.BRUSH_GLOW_WAVE_SPEED;
      wave = smoothstep(0.35, 1, 0.5 + 0.5 * Math.sin(phase));
      dirX = 0.7071;
      dirY = 0.7071;
    } else if (pattern === 3) {
      const phase = baseY * CONFIG.BRUSH_GLOW_WAVE_SCALE - this.time * CONFIG.BRUSH_GLOW_WAVE_SPEED;
      wave = smoothstep(0.3, 1, 0.5 + 0.5 * Math.sin(phase));
      dirX = Math.sin(this.time * 0.7) * 0.25;
      dirY = 1;
    } else {
      const cx = width * 0.5;
      const cy = height * 0.5;
      const dx = baseX - cx;
      const dy = baseY - cy;
      const d = Math.max(1, Math.hypot(dx, dy));
      const phase = d * CONFIG.BRUSH_GLOW_WAVE_SCALE - this.time * CONFIG.BRUSH_GLOW_WAVE_SPEED;
      wave = smoothstep(0.32, 1, 0.5 + 0.5 * Math.sin(phase));
      dirX = -dy / d;
      dirY = dx / d;
    }

    const len = Math.max(1, Math.hypot(dirX, dirY));
    const displacement = wave * CONFIG.BRUSH_RIPPLE_MOTION_STRENGTH;
    const targetX = baseX + (dirX / len) * displacement;
    const targetY = baseY + (dirY / len) * displacement;
    stroke.x = lerp(fromX, targetX, transition);
    stroke.y = lerp(fromY, targetY, transition);
    stroke.angle = Math.atan2(dirY, dirX);
    if (transition >= 1) {
      stroke.transitionFromX = stroke.x;
      stroke.transitionFromY = stroke.y;
    }
  }

  _idlePatternWave(stroke, pattern) {
    if (pattern === 0) {
      return 0.5 + 0.5 * Math.sin(this.flowTime * 18 + stroke.noiseOffset);
    }
    if (pattern === 1) {
      return rippleAt(stroke.x, stroke.y, this.width, this.height, this.time).wave;
    }
    if (pattern === 2) {
      const phase = (stroke.x + stroke.y) * CONFIG.BRUSH_GLOW_WAVE_SCALE - this.time * CONFIG.BRUSH_GLOW_WAVE_SPEED;
      return smoothstep(0.35, 1, 0.5 + 0.5 * Math.sin(phase));
    }
    if (pattern === 3) {
      const phase = stroke.y * CONFIG.BRUSH_GLOW_WAVE_SCALE - this.time * CONFIG.BRUSH_GLOW_WAVE_SPEED;
      return smoothstep(0.3, 1, 0.5 + 0.5 * Math.sin(phase));
    }
    const d = Math.hypot(stroke.x - this.width * 0.5, stroke.y - this.height * 0.5);
    const phase = d * CONFIG.BRUSH_GLOW_WAVE_SCALE - this.time * CONFIG.BRUSH_GLOW_WAVE_SPEED;
    return smoothstep(0.32, 1, 0.5 + 0.5 * Math.sin(phase));
  }

  _layoutIdlePattern(width, height, pattern, immediate = false) {
    if (pattern === 0) {
      for (const stroke of this.strokes) {
        const pos = pickSpawnPosition(width, height, null);
        stroke.transitionFromX = stroke.x;
        stroke.transitionFromY = stroke.y;
        stroke.baseX = pos.x;
        stroke.baseY = pos.y;
        if (immediate) {
          stroke.x = pos.x;
          stroke.y = pos.y;
          stroke.transitionFromX = stroke.x;
          stroke.transitionFromY = stroke.y;
        }
        stroke.age = stroke.maxLife * 0.5;
      }
      return;
    }
    this._layoutRippleSurface(width, height, immediate);
  }

  _layoutRippleSurface(width, height, immediate = false) {
    const count = Math.max(1, this.strokes.length);
    const aspect = width / Math.max(1, height);
    const cols = Math.ceil(Math.sqrt(count * aspect));
    const rows = Math.ceil(count / cols);
    const padX = width / (cols + 1);
    const padY = height / (rows + 1);

    for (let i = 0; i < count; i++) {
      const stroke = this.strokes[i];
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = padX * (col + 1);
      const y = padY * (row + 1);
      stroke.transitionFromX = stroke.x;
      stroke.transitionFromY = stroke.y;
      stroke.baseX = x;
      stroke.baseY = y;
      if (immediate) {
        stroke.x = x;
        stroke.y = y;
        stroke.transitionFromX = stroke.x;
        stroke.transitionFromY = stroke.y;
      }
      stroke.rippleSourceIdx = i % RIPPLE_SOURCES.length;
      stroke.age = stroke.maxLife * 0.5;
      stroke.silhouetteTargetX = null;
      stroke.silhouetteTargetY = null;
      stroke.silhouetteAttached = false;
    }
  }

  _applySilhouetteAttraction(stroke, people, quietField, dt) {
    if (!people.length || CONFIG.BRUSH_SILHOUETTE_FOLLOW_ATTRACTION <= 0) {
      stroke.silhouetteTargetX = null;
      stroke.silhouetteTargetY = null;
      stroke.silhouetteStartDistance = 1;
      stroke.silhouetteAttached = false;
      return;
    }

    const needsTarget = (
      stroke.silhouetteTargetX === null ||
      quietField.samplePresence(stroke.silhouetteTargetX, stroke.silhouetteTargetY) < 0.35 ||
      Math.random() < CONFIG.BRUSH_SILHOUETTE_TARGET_REFRESH * dt
    );
    if (needsTarget) {
      const target = this._pickSilhouetteTarget(quietField);
      if (target) {
        stroke.silhouetteTargetX = target.x;
        stroke.silhouetteTargetY = target.y;
        stroke.silhouetteStartDistance = Math.max(1, Math.hypot(target.x - stroke.x, target.y - stroke.y));
      } else {
        stroke.silhouetteAttached = false;
      }
    }

    if (stroke.silhouetteTargetX === null) return;

    const dx = stroke.silhouetteTargetX - stroke.x;
    const dy = stroke.silhouetteTargetY - stroke.y;
    const d = Math.hypot(dx, dy);
    if (d < 1) return;

    const localPresence = quietField.samplePresence(stroke.x, stroke.y);
    const targetPresence = quietField.samplePresence(stroke.silhouetteTargetX, stroke.silhouetteTargetY);
    if (localPresence > 0.5 || d < 18) stroke.silhouetteAttached = true;

    const attraction = stroke.silhouetteAttached
      ? CONFIG.BRUSH_SILHOUETTE_FOLLOW_ATTRACTION
      : CONFIG.BRUSH_SILHOUETTE_INITIAL_ATTRACTION;
    const maxPull = stroke.silhouetteAttached
      ? CONFIG.BRUSH_SILHOUETTE_FOLLOW_MAX_PULL
      : CONFIG.BRUSH_SILHOUETTE_INITIAL_MAX_PULL;
    const pull = clamp(
      (0.18 + targetPresence * 0.82) * attraction * dt,
      0,
      maxPull
    );
    const approach = stroke.silhouetteAttached
      ? 1
      : this._silhouetteApproachEase(d, stroke.silhouetteStartDistance);
    stroke.x += dx * pull * approach;
    stroke.y += dy * pull * approach;
  }

  _silhouetteApproachEase(distance, startDistance) {
    const slowNearBody = smoothstep(0, CONFIG.BRUSH_SILHOUETTE_SLOW_RADIUS, distance);
    return lerp(
      CONFIG.BRUSH_SILHOUETTE_MIN_APPROACH,
      1,
      slowNearBody
    );
  }

  _pickSilhouetteTarget(quietField) {
    for (let i = 0; i < 28; i++) {
      const x = Math.random() * this.width;
      const y = Math.random() * this.height;
      if (quietField.samplePresence(x, y) > 0.5) return { x, y };
    }
    return null;
  }

  _globalWipeAt(x, y, reveal) {
    if (reveal <= 0) return 0;
    const cx = this.width * 0.5;
    const cy = this.height * 0.5;
    const maxR = Math.hypot(Math.max(cx, this.width - cx), Math.max(cy, this.height - cy));
    const d = Math.hypot(x - cx, y - cy) / maxR;
    const edge = reveal;
    const softness = Math.max(0.001, CONFIG.GLOBAL_REVEAL_WIPE_SOFTNESS);
    return 1 - smoothstep(edge, edge + softness, d);
  }

  _imageSparkleForPoint(index, pt, appear, pointCount) {
    if (!CONFIG.IMAGE_SPARKLE_ENABLED || appear < 0.35) return 0;
    if (pointCount <= 0) return 0;

    const interval = Math.max(0.2, CONFIG.IMAGE_SPARKLE_INTERVAL);
    const slot = Math.floor(this.time / interval);
    if (slot !== this.sparkleSlot) {
      this.sparkleSlot = slot;
    }

    const selected = Math.floor(
      (Math.abs(Math.sin((slot + 1) * 91.731) * 43758.5453) % 1) * pointCount
    );
    if (index !== selected) return 0;

    const elapsed = this.time - slot * interval;
    const duration = Math.min(interval, Math.max(0.05, CONFIG.IMAGE_SPARKLE_DURATION));
    if (elapsed > duration) return 0;

    const phase = elapsed / duration;
    const pulse = Math.sin(phase * Math.PI);
    return Math.max(0, pulse) * smoothstep(0.35, 0.75, appear);
  }

  render(quietField, imageField) {
    this._updateSilhouetteOverlay(quietField);
    this._updateBrushAttributes(quietField);
    this._updateImageAttributes(quietField, imageField);
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.renderer.dispose();
    this.brushGeometry.dispose();
    this.brushGlowGeometry.dispose();
    this.brushMaterial.dispose();
    this.brushGlowMaterial.dispose();
    this.silhouetteGeometry.dispose();
    this.silhouetteMaterial.dispose();
    this.silhouetteTexture.dispose();
    this.imageGeometry.dispose();
    this.imageGlowGeometry.dispose();
    this.imageMaterial.dispose();
    this.imageGlowMaterial.dispose();
  }

  _initBrushPoints() {
    const n = this.strokes.length;
    this.brushPositions = new Float32Array(n * 3);
    this.brushColors = new Float32Array(n * 3);
    this.brushAlphas = new Float32Array(n);
    this.brushSizes = new Float32Array(n);

    this.brushGeometry = new THREE.BufferGeometry();
    this.brushGeometry.setAttribute('position', new THREE.BufferAttribute(this.brushPositions, 3));
    this.brushGeometry.setAttribute('color', new THREE.BufferAttribute(this.brushColors, 3));
    this.brushGeometry.setAttribute('alpha', new THREE.BufferAttribute(this.brushAlphas, 1));
    this.brushGeometry.setAttribute('size', new THREE.BufferAttribute(this.brushSizes, 1));
    this.brushMaterial = this._makePointMaterial(
      CONFIG.BRUSH_SHADER_GLOW,
      CONFIG.BRUSH_SHADER_CORE,
      THREE.AdditiveBlending
    );
    this.brushPoints = new THREE.Points(this.brushGeometry, this.brushMaterial);
    this.brushPoints.renderOrder = 1;
    this.scene.add(this.brushPoints);
  }

  _initBrushGlowPoints() {
    const n = this.strokes.length;
    this.brushGlowPositions = new Float32Array(n * 3);
    this.brushGlowColors = new Float32Array(n * 3);
    this.brushGlowAlphas = new Float32Array(n);
    this.brushGlowSizes = new Float32Array(n);

    this.brushGlowGeometry = new THREE.BufferGeometry();
    this.brushGlowGeometry.setAttribute('position', new THREE.BufferAttribute(this.brushGlowPositions, 3));
    this.brushGlowGeometry.setAttribute('color', new THREE.BufferAttribute(this.brushGlowColors, 3));
    this.brushGlowGeometry.setAttribute('alpha', new THREE.BufferAttribute(this.brushGlowAlphas, 1));
    this.brushGlowGeometry.setAttribute('size', new THREE.BufferAttribute(this.brushGlowSizes, 1));
    this.brushGlowMaterial = this._makeGlowMaterial(1.0);
    this.brushGlowPoints = new THREE.Points(this.brushGlowGeometry, this.brushGlowMaterial);
    this.brushGlowPoints.renderOrder = 0;
    this.scene.add(this.brushGlowPoints);
  }

  _initSilhouetteOverlay() {
    this.silhouetteTexture = new THREE.CanvasTexture(document.createElement('canvas'));
    this.silhouetteTexture.minFilter = THREE.LinearFilter;
    this.silhouetteTexture.magFilter = THREE.LinearFilter;
    this.silhouetteTexture.generateMipmaps = false;

    this.silhouetteGeometry = new THREE.PlaneGeometry(this.width, this.height);
    this.silhouetteMaterial = new THREE.ShaderMaterial({
      vertexShader: SILHOUETTE_VERTEX_SHADER,
      fragmentShader: SILHOUETTE_FRAGMENT_SHADER,
      uniforms: {
        uMask: { value: this.silhouetteTexture },
        uAlpha: { value: CONFIG.BODY_SILHOUETTE_ALPHA },
        uEdge: { value: CONFIG.BODY_SILHOUETTE_EDGE },
      },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NormalBlending,
    });
    this.silhouettePlane = new THREE.Mesh(this.silhouetteGeometry, this.silhouetteMaterial);
    this.silhouettePlane.renderOrder = 1.5;
    this.scene.add(this.silhouettePlane);
  }

  _updateSilhouetteOverlay(quietField) {
    const canvas = quietField.getDarkMaskCanvas();
    if (this.silhouetteTexture.image !== canvas) {
      this.silhouetteTexture.image = canvas;
    }
    this.silhouetteTexture.needsUpdate = true;
    this.silhouetteMaterial.uniforms.uAlpha.value = CONFIG.BODY_SILHOUETTE_ALPHA;
    this.silhouetteMaterial.uniforms.uEdge.value = CONFIG.BODY_SILHOUETTE_EDGE;

    const params = this.silhouettePlane.geometry.parameters;
    if (params.width !== this.width || params.height !== this.height) {
      this.silhouetteGeometry.dispose();
      this.silhouetteGeometry = new THREE.PlaneGeometry(this.width, this.height);
      this.silhouettePlane.geometry = this.silhouetteGeometry;
    }
  }

  _initImagePoints() {
    this.imagePointCount = 0;
    this.imagePositions = new Float32Array(0);
    this.imageColors = new Float32Array(0);
    this.imageAlphas = new Float32Array(0);
    this.imageSizes = new Float32Array(0);

    this.imageGeometry = new THREE.BufferGeometry();
    this.imageGeometry.setAttribute('position', new THREE.BufferAttribute(this.imagePositions, 3));
    this.imageGeometry.setAttribute('color', new THREE.BufferAttribute(this.imageColors, 3));
    this.imageGeometry.setAttribute('alpha', new THREE.BufferAttribute(this.imageAlphas, 1));
    this.imageGeometry.setAttribute('size', new THREE.BufferAttribute(this.imageSizes, 1));
    this.imageMaterial = this._makePointMaterial(
      CONFIG.IMAGE_MARK_SHADER_GLOW,
      CONFIG.IMAGE_MARK_SHADER_CORE,
      THREE.NormalBlending
    );
    this.imagePoints = new THREE.Points(this.imageGeometry, this.imageMaterial);
    this.imagePoints.renderOrder = 3;
    this.scene.add(this.imagePoints);
  }

  _initImageGlowPoints() {
    this.imageGlowPointCount = 0;
    this.imageGlowPositions = new Float32Array(0);
    this.imageGlowColors = new Float32Array(0);
    this.imageGlowAlphas = new Float32Array(0);
    this.imageGlowSizes = new Float32Array(0);

    this.imageGlowGeometry = new THREE.BufferGeometry();
    this.imageGlowGeometry.setAttribute('position', new THREE.BufferAttribute(this.imageGlowPositions, 3));
    this.imageGlowGeometry.setAttribute('color', new THREE.BufferAttribute(this.imageGlowColors, 3));
    this.imageGlowGeometry.setAttribute('alpha', new THREE.BufferAttribute(this.imageGlowAlphas, 1));
    this.imageGlowGeometry.setAttribute('size', new THREE.BufferAttribute(this.imageGlowSizes, 1));
    this.imageGlowMaterial = this._makeGlowMaterial(1.0);
    this.imageGlowPoints = new THREE.Points(this.imageGlowGeometry, this.imageGlowMaterial);
    this.imageGlowPoints.renderOrder = 2;
    this.scene.add(this.imageGlowPoints);
  }

  _makePointMaterial(glow, core, blending) {
    return new THREE.ShaderMaterial({
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      uniforms: {
        uGlow: { value: glow },
        uCore: { value: core },
      },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending,
    });
  }

  _makeGlowMaterial(glow) {
    return new THREE.ShaderMaterial({
      vertexShader: VERTEX_SHADER,
      fragmentShader: GLOW_FRAGMENT_SHADER,
      uniforms: {
        uGlow: { value: glow },
      },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
  }

  _updateBrushAttributes(quietField) {
    const globalReveal = quietField.globalReveal ?? 0;
    for (let i = 0; i < this.strokes.length; i++) {
      const s = this.strokes[i];
      const lifeT = s.age / s.maxLife;
      const fadeIn = clamp(lifeT / 0.08, 0, 1);
      const fadeOut = clamp((1 - lifeT) / 0.2, 0, 1);
      const alpha = Math.min(fadeIn, fadeOut);
      const quiet = quietField.sampleQuiet(s.x, s.y);
      const dark = quietField.sampleDark(s.x, s.y);
      const presence = quietField.samplePresence(s.x, s.y);
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

      const gatherGlow = clamp(presence * (1 - dark) * 0.55, 0, 0.55);
      r = lerp(r, HIDDEN_RGB.r, gatherGlow);
      g = lerp(g, HIDDEN_RGB.g, gatherGlow);
      b = lerp(b, HIDDEN_RGB.b, gatherGlow);
      const globalErase = this._globalWipeAt(s.x, s.y, globalReveal);
      const eraseAlpha = 1 - clamp(globalErase * CONFIG.GLOBAL_REVEAL_ERASE_STRENGTH, 0, 1);
      const pattern = this.idlePatternIndex < 0 ? 1 : this.idlePatternIndex;
      const wave = this._idlePatternWave(s, pattern);
      const waveVisibility = clamp((1 - presence) * (1 - dark) * (1 - globalReveal), 0, 1);
      const glowWave = 1 + (wave - 0.5) * 2 * CONFIG.BRUSH_GLOW_WAVE_STRENGTH * waveVisibility;

      this._setPoint(this.brushPositions, i, s.x, s.y, 0);
      this._setColor(this.brushColors, i, r, g, b);
      this.brushAlphas[i] = alpha * (0.95 + gatherGlow * 0.35) * eraseAlpha;
      this.brushSizes[i] = s.width * CONFIG.BRUSH_POINT_SIZE_MULT * (1 - darkAmt * 0.25 + gatherGlow * 0.18)
        * (1 + (glowWave - 1) * 0.18);

      this._setPoint(this.brushGlowPositions, i, s.x, s.y, -0.1);
      this._setColor(this.brushGlowColors, i, r, g, b);
      this.brushGlowAlphas[i] = alpha * CONFIG.BRUSH_GLOW_ALPHA * (1 - darkAmt * 0.45) * eraseAlpha
        * Math.max(0.1, glowWave);
      this.brushGlowSizes[i] = this.brushSizes[i] * CONFIG.BRUSH_GLOW_SIZE_MULT * (1 + (glowWave - 1) * 0.28);
    }
    this._markNeedsUpdate(this.brushGeometry);
    this._markNeedsUpdate(this.brushGlowGeometry);
  }

  _updateImageAttributes(quietField, imageField) {
    const points = imageField.getSamplePoints();
    if (points.length !== this.imagePointCount) this._resizeImageBuffers(points.length);
    if (points.length !== this.imageGlowPointCount) this._resizeImageGlowBuffers(points.length);

    for (let i = 0; i < points.length; i++) {
      const pt = points[i];
      const appear = this._globalWipeAt(pt.tx, pt.ty, quietField.globalReveal ?? 0);

      const settle = smoothstep(0.05, 0.65, appear);
      const chaos = 1 - settle;
      const sparkle = this._imageSparkleForPoint(i, pt, appear, points.length);
      const alphaBoost = lerp(1, CONFIG.IMAGE_SPARKLE_ALPHA_BOOST, sparkle);
      const sizeBoost = lerp(1, CONFIG.IMAGE_SPARKLE_SIZE_BOOST, sparkle);
      const alpha = appear <= 0.015 ? 0 : appear * appear * CONFIG.IMAGE_MARK_ALPHA * alphaBoost;
      const liveJitterX = Math.sin(this.time * 2.3 + pt.jitterSeed) * 4 * chaos;
      const liveJitterY = Math.cos(this.time * 2.1 + pt.jitterSeed) * 4 * chaos;
      const x = pt.tx + pt.scatterX * chaos + liveJitterX;
      const y = pt.ty + pt.scatterY * chaos + liveJitterY;

      this._setPoint(this.imagePositions, i, x, y, 0);
      this._setColor(this.imageColors, i, HIDDEN_RGB.r, HIDDEN_RGB.g, HIDDEN_RGB.b);
      this.imageAlphas[i] = alpha;
      this.imageSizes[i] = Math.max(1.2, pt.radius * CONFIG.IMAGE_MARK_POINT_SIZE_MULT * sizeBoost);

      this._setPoint(this.imageGlowPositions, i, x, y, -0.1);
      this._setColor(this.imageGlowColors, i, HIDDEN_RGB.r, HIDDEN_RGB.g, HIDDEN_RGB.b);
      this.imageGlowAlphas[i] = alpha * CONFIG.IMAGE_MARK_GLOW_ALPHA * (1 + sparkle * 1.5);
      this.imageGlowSizes[i] = this.imageSizes[i] * CONFIG.IMAGE_MARK_GLOW_SIZE_MULT * (1 + sparkle * 0.7);
    }
    this._markNeedsUpdate(this.imageGeometry);
    this._markNeedsUpdate(this.imageGlowGeometry);
  }

  _resizeImageBuffers(count) {
    this.imagePointCount = count;
    this.imagePositions = new Float32Array(count * 3);
    this.imageColors = new Float32Array(count * 3);
    this.imageAlphas = new Float32Array(count);
    this.imageSizes = new Float32Array(count);

    this.imageGeometry.setAttribute('position', new THREE.BufferAttribute(this.imagePositions, 3));
    this.imageGeometry.setAttribute('color', new THREE.BufferAttribute(this.imageColors, 3));
    this.imageGeometry.setAttribute('alpha', new THREE.BufferAttribute(this.imageAlphas, 1));
    this.imageGeometry.setAttribute('size', new THREE.BufferAttribute(this.imageSizes, 1));
  }

  _resizeImageGlowBuffers(count) {
    this.imageGlowPointCount = count;
    this.imageGlowPositions = new Float32Array(count * 3);
    this.imageGlowColors = new Float32Array(count * 3);
    this.imageGlowAlphas = new Float32Array(count);
    this.imageGlowSizes = new Float32Array(count);

    this.imageGlowGeometry.setAttribute('position', new THREE.BufferAttribute(this.imageGlowPositions, 3));
    this.imageGlowGeometry.setAttribute('color', new THREE.BufferAttribute(this.imageGlowColors, 3));
    this.imageGlowGeometry.setAttribute('alpha', new THREE.BufferAttribute(this.imageGlowAlphas, 1));
    this.imageGlowGeometry.setAttribute('size', new THREE.BufferAttribute(this.imageGlowSizes, 1));
  }

  _setPoint(buffer, i, x, y, z) {
    const o = i * 3;
    buffer[o] = x - this.width / 2;
    buffer[o + 1] = this.height / 2 - y;
    buffer[o + 2] = z;
  }

  _setColor(buffer, i, r, g, b) {
    const o = i * 3;
    buffer[o] = r / 255;
    buffer[o + 1] = g / 255;
    buffer[o + 2] = b / 255;
  }

  _markNeedsUpdate(geometry) {
    geometry.attributes.position.needsUpdate = true;
    geometry.attributes.color.needsUpdate = true;
    geometry.attributes.alpha.needsUpdate = true;
    geometry.attributes.size.needsUpdate = true;
  }
}
