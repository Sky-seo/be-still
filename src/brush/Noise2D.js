// Compact 2D Perlin-style noise, self-contained (no dependency).
// Used to drive the curl-noise flow field the brush strokes swim through.

const PERM = new Uint8Array(512);
(function initPermutation(seed = 42) {
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  // deterministic shuffle
  let s = seed;
  const rand = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = p[i];
    p[i] = p[j];
    p[j] = tmp;
  }
  for (let i = 0; i < 512; i++) PERM[i] = p[i & 255];
})();

function fade(t) {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function grad(hash, x, y) {
  const h = hash & 7;
  const u = h < 4 ? x : y;
  const v = h < 4 ? y : x;
  return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v);
}

export function noise2D(x, y) {
  const X = Math.floor(x) & 255;
  const Y = Math.floor(y) & 255;
  const xf = x - Math.floor(x);
  const yf = y - Math.floor(y);
  const u = fade(xf);
  const v = fade(yf);

  const aa = PERM[PERM[X] + Y];
  const ab = PERM[PERM[X] + Y + 1];
  const ba = PERM[PERM[X + 1] + Y];
  const bb = PERM[PERM[X + 1] + Y + 1];

  const x1 = grad(aa, xf, yf) + u * (grad(ba, xf - 1, yf) - grad(aa, xf, yf));
  const x2 = grad(ab, xf, yf - 1) + u * (grad(bb, xf - 1, yf - 1) - grad(ab, xf, yf - 1));
  return (x1 + v * (x2 - x1)) * 0.7; // roughly normalized to [-1, 1]
}

// Curl of the noise field — gives a divergence-free swirling flow,
// which reads as natural currents/vortices rather than jittery random motion.
const EPS = 0.6;
export function curlNoise(x, y, t) {
  const n1 = noise2D(x, y + EPS + t);
  const n2 = noise2D(x, y - EPS + t);
  const dNdy = (n1 - n2) / (2 * EPS);

  const n3 = noise2D(x + EPS, y + t);
  const n4 = noise2D(x - EPS, y + t);
  const dNdx = (n3 - n4) / (2 * EPS);

  return { x: dNdy, y: -dNdx };
}
