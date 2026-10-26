import { useCallback, useEffect, useRef, useState } from 'react';
import type { VoicePage } from '../domain/voicePages.ts';
import { listen, loudness, MAX_LISTEN_MS, startListening } from '../domain/speechEnd.ts';
import { pickPage, transcribe, VoiceError } from '../services/voice.ts';

/**
 * Serves whoever is at the counter with busy hands: they know which screen they want, not where it
 * is. Tap F9 (or the Voice key) and say "open stock": the recording stops by itself when they stop
 * talking, and the page opens; holding F9 while speaking works too. Esc or Back returns to where
 * they were. Listening only after the key; a recording with no speech is never sent; nothing is kept.
 * Anything that should start listening (a wake word one day) calls `start`.
 */
type Voice =
  | { kind: 'idle' }
  | { kind: 'listening' }
  | { kind: 'working'; heard?: string }
  | { kind: 'opened'; heard: string; page: VoicePage; from: string }
  | { kind: 'failed'; message: string };

/** Held at least this long, letting go sends; a shorter press is a tap and listening carries on. */
const HOLD_MS = 400;
const SHOW_MS = 6_000;
const READ_EVERY_MS = 50;
const NOT_HEARD = 'Did not catch that. Press F9 and try again';

interface Recording {
  recorder: MediaRecorder;
  /** Not sent: no speech came ('nothing') or the person cancelled with Esc. */
  drop: 'nothing' | 'cancel' | null;
  quit: () => void;
}

/**
 * Reads the microphone's loudness and says when the request is over. Without Web Audio (old
 * browsers, tests) the longest request still ends it.
 */
function watchSpeech(stream: MediaStream, onEnd: (heard: 'done' | 'nothing') => void): () => void {
  const Ctx = typeof AudioContext === 'undefined' ? null : AudioContext;
  if (!Ctx) {
    const t = setTimeout(() => onEnd('done'), MAX_LISTEN_MS);
    return () => clearTimeout(t);
  }
  const ctx = new Ctx();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  ctx.createMediaStreamSource(stream).connect(analyser);
  const samples = new Float32Array(analyser.fftSize);
  let s = startListening(Date.now());
  const timer = setInterval(() => {
    analyser.getFloatTimeDomainData(samples);
    const step = listen(s, Date.now(), loudness(samples));
    s = step.s;
    if (step.heard !== 'listening') onEnd(step.heard);
  }, READ_EVERY_MS);
  return () => { clearInterval(timer); void ctx.close().catch(() => {}); };
}

