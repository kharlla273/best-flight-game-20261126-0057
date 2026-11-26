// The flight model: an arcade plane with real discipline — speed comes from throttle, turns
// come from bank, lift dies below stall speed, and the ground is always waiting. State is kept
// in metres, knots and radians; step() advances it one fixed tick.
import {
  CLIMB_FACTOR, FUEL_BURN_BASE, FUEL_BURN_THROTTLE, FUEL_MAX, HULL_MAX,
  PITCH_LIMIT, PITCH_RATE, ROLL_LIMIT, ROLL_RATE, SINK_RATE, SPEED_MAX,
  SPEED_MIN, STALL_SINK, STEP, TURN_RATE,
} from './config.js';
import { groundHeight, onRunway } from './terrain.js';

const KNOT_TO_MS = 0.514444;

/** A fresh aircraft on the runway threshold, engine idling, facing down the strip. */
export function createPlane() {
  return {
    x: -260, y: 44, z: 0, // just above the runway, west end
    heading: 0, // east, down the runway centreline
    pitch: 0,
    roll: 0,
    speed: 0, // knots
    throttle: 0,
    fuel: FUEL_MAX,
    hull: HULL_MAX,
    airborne: false,
    verticalSpeed: 0, // m/s, smoothed for the HUD and landing checks
    stalled: false,
    landed: false, // true once a clean touchdown has been made
    groundSpeed: 0,
    strikeCooldown: 0, // seconds until the next terrain strike can hurt again
  };
}

export function resetPlane(plane) {
  const fresh = createPlane();
  Object.assign(plane, fresh);
}

/**
 * Advance the plane one tick. `stick` is { pitch: -1..1 (up positive), roll: -1..1 (right
 * positive), throttle: -1..1 (change), flaps: boolean }. Returns an event string or ''.
 * Events: 'takeoff' | 'touchdown' | 'hard-landing' | 'terrain' | 'fuel-empty' | 'stalled'.
 */
export function stepPlane(plane, stick, dt) {
  const events = [];

  // Throttle: stick changes it; the engine dies when the tank is dry.
  if (plane.fuel <= 0) {
    if (plane.throttle > 0) events.push('fuel-empty');
    plane.throttle = 0;
  } else {
    plane.throttle = Math.max(0, Math.min(1, plane.throttle + stick.throttle * dt * 0.55));
  }

  // Fuel burn grows with throttle; flaps cost a little extra drag.
  const burn = (FUEL_BURN_BASE + FUEL_BURN_THROTTLE * plane.throttle) * dt;
  plane.fuel = Math.max(0, plane.fuel - burn);

  // Roll and pitch ease toward the commanded angles; a stalled wing answers slowly.
  const authority = plane.stalled ? 0.35 : 1;
  const targetRoll = stick.roll * ROLL_LIMIT;
  const targetPitch = stick.pitch * PITCH_LIMIT;
  plane.roll += clamp(targetRoll - plane.roll, -ROLL_RATE * authority * dt, ROLL_RATE * authority * dt);
  plane.pitch += clamp(targetPitch - plane.pitch, -PITCH_RATE * authority * dt, PITCH_RATE * authority * dt);
  // Gentle auto-level: hands off the stick and the wings come back to level.
  if (Math.abs(stick.roll) < 0.05) plane.roll *= Math.max(0, 1 - 0.5 * dt);

  // Speed chases the throttle setting; flaps bleed speed for the approach.
  const targetSpeed = SPEED_MIN + plane.throttle * (SPEED_MAX - SPEED_MIN);
  const drag = stick.flaps ? 26 : 12;
  const rate = plane.speed < targetSpeed ? 14 : drag;
  plane.speed += clamp(targetSpeed - plane.speed, -rate * dt, rate * dt);
  if (plane.speed < 0) plane.speed = 0;

  // Stall: below flying speed the wing quits and the nose drops.
  const wasStalled = plane.stalled;
  plane.stalled = plane.airborne && plane.speed < SPEED_MIN + 6;
  if (plane.stalled && !wasStalled) events.push('stalled');

  // Banked turn: heading follows the bank, faster at cruise speed.
  const turnAuthority = Math.min(1, plane.speed / 90);
  plane.heading -= plane.roll * TURN_RATE * turnAuthority * dt;

  // Vertical speed: pitch converts forward speed into climb; sink always pulls down.
  const speedMs = plane.speed * KNOT_TO_MS;
  const climb = Math.sin(plane.pitch) * speedMs * CLIMB_FACTOR;
  const sink = plane.stalled ? STALL_SINK : SINK_RATE * (1 - Math.min(1, plane.speed / 70));
  const targetVs = plane.airborne ? climb - sink : 0;
  plane.verticalSpeed += (targetVs - plane.verticalSpeed) * Math.min(1, 4 * dt);
  plane.y += plane.verticalSpeed * dt;

  // Forward motion along the heading.
  const fx = Math.cos(plane.heading);
  const fz = -Math.sin(plane.heading);
  plane.x += fx * speedMs * Math.cos(plane.pitch) * dt;
  plane.z += fz * speedMs * Math.cos(plane.pitch) * dt;

  // Takeoff: enough speed and a little back-pressure lifts the wheels. A takeoff this tick
  // must not also count as a touchdown: the wheels have only just left the ground.
  const ground = groundHeight(plane.x, plane.z);
  let tookOff = false;
  if (!plane.airborne) {
    plane.y = ground + 2;
    if (plane.speed > 62 && plane.pitch > 0.08) {
      plane.airborne = true;
      tookOff = true;
      events.push('takeoff');
    }
  }

  // Ground contact.
  if (plane.airborne && !tookOff && plane.y <= ground + 2) {
    const vs = -plane.verticalSpeed;
    const onStrip = onRunway(plane.x, plane.z);
    const gentle = vs <= 2.6 && Math.abs(plane.roll) < 0.35 && plane.speed > 45;
    plane.y = ground + 2;
    if (onStrip && gentle) {
      plane.airborne = false;
      plane.landed = true;
      plane.verticalSpeed = 0;
      events.push('touchdown');
    } else if (onStrip && vs <= 6) {
      // A firm arrival on the strip is a hard landing, not a crash: it costs hull,
      // and the sortie still counts.
      plane.airborne = false;
      plane.landed = true;
      plane.verticalSpeed = 0;
      events.push('hard-landing');
    } else if (plane.strikeCooldown <= 0) {
      // A glancing strike: damage once, then bounce clear so one hillside cannot
      // shred the airframe tick after tick.
      plane.strikeCooldown = 1.5;
      plane.y = ground + 6;
      plane.verticalSpeed = Math.max(plane.verticalSpeed, 3);
      events.push('terrain');
    }
  }
  plane.strikeCooldown = Math.max(0, plane.strikeCooldown - dt);

  // Rolling on the ground: light rolling resistance while the throttle is open, firm brakes
  // once it closes (the drag must stay below the engine's acceleration, or she never moves).
  if (!plane.airborne) {
    const brake = plane.throttle < 0.05 ? 22 : 3;
    plane.speed = Math.max(0, plane.speed - brake * dt);
    plane.groundSpeed = plane.speed;
    plane.verticalSpeed = 0;
  } else {
    plane.groundSpeed = speedMs;
  }

  return events;
}

function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

export { STEP };
