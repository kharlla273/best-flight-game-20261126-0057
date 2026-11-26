// Sound, all synthesized with WebAudio — no audio files, no network. The engine is a pair of
// detuned oscillators whose pitch follows the throttle; rings chime, touchdowns thud, and a
// soft alarm sounds when fuel or hull runs low. Nothing starts until the pilot first presses
// a key or clicks, as browsers require.
export function createAudio() {
  let context = null;
  let engineOscA = null;
  let engineOscB = null;
  let engineGain = null;
  let windGain = null;
  let muted = false;
  let started = false;

  function ensure() {
    if (started) return;
    started = true;
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      context = new AudioContext();
      engineGain = context.createGain();
      engineGain.gain.value = 0;
      engineGain.connect(context.destination);
      engineOscA = context.createOscillator();
      engineOscA.type = 'sawtooth';
      engineOscA.frequency.value = 55;
      engineOscB = context.createOscillator();
      engineOscB.type = 'square';
      engineOscB.frequency.value = 110;
      const lowpass = context.createBiquadFilter();
      lowpass.type = 'lowpass';
      lowpass.frequency.value = 420;
      const oscGain = context.createGain();
      oscGain.gain.value = 0.5;
      engineOscA.connect(oscGain);
      engineOscB.connect(oscGain);
      oscGain.connect(lowpass);
      lowpass.connect(engineGain);
      engineOscA.start();
      engineOscB.start();
      // Wind: looped filtered noise, loudness follows airspeed.
      const noiseBuffer = context.createBuffer(1, context.sampleRate * 2, context.sampleRate);
      const data = noiseBuffer.getChannelData(0);
      for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1;
      const noise = context.createBufferSource();
      noise.buffer = noiseBuffer;
      noise.loop = true;
      const bandpass = context.createBiquadFilter();
      bandpass.type = 'bandpass';
      bandpass.frequency.value = 700;
      windGain = context.createGain();
      windGain.gain.value = 0;
      noise.connect(bandpass);
      bandpass.connect(windGain);
      windGain.connect(context.destination);
      noise.start();
    } catch {
      context = null;
    }
  }

  /** Call every frame with the live flight state; the drone follows throttle and speed. */
  function update(throttle, speed, airborne, active) {
    if (!context || muted) {
      if (engineGain) engineGain.gain.value = 0;
      if (windGain) windGain.gain.value = 0;
      return;
    }
    const t = context.currentTime;
    const engineLevel = active ? 0.05 + throttle * 0.075 : 0;
    engineGain.gain.setTargetAtTime(engineLevel, t, 0.1);
    engineOscA.frequency.setTargetAtTime(48 + throttle * 62, t, 0.1);
    engineOscB.frequency.setTargetAtTime(96 + throttle * 124, t, 0.1);
    const windLevel = active && airborne ? Math.min(0.09, speed / 2400) : 0;
    windGain.gain.setTargetAtTime(windLevel, t, 0.2);
  }

  function blip(frequency, duration, type, level) {
    if (!context || muted) return;
    try {
      const osc = context.createOscillator();
      osc.type = type;
      osc.frequency.value = frequency;
      const gain = context.createGain();
      gain.gain.setValueAtTime(level, context.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + duration);
      osc.connect(gain);
      gain.connect(context.destination);
      osc.start();
      osc.stop(context.currentTime + duration);
    } catch {
      // A failed blip is never worth crashing the game over.
    }
  }

  function ringChime() {
    blip(880, 0.35, 'sine', 0.16);
    setTimeout(() => blip(1318, 0.4, 'sine', 0.12), 90);
  }

  function touchdownThud() {
    blip(70, 0.25, 'sine', 0.3);
  }

  function crashNoise() {
    blip(50, 0.7, 'sawtooth', 0.25);
    setTimeout(() => blip(38, 0.8, 'square', 0.15), 120);
  }

  function alarm() {
    blip(620, 0.18, 'square', 0.08);
    setTimeout(() => blip(620, 0.18, 'square', 0.08), 240);
  }

  function toggleMute() {
    muted = !muted;
    return muted;
  }

  return { ensure, update, ringChime, touchdownThud, crashNoise, alarm, toggleMute };
}
