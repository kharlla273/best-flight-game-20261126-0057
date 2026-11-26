// The valley: height field, river, roads and the runway clearing. Everything here is a pure
// function of world coordinates, so the renderer, the flight model and the screenshots all agree
// about where the ground is.
import { RUNWAY, RUNWAY_ELEV, WATER_LEVEL, WORLD_SEED } from './config.js';
import { fbm, noise2 } from './random.js';

const SEED = WORLD_SEED;

/** Distance from a point to the runway centreline segment, in metres. */
export function distanceToRunway(x, z) {
  const half = RUNWAY.length / 2;
  const dx = Math.max(Math.abs(x - RUNWAY.x) - half, 0);
  const dz = Math.abs(z - RUNWAY.z);
  return Math.hypot(dx, dz);
}

/** The river winds north-south through the valley, west of the runway. */
export function riverDistance(x, z) {
  const centre = -620 + 130 * Math.sin(z / 700) + 60 * Math.sin(z / 260 + 1.7);
  return Math.abs(x - centre);
}

/**
 * Ground height in metres at (x, z). Rolling hills grow into ridges away from the valley floor;
 * the runway clearing and the riverbed are carved flat into it.
 */
export function groundHeight(x, z) {
  // Valley floor: gentle hills.
  let h = RUNWAY_ELEV + 26 * fbm(x / 420, z / 420, SEED, 3);
  // Ridges rise with distance from the valley centre line (z = 0 corridor, x in [-400, 1600]).
  const ridge = Math.max(Math.abs(z) - 700, 0) / 900 + Math.max(-x - 500, 0) / 1200 + Math.max(x - 1900, 0) / 900;
  const ridgeFactor = Math.min(ridge, 1.6);
  h += ridgeFactor * (150 + 190 * Math.max(0, fbm(x / 900 + 7, z / 900, SEED + 31, 3)));
  // Riverbed: a shallow channel along the river line.
  const rd = riverDistance(x, z);
  if (rd < 90) {
    const t = 1 - rd / 90;
    h -= t * t * 34;
  }
  // Runway clearing: blend to the flat runway elevation near the strip.
  const dr = distanceToRunway(x, z);
  if (dr < 320) {
    const t = Math.min(1, (320 - dr) / 180);
    const blend = t * t * (3 - 2 * t);
    h = h * (1 - blend) + RUNWAY_ELEV * blend;
  }
  return h;
}

/** True when the point is over water (the river channel below the water line). */
export function isWater(x, z) {
  return riverDistance(x, z) < 46 && groundHeight(x, z) < WATER_LEVEL + 4;
}

/** True when (x, z) is on the paved runway strip. */
export function onRunway(x, z) {
  const halfL = RUNWAY.length / 2;
  const halfW = RUNWAY.width / 2;
  return Math.abs(x - RUNWAY.x) <= halfL && Math.abs(z - RUNWAY.z) <= halfW;
}

/** Slope magnitude, sampled for shading: how steep the ground is at (x, z). */
export function groundSlope(x, z) {
  const e = 12;
  const dx = (groundHeight(x + e, z) - groundHeight(x - e, z)) / (2 * e);
  const dz = (groundHeight(x, z + e) - groundHeight(x, z - e)) / (2 * e);
  return Math.hypot(dx, dz);
}

/** Field patch id for colouring farmland: -1 means wild grass, otherwise a field tone. */
export function fieldPatch(x, z) {
  const n = noise2(x / 260 + 3.1, z / 260 + 8.4, SEED + 77);
  if (n < -0.25) return 0; // gold wheat
  if (n > 0.45) return 1; // dark green crop
  return -1;
}

// A small road network: the valley road runs along the river, a spur reaches the runway.
export const ROADS = [
  { points: [[-700, -1400], [-560, -700], [-640, 0], [-520, 700], [-660, 1400]], width: 10 },
  { points: [[-620, 40], [-320, 20], [-40, 0]], width: 8 },
  { points: [[-560, -700], [-100, -640], [300, -560]], width: 8 },
];

// The hamlet of Alderwick: a dozen rooftops east of the river, north of the strip.
export const TOWN = (() => {
  const houses = [];
  let gx = -420;
  let gz = -260;
  const cells = [
    [0, 0], [46, 8], [92, -6], [20, 52], [70, 60], [130, 44],
    [-38, 54], [8, 108], [60, 116], [118, 104], [-52, 108], [150, 96],
  ];
  for (const [ox, oz] of cells) {
    const x = gx + ox;
    const z = gz + oz;
    houses.push({ x, z, w: 14 + ((ox * 7 + oz * 3) % 8), d: 12 + ((ox * 5 + oz) % 7), h: 7 + ((ox + oz) % 5) });
  }
  return houses;
})();
