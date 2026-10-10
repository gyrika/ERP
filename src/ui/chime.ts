import { useEffect, useState } from 'react';

/**
 * Kitchen alert sound, synthesised (no audio file to load or cache).
 * Browsers only allow sound after a tap on the page, so the kitchen screen
 * shows a "turn on sound" bar until that first tap has happened.
 */
let ctx: AudioContext | null = null;

const audio = (): AudioContext | null => {
  if (typeof AudioContext === 'undefined') return null;
  ctx ??= new AudioContext();
  return ctx;
};

/** Two short rising tones, ~350 ms: clear over kitchen noise, not alarming. */
export const chime = (): void => {
  const a = audio();
  if (!a || a.state !== 'running') return;
  [880, 1320].forEach((freq, i) => {
    const t = a.currentTime + i * 0.16;
    const osc = a.createOscillator();
    const gain = a.createGain();
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.4, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    osc.connect(gain).connect(a.destination);
    osc.start(t);
    osc.stop(t + 0.2);
  });
};

/** True when sound is blocked and needs one tap; the tap anywhere turns it on. */
export function useSoundBlocked(): boolean {
  const [blocked, setBlocked] = useState(() => audio()?.state === 'suspended');
  useEffect(() => {
    const a = audio();
    if (!a) return;
    const sync = () => setBlocked(a.state === 'suspended');
    const unlock = () => { void a.resume().then(sync); };
    a.addEventListener('statechange', sync);
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    sync();
    return () => {
      a.removeEventListener('statechange', sync);
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
  }, []);
  return blocked;
}
