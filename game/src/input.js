// Keyboard and mouse input: one job, reading the pilot. Keys are the primary controls;
// the mouse steers gently too (hold the pointer off-centre to bank and pitch). Actions are
// edge-triggered and consumed once, so a key press never double-fires.
import { ACTION_CONFIRM, ACTION_PAUSE, ACTION_RESTART, ACTION_MUTE } from './actions.js';

const KEY_BINDINGS = {
  ArrowUp: 'pitchDown',
  KeyW: 'pitchDown',
  ArrowDown: 'pitchUp',
  KeyS: 'pitchUp',
  ArrowLeft: 'rollLeft',
  KeyA: 'rollLeft',
  ArrowRight: 'rollRight',
  KeyD: 'rollRight',
  ShiftLeft: 'throttleUp',
  ShiftRight: 'throttleUp',
  ControlLeft: 'throttleDown',
  ControlRight: 'throttleDown',
  Space: 'flaps',
  Enter: 'confirm',
  KeyP: 'pause',
  Escape: 'pause',
  KeyR: 'restart',
  KeyM: 'mute',
};

export function createInput(canvas) {
  const held = new Set();
  const queuedActions = new Set();
  let mouseX = 0;
  let mouseY = 0;
  let mouseActive = false;
  let mouseDown = false;

  function onKeyDown(event) {
    const binding = KEY_BINDINGS[event.code];
    if (!binding) return;
    event.preventDefault();
    if (event.repeat) return;
    held.add(binding);
    if (binding === 'confirm') queuedActions.add(ACTION_CONFIRM);
    if (binding === 'pause') queuedActions.add(ACTION_PAUSE);
    if (binding === 'restart') queuedActions.add(ACTION_RESTART);
    if (binding === 'mute') queuedActions.add(ACTION_MUTE);
  }

  function onKeyUp(event) {
    const binding = KEY_BINDINGS[event.code];
    if (binding) held.delete(binding);
  }

  function onMouseMove(event) {
    const rect = canvas.getBoundingClientRect();
    mouseX = (event.clientX - rect.left) / rect.width - 0.5;
    mouseY = (event.clientY - rect.top) / rect.height - 0.5;
    mouseActive = true;
  }

  function onMouseDown(event) {
    mouseDown = true;
    queuedActions.add(ACTION_CONFIRM);
    event.preventDefault();
  }

  function onMouseUp() {
    mouseDown = false;
  }

  function onBlur() {
    held.clear();
    mouseActive = false;
  }

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  canvas.addEventListener('mousemove', onMouseMove);
  canvas.addEventListener('mousedown', onMouseDown);
  window.addEventListener('mouseup', onMouseUp);
  window.addEventListener('blur', onBlur);

  /** Current stick deflection: { pitch: -1..1 (up positive), roll: -1..1, throttle: -1..1, flaps }. */
  function stick() {
    let pitch = 0;
    let roll = 0;
    if (held.has('pitchUp')) pitch += 1;
    if (held.has('pitchDown')) pitch -= 1;
    if (held.has('rollLeft')) roll -= 1;
    if (held.has('rollRight')) roll += 1;
    // Mouse steering: gentle, blended in only when no key is held for that axis.
    if (mouseActive) {
      if (pitch === 0) pitch = clamp(-mouseY * 2.4, -1, 1);
      if (roll === 0) roll = clamp(mouseX * 2.4, -1, 1);
    }
    let throttle = 0;
    if (held.has('throttleUp')) throttle += 1;
    if (held.has('throttleDown')) throttle -= 1;
    return {
      pitch,
      roll,
      throttle,
      flaps: held.has('flaps'),
      mouseDown,
    };
  }

  /** Actions queued since the last call, as a bitmask; calling clears them. */
  function takeActions() {
    let bits = 0;
    for (const action of queuedActions) bits |= action;
    queuedActions.clear();
    return bits;
  }

  return { stick, takeActions };
}

function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}
