/**
 * Counter sounds (not the kitchen chime, which must always play). One on/off
 * setting, remembered on this device only.
 */
const KEY = 'cb.sound';

export const soundOn = (): boolean => {
  try { return localStorage.getItem(KEY) !== 'off'; } catch { return true; }
};

export const setSoundOn = (on: boolean): void => {
  try { localStorage.setItem(KEY, on ? 'on' : 'off'); } catch { /* blocked storage: stays on for this visit */ }
};

let ctx: AudioContext | null = null;

/**
 * The unlock "clunk": a short, low thump (pitch falling 110 -> 55 Hz, ~140 ms)
 * with a soft click on top. Quiet on purpose: felt more than heard.
 */
export const clunk = (): void => {
  if (!soundOn() || typeof AudioContext === 'undefined') return;
  ctx ??= new AudioContext();
  const a = ctx;
  if (a.state === 'suspended') void a.resume();
  const t = a.currentTime;

  const body = a.createOscillator();
  const bodyGain = a.createGain();
  body.type = 'sine';
  body.frequency.setValueAtTime(110, t);
  body.frequency.exponentialRampToValueAtTime(55, t + 0.12);
  bodyGain.gain.setValueAtTime(0.0001, t);
  bodyGain.gain.exponentialRampToValueAtTime(0.28, t + 0.008);
  bodyGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
  body.connect(bodyGain).connect(a.destination);
  body.start(t);
  body.stop(t + 0.15);

  const click = a.createOscillator();
  const clickGain = a.createGain();
  click.type = 'triangle';
  click.frequency.setValueAtTime(1400, t);
  clickGain.gain.setValueAtTime(0.0001, t);
  clickGain.gain.exponentialRampToValueAtTime(0.05, t + 0.002);
  clickGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.03);
  click.connect(clickGain).connect(a.destination);
  click.start(t);
  click.stop(t + 0.04);
};
