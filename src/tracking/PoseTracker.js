// Thin wrapper around TensorFlow.js MoveNet MultiPose.
// Responsible only for: model lifecycle + raw pose output per frame.
// Knows nothing about stillness, identity, or art direction.

import * as tf from '@tensorflow/tfjs';
import * as poseDetection from '@tensorflow-models/pose-detection';
import { CONFIG } from '../config.js';

export class PoseTracker {
  constructor() {
    this.detector = null;
    this.ready = false;
  }

  async init() {
    await tf.setBackend('webgl');
    await tf.ready();

    this.detector = await poseDetection.createDetector(
      poseDetection.SupportedModels.MoveNet,
      {
        modelType: poseDetection.movenet.modelType.MULTIPOSE_LIGHTNING,
        enableTracking: false, // we run our own identity tracker downstream
      }
    );
    this.ready = true;
  }

  // Returns raw poses: [{ keypoints: [{x,y,score,name}], score }]
  // Coordinates are in the pixel space of `frame` (the tracking canvas).
  async estimate(frame) {
    if (!this.ready || !frame) return [];
    const poses = await this.detector.estimatePoses(frame, { flipHorizontal: CONFIG.CAMERA_FLIP_HORIZONTAL });
    return poses
      .filter((p) => (p.score ?? 0) >= 0.15)
      .slice(0, CONFIG.MAX_PEOPLE);
  }

  dispose() {
    if (this.detector) this.detector.dispose();
  }
}
