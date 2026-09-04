// Orchestration only: wires the modules together and runs the render loop.
// No interaction logic or rendering detail lives here.

import { CONFIG } from './config.js';
import { CameraInput } from './camera/CameraInput.js';
import { PoseTracker } from './tracking/PoseTracker.js';
import { PersonTracker } from './tracking/PersonTracker.js';
import { QuietField } from './field/QuietField.js';
import { ImageField } from './field/ImageField.js';
import { WebGLBrushField } from './brush/WebGLBrushField.js';
import { DebugOverlay } from './debug/DebugOverlay.js';
import { createSimulatedPresence } from './debug/SimulatedPresence.js';
import { clamp } from './utils/math.js';

const VERSE_FEED_URL = 'verses.json';
const BIBLE_BOOKS_EN = [
  'Genesis', 'Exodus', 'Leviticus', 'Numbers', 'Deuteronomy', 'Joshua', 'Judges', 'Ruth',
  '1 Samuel', '2 Samuel', '1 Kings', '2 Kings', '1 Chronicles', '2 Chronicles', 'Ezra',
  'Nehemiah', 'Esther', 'Job', 'Psalms', 'Proverbs', 'Ecclesiastes', 'Song of Songs',
  'Isaiah', 'Jeremiah', 'Lamentations', 'Ezekiel', 'Daniel', 'Hosea', 'Joel', 'Amos',
  'Obadiah', 'Jonah', 'Micah', 'Nahum', 'Habakkuk', 'Zephaniah', 'Haggai', 'Zechariah',
  'Malachi', 'Matthew', 'Mark', 'Luke', 'John', 'Acts', 'Romans', '1 Corinthians',
  '2 Corinthians', 'Galatians', 'Ephesians', 'Philippians', 'Colossians',
  '1 Thessalonians', '2 Thessalonians', '1 Timothy', '2 Timothy', 'Titus', 'Philemon',
  'Hebrews', 'James', '1 Peter', '2 Peter', '1 John', '2 John', '3 John', 'Jude',
  'Revelation',
];

const simulateMode = new URLSearchParams(location.search).get('simulate');
const simulatedPoses = createSimulatedPresence(simulateMode, CONFIG.TRACKING_WIDTH, CONFIG.TRACKING_HEIGHT);
if (simulatedPoses) console.info(`[main] simulated presence active: "${simulateMode}" (no camera required)`);

const paintCanvas = document.getElementById('paint-canvas');
const cameraCanvas = document.getElementById('camera-canvas');
const debugCanvas = document.getElementById('debug-canvas');
const centerText = document.getElementById('center-text');
const verseText = document.getElementById('verse-text');
const verseKo = document.getElementById('verse-ko');
const verseEn = document.getElementById('verse-en');
const verseRef = document.getElementById('verse-ref');
const cameraViewCtx = cameraCanvas.getContext('2d');

let width = window.innerWidth;
let height = window.innerHeight;

function resizeCanvases() {
  width = window.innerWidth;
  height = window.innerHeight;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);

  for (const c of [cameraCanvas, debugCanvas]) {
    c.width = width * dpr;
    c.height = height * dpr;
  }
  cameraViewCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  debugCanvas.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);

  if (quietField) quietField.resize(width, height);
  if (imageField) imageField.resize(width, height);
  if (brushField) brushField.resize(width, height);
}

const camera = new CameraInput();
const poseTracker = new PoseTracker();
const personTracker = new PersonTracker();
let quietField = new QuietField(width, height);
let imageField = new ImageField(width, height);
let brushField = new WebGLBrushField(paintCanvas, width, height);
const debugOverlay = new DebugOverlay(debugCanvas);
debugOverlay.enabled = CONFIG.DEBUG_DEFAULT;
let cameraViewEnabled = false;

window.addEventListener('resize', resizeCanvases);
window.addEventListener('keydown', (e) => {
  if (e.key === 'd' || e.key === 'D') debugOverlay.toggle();
  if (e.key === 's' || e.key === 'S') {
    cameraViewEnabled = !cameraViewEnabled;
    cameraCanvas.classList.toggle('is-visible', cameraViewEnabled);
  }
  if (e.key === 'f' || e.key === 'F') {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen?.();
    else document.exitFullscreen?.();
  }
});

resizeCanvases();

let people = []; // latest tracked people, render-space

// --- Tracking loop: runs independently of render FPS, at a lower cadence. ---
async function trackingLoop() {
  const interval = 1000 / CONFIG.TARGET_TRACKING_FPS;
  let lastTrackTime = performance.now();

  while (true) {
    const frameStart = performance.now();
    const dt = clamp((frameStart - lastTrackTime) / 1000, 0, 0.5);
    lastTrackTime = frameStart;

    if (simulatedPoses) {
      people = personTracker.update(
        simulatedPoses(),
        CONFIG.TRACKING_WIDTH,
        CONFIG.TRACKING_HEIGHT,
        width,
        height,
        dt
      );
    } else {
      const frame = camera.getTrackingFrame();
      if (frame) {
        try {
          const poses = await poseTracker.estimate(frame);
          people = personTracker.update(
            poses,
            CONFIG.TRACKING_WIDTH,
            CONFIG.TRACKING_HEIGHT,
            width,
            height,
            dt
          );
        } catch (err) {
          console.warn('[trackingLoop] pose estimation error:', err);
        }
      } else {
        // camera not ready yet — decay tracked people via grace period naturally
        people = personTracker.update([], CONFIG.TRACKING_WIDTH, CONFIG.TRACKING_HEIGHT, width, height, dt);
      }
    }

    const elapsed = performance.now() - frameStart;
    const wait = Math.max(0, interval - elapsed);
    await new Promise((r) => setTimeout(r, wait));
  }
}

