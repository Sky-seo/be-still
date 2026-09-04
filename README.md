# be still

An interactive media art installation: a GPU-rendered turbulent glow field
that reacts to human presence. Movement feeds the turbulence; sustained
stillness gradually slows and darkens the field around a person, revealing
a hidden portrait image that was there underneath it the whole time.

## Run it

```bash
npm install
npm run dev
```

Open the printed `localhost` URL in Chrome and allow camera access. `f`
toggles fullscreen (for kiosk display), `d` toggles the debug overlay.

## Tuning

Every pacing/visual constant lives in [src/config.js](src/config.js) —
stillness thresholds, influence radius, brush count, colors, trail
persistence, darkness strength, image-reveal sampling, etc. Edit and reload;
no other file should need to change for art-direction passes.

## Testing without a camera or a person

Append `?simulate=<mode>` to the URL to drive the tracking pipeline with a
synthetic presence instead of the camera — useful for tuning stillness
pacing alone in a room:

- `?simulate=still` — one person, stationary at center
- `?simulate=move` — one person wandering (should stay turbulent)
- `?simulate=multi` — two people, one still, one wandering (tests independence)
- `?simulate=approach` — stands still ~26s, then walks away (tests dissolve)

In dev builds, `window.__beStill` also exposes the live `quietField`,
`imageField`, `brushField`, `glowRenderer`, and tracked `people` in the
browser console for direct inspection while tuning.

## Architecture

```
src/
  config.js                   all tunables
  main.js                     orchestration + render loop only
  camera/CameraInput.js       getUserMedia, reconnect, tracking-res canvas
  tracking/PoseTracker.js     MoveNet MultiPose wrapper (raw poses only)
  tracking/PersonTracker.js   cross-frame identity, smoothing, stillness math
  field/QuietField.js         low-res grid: calm/quiet/dark/reveal layers
  field/ImageField.js         persistent hidden image layer (rasterized-to-points)
  brush/Noise2D.js            curl-noise flow field
  brush/BrushField.js         particle simulation + per-particle color/size, image reveal
  render/GlowRenderer.js      WebGL2: additive point-sprite glow, framebuffer trail persistence
  debug/DebugOverlay.js       all diagnostic drawing (off in exhibition mode)
  debug/SimulatedPresence.js  synthetic poses for camera-less tuning
  utils/math.js               clamp/lerp/smoothstep/seeded RNG
public/
  christ.jpg                  the hidden image (swap via CONFIG.IMAGE_SRC)
```

Conceptual rule encoded in the architecture: `ImageField` loads the image once
and samples its dark/ink pixels to points — that point cloud is a fixed truth
that exists independent of any person, from frame one. Stillness never
creates it; `QuietField`'s reveal layer only raises a per-cell 0–1 value that
controls how settled those points currently are. `BrushField.drawImageReveal()`
reads both: each point wanders in a scattered orbit around its true position
when reveal is low (indistinguishable from the surrounding noise), and
converges onto the true position as reveal rises. Movement reverses this
continuously — never a fade, always a coming-apart, because the image was
never actually created by the interaction, only obscured or exposed. Because
the image is large relative to one person's reveal radius, standing in
different places uncovers different parts of it, and people standing near
each other naturally merge into revealing a larger contiguous region — both
are emergent from `QuietField` being spatial, not special-cased anywhere.

**Rendering split**: `BrushField` only simulates (particle position, aging,
steering by curl-noise + nearby stillness) and computes each particle's
color/size — same "never a flat mask, every particle self-modulates toward
the QuietField it samples" rule as before. `GlowRenderer` only draws what
it's handed: particles become additive point sprites (soft radial falloff),
accumulated into a ping-pong framebuffer pair that fades toward background
each frame — the GPU equivalent of the old Canvas2D fade-rect trail, except
overlapping particles now brighten and merge into a connected glow rather
than laying flat alpha side by side. The quiet-region extra-fade effect
(paint sinking away faster where things have gone still) is wired in via a
small texture upload of `QuietField.buildFadeMaskCanvas()` sampled directly
in the fade shader — same "soft blurred grid, never a geometric mask"
technique as before, just GPU-side now. The image reveal stays on a separate
transparent Canvas2D layer on top of the glow canvas — legibility of the
image was hard-won through several density/radius tuning passes, so it's
kept isolated from the (heavier, ongoing) glow-rendering work.

## Known constraint worth tracking

`REVEAL_INFLUENCE_RADIUS` (config.js) sets how large an area around a still
person can fully settle. Since the whole image is one continuous point
cloud (not several small independent phrases like the earlier text-based
version), there's no risk of two separate things bleeding into each other —
but a very small radius will make any single vantage point only ever reveal
a small fragment of the portrait, which may or may not be the intended
pacing; worth tuning against the actual image size on the real screen.

## Not yet implemented (later milestones)

- Multi-camera / production kiosk hardening
- Further density/legibility tuning of the image reveal at real viewing
  distance and against the specific installation screen size
- The quiet-region extra-fade texture is grid-resolution (96×54) — fine at
  current scale, but worth revisiting if the glow layer's particle count or
  screen resolution grows substantially