export function useVoice(pages: readonly VoicePage[], current: string, open: (hash: string) => void) {
  const [voice, setVoice] = useState<Voice>({ kind: 'idle' });
  const rec = useRef<Recording | null>(null);
  /** One request at a time: a second F9 while the first is being read does nothing. */
  const busy = useRef(false);
  /**
   * When F9 (or the Voice key) went down, while it is down; a held key, not the silence, ends the
   * request. Kept apart from the recording: a quick tap is often let go before the microphone opens.
   */
  const pressed = useRef<number | null>(null);
  const pagesRef = useRef(pages);
  pagesRef.current = pages;
  const currentRef = useRef(current);
  currentRef.current = current;

  const finish = useCallback(async (audio: Blob) => {
    setVoice({ kind: 'working' });
    try {
      const heard = await transcribe(audio);
      if (!heard) { setVoice({ kind: 'failed', message: NOT_HEARD }); return; }
      setVoice({ kind: 'working', heard });
      const page = await pickPage(heard, pagesRef.current);
      if (!page) { setVoice({ kind: 'failed', message: `"${heard}": no page for that` }); return; }
      const from = currentRef.current;
      open(page.hash);
      setVoice({ kind: 'opened', heard, page, from });
    } catch (e) {
      setVoice({ kind: 'failed', message: e instanceof VoiceError ? e.message : 'Voice could not help this time' });
    } finally {
      busy.current = false;
    }
  }, [open]);

  const end = useCallback((drop: Recording['drop'] = null) => {
    const r = rec.current;
    if (!r || r.recorder.state !== 'recording') return;
    r.drop = drop;
    r.recorder.stop();
  }, []);

  const begin = useCallback(async () => {
    busy.current = true;
    if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      busy.current = false;
      setVoice({ kind: 'failed', message: 'This screen has no microphone support' });
      return;
    }
    let stream: MediaStream;
    try {
      // One channel, cleaned by the browser: the shop's fans and the street matter less to Whisper.
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch {
      busy.current = false;
      setVoice({ kind: 'failed', message: 'No microphone, or it is not allowed' });
      return;
    }
    const recorder = new MediaRecorder(stream);
    const chunks: Blob[] = [];
    const r: Recording = { recorder, drop: null, quit: () => {} };
    const startedAt = Date.now();
    recorder.ondataavailable = (e) => chunks.push(e.data);
    recorder.onstop = () => {
      r.quit();
      stream.getTracks().forEach((t) => t.stop());
      rec.current = null;
      if (r.drop) { busy.current = false; setVoice(r.drop === 'cancel' ? { kind: 'idle' } : { kind: 'failed', message: NOT_HEARD }); return; }
      void finish(new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }));
    };
    r.quit = watchSpeech(stream, (heard) => {
      // Silence ends a tapped request; a held key ends when let go (or at the longest request).
      if (heard === 'nothing') end('nothing');
      else if (pressed.current === null || Date.now() - startedAt >= MAX_LISTEN_MS) end();
    });
    rec.current = r;
    recorder.start();
    setVoice({ kind: 'listening' });
  }, [finish, end]);

  /** F9 or the Voice key went down: start listening, or send what is being said. */
  const start = useCallback(async () => {
    if (rec.current) { end(); return; }
    if (busy.current) return;
    pressed.current = Date.now();
    await begin();
  }, [begin, end]);

  /** F9 or the Voice key came up: after a hold that sends; after a tap, listening carries on. */
  const stop = useCallback(() => {
    const at = pressed.current;
    pressed.current = null;
    if (at !== null && Date.now() - at >= HOLD_MS) end();
  }, [end]);

  const back = useCallback(() => {
    setVoice((v) => { if (v.kind === 'opened') open(v.from); return { kind: 'idle' }; });
  }, [open]);

  // F9 starts (and a second F9 sends). Esc while listening drops it; right after a page opened, goes back.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === 'F9') { e.preventDefault(); if (!e.repeat) void start(); }
      if (e.key === 'Escape' && rec.current) { e.preventDefault(); e.stopImmediatePropagation(); end('cancel'); }
      else if (e.key === 'Escape' && voice.kind === 'opened') { e.preventDefault(); e.stopImmediatePropagation(); back(); }
    };
    const up = (e: KeyboardEvent) => { if (e.key === 'F9') { e.preventDefault(); stop(); } };
    window.addEventListener('keydown', down, true);
    window.addEventListener('keyup', up, true);
    return () => { window.removeEventListener('keydown', down, true); window.removeEventListener('keyup', up, true); };
  }, [start, stop, back, end, voice.kind]);

  // A result shows for a moment, then gets out of the way.
  useEffect(() => {
    if (voice.kind !== 'opened' && voice.kind !== 'failed') return;
    const t = setTimeout(() => setVoice({ kind: 'idle' }), SHOW_MS);
    return () => clearTimeout(t);
  }, [voice]);

  // Leaving the screen mid-request lets go of the microphone.
  useEffect(() => () => end('cancel'), [end]);

  return { voice, start, stop, back };
}

export const MicIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM19 11a7 7 0 0 1-14 0M12 18v3" />
  </svg>
);

/** What voice is doing, at the bottom of any screen; nothing when idle. */
export function VoiceNote({ voice, onBack }: { voice: Voice; onBack: () => void }) {
  if (voice.kind === 'idle') return null;
  return (
    <div className={`voice-note voice-note--${voice.kind}`} role="status" aria-live="polite">
      {voice.kind === 'listening' && <><span className="voice-note__dot" aria-hidden="true" /> Listening… stops when you do</>}
      {voice.kind === 'working' && <>{voice.heard ? <>"{voice.heard}" · finding the page…</> : 'Reading what you said…'}</>}
      {voice.kind === 'opened' && (
        <>
          <span>"{voice.heard}" → <b>{voice.page.label.split(':')[0]}</b></span>
          <button type="button" className="voice-note__back" onClick={onBack}>Back <kbd>Esc</kbd></button>
        </>
      )}
      {voice.kind === 'failed' && <>{voice.message}</>}
    </div>
  );
}
