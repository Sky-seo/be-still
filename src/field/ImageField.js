// The persistent hidden layer: a single image, loaded once and sampled to
// dark-pixel points. Exists independent of any person from frame one —
// stillness never creates it, only reveals it. Same reveal mechanic as
// before (driven entirely by QuietField's reveal layer); the source
// material is now a portrait image instead of set phrases.
//
// Because the image is large relative to any one person's reveal radius,
// standing in different places uncovers different parts of it — and nothing
// here needs to know that; it's an emergent effect of QuietField being
// spatial. Multiple people standing near each other still naturally merge
// into revealing a larger contiguous region.

import { CONFIG } from '../config.js';
import { makeSeededRandom, clamp } from '../utils/math.js';

export class ImageField {
  constructor(renderWidth, renderHeight) {
    this.width = renderWidth;
    this.height = renderHeight;
    this.points = [];
    this.ready = false;
    this._image = null;
    this._load();
  }

  async _load() {
    try {
      const img = new Image();
      img.src = CONFIG.IMAGE_SRC;
      await img.decode();
      this._image = img;
      this._generate();
      this.ready = true;
    } catch (err) {
      console.error('[ImageField] failed to load', CONFIG.IMAGE_SRC, err);
    }
  }

  resize(renderWidth, renderHeight) {
    this.width = renderWidth;
    this.height = renderHeight;
    if (this._image) this._generate();
  }

  _generate() {
    const img = this._image;
    const aspect = img.width / img.height;

    // Sized off canvas height — a tall presence in the room, not a small
    // icon — capped so it never clips off a narrow viewport's width.
    let dispH = this.height * CONFIG.IMAGE_SIZE_RATIO;
    let dispW = dispH * aspect;
    const maxW = this.width * 0.92;
    if (dispW > maxW) {
      dispW = maxW;
      dispH = dispW / aspect;
    }

    const originX = this.width / 2 - dispW / 2;
    const originY = this.height / 2 - dispH / 2;

    // Sample at a capped native-ish resolution for crisp linework without
    // scanning a huge pixel grid every resize.
    const sampleW = Math.min(img.naturalWidth || img.width, 700);
    const sampleH = Math.round(sampleW / aspect);

    const offscreen = document.createElement('canvas');
    offscreen.width = sampleW;
    offscreen.height = sampleH;
    const ctx = offscreen.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, sampleW, sampleH);
    const { data } = ctx.getImageData(0, 0, sampleW, sampleH);

    const rand = makeSeededRandom(CONFIG.IMAGE_SAMPLE_SEED);
    const step = CONFIG.IMAGE_SAMPLE_STEP;
    const keepProb = CONFIG.IMAGE_SAMPLE_KEEP_PROB;
    const scaleX = dispW / sampleW;
    const scaleY = dispH / sampleH;
    const points = [];

    for (let y = 0; y < sampleH; y += step) {
      for (let x = 0; x < sampleW; x += step) {
        const o = (y * sampleW + x) * 4;
        const lum = data[o] * 0.299 + data[o + 1] * 0.587 + data[o + 2] * 0.114;
        if (lum > CONFIG.IMAGE_DARK_THRESHOLD) continue; // only the ink/linework, not the page
        if (rand() > keepProb) continue;

        const scatterAngle = rand() * Math.PI * 2;
        const scatterDist = CONFIG.IMAGE_SCATTER_RADIUS * (0.4 + rand() * 0.6);
        points.push({
          tx: originX + x * scaleX,
          ty: originY + y * scaleY,
          scatterX: Math.cos(scatterAngle) * scatterDist,
          scatterY: Math.sin(scatterAngle) * scatterDist,
          jitterSeed: rand() * 1000,
          radius: CONFIG.IMAGE_MARK_RADIUS_MIN + rand() * (CONFIG.IMAGE_MARK_RADIUS_MAX - CONFIG.IMAGE_MARK_RADIUS_MIN),
        });
      }
    }
    this.points = points;
  }

  getSamplePoints() {
    return this.points;
  }
}
