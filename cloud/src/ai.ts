import type { CloudDevice, D1Like, Kind } from './cloud.ts';
import { HttpError, json, sha256Hex } from './http.ts';
import { VOICE_HINT } from '../../src/domain/voicePages.ts';

/**
 * The language model (SCRUM-142/144), on Cloudflare Workers AI: free within its daily allowance,
 * no key, and the shop's data stays with Cloudflare, which already holds its events. It only ever
 * suggests: it picks one of the commands it is given (never anything else), or turns a short
 * recording into words. Selling never waits for it; without internet the screens work as before.
 */

/** Workers AI as far as the cloud uses it (the Worker's `AI` binding); a fake in tests. */
export interface AiLike {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
}

/**
 * Change a model here; nothing else depends on which one it is. Measure first with
 * `npm run ai-eval` in cloud/ (24 spoken requests against the POS's real page list).
 * 2026-10-24, with example phrases in the page labels: mistral-small-3.1-24b 23/24 right and
 * never a wrong page (~0.5 s); llama-3.3-70b 21/24; llama-3.1-8b-instruct-fp8 20/24 with three
 * wrong pages (~0.2 s); llama-3.2-3b and granite mostly answered nothing; the "thinking"
 * models (glm-4.7-flash, gemma-4) are too slow. A wrong page is worse than none.
 * Speech (SCRUM-181): whisper-large-v3-turbo instead of the first Whisper, because it takes a
 * starting prompt (the shop's words), a language and its own silence filter; ~1 s.
 * Workers AI retires models (llama-3.1-8b-instruct went 2026-05-30): a retired model makes the
 * endpoints answer 503, and the screens work as before.
 */
export const COMMAND_MODEL = '@cf/mistralai/mistral-small-3.1-24b-instruct';
export const SPEECH_MODEL = '@cf/openai/whisper-large-v3-turbo';

/** Model calls per shop per day (cache hits are free). A bug cannot burn the free allowance. */
export const AI_DAILY_CALLS = 300;
/** About 30 seconds of compressed speech; a spoken command is a few seconds (the counter stops at 10). */
export const MAX_AUDIO_BYTES = 1_000_000;
const MAX_COMMANDS = 80;
const TEXT_MAX = 200;
/** A page's description with an example of how staff ask for it. */
const LABEL_MAX = 160;
const COMMAND_ID = /^[\w:.-]{1,64}$/;

export interface AiContext {
  db: D1Like;
  now: () => number;
  ai: AiLike | null;
  dailyCalls?: number;
  authenticate(req: Request, allowed: Kind[]): Promise<CloudDevice>;
}

/** A page or action the person may already use, as their screen lists it. */
export interface PageCommand { id: string; label: string }

/** The shop's date in Sri Lanka (UTC+5:30), for the daily cap. */
const shopDay = (t: number): string => new Date(t + 330 * 60_000).toISOString().slice(0, 10);

const tidy = (text: string): string => text.trim().replace(/\s+/g, ' ');

/** The request and the commands, or why not. */
export const readCommandAsk = (body: unknown): { text: string; commands: PageCommand[] } | string => {
  if (typeof body !== 'object' || body === null) return 'body must be { text, commands }';
  const { text, commands } = body as Record<string, unknown>;
  if (typeof text !== 'string' || !tidy(text) || text.length > TEXT_MAX) return `text must be 1-${TEXT_MAX} characters`;
  if (!Array.isArray(commands) || commands.length === 0 || commands.length > MAX_COMMANDS) return `commands must be 1-${MAX_COMMANDS}`;
  const list: PageCommand[] = [];
  for (const c of commands) {
    const { id, label } = (c ?? {}) as Record<string, unknown>;
    if (typeof id !== 'string' || !COMMAND_ID.test(id) || typeof label !== 'string' || !label.trim() || label.length > LABEL_MAX) {
      return 'each command needs an id and a label';
    }
    list.push({ id, label: tidy(label) });
  }
  return { text: tidy(text), commands: list };
};

/** Part of the cache key: a changed prompt never reuses answers to the old one. */
const PROMPT_VERSION = 3;

/** What the model is asked: one id from the list, or "none". */
export const commandPrompt = (text: string, commands: readonly PageCommand[]) => ({
  messages: [
    {
      role: 'system',
      content: [
        "You open screens in a pizza shop's till. The user says what they want; reply with the id of the one screen that does it.",
        'If no screen does exactly that, reply none. Never pick a screen just because it is the main one.',
        'Reply with the id only, no other words.',
      ].join(' '),
    },
    { role: 'user', content: `Screens:\n${commands.map((c) => `${c.id}: ${c.label}`).join('\n')}\n\nThe user says: ${text}` },
  ],
  max_tokens: 20,
});

/**
 * The words of a text model's reply: older Workers AI models answer `{ response }`, newer ones the
 * OpenAI shape `{ choices: [{ message: { content } }] }`.
 */
