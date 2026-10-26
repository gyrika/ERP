import { useRef, useState } from 'react';
import type { CameraSpec } from '../../domain/tables.ts';
import type { TestVideos, VisionClient } from '../../services/visionClient.ts';
import { PinCancelled, type WithPin } from './setupParts.tsx';

/**
 * TEMPORARY (owner, 2026-10-27): try detection without a camera. "Test with a video…" opens the
 * file explorer; the video goes to the shop server (server/setup.ts `cvTestVideoUpload`) and plays
 * in a loop in place of this camera's stream, for the views and the camera worker, until Stop or
 * the next server start. Remove with TEST_VIDEO, this file and the server's TEMPORARY parts.
 */
export const TEST_VIDEO = true;
const ACCEPT = 'video/*,.mp4,.mov,.m4v,.avi,.mkv,.webm';
const MAX_MB = 200;

export function TestVideo({ client, withPin, camera, playing, onChange, detecting }: {
  client: VisionClient; withPin: WithPin; camera: CameraSpec;
  /** The video's name while this camera plays one. */
  playing: string | undefined;
  onChange: (t: TestVideos) => void;
  /** CV is in Shadow or Live: the worker checks the video. */
  detecting: boolean;
}) {
  const picker = useRef<HTMLInputElement>(null);
  const [sending, setSending] = useState<{ name: string; share: number } | null>(null);
  const [error, setError] = useState('');
  if (!TEST_VIDEO) return null;

  const send = async (file: File) => {
    setError('');
    if (file.size > MAX_MB * 1024 * 1024) { setError(`The video is over ${MAX_MB} MB: pick a shorter one.`); return; }
    try {
      await withPin('play a test video', async (p) => {
        setSending({ name: file.name, share: 0 });
        onChange(await client.uploadTestVideo(p, camera.id, file, (share) => setSending({ name: file.name, share })));
      });
    } catch (e) { if (!(e instanceof PinCancelled)) setError(e instanceof Error ? e.message : String(e)); }
    setSending(null);
  };
  const stop = async () => {
    setError('');
    try { await withPin('stop the test video', async (p) => onChange(await client.stopTestVideo(p, camera.id))); }
    catch (e) { if (!(e instanceof PinCancelled)) setError(e instanceof Error ? e.message : String(e)); }
  };

  return (
    <section className="testvideo" aria-label="Test video (temporary)">
      <span className="testvideo__tag">Testing only</span>
      <input ref={picker} type="file" accept={ACCEPT} hidden aria-label={`A test video for ${camera.name}`}
        onChange={(e) => { const file = e.currentTarget.files?.[0]; e.currentTarget.value = ''; if (file) void send(file); }} />
      {sending ? (
        <div className="testvideo__line">
          <span>Sending {sending.name}…</span>
          <progress max={1} value={sending.share} aria-label="Sending the video" />
        </div>
      ) : playing ? (
        <div className="testvideo__line">
          <span><b>{playing}</b> plays in place of {camera.name}.{!detecting && ' Turn CV on to see detection.'}</span>
          <button type="button" className="chip" onClick={() => picker.current?.click()}>Another video…</button>
          <button type="button" className="chip chip--solid" onClick={() => void stop()}>Stop test</button>
        </div>
      ) : (
        <div className="testvideo__line">
          <button type="button" className="chip chip--solid" onClick={() => picker.current?.click()}>Test with a video…</button>
          <span className="setup__hint">Plays a short clip as {camera.name}, in a loop, up to {MAX_MB} MB.</span>
        </div>
      )}
      {error && <p className="setup__error" role="alert">{error}</p>}
    </section>
  );
}
