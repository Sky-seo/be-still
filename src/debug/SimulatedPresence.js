// Dev-only utility: synthesizes fake pose detections so the full
// tracking -> stillness -> quiet field -> reveal pipeline can be tuned
// and verified without a camera or a person physically present.
//
// Activated via URL query param, e.g. ?simulate=still or ?simulate=multi.
// Has no effect and adds no cost unless that param is present.

import { CONFIG } from '../config.js';

const UPPER_BODY_POINTS = [
  ['left_shoulder', -1, -0.2],
  ['right_shoulder', 1, -0.2],
  ['left_elbow', -1.55, 0.55],
  ['right_elbow', 1.55, 0.55],
  ['left_wrist', -2.05, 1.2],
  ['right_wrist', 2.05, 1.2],
];

function upperBodyPose(cx, cy, spread = 18) {
  return {
    score: 1,
    keypoints: UPPER_BODY_POINTS.map(([name, ox, oy]) => ({
      name,
      score: 1,
      x: cx + ox * spread,
      y: cy + oy * spread,
    })),
  };
}

export function createSimulatedPresence(mode, trackingWidth, trackingHeight) {
  if (!mode) return null;
  const t0 = performance.now() / 1000;

  if (mode === 'still') {
    const cx = trackingWidth * 0.5;
    const cy = trackingHeight * 0.5;
    return () => [upperBodyPose(cx, cy)];
  }

  if (mode === 'move') {
    return () => {
      const t = performance.now() / 1000 - t0;
      const cx = trackingWidth * 0.5 + Math.sin(t * 1.3) * trackingWidth * 0.3;
      const cy = trackingHeight * 0.5 + Math.cos(t * 0.9) * trackingHeight * 0.2;
      return [upperBodyPose(cx, cy)];
    };
  }

  if (mode === 'multi') {
    return () => {
      const t = performance.now() / 1000 - t0;
      // person A: still after 1s settle. person B: wanders throughout.
      const ax = trackingWidth * 0.32 + Math.sin(t * 0.4) * 3;
      const ay = trackingHeight * 0.5 + Math.cos(t * 0.4) * 3;
      const bx = trackingWidth * 0.68 + Math.sin(t * 1.1) * trackingWidth * 0.15;
      const by = trackingHeight * 0.5 + Math.cos(t * 0.7) * trackingHeight * 0.15;
      return [upperBodyPose(ax, ay), upperBodyPose(bx, by)];
    };
  }

  if (mode === 'approach') {
    // still, then walks away (tests reveal -> dissolve back into noise)
    return () => {
      const t = performance.now() / 1000 - t0;
      const cx = trackingWidth * 0.5;
      let cy = trackingHeight * 0.5;
      if (t > 26) cy += Math.min((t - 26) * trackingHeight * 0.25, trackingHeight);
      return [upperBodyPose(cx, cy)];
    };
  }

  return null;
}
