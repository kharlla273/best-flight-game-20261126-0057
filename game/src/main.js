// Boot and the one loop: input is read every frame, the world advances in fixed 1/60 s steps
// (several in a slow frame, none in a fast one), and the renderer paints what is there.
//
// ?shot=<name> (with &seed=<n>) stages that scene instead of running the loop, paints it twice
// and sets window.__shotReady for a screenshot: title | rings | landing | home.
import { STEP } from './config.js';
import { createWorld, SCREEN_PLAY, SCREEN_TITLE } from './world.js';
import { stageShot } from './shots.js';
import { createRenderer } from './render.js';

/** The longest frame the loop catches up on; a longer stall (a hidden tab) is dropped. */
const MAX_FRAME = 0.25;

const params = new URLSearchParams(window.location.search);
const shot = params.get('shot');

const canvas = document.getElementById('game');
const status = document.getElementById('status');

function runShot(name) {
  const scene = stageShot(name);
  const renderer = createRenderer(canvas);
  let painted = 0;
  function paint() {
    renderer.draw({
      plane: scene.plane,
      mission: scene.mission,
      screen: scene.screen,
      now: scene.now,
      time: scene.now,
      best: scene.best,
      breakdown: scene.breakdown,
      crashed: scene.crashed,
    });
    painted += 1;
    if (painted < 2) requestAnimationFrame(paint);
    else {
      // Small read-only hook for play-testing: what the staged sortie actually did.
      window.__shotState = {
        ringsCleared: scene.mission.ringsCleared,
        phase: scene.mission.phase,
        score: scene.mission.score,
        landed: scene.plane.landed,
        speed: Math.round(scene.plane.speed),
        altitude: Math.round(scene.plane.y),
        fuel: Math.round(scene.plane.fuel),
        hull: Math.round(scene.plane.hull),
        trace: scene.trace,
      };
      window.__shotReady = true;
    }
  }
  requestAnimationFrame(paint);
}

function runGame() {
  const world = createWorld(canvas, null);
  let accumulator = 0;
  let last = performance.now();

  // Screen readers (and anyone watching the page's text) hear the screen changes.
  function announce(message) {
    status.textContent = message;
  }

  function frame(nowMs) {
    requestAnimationFrame(frame);
    accumulator += Math.min((nowMs - last) / 1000, MAX_FRAME);
    last = nowMs;
    world.handleActions();
    if (world.screen === SCREEN_PLAY || world.screen === SCREEN_TITLE) {
      while (accumulator >= STEP && world.screen === SCREEN_PLAY) {
        world.step(STEP);
        accumulator -= STEP;
      }
      if (world.screen === SCREEN_TITLE) accumulator = 0;
    } else {
      accumulator = 0;
    }
    world.draw(nowMs / 1000);
  }

  announce('Skymark Courier. Press Enter or click to fly.');
  requestAnimationFrame(frame);
}

if (shot) runShot(shot);
else runGame();