// --- Render loop: runs at display refresh rate. ---
let lastRenderTime = performance.now();
let fps = 60;
let centerTextHidden = false;
let verseVisible = false;
let lastVerseIndex = -1;
let comfortVerses = [];

function updateCenterText() {
  if (!centerText) return;

  const shouldHide = centerTextHidden
    ? quietField.globalReveal > 0.02
    : quietField.globalReveal > 0.08;

  if (shouldHide === centerTextHidden) return;
  centerTextHidden = shouldHide;
  centerText.classList.toggle('is-fading', centerTextHidden);
}

function pickVerse() {
  if (!comfortVerses.length) return null;
  if (comfortVerses.length === 1) return comfortVerses[0];
  let index = Math.floor(Math.random() * comfortVerses.length);
  if (index === lastVerseIndex) index = (index + 1) % comfortVerses.length;
  lastVerseIndex = index;
  return comfortVerses[index];
}

function makeEnglishReference(item) {
  if (item.reference_en || item.ref_en) return String(item.reference_en ?? item.ref_en);
  const book = BIBLE_BOOKS_EN[item.book_no - 1];
  const chapter = Number(item.chapter);
  const start = Number(item.verse_start);
  const end = Number(item.verse_end);
  if (!book || !chapter || !start) return String(item.ref ?? item.reference_short ?? item.reference ?? '');
  const verseRange = end && end !== start ? `${start}-${end}` : `${start}`;
  return `${book} ${chapter}:${verseRange}`;
}

async function loadVerseFeed() {
  try {
    const res = await fetch(VERSE_FEED_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const rows = Array.isArray(data) ? data : data.verses;
    if (!Array.isArray(rows)) throw new Error('Expected an array or { "verses": [...] }');
    comfortVerses = rows
      .map((item) => ({
        ref: makeEnglishReference(item),
        ko: String(item.ko ?? item.korean ?? item.text_ko ?? ''),
        en: String(item.en ?? item.english ?? item.text_en ?? ''),
      }))
      .filter((item) => item.ko && item.en);
    console.info(`[main] loaded ${comfortVerses.length} verse feed items`);
  } catch (err) {
    comfortVerses = [];
    console.warn(`[main] could not load ${VERSE_FEED_URL}:`, err);
  }
}

function updateVerseText() {
  if (!verseText || !verseKo || !verseEn || !verseRef) return;

  const shouldShow = verseVisible
    ? quietField.globalReveal > 0.015
    : quietField.globalReveal > 0.06;

  if (shouldShow && !verseVisible) {
    const verse = pickVerse();
    if (verse) {
      verseKo.textContent = verse.ko;
      verseEn.textContent = verse.en;
      verseRef.textContent = verse.ref;
    }
  }

  if (shouldShow === verseVisible) return;
  verseVisible = shouldShow;
  verseText.style.setProperty('--verse-fade-ms', verseVisible ? '4400ms' : '1000ms');
  verseText.classList.toggle('is-visible', verseVisible);
}

function drawCameraView() {
  cameraViewCtx.clearRect(0, 0, width, height);
  if (!cameraViewEnabled || !camera.ready || camera.video.readyState < 2) return;

  const source = camera.trackingCanvas;
  if (!source?.width || !source?.height) return;

  cameraViewCtx.save();
  if (CONFIG.SCREEN_FLIP_HORIZONTAL) {
    cameraViewCtx.translate(width, 0);
    cameraViewCtx.scale(-1, 1);
  }
  cameraViewCtx.imageSmoothingEnabled = true;
  cameraViewCtx.drawImage(source, 0, 0, width, height);
  cameraViewCtx.restore();
}

function renderLoop() {
  const now = performance.now();
  const dt = clamp((now - lastRenderTime) / 1000, 0, 0.1);
  lastRenderTime = now;
  fps += ((1 / Math.max(dt, 0.0001)) - fps) * 0.08;

  quietField.update(people, dt);
  updateCenterText();
  updateVerseText();
  brushField.update(dt, people, quietField);
  brushField.render(quietField, imageField);
  drawCameraView();

  debugOverlay.draw({
    people,
    strokeCount: brushField.strokes.length,
    fps,
    influenceRadius: CONFIG.INFLUENCE_RADIUS,
    trackingReady: camera.ready,
  });

  requestAnimationFrame(renderLoop);
}

async function boot() {
  await loadVerseFeed();
  if (!simulatedPoses) {
    camera.onStatusChange((ready) => {
      if (!ready) console.warn('[main] camera not ready — awaiting (re)connect');
    });
    await camera.start();
    await poseTracker.init();
  }
  trackingLoop();
  requestAnimationFrame(renderLoop);
}

boot();

if (import.meta.env.DEV) {
  window.__beStill = { get people() { return people; }, quietField, imageField, brushField };
}
