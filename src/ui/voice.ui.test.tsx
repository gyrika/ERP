import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { Root } from './Root.tsx';

/** A microphone that records whatever is held, for as long as it is held. */
class FakeRecorder {
  state = 'inactive';
  mimeType = 'audio/webm';
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  start() { this.state = 'recording'; }
  stop() { this.state = 'inactive'; this.ondataavailable?.({ data: new Blob(['speech']) }); this.onstop?.(); }
}

let clock = 0;
const asked: { path: string; body: unknown }[] = [];
let heard = 'is the mozzarella running low';
let picked: string | null = 'items';

beforeEach(() => {
  localStorage.clear();
  history.replaceState(null, '', '/');
  asked.length = 0;
  vi.stubGlobal('MediaRecorder', FakeRecorder);
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } });
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

test('hold F9, say it, let go: the page opens; Esc goes back to where it was', async () => {
  render(<Root />);
  await say();
  expect(location.hash).toBe('#items');
  expect(screen.getByRole('status', { name: '' }).textContent).toContain('"is the mozzarella running low" → Stock');
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
  expect(asked.map((a) => a.path)).toEqual(['/api/v1/ai/transcribe']);
  heard = 'is the mozzarella running low';
});

test('no page for it: it says so and stays where it is', async () => {
  heard = 'give a refund';
  picked = null;
  render(<Root />);
  await say();
  expect(location.hash).toBe('');
  expect(screen.getByText('"give a refund": no page for that')).toBeTruthy();
  heard = 'is the mozzarella running low';
  picked = 'items';
});

test('a tap on F9 is not speech: nothing is sent', async () => {
  render(<Root />);
  await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F9' })); });
  clock += 100;
  await act(async () => { window.dispatchEvent(new KeyboardEvent('keyup', { key: 'F9' })); });
  expect(screen.getByText('Hold F9 while you speak')).toBeTruthy();
  expect(asked).toHaveLength(0);
});
