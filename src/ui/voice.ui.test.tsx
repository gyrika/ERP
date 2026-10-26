import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { Root } from './Root.tsx';

/** A microphone that records whatever is held, for as long as it is held. */
class FakeRecorder {
  state = 'inactive';
  mimeType = 'audio/webm';
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  constructor() { recorders.push(this); }
  start() { this.state = 'recording'; }
  stop() { this.state = 'inactive'; this.ondataavailable?.({ data: new Blob(['speech']) }); this.onstop?.(); }
}

const recorders: FakeRecorder[] = [];
let clock = 0;
const asked: { path: string; body: unknown }[] = [];
const ASKS_MODEL = 'do we have enough chicken';
let heard = ASKS_MODEL;
let picked: string | null = 'items';

beforeEach(() => {
  localStorage.clear();
  history.replaceState(null, '', '/');
  asked.length = 0;
  recorders.length = 0;
  vi.stubGlobal('MediaRecorder', FakeRecorder);
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async (c: MediaStreamConstraints) => { asked.push({ path: 'mic', body: c }); return { getTracks: () => [{ stop() {} }] }; } } });
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (path.startsWith('/api/v1/ai/')) asked.push({ path, body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body });
    if (path === '/api/v1/ai/transcribe') return new Response(JSON.stringify({ text: heard }));
    if (path === '/api/v1/ai/command') return new Response(JSON.stringify({ id: picked, cached: false }));
    return new Response('{}', { status: 404 });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

/** Hold F9 for a second while "speaking", then let go. */
const say = async () => {
  await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F9' })); });
  clock += 1000;
  await act(async () => { window.dispatchEvent(new KeyboardEvent('keyup', { key: 'F9' })); });
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
};

const key = async (type: 'keydown' | 'keyup', k = 'F9') => {
  await act(async () => { window.dispatchEvent(new KeyboardEvent(type, { key: k })); });
};
const settle = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 20)); }); };
const sent = () => asked.filter((a) => a.path.startsWith('/api/'));

test('hold F9, say it, let go: the page opens; Esc goes back to where it was', async () => {
  render(<Root />);
  await say();
  expect(location.hash).toBe('#items');
  expect(screen.getByRole('status', { name: '' }).textContent).toContain(`"${ASKS_MODEL}" → Stock`);
  // The model was offered only pages this person may open, without their hash.
  const offer = asked.find((a) => a.path === '/api/v1/ai/command')!.body as { commands: { id: string; label: string }[] };
  expect(offer.commands.map((c) => c.id)).toContain('items');
  expect(Object.keys(offer.commands[0])).toEqual(['id', 'label']);

  await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
  expect(location.hash).toBe('');
});

test('plain words open their page without asking the model', async () => {
  heard = 'Open suppliers.';
  render(<Root />);
  await say();
  expect(location.hash).toBe('#suppliers');
  expect(sent().map((a) => a.path)).toEqual(['/api/v1/ai/transcribe']);
  heard = ASKS_MODEL;
});

test('no page for it: it says so and stays where it is', async () => {
  heard = 'give a refund';
  picked = null;
  render(<Root />);
  await say();
  expect(location.hash).toBe('');
  expect(screen.getByText('"give a refund": no page for that')).toBeTruthy();
  heard = ASKS_MODEL;
  picked = 'items';
});

test('the microphone is asked for one cleaned-up channel', async () => {
  render(<Root />);
  await say();
  expect(asked[0]).toEqual({ path: 'mic', body: { audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } } });
});

test('tap F9 and it keeps listening; a second F9 sends', async () => {
  render(<Root />);
  await key('keydown');
  clock += 100;
  await key('keyup');
  expect(screen.getByRole('status').textContent).toContain('Listening');
  expect(sent()).toHaveLength(0);
  clock += 2000;
  await key('keydown');
  await settle();
  expect(location.hash).toBe('#items');
});

