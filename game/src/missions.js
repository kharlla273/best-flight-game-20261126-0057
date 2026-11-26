// Missions and scoring: the sortie is one arc — take off, thread the six valley rings in
// order, then bring her home onto the strip. Fuel and hull turn the sortie into decisions;
// the score is rings plus landing quality plus the time left over.
import {
  CRASH_DAMAGE_MIN, HARD_LANDING_VS, HULL_MAX, LANDING_VS_OK, RINGS,
  SCORE_LANDING_BASE, SCORE_LANDING_SOFT, SCORE_RING, SCORE_TIME_BONUS,
} from './config.js';
import { groundHeight, onRunway } from './terrain.js';

export const PHASE_RINGS = 'rings';
export const PHASE_LAND = 'land';
export const PHASE_DONE = 'done';

/** The ring's approach direction: from the previous ring (or the runway) toward this one. */
export function ringNormal(index) {
  const ring = RINGS[index];
  const prev = index === 0 ? { x: -260, z: 0 } : RINGS[index - 1];
  const dx = ring.x - prev.x;
  const dz = ring.z - prev.z;
  const len = Math.hypot(dx, dz) || 1;
  return { x: dx / len, z: dz / len };
}

/** A fresh mission: rings in order, no score yet, the clock running from takeoff. */
export function createMission() {
  return {
    phase: PHASE_RINGS,
    ringIndex: 0,
    score: 0,
    ringsCleared: 0,
    elapsed: 0, // seconds since takeoff
    started: false,
    landingQuality: null, // 'soft' | 'hard' once down
    message: '',
    messageUntil: 0,
    banner: '',
    bannerUntil: 0,
    prevPos: null, // last tick's position, for the ring-plane crossing test
  };
}

export function resetMission(mission) {
  Object.assign(mission, createMission());
}

function say(mission, text, now, seconds) {
  mission.message = text;
  mission.messageUntil = now + seconds;
}

function banner(mission, text, now, seconds) {
  mission.banner = text;
  mission.bannerUntil = now + seconds;
}

/** Distance from the plane to the centre of the next ring, in metres. */
export function ringDistance(plane, mission) {
  const ring = RINGS[mission.ringIndex];
  if (!ring) return 0;
  return Math.hypot(plane.x - ring.x, plane.y - ring.y, plane.z - ring.z);
}

/** Bearing to the next objective, in radians, for the HUD's off-screen arrow. */
export function objectiveBearing(plane, mission) {
  let tx;
  let tz;
  if (mission.phase === PHASE_RINGS) {
    const ring = RINGS[mission.ringIndex];
    tx = ring.x;
    tz = ring.z;
  } else {
    tx = 0;
    tz = 0;
  }
  // World bearing: heading 0 is east (+x), positive heading turns toward south (-z).
  const bearing = Math.atan2(-(tz - plane.z), tx - plane.x);
  let diff = bearing - plane.heading;
  while (diff > Math.PI) diff -= 2 * Math.PI;
  while (diff < -Math.PI) diff += 2 * Math.PI;
  return diff;
}

/**
 * Advance the mission one tick. `events` are the flight model's event strings for this tick;
 * `now` is the mission clock in seconds. Returns sound cues: 'ring' | 'land' | 'crash' | 'alarm'.
 */