export const replyText = (reply: unknown): string => {
  if (typeof reply === 'string') return reply;
  if (typeof reply !== 'object' || reply === null) return '';
  const r = reply as { response?: unknown; choices?: { message?: { content?: unknown } }[] };
  if (typeof r.response === 'string') return r.response;
  const content = Array.isArray(r.choices) ? r.choices[0]?.message?.content : undefined;
  return typeof content === 'string' ? content : '';
};

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The id the model chose, only if it is one of the commands; anything else is none. */
export const pickCommand = (reply: unknown, commands: readonly PageCommand[]): string | null => {
  const out = replyText(reply);
  const said = out.trim().replace(/^["'`\s]+|["'`.\s]+$/g, '').toLowerCase();
  const exact = commands.find((c) => c.id.toLowerCase() === said);
  if (exact) return exact.id;
  // "The id is stock." and the like: only when exactly one id appears on its own.
  const named = commands.filter((c) => new RegExp(`(^|[^\\w:.-])${escapeRe(c.id.toLowerCase())}($|[^\\w:-])`).test(out.toLowerCase()));
  return named.length === 1 ? named[0].id : null;
};

/**
 * What Whisper is asked. English, because the pages are found by their English words: staff mix
 * Sinhala and English ("stock eka pennanna"), and in English mode the English nouns come back as
 * written words instead of Sinhala script. The starting prompt is the shop's words, so "GRN" and
 * "margherita" come back spelled right; the silence filter drops the fans and the oven.
 */
export const speechInput = (audio: Uint8Array) => ({
  audio: base64(audio),
  language: 'en',
  initial_prompt: VOICE_HINT,
  vad_filter: true,
  condition_on_previous_text: false,
});

const base64 = (bytes: Uint8Array): string => {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};

const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** What Whisper says when it heard only a room: never a request. */
const NOT_SPEECH = new Set(['you', 'thank you', 'thanks', 'thanks for watching', 'thank you for watching', 'bye', 'okay', 'hmm', 'uh', 'um']);

/**
 * The words Whisper heard, tidied; empty when nothing usable came back: no text, a word it says to
 * silence, or its starting prompt read back (it does that to a near-silent recording).
 */
export const heardText = (reply: unknown): string => {
  const raw = typeof reply === 'object' && reply !== null ? (reply as { text?: unknown }).text : undefined;
  if (typeof raw !== 'string') return '';
  const text = tidy(raw).slice(0, TEXT_MAX);
  const plain = words(text);
  if (!plain || NOT_SPEECH.has(plain)) return '';
  if (plain.length > 30 && words(VOICE_HINT).includes(plain)) return '';
  return text;
};

export async function aiRoutes(req: Request, url: URL, c: AiContext): Promise<Response | null> {
  if (!url.pathname.startsWith('/api/v1/ai/')) return null;
  if (req.method !== 'POST') throw new HttpError(405, 'server', 'method not allowed');
  const device = await c.authenticate(req, ['shop_server', 'owner', 'manager']);
  const { db, now, ai } = c;

  /** One more model call today, or 429 once the shop's cap is reached. */
  const count = async () => {
    const row = await db.prepare(`INSERT INTO ai_usage (tenant_id, day, calls) VALUES (?, ?, 1)
      ON CONFLICT (tenant_id, day) DO UPDATE SET calls = calls + 1 RETURNING calls`)
      .bind(device.tenantId, shopDay(now())).first<{ calls: number }>();
    if ((row?.calls ?? 0) > (c.dailyCalls ?? AI_DAILY_CALLS)) throw new HttpError(429, 'too_many', "today's language-model limit is used up");
  };
  const model = async (name: string, input: Record<string, unknown>): Promise<unknown> => {
    if (!ai) throw new HttpError(503, 'unavailable', 'the language model is not set up');
    await count();
    try { return await ai.run(name, input); } catch (e) {
      console.error('workers ai', name, e);
      throw new HttpError(503, 'unavailable', 'the language model did not answer');
    }
  };

  if (url.pathname === '/api/v1/ai/command') {
    let body: unknown;
    try { body = await req.json(); } catch { throw new HttpError(400, 'invalid_event', 'body is not JSON'); }
    const ask = readCommandAsk(body);
    if (typeof ask === 'string') throw new HttpError(400, 'invalid_event', ask);
    // The model is part of the question: changing it never reuses an older model's answers.
    const key = await sha256Hex(`command\n${COMMAND_MODEL}\n${PROMPT_VERSION}\n${ask.text.toLowerCase()}\n${ask.commands.map((x) => `${x.id}:${x.label}`).join('\n')}`);
    const hit = await db.prepare('SELECT answer FROM ai_cache WHERE tenant_id = ? AND key = ?').bind(device.tenantId, key).first<{ answer: string }>();
    if (hit) return json(200, { id: (JSON.parse(hit.answer) as { id: string | null }).id, cached: true });
    const id = pickCommand(await model(COMMAND_MODEL, commandPrompt(ask.text, ask.commands)), ask.commands);
    await db.prepare('INSERT OR REPLACE INTO ai_cache (tenant_id, key, answer, created_at) VALUES (?, ?, ?, ?)')
      .bind(device.tenantId, key, JSON.stringify({ id }), now()).run();
    return json(200, { id, cached: false });
  }

  if (url.pathname === '/api/v1/ai/transcribe') {
    const type = req.headers.get('content-type') ?? '';
    if (!type.startsWith('audio/') && type !== 'application/octet-stream') throw new HttpError(400, 'invalid_event', 'send the recording as audio');
    const audio = new Uint8Array(await req.arrayBuffer());
    if (audio.length === 0) throw new HttpError(400, 'invalid_event', 'the recording is empty');
    if (audio.length > MAX_AUDIO_BYTES) throw new HttpError(413, 'invalid_event', 'the recording is too long');
    // The recording is used for this answer only and never stored.
    return json(200, { text: heardText(await model(SPEECH_MODEL, speechInput(audio))) });
  }

  throw new HttpError(404, 'server', 'no such endpoint');
}