test('Esc while listening drops it: nothing is sent, nothing is said', async () => {
  render(<Root />);
  await key('keydown');
  clock += 100;
  await key('keyup');
  await key('keydown', 'Escape');
  await settle();
  expect(sent()).toHaveLength(0);
  expect(screen.queryByRole('status')).toBeNull();
  expect(location.hash).toBe('');
});

test('one request at a time: F9 while the first is being read starts nothing', async () => {
  let answer!: () => void;
  const slow = new Promise<void>((r) => { answer = r; });
  const real = fetch;
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/v1/ai/transcribe') await slow;
    return real(path, init);
  }));
  render(<Root />);
  await say();
  await key('keydown');
  await key('keyup');
  expect(recorders).toHaveLength(1);
  answer();
  await settle();
  expect(location.hash).toBe('#items');
  expect(sent().filter((a) => a.path === '/api/v1/ai/transcribe')).toHaveLength(1);
});

test('no shop server, or not allowed: one plain sentence, and it stays put', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
  render(<Root />);
  await say();
  expect(screen.getByText('Voice needs the shop server')).toBeTruthy();
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 403 })));
  clock += 10_000;
  await say();
  expect(screen.getByText('Voice works on the shop PC once it is connected')).toBeTruthy();
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })));
  await say();
  expect(screen.getByText('Voice needs the internet right now')).toBeTruthy();
  expect(location.hash).toBe('');
});

test('no microphone, or it is not allowed: it says so', async () => {
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => { throw new DOMException('denied', 'NotAllowedError'); } } });
  render(<Root />);
  await say();
  expect(screen.getByText('No microphone, or it is not allowed')).toBeTruthy();
  expect(sent()).toHaveLength(0);
});

/** A microphone in a room: each reading is whatever loudness the test sets. */
function fakeRoom() {
  const room = { level: 0.005 };
  class FakeAudioContext {
    createAnalyser() {
      return { fftSize: 0, connect() {}, getFloatTimeDomainData(a: Float32Array) { a.fill(room.level); } };
    }
    createMediaStreamSource() { return { connect() {} }; }
    close() { return Promise.resolve(); }
  }
  vi.stubGlobal('AudioContext', FakeAudioContext);
  return room;
}

/** Lets the room go on for `ms`, a reading every 50 ms. */
const pass = async (ms: number) => {
  for (let t = 0; t < ms; t += 50) {
    clock += 50;
    await act(async () => { vi.advanceTimersByTime(50); });
  }
};

test('tapped, it stops by itself a moment after the speaker stops, and sends', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  try {
    const room = fakeRoom();
    render(<Root />);
    await key('keydown');
    clock += 100;
    await key('keyup');
    await pass(300);
    room.level = 0.25;
    await pass(1200);
    room.level = 0.005;
    await pass(700);
    expect(sent()).toHaveLength(0); // a pause, not the end
    await pass(400);
    await settle();
    expect(location.hash).toBe('#items');
  } finally { vi.useRealTimers(); }
});

test("tapped in a busy room and nobody speaks: nothing is sent, and it says it didn't catch that", async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  try {
    const room = fakeRoom();
    room.level = 0.05;
    render(<Root />);
    await key('keydown');
    clock += 100;
    await key('keyup');
    await pass(5_200);
    await settle();
    expect(sent()).toHaveLength(0);
    expect(screen.getByText('Did not catch that. Press F9 and try again')).toBeTruthy();
  } finally { vi.useRealTimers(); }
});

test('held, a pause does not cut the speaker off; letting go sends', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  try {
    const room = fakeRoom();
    render(<Root />);
    await key('keydown');
    await pass(200);
    room.level = 0.25;
    await pass(800);
    room.level = 0.005;
    await pass(2000);
    expect(sent()).toHaveLength(0);
    await key('keyup');
    await settle();
    expect(location.hash).toBe('#items');
  } finally { vi.useRealTimers(); }
});