export function stepMission(mission, plane, events, now, dt) {
  const cues = [];
  if (plane.airborne && !mission.started) {
    mission.started = true;
    mission.elapsed = 0;
    banner(mission, 'RING RUN — thread all six rings', now, 4);
  }
  if (mission.started && mission.phase !== PHASE_DONE) mission.elapsed += dt;

  // Ring capture: the plane passes within the ring's disc (3D distance to its centre), or
  // flies through the ring's plane inside the disc — a fast fly-through at 180 knots
  // crosses the plane between two ticks, so the crossing is what counts, not the sample.
  if (mission.phase === PHASE_RINGS && plane.airborne) {
    const ring = RINGS[mission.ringIndex];
    const dist = Math.hypot(plane.x - ring.x, plane.y - ring.y, plane.z - ring.z);
    let captured = dist < ring.r;
    if (!captured && mission.prevPos) {
      const n = ringNormal(mission.ringIndex);
      const s0 = (mission.prevPos.x - ring.x) * n.x + (mission.prevPos.z - ring.z) * n.z;
      const s1 = (plane.x - ring.x) * n.x + (plane.z - ring.z) * n.z;
      if ((s0 < 0 && s1 >= 0) || (s0 > 0 && s1 <= 0)) {
        const t = s0 / (s0 - s1);
        const cx = mission.prevPos.x + (plane.x - mission.prevPos.x) * t;
        const cy = mission.prevPos.y + (plane.y - mission.prevPos.y) * t;
        const cz = mission.prevPos.z + (plane.z - mission.prevPos.z) * t;
        if (Math.hypot(cx - ring.x, cy - ring.y, cz - ring.z) < ring.r) captured = true;
      }
    }
    if (captured) {
      mission.score += SCORE_RING;
      mission.ringsCleared += 1;
      mission.ringIndex += 1;
      cues.push('ring');
      if (mission.ringIndex >= RINGS.length) {
        mission.phase = PHASE_LAND;
        banner(mission, 'ALL RINGS CLEAR — bring her home to runway 27', now, 5);
        say(mission, `+${SCORE_RING} — ring ${mission.ringsCleared} of ${RINGS.length}`, now, 3);
      } else {
        say(mission, `+${SCORE_RING} — ring ${mission.ringsCleared} of ${RINGS.length}`, now, 2.5);
      }
    }
  }

  // Landing: the flight model reports the touchdown; quality decides the bonus.
  if (events.includes('touchdown') || events.includes('hard-landing')) {
    const soft = events.includes('touchdown');
    mission.landingQuality = soft ? 'soft' : 'hard';
    const landingScore = SCORE_LANDING_BASE + (soft ? SCORE_LANDING_SOFT : 0);
    mission.score += landingScore;
    if (mission.phase === PHASE_RINGS) {
      // Landed early, rings unfinished: the sortie ends here, rings missed stay missed.
      mission.phase = PHASE_DONE;
      say(mission, `Down early — ${mission.ringsCleared} of ${RINGS.length} rings`, now, 4);
    } else if (mission.phase === PHASE_LAND) {
      const timeBonus = Math.max(0, Math.round(SCORE_TIME_BONUS - mission.elapsed * 0.6));
      mission.score += timeBonus;
      mission.phase = PHASE_DONE;
      banner(mission, soft ? 'SORTIE COMPLETE — a greaser!' : 'SORTIE COMPLETE — down safe', now, 6);
      say(mission, `Landing +${landingScore} · time bonus +${timeBonus}`, now, 5);
    }
    cues.push('land');
  }

  // Hard landing hurts the airframe.
  if (events.includes('hard-landing')) {
    plane.hull = Math.max(0, plane.hull - 18);
    if (plane.hull <= 0) cues.push('crash');
  }

  // Terrain strike: heavy damage; a second one ends the flight.
  if (events.includes('terrain')) {
    plane.hull = Math.max(0, plane.hull - CRASH_DAMAGE_MIN);
    cues.push('crash');
    if (plane.hull <= 0) {
      mission.phase = PHASE_DONE;
      banner(mission, 'AIRFRAME LOST — the valley keeps her', now, 6);
    } else {
      say(mission, 'TERRAIN STRIKE — hull damaged, climb out!', now, 3);
    }
  }

  // Low fuel / low hull warnings, once every few seconds.
  if (plane.fuel < 20 && plane.fuel > 0 && Math.floor(now) % 4 === 0 && Math.floor(now * 60) % 60 === 0) {
    cues.push('alarm');
    say(mission, 'LOW FUEL — head for the strip', now, 2);
  }
  if (plane.hull < 30 && plane.hull > 0 && Math.floor(now) % 5 === 0 && Math.floor(now * 60) % 60 === 0) {
    cues.push('alarm');
  }

  // Out of fuel over the valley: glide it in or walk home.
  if (plane.fuel <= 0 && plane.airborne) {
    say(mission, 'ENGINE OUT — gliding on fumes', now, 2);
  }

  // A plane that rolls to a stop on the strip after the rings are done ends the sortie.
  if (mission.phase === PHASE_LAND && plane.landed && plane.speed < 2) {
    mission.phase = PHASE_DONE;
  }
  // Parked on the strip with the rings unfinished and the engine off: sortie over.
  if (mission.phase === PHASE_RINGS && plane.landed && plane.speed < 2 && mission.started) {
    mission.phase = PHASE_DONE;
  }

  mission.prevPos = { x: plane.x, y: plane.y, z: plane.z };
  return cues;
}

/** Final score breakdown for the end screen. */
export function scoreBreakdown(mission) {
  return {
    rings: mission.ringsCleared * SCORE_RING,
    ringsCleared: mission.ringsCleared,
    ringsTotal: RINGS.length,
    landing: mission.landingQuality
      ? SCORE_LANDING_BASE + (mission.landingQuality === 'soft' ? SCORE_LANDING_SOFT : 0)
      : 0,
    landingQuality: mission.landingQuality,
    timeBonus:
      mission.phase === PHASE_DONE && mission.landingQuality && mission.ringsCleared === RINGS.length
        ? Math.max(0, Math.round(SCORE_TIME_BONUS - mission.elapsed * 0.6))
        : 0,
    total: mission.score,
    elapsed: mission.elapsed,
  };
}

export { groundHeight, onRunway, HULL_MAX, LANDING_VS_OK, HARD_LANDING_VS };
