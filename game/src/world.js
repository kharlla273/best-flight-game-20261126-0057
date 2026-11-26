// The world: one place where the screens, the clock and the score live. The loop asks it to
// step and to draw; it owns the plane, the mission and the transitions between title, play,
// pause and the end screen. Nothing here touches the DOM except through the renderer.
import { STEP } from './config.js';
import { createPlane, resetPlane, stepPlane } from './plane.js';
import { createMission, PHASE_DONE, resetMission, scoreBreakdown, stepMission } from './missions.js';
import { createRenderer } from './render.js';
import { createAudio } from './audio.js';
import { createInput } from './input.js';
import { ACTION_CONFIRM, ACTION_MUTE, ACTION_PAUSE, ACTION_RESTART } from './actions.js';

export const SCREEN_TITLE = 'title';
export const SCREEN_PLAY = 'play';
export const SCREEN_PAUSED = 'paused';
export const SCREEN_OVER = 'over';

const BEST_KEY = 'skymark-courier-best';

/** Read the pilot's best sortie from this browser, or 0 when there is none yet. */
export function readBest() {
  try {
    return Number.parseInt(window.localStorage.getItem(BEST_KEY) ?? '0', 10) || 0;
  } catch {
    return 0;
  }
}

function saveBest(value) {
  try {
    window.localStorage.setItem(BEST_KEY, String(value));
  } catch {
    // Storage can be off (private windows): the best then lasts this visit only.
  }
}

/**
 * Build the world around a canvas. `shot` is null in normal play, or a scene name staged by
 * shots.js for screenshots. Returns { step, draw, state } for the main loop.
 */
export function createWorld(canvas, shot) {
  const renderer = createRenderer(canvas);
  const audio = createAudio();
  const input = shot ? null : createInput(canvas);
  const plane = createPlane();
  const mission = createMission();
  let screen = SCREEN_TITLE;
  let best = readBest();
  let now = 0; // mission clock, seconds
  let breakdown = null;
  let crashed = false;

  function startSortie() {
    resetPlane(plane);
    resetMission(mission);
    breakdown = null;
    crashed = false;
    now = 0;
    screen = SCREEN_PLAY;
  }

  function endSortie(wasCrash) {
    crashed = wasCrash;
    breakdown = scoreBreakdown(mission);
    if (breakdown.total > best) {
      best = breakdown.total;
      saveBest(best);
    }
    screen = SCREEN_OVER;
  }

  function handleActions() {
    const actions = input.takeActions();
    if (actions & ACTION_MUTE) {
      audio.toggleMute();
    }
    if (actions & ACTION_RESTART && screen !== SCREEN_TITLE) {
      startSortie();
      return;
    }
    if (actions & ACTION_CONFIRM) {
      audio.ensure();
      if (screen === SCREEN_TITLE || screen === SCREEN_OVER) startSortie();
      else if (screen === SCREEN_PAUSED) screen = SCREEN_PLAY;
    }
    if (actions & ACTION_PAUSE) {
      if (screen === SCREEN_PLAY) screen = SCREEN_PAUSED;
      else if (screen === SCREEN_PAUSED) screen = SCREEN_PLAY;
    }
  }

  function step(dt) {
    if (screen !== SCREEN_PLAY) return;
    now += dt;
    const stick = input.stick();
    const events = stepPlane(plane, stick, dt);
    const cues = stepMission(mission, plane, events, now, dt);
    for (const cue of cues) {
      if (cue === 'ring') audio.ringChime();
      else if (cue === 'land') audio.touchdownThud();
      else if (cue === 'crash') audio.crashNoise();
      else if (cue === 'alarm') audio.alarm();
    }
    if (events.includes('terrain') && plane.hull <= 0) endSortie(true);
    else if (mission.phase === PHASE_DONE) endSortie(false);
    audio.update(plane.throttle, plane.speed, plane.airborne, screen === SCREEN_PLAY);
  }

  function draw(time) {
    renderer.draw({ plane, mission, screen, now, time, best, breakdown, crashed });
  }

  // Leaving the tab pauses a running sortie rather than letting it fly on unseen.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && screen === SCREEN_PLAY) screen = SCREEN_PAUSED;
  });

  return {
    step,
    draw,
    handleActions,
    state: { plane, mission },
    get screen() {
      return screen;
    },
  };
}

export { STEP };
