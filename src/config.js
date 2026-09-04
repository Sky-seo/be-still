// -----------------------------------------------------------------------
// CONFIG — every tunable that shapes pacing, atmosphere, and interaction.
// Edit these to art-direct the installation without touching core logic.
// -----------------------------------------------------------------------

export const CONFIG = {
  // ---- Camera / tracking -------------------------------------------------
  TRACKING_WIDTH: 1080,          // camera frames are downscaled to this for pose detection
  TRACKING_HEIGHT: 720,
  TARGET_TRACKING_FPS: 20,      // pose model runs at this cadence, independent of render FPS
  MAX_PEOPLE: 6,
  MIN_POSE_SCORE: 0.25,         // per-keypoint confidence floor
  MIN_TORSO_KEYPOINTS: 2,       // need at least this many upper-body points to trust a person's centroid
  CAMERA_FLIP_HORIZONTAL: false, // keep model input stable; screen mirroring is applied after tracking
  CAMERA_ROTATION_DEG: 90,      // rotate camera input before tracking/view; -90 = left, 90 = right
  SCREEN_FLIP_HORIZONTAL: false, // flip final silhouette/mask coordinates to match the projected screen

  // ---- Person tracking / identity ----------------------------------------
  MATCH_MAX_DISTANCE: 0.34,     // normalized (0-1 of frame diagonal) max jump to match same person across frames
  PERSON_GRACE_PERIOD: 2.0,     // seconds a person is kept "alive" after detection drops (avoids flicker resets)
  POSITION_SMOOTHING: 0.14,     // EMA factor for centroid smoothing (higher = snappier, lower = smoother)
  KEYPOINT_SMOOTHING: 0.16,     // EMA factor for shoulder/arm points (lower = steadier mask)

  // ---- Stillness detection ------------------------------------------------
  MOTION_THRESHOLD: 0.028,      // normalized speed (frame-diagonals/sec) below which a person counts as "still"
  MOVEMENT_PENALTY_SCALE: 6.0,  // how sharply exceeding the threshold drains accumulated stillness
  STILLNESS_START: 1.0,         // seconds before ANY visible reaction begins
  QUIET_START: 2.0,             // seconds: local field begins slowing
  QUIET_FULL: 4.0,              // seconds: strokes routing around / density dropping is fully in effect
  DARK_START: 4.0,              // seconds: quiet region starts turning dark
  DARK_FULL: 7.0,               // seconds: darkness fully settled
  REVEAL_START: 3.0,            // seconds: image marks begin after holding still
  REVEAL_FULL: 5.0,             // seconds: full local reveal of that area of the image
  IMAGE_HIDE_SPEED_THRESHOLD: 0.2, // hide image marks immediately above this tracked speed
  IMAGE_TRIGGER_SPEED_THRESHOLD: 0.04, // image reveal timer only runs at or below this speed
  IMAGE_RECOVERY_WAIT: 3.0,     // seconds to wait again after speed crosses the hide threshold
  IMAGE_REVEAL_GATHER_DURATION: 1.5, // seconds for image particles to fade/gather after the wait
  IMAGE_GLOBAL_REVEAL_DURATION: 4.5, // seconds for the full center-out Jesus image reveal
  IMAGE_REVEAL_RISE_RATE: 1.35, // per second, fade-in/gathering speed for image particles
  // (compressed ~3x from the original pacing brief for fast iteration while
  // tuning legibility/visuals — stretch these back out for the final
  // installation pass; see README "Pacing" note.)

  // ---- Influence field -----------------------------------------------------
  INFLUENCE_RADIUS: 230,        // px (in render space) radius of a single person's field of influence
  INFLUENCE_SOFTNESS: 0.6,      // 0-1, how soft/gradient the falloff at the edge of influence is
  BODY_MASK_ENABLED: true,       // use tracked body shape instead of a circular influence field
  BODY_MASK_LINE_WIDTH: 42,      // px thickness of limbs/spine in the body reveal mask
  BODY_MASK_ARM_LINE_WIDTH: 78,  // px thickness for arms in the body reveal mask
  BODY_MASK_JOINT_RADIUS: 22,    // px soft caps around tracked joints
  BODY_MASK_FACE_RADIUS: 48,     // px single circle built from the face keypoints
  BODY_MASK_TORSO_PADDING: 18,   // legacy tuning value
  BODY_SILHOUETTE_ALPHA: 0.82,   // opacity of the explicit black WebGL silhouette overlay
  BODY_SILHOUETTE_EDGE: 0.18,    // 0-1 mask edge threshold; higher = harder/clearer silhouette

  // ---- Quiet field grid (low-res simulation grid for perf) -----------------
  QUIET_GRID_COLS: 96,
  QUIET_GRID_ROWS: 54,
  QUIET_DECAY_RATE: 0.55,       // per second, how fast quietness drains from a cell with no influence
  QUIET_RISE_RATE: 0.9,         // per second, how fast quietness rises toward a person's stillness value
  QUIET_DIFFUSION: 0.06,        // 0-1, blends each cell toward neighbor average per step (lower = clearer silhouette)

  // ---- Brush field -----------------------------------------------------------
  BRUSH_COUNT: 400,
  BRUSH_MIN_LENGTH: 10,
  BRUSH_MAX_LENGTH: 34,
  BRUSH_MIN_WIDTH: 1.4,
  BRUSH_MAX_WIDTH: 5.2,
  BRUSH_BASE_SPEED: 26,         // px/sec baseline drift speed at full turbulence
  BRUSH_MIN_SPEED_FACTOR: 0.05, // speed multiplier floor when fully quiet (never fully frozen)
  TURBULENCE_STRENGTH: 2,     // curl-noise field strength
  TURBULENCE_SCALE: 0.0056,     // spatial frequency of the flow field
  TURBULENCE_TIME_SCALE: 0.06,  // how fast the flow field itself evolves
  BRUSH_LIFETIME_MIN: 2.4,      // seconds before a stroke fades and respawns
  BRUSH_LIFETIME_MAX: 5.5,
  BRUSH_RESPAWN_JITTER: true,
  BRUSH_POINT_SIZE_MULT: 6.5,   // visual point size multiplier for drifting particles
  BRUSH_GLOW_SIZE_MULT: 4.5,    // extra multiplier for the separate soft glow layer
  BRUSH_GLOW_ALPHA: 0.42,       // alpha multiplier for the separate soft glow layer
  BRUSH_GLOW_WAVE_STRENGTH: 0.55, // 0-1, how strongly idle particles breathe in waves
  BRUSH_GLOW_WAVE_SCALE: 0.018,   // spatial frequency of the center-out ripple
  BRUSH_GLOW_WAVE_SPEED: 2.2,     // ripple expansion speed
  BRUSH_GLOW_WAVE_CLUMP: 0.78,    // 0-1, higher = sharper ripple rings
  BRUSH_RIPPLE_MOTION_STRENGTH: 18, // px/sec outward ripple motion in the idle field
  BRUSH_RIPPLE_DIRECTION_BLEND: 0.82, // 0-1, how strongly idle motion follows ripple patterns
  BRUSH_IDLE_PATTERN_DURATION: 10, // seconds before rotating to the next idle movement pattern
  BRUSH_IDLE_PATTERN_TRANSITION: 1.35, // seconds to flow into the next idle pattern
  BRUSH_SHADER_GLOW: 1.8,       // cheap GPU halo strength for drifting particles
  BRUSH_SHADER_CORE: 0.08,      // 0-0.5, smaller = tighter bright core
  BRUSH_SILHOUETTE_INITIAL_ATTRACTION: 0.65, // pull speed before particles first settle into the silhouette
  BRUSH_SILHOUETTE_INITIAL_MAX_PULL: 0.018, // max per-frame lerp during initial arrival
  BRUSH_SILHOUETTE_SLOW_RADIUS: 190, // px distance where incoming particles begin slowing down
  BRUSH_SILHOUETTE_MIN_APPROACH: 0.16, // 0-1, pull multiplier at the target edge
  BRUSH_SILHOUETTE_FOLLOW_ATTRACTION: 5.0, // pull speed after particles have attached to the silhouette
  BRUSH_SILHOUETTE_FOLLOW_MAX_PULL: 0.22, // max per-frame lerp while following body movement
  BRUSH_SILHOUETTE_TARGET_REFRESH: 0.35, // per second, retarget rate while a person is present
  GLOBAL_REVEAL_WIPE_SOFTNESS: 0.18, // 0-1 width of center-out reveal/erase edge
  GLOBAL_REVEAL_ERASE_STRENGTH: 1.0, // how strongly drifting particles disappear during global reveal

  // ---- Trail / persistence rendering ------------------------------------------
  TRAIL_FADE_ALPHA: 0.055,      // per-frame alpha of the fade-to-background rect (lower = longer trails)
  TRAIL_FADE_ALPHA_QUIET: 0.14, // trail fade rate inside fully quiet regions (paint sinks away faster)

  // ---- Color -------------------------------------------------------------
  PALETTE: [
    '#8a3b2e', // burnt sienna
    '#c96f3c', // ochre orange
    '#3c5a72', // muted indigo-teal
    '#274257', // deep blue
    '#9c7b3d', // gold umber
    '#5b2f47', // plum
  ],
  BACKGROUND_COLOR: '#100c10',
  COLOR_DESATURATION: 0.85,     // 0-1, how far toward gray/black a stroke goes at full quietness
  DARKNESS_STRENGTH: 0.92,      // 0-1, how far toward near-black (not pure black) full darkness pushes strokes

  // ---- Image field (persistent hidden layer) ----------------------------------
  IMAGE_SRC: 'christ.png', // served from public/; relative path works at root or under /be-still/
  IMAGE_SAMPLE_SEED: 1337,        // fixed seed: point scatter never changes between sessions
  IMAGE_SIZE_RATIO: 0.85,         // displayed height, relative to canvas height
  IMAGE_DARK_THRESHOLD: 130,      // 0-255 luminance — below this counts as "ink", above is the page
  IMAGE_SAMPLE_STEP: 2,           // px spacing when sampling the source image — denser than the earlier text-only pass; a full portrait's fine linework (hair, crown of thorns) needs more points to read at all
  IMAGE_SAMPLE_KEEP_PROB: 0.75,   // fraction of sampled points kept -> stippled, painterly density
  IMAGE_SCATTER_RADIUS: 16,       // px a mark wanders from its true image position when unrevealed — kept tight so mid-transition still reads
  IMAGE_MARK_RADIUS_MIN: 0.1,     // small dabs — smaller than before so dense areas don't merge into blobs and lose the linework
  IMAGE_MARK_RADIUS_MAX: 0.5,
  IMAGE_MARK_ALPHA: 1.0,          // max opacity per mark at full settle — fully opaque so revealed marks read crisp against the dark field
  IMAGE_MARK_POINT_SIZE_MULT: 8.0, // visual point size multiplier for revealed image particles
  IMAGE_MARK_GLOW_SIZE_MULT: 5.0,  // extra multiplier for the separate soft glow layer
  IMAGE_MARK_GLOW_ALPHA: 0.55,     // alpha multiplier for the separate soft glow layer
  IMAGE_MARK_SHADER_GLOW: 1.25,   // cheap GPU halo strength for revealed image particles
  IMAGE_MARK_SHADER_CORE: 0.12,   // 0-0.5, smaller = tighter bright core
  IMAGE_SPARKLE_ENABLED: true,
  IMAGE_SPARKLE_INTERVAL: 3.0,     // seconds between single star-like sparkles
  IMAGE_SPARKLE_DURATION: 0.12,    // seconds each selected sparkle stays visible
  IMAGE_SPARKLE_SIZE_BOOST: 1.45,  // point size multiplier at sparkle peak
  IMAGE_SPARKLE_ALPHA_BOOST: 1.35, // alpha multiplier at sparkle peak
  HIDDEN_MARK_COLOR: '#f5efe0',   // pale off-white, brightened slightly for more contrast — still not pure digital white

  // ---- Debug ---------------------------------------------------------------
  DEBUG_DEFAULT: false,

  // ---- Misc ------------------------------------------------------------------
  MULTI_PERSON_MERGE: true,     // overlapping quiet fields sum naturally (no special casing needed downstream)
};
