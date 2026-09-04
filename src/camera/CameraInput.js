// Camera input: acquires the webcam stream, exposes a low-resolution
// tracking canvas (separate from render resolution), and handles
// graceful reconnect for long-duration installation use.

import { CONFIG } from '../config.js';

export class CameraInput {
  constructor() {
    this.video = document.createElement('video');
    this.video.autoplay = true;
    this.video.muted = true;
    this.video.playsInline = true;

    this.trackingCanvas = document.createElement('canvas');
    this.trackingCanvas.width = CONFIG.TRACKING_WIDTH;
    this.trackingCanvas.height = CONFIG.TRACKING_HEIGHT;
    this.trackingCtx = this.trackingCanvas.getContext('2d', { willReadFrequently: true });

    this.stream = null;
    this.ready = false;
    this._reconnectTimer = null;
    this._onStatusChange = null;
  }

  onStatusChange(cb) {
    this._onStatusChange = cb;
  }

  _setReady(ready) {
    this.ready = ready;
    if (this._onStatusChange) this._onStatusChange(ready);
  }

  async start() {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          facingMode: 'user',
        },
        audio: false,
      });
      this.video.srcObject = this.stream;
      await this.video.play();

      const track = this.stream.getVideoTracks()[0];
      if (track) {
        track.addEventListener('ended', () => this._handleDisconnect());
      }

      this._setReady(true);
      if (this._reconnectTimer) {
        clearTimeout(this._reconnectTimer);
        this._reconnectTimer = null;
      }
    } catch (err) {
      console.warn('[CameraInput] getUserMedia failed, retrying in 3s:', err.message);
      this._setReady(false);
      this._scheduleReconnect();
    }
  }

  _handleDisconnect() {
    console.warn('[CameraInput] camera track ended, attempting reconnect');
    this._setReady(false);
    this._scheduleReconnect();
  }

  _scheduleReconnect() {
    if (this._reconnectTimer) return;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this.start();
    }, 3000);
  }

  // Draws the current video frame into the low-res tracking canvas
  // and returns it for the pose model to consume.
  getTrackingFrame() {
    if (!this.ready || this.video.readyState < 2) return null;
    this.trackingCtx.clearRect(0, 0, this.trackingCanvas.width, this.trackingCanvas.height);
    drawRotatedVideoCover(
      this.trackingCtx,
      this.video,
      this.trackingCanvas.width,
      this.trackingCanvas.height,
      CONFIG.CAMERA_ROTATION_DEG
    );
    return this.trackingCanvas;
  }
}

export function drawRotatedVideoCover(ctx, video, width, height, rotationDeg = 0) {
  const vw = video.videoWidth || video.width;
  const vh = video.videoHeight || video.height;
  if (!vw || !vh) return;

  const normalizedRotation = ((rotationDeg % 360) + 360) % 360;
  const swapsAxes = normalizedRotation === 90 || normalizedRotation === 270;
  const sourceW = swapsAxes ? vh : vw;
  const sourceH = swapsAxes ? vw : vh;
  const scaleX = width / sourceW;
  const scaleY = height / sourceH;

  ctx.save();
  ctx.translate(width / 2, height / 2);
  ctx.rotate((rotationDeg * Math.PI) / 180);
  ctx.scale(swapsAxes ? scaleY : scaleX, swapsAxes ? scaleX : scaleY);
  ctx.drawImage(video, -vw / 2, -vh / 2, vw, vh);
  ctx.restore();
}
