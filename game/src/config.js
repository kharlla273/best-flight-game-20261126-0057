// Shared tuning constants for Skymark Courier. All distances in metres, speeds in knots,
// angles in radians unless a name says otherwise. One file, one job: numbers only.
export const STEP = 1 / 60;

// World
export const WORLD_SEED = 20261126;
export const RUNWAY_ELEV = 42; // metres above sea level, the valley floor
export const WATER_LEVEL = 6;
export const VIEW_DISTANCE = 1500;
export const GRID_STEP = 40;

// Aircraft limits
export const SPEED_MIN = 38; // knots: below this the wing stops flying
export const SPEED_MAX = 185;
export const SPEED_CRUISE = 120;
export const THROTTLE_MIN = 0;
export const THROTTLE_MAX = 1;
export const PITCH_LIMIT = 0.61; // ~35 degrees
export const ROLL_LIMIT = 1.05; // ~60 degrees
export const ROLL_RATE = 1.9; // rad/s toward the commanded bank
export const PITCH_RATE = 1.1; // rad/s toward the commanded pitch
export const TURN_RATE = 0.55; // heading rad/s at full bank and cruise speed
export const CLIMB_FACTOR = 0.62; // fraction of forward speed turned into climb
export const SINK_RATE = 2.2; // m/s of sink with no lift
export const STALL_SINK = 9.0; // m/s of sink once stalled

// Resources
export const FUEL_MAX = 100;
export const FUEL_BURN_BASE = 0.055; // per second at idle
export const FUEL_BURN_THROTTLE = 0.16; // per second extra at full throttle
export const HULL_MAX = 100;
export const CRASH_DAMAGE_MIN = 34; // damage from any terrain strike
export const HARD_LANDING_VS = 4.5; // m/s vertical speed that starts hurting on touchdown
export const LANDING_VS_OK = 2.6; // m/s: a gentle touchdown

// Runway (valley floor, heading east, 09/27)
export const RUNWAY = {
  x: 0,
  z: 0,
  heading: 0, // runway centreline points east (+x)
  length: 620,
  width: 34,
};

// Rings: [x, z, altitude, radius] — the ring run threads the valley and climbs the ridge.
export const RINGS = [
  { x: 420, z: -160, y: 150, r: 26 },
  { x: 780, z: -420, y: 210, r: 26 },
  { x: 1150, z: -240, y: 260, r: 24 },
  { x: 1420, z: 120, y: 320, r: 24 },
  { x: 1180, z: 520, y: 280, r: 24 },
  { x: 700, z: 620, y: 190, r: 26 },
];

// Scoring
export const SCORE_RING = 250;
export const SCORE_LANDING_BASE = 400;
export const SCORE_LANDING_SOFT = 600;
export const SCORE_TIME_BONUS = 300;

// Colours (one palette, sky to soil)
export const SKY_TOP = '#2f6fb4';
export const SKY_HORIZON = '#bcd9ee';
export const SUN_COLOR = '#fff3c4';
export const GRASS_LOW = '#5d8a3c';
export const GRASS_HIGH = '#7fae56';
export const FIELD_GOLD = '#c2a55a';
export const ROCK = '#8a7f74';
export const SNOW = '#eef3f6';
export const WATER = '#3f7fb8';
export const ROAD = '#4a4640';
export const RUNWAY_COLOR = '#33373d';
export const HUD_GREEN = '#7dff9a';
export const HUD_AMBER = '#ffc857';
export const HUD_RED = '#ff6b5e';
