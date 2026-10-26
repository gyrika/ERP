/**
 * When a spoken request is over (SCRUM-181), from the microphone's loudness alone: tap F9, speak,
 * and the recording stops by itself about a second after the last word. Pure: the screen feeds it
 * one loudness reading (RMS, 0-1) every few milliseconds and stops when it says so.
 *
 * The room sets the bar: the quietest moment heard so far is the shop's background (fans, the oven,
 * the road), and only sound well above it counts as a voice. A clang or a shout from the kitchen
 * is too short to count; a request that never starts sends nothing.
 */

/** Sound counts as a voice at this many times the background... */
export const VOICE_OVER_FLOOR = 3;
/** ...and never below this, so a silent room does not turn breathing into speech. */
export const MIN_VOICE = 0.02;
/** This much voice, in all, before it is speech and not a clang. */
export const MIN_SPEECH_MS = 250;
/** Quiet this long after speech: the request is over. */
export const END_SILENCE_MS = 900;
/** Nobody spoke this long after the tap: nothing to send. */
export const NO_SPEECH_MS = 5_000;
/** The longest request; a command is a few seconds. */
export const MAX_LISTEN_MS = 10_000;

export interface Listening {
  start: number;
  /** The quietest reading so far: the room. */
  floor: number;
  voicedMs: number;
  lastVoice: number;
  lastAt: number;
}

/** 'done': send what was said; 'nothing': no speech, send nothing. */
export type Heard = 'listening' | 'done' | 'nothing';

export const startListening = (at: number): Listening => ({ start: at, floor: Infinity, voicedMs: 0, lastVoice: at, lastAt: at });

/** One reading taken at `at`. */
export function listen(s: Listening, at: number, level: number): { s: Listening; heard: Heard } {
  const floor = Math.min(s.floor, level);
  const voice = level >= Math.max(floor * VOICE_OVER_FLOOR, MIN_VOICE);
  const next: Listening = {
    ...s,
    floor,
    voicedMs: s.voicedMs + (voice ? at - s.lastAt : 0),
    lastVoice: voice ? at : s.lastVoice,
    lastAt: at,
  };
  const spoke = next.voicedMs >= MIN_SPEECH_MS;
  if (spoke && at - next.lastVoice >= END_SILENCE_MS) return { s: next, heard: 'done' };
  if (!spoke && at - s.start >= NO_SPEECH_MS) return { s: next, heard: 'nothing' };
  if (at - s.start >= MAX_LISTEN_MS) return { s: next, heard: spoke ? 'done' : 'nothing' };
  return { s: next, heard: 'listening' };
}

/** The loudness of one block of samples (-1..1), as root mean square. */
export const loudness = (samples: ArrayLike<number>): number => {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return samples.length ? Math.sqrt(sum / samples.length) : 0;
};
