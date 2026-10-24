import { matchPage, type VoicePage } from '../domain/voicePages.ts';
import { syncToken } from './pairing.ts';

/**
 * Voice at the counter (SCRUM-145), through the shop server to the cloud's language model.
 * The recording is sent once and never kept. Every failure becomes one plain sentence for the
 * cashier; the screens never wait on it.
 */
export class VoiceError extends Error {}

const call = async (path: string, body: BodyInit, type: string): Promise<unknown> => {
  const token = syncToken();
  let r: Response;
  try {
    r = await fetch(path, { method: 'POST', headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': type }, body, signal: AbortSignal.timeout(25_000) });
  } catch {
    throw new VoiceError('Voice needs the shop server');
  }
  if (r.status === 401 || r.status === 403) throw new VoiceError('Voice works on the shop PC once it is connected');
  if (r.status === 429) throw new VoiceError('Voice is resting until tomorrow');
  if (r.status === 503) throw new VoiceError('Voice needs the internet right now');
  if (!r.ok) throw new VoiceError('Voice could not help this time');
  return r.json();
};

/** What was said, in words ('' when nothing usable was heard). */
export const transcribe = async (audio: Blob): Promise<string> => {
  const d = (await call('/api/v1/ai/transcribe', audio, audio.type || 'audio/webm')) as { text?: unknown };
  return typeof d.text === 'string' ? d.text : '';
};

/** The page the words ask for: plain words without the model, the rest by the model; null when none fits. */
export const pickPage = async (text: string, pages: readonly VoicePage[]): Promise<VoicePage | null> => {
  const plain = matchPage(text, pages);
  if (plain) return plain;
  const d = (await call('/api/v1/ai/command', JSON.stringify({ text, commands: pages.map(({ id, label }) => ({ id, label })) }), 'application/json')) as { id?: unknown };
  return pages.find((p) => p.id === d.id) ?? null;
};
