// Screenshot scenes behind ?shot=<name>&seed=<n>. Each one plays the real rules forward from
// a fresh world for a fixed number of steps, steered by a simple autopilot that flies toward
// the next ring or the runway, so the frame is what a real sortie looks like and the same
// seed always gives the same frame. The autopilot reads the same state the player sees.
import { RINGS, STEP } from './config.js';
import { createPlane, stepPlane } from './plane.js';
import { createMission, PHASE_LAND, PHASE_RINGS, scoreBreakdown, stepMission } from './missions.js';
import { groundHeight } from './terrain.js';

const SCENES = {
  // Title screen over the valley, plane parked on the strip.
  title: { seconds: 2, screen: 'title' },
  // Mid ring-run: four rings down, chasing the fifth over the river.
  rings: { seconds: 80, screen: 'play' },
  // On final approach, runway ahead, gear down low over the fields.
  landing: { seconds: 132, screen: 'play' },
  // All rings clear, on the rollout after a greaser.
  home: { seconds: 175, screen: 'play' },
};

/** Steer toward a target point: bank toward it, pitch to hold the target altitude. */
function autopilotStick(plane, target, now) {
  const dx = target.x - plane.x;
  const dz = target.z - plane.z;
  const desiredHeading = Math.atan2(-dz, dx);
  let headingError = desiredHeading - plane.heading;
  while (headingError > Math.PI) headingError -= 2 * Math.PI;
  while (headingError < -Math.PI) headingError += 2 * Math.PI;
  // Banking right (positive roll) turns the nose toward falling heading, so the bank
  // needed to close a heading error is the negative of that error.
  const roll = Math.max(-1, Math.min(1, -headingError * 1.4));
  const altError = target.y - plane.y;
  // Pitch eases toward the target altitude, never diving steeply: a steep dive into a
  // ridge is how sorties end. On final the gain is much higher and the dive limit opened,
  // so the plane tracks the glide slope instead of floating a dozen metres above it.
  const gain = target.final ? 12 : 60;
  const minPitch = target.final ? -0.6 : -0.35;
  const pitch = Math.max(minPitch, Math.min(0.9, altError / gain + 0.12));
  // Throttle: cruise en route, ease off near the target so the turn tightens and the
  // plane can actually fly through the ring instead of orbiting it at full speed.
  const dist = Math.hypot(dx, dz);
  let throttle = 0.5;
  if (!target.final && dist < 400) {
    throttle = plane.throttle > 0.2 ? -0.8 : 0;
  } else if (target.final && dist < 500) {
    throttle = -0.6;
  }
  return { pitch, roll, throttle, flaps: Boolean(target.final && dist < 400) };
}

/** Run one scene and return the world state to draw, plus the screen to draw over it. */
export function stageShot(name) {
  const scene = SCENES[name] ?? SCENES.title;
  const plane = createPlane();
  const mission = createMission();
  let now = 0;
  let screen = scene.screen;
  // A sampled trace of the staged flight, for verification (one entry every 5 seconds).
  const trace = [];
  // Approach legs: 0 = gate 700 m west of the strip, 1 = final fix 400 m out on the
  // centreline, 2 = the threshold. The plane must pass near each gate before the next,
  // so the final is flown down the centreline, wings level, instead of cutting the corner.
  let approachLeg = 0;

  // Take off: full throttle, rotate once past 62 knots.
  const steps = Math.round(scene.seconds / STEP);
  for (let i = 0; i < steps; i += 1) {
    now += STEP;
    if (Math.floor(now * 60) % 300 === 0) {
      trace.push({
        t: Math.round(now),
        x: Math.round(plane.x),
        y: Math.round(plane.y),
        z: Math.round(plane.z),
        hdg: Number(plane.heading.toFixed(2)),
        spd: Math.round(plane.speed),
        vs: Number(plane.verticalSpeed.toFixed(1)),
        leg: approachLeg,
        phase: mission.phase,
        rings: mission.ringsCleared,
      });
    }
    let stick;
    if (!plane.airborne) {
      stick = { pitch: plane.speed > 60 ? 0.5 : 0.1, roll: 0, throttle: 1, flaps: false };
    } else if (mission.phase === PHASE_RINGS) {
      const ring = RINGS[mission.ringIndex] ?? { x: 0, y: 150, z: 0 };
      stick = autopilotStick(plane, ring, now);
    } else if (mission.phase === PHASE_LAND) {
      // Three-gate approach: the 700 m gate, the final fix 400 m out, then the threshold.
      // The last leg is line-following, not point-chasing: head east, correcting back
      // toward the centreline in proportion to the cross-track error, on a glide slope
      // that never drops below 60 m until the plane is lined up with the strip.
      const dGate1 = Math.hypot(plane.x + 700, plane.z);
      const dGate2 = Math.hypot(plane.x + 400, plane.z);
      const distThreshold = Math.hypot(plane.x, plane.z);
      if (approachLeg === 0 && dGate1 < 120) approachLeg = 1;
      if (approachLeg === 1 && dGate2 < 120) approachLeg = 2;
      if (approachLeg < 2) {
        const target = approachLeg === 0 ? { x: -700, z: 0, y: 150 } : { x: -400, z: 0, y: 80 };
        stick = autopilotStick(plane, target, now);
      } else {
        // Line-following on the centreline: heading 0 is east and +z is south, so a
        // plane north of the line (z < 0) must head south (negative heading) to return.
        const desiredHeading = Math.max(-0.3, Math.min(0.3, plane.z / 150));
        let headingError = desiredHeading - plane.heading;
        while (headingError > Math.PI) headingError -= 2 * Math.PI;
        while (headingError < -Math.PI) headingError += 2 * Math.PI;
        const roll = Math.max(-1, Math.min(1, -headingError * 1.4));
        const slopeY = 46 + Math.max(0, (distThreshold - 100) * 0.1);
        const targetY = Math.abs(plane.z) > 25 ? Math.max(slopeY, 60) : slopeY;
        const altError = targetY - plane.y;
        const pitch = Math.max(-0.6, Math.min(0.9, altError / 12 + 0.12));
        stick = { pitch, roll, throttle: 0, flaps: distThreshold < 400 };
        if (distThreshold < 200 && plane.y < 55 && Math.abs(plane.z) < 25) stick.pitch = -0.12;
        if (plane.throttle > 0.2) stick.throttle = -0.6;
        else if (plane.throttle < 0.15) stick.throttle = 0.6;
        else stick.throttle = 0;
      }
    } else {
      stick = { pitch: 0, roll: 0, throttle: -1, flaps: true };
    }
    const events = stepPlane(plane, stick, STEP);
    stepMission(mission, plane, events, now, STEP);
    if (mission.phase === PHASE_LAND && plane.landed) break;
    if (name === 'home' && plane.landed) break;
  }
  if (name === 'home') screen = 'over';
  return {
    plane,
    mission,
    screen,
    now,
    trace,
    breakdown: screen === 'over' ? scoreBreakdown(mission) : null,
    crashed: false,
    best: 0,
  };
}
