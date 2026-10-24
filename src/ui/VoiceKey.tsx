import { useCallback, useEffect, useRef, useState } from 'react';
import type { VoicePage } from '../domain/voicePages.ts';
import { pickPage, transcribe, VoiceError } from '../services/voice.ts';

/**
 * Serves whoever is at the counter with busy hands: they know which screen they want, not where it
 * is. Hold F9 (or the Voice key), say "open stock", let go: the page opens, and Esc or Back returns
 * to where they were. Never listening unless the key is held; nothing is kept.
 */
type Voice =
  | { kind: 'idle' }
  | { kind: 'listening' }
  | { kind: 'working'; heard?: string }
  | { kind: 'opened'; heard: string; page: VoicePage; from: string }
  | { kind: 'failed'; message: string };

/** Shorter than this is a tap, not speech. */
const MIN_MS = 400;
const SHOW_MS = 6_000;

export function useVoice(pages: readonly VoicePage[], current: string, open: (hash: string) => void) {
  const [voice, setVoice] = useState<Voice>({ kind: 'idle' });
  const rec = useRef<{ recorder: MediaRecorder; started: number } | null>(null);
  const pagesRef = useRef(pages);
  pagesRef.current = pages;
  const currentRef = useRef(current);
  currentRef.current = current;

  const finish = useCallback(async (audio: Blob) => {
    setVoice({ kind: 'working' });
    try {
      const heard = await transcribe(audio);
      if (!heard) { setVoice({ kind: 'failed', message: 'Did not catch that. Hold F9 and try again' }); return; }
      setVoice({ kind: 'working', heard });
      const page = await pickPage(heard, pagesRef.current);
      if (!page) { setVoice({ kind: 'failed', message: `"${heard}": no page for that` }); return; }
      const from = currentRef.current;
      open(page.hash);
      setVoice({ kind: 'opened', heard, page, from });
    } catch (e) {
      setVoice({ kind: 'failed', message: e instanceof VoiceError ? e.message : 'Voice could not help this time' });
    }
  }, [open]);

  const start = useCallback(async () => {
    if (rec.current) return;
    if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setVoice({ kind: 'failed', message: 'This screen has no microphone support' });
      return;
    }
    let stream: MediaStream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch {
      setVoice({ kind: 'failed', message: 'No microphone, or it is not allowed' });
      return;
    }
    const recorder = new MediaRecorder(stream);
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => chunks.push(e.data);
    recorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      const held = Date.now() - (rec.current?.started ?? Date.now());
      rec.current = null;
      if (held < MIN_MS) { setVoice({ kind: 'failed', message: 'Hold F9 while you speak' }); return; }
      void finish(new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }));
    };
    rec.current = { recorder, started: Date.now() };
    recorder.start();
    setVoice({ kind: 'listening' });
  }, [finish]);

  const stop = useCallback(() => {
    if (rec.current?.recorder.state === 'recording') rec.current.recorder.stop();
  }, []);

  const back = useCallback(() => {
    setVoice((v) => { if (v.kind === 'opened') open(v.from); return { kind: 'idle' }; });
  }, [open]);

  // F9 held = listening. Esc right after a page opened goes back to where it was.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === 'F9') { e.preventDefault(); if (!e.repeat) void start(); }
      if (e.key === 'Escape' && voice.kind === 'opened') { e.preventDefault(); e.stopImmediatePropagation(); back(); }
    };
    const up = (e: KeyboardEvent) => { if (e.key === 'F9') { e.preventDefault(); stop(); } };
    window.addEventListener('keydown', down, true);
    window.addEventListener('keyup', up, true);
    return () => { window.removeEventListener('keydown', down, true); window.removeEventListener('keyup', up, true); };
  }, [start, stop, back, voice.kind]);

  // A result shows for a moment, then gets out of the way.
  useEffect(() => {
    if (voice.kind !== 'opened' && voice.kind !== 'failed') return;
    const t = setTimeout(() => setVoice({ kind: 'idle' }), SHOW_MS);
    return () => clearTimeout(t);
  }, [voice]);

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
      {voice.kind === 'listening' && <><span className="voice-note__dot" aria-hidden="true" /> Listening… let go of F9 to send</>}
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
