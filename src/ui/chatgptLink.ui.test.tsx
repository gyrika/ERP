import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ChatGptLink } from './ChatGptLink.tsx';

// The owner's Disconnect button (SCRUM-197).

type Answer = { status: number; body?: unknown };
const cloud = (answers: Record<string, Answer>) => {
  const calls: { path: string; body?: string; auth: string | null }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = url.replace('/api/v1/mcp/', '');
    calls.push({ path, body: init?.body as string | undefined, auth: new Headers(init?.headers).get('authorization') });
    const a = answers[path] ?? { status: 404 };
    return new Response(JSON.stringify(a.body ?? {}), { status: a.status });
  }));
  return calls;
};

beforeEach(() => { localStorage.setItem('cb.owner.token', 'owner-secret'); });
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  localStorage.clear();
});

const connected = { connection: { status: 200, body: { connected: true } } };

test('nothing shows when ChatGPT is not connected, the server is off, or there is no internet', async () => {
  const quiet: Record<string, Answer>[] = [{ connection: { status: 200, body: { connected: false } } }, {}];
  for (const answers of quiet) {
    const calls = cloud(answers);
    const { unmount } = render(<ChatGptLink />);
    await waitFor(() => expect(calls.length).toBe(1));
    await Promise.resolve();
    expect(screen.queryByRole('button', { name: 'Disconnect' })).toBeNull();
    unmount();
  }
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
  render(<ChatGptLink />);
  await Promise.resolve();
  expect(screen.queryByRole('button', { name: 'Disconnect' })).toBeNull();
});

test('Disconnect: one tap, no dialog, says so only once the cloud has done it, and offers Undo', async () => {
  let finish!: (r: Response) => void;
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    calls.push(url);
    if (url.endsWith('/connection')) return Promise.resolve(Response.json({ connected: true }));
    if (url.endsWith('/disconnect')) return new Promise<Response>((resolve) => { finish = resolve; });
    return Promise.resolve(Response.json({ ok: true }));
  }));
  render(<ChatGptLink />);
  fireEvent.click(await screen.findByRole('button', { name: 'Disconnect' }));

  expect((screen.getByRole('button', { name: 'Disconnecting…' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByText('ChatGPT disconnected')).toBeNull();
  expect(screen.queryByRole('dialog')).toBeNull();

  finish(Response.json({ at: 1234 }));
  expect(await screen.findByText('ChatGPT disconnected')).toBeTruthy();
  expect(screen.queryByText("ChatGPT can read your sales.")).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
  expect(await screen.findByText("ChatGPT can read your sales.")).toBeTruthy();
  expect(screen.queryByText('ChatGPT disconnected')).toBeNull();
  expect(calls.at(-1)).toBe('/api/v1/mcp/reconnect');
});

test('a failed Disconnect says plainly that ChatGPT can still read', async () => {
  cloud({ ...connected, disconnect: { status: 500 } });
  render(<ChatGptLink />);
  fireEvent.click(await screen.findByRole('button', { name: 'Disconnect' }));
  expect((await screen.findByRole('alert')).textContent).toMatch(/ChatGPT can still read/);
  expect(screen.getByRole('button', { name: 'Disconnect' })).toBeTruthy();
  expect(screen.queryByText('ChatGPT disconnected')).toBeNull();
});

test('a failed Undo says it stays disconnected', async () => {
  cloud({ ...connected, disconnect: { status: 200, body: { at: 5 } }, reconnect: { status: 410 } });
  render(<ChatGptLink />);
  fireEvent.click(await screen.findByRole('button', { name: 'Disconnect' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Undo' }));
  expect((await screen.findByRole('alert')).textContent).toMatch(/stays disconnected/);
  expect(screen.queryByRole('button', { name: 'Disconnect' })).toBeNull();
});

test('every call carries the owner link, and Undo names the disconnect it reverses', async () => {
  const calls = cloud({ ...connected, disconnect: { status: 200, body: { at: 77 } }, reconnect: { status: 200 } });
  render(<ChatGptLink />);
  fireEvent.click(await screen.findByRole('button', { name: 'Disconnect' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Undo' }));
  await screen.findByRole('button', { name: 'Disconnect' });
  expect(calls.map((c) => c.path)).toEqual(['connection', 'disconnect', 'reconnect']);
  expect(calls.every((c) => c.auth === 'Bearer owner-secret')).toBe(true);
  expect(calls[2].body).toBe(JSON.stringify({ at: 77 }));
});
