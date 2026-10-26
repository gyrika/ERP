import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Root } from './Root.tsx';

/** The shop server's CV pack endpoints: the first pack arrives damaged, the second one is fine. */
function fakeShopServer() {
  const s = { active: false, phase: 'idle', tries: 0, asked: [] as string[] };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const step = String(url).replace('/api/v1/setup', '');
    if (!step.startsWith('/cv/')) return new Response('{}', { status: 404 });
    s.asked.push(step);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (body.ownerPin !== '1234') return Response.json({ message: "that is not the owner's PIN" }, { status: 401 });
    if (step === '/cv/activate') { s.active = true; s.tries += 1; return Response.json({ active: true, phase: 'downloading', bytes: 0, total: 50_000_000 }); }
    if (!s.active) return Response.json({ active: false, phase: 'idle' });
    return Response.json(s.tries === 1
      ? { active: true, phase: 'failed', reason: 'models/yolox_nano.onnx is damaged (its sha256 does not match the manifest)' }
      : { active: true, phase: 'ready', version: '1' });
  }));
  return s;
}

beforeEach(() => { localStorage.clear(); history.replaceState(null, '', '/#cameras'); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

test("CV is off until the owner activates it; a damaged pack says why, and Retry fetches it again", async () => {
  const server = fakeShopServer();
  const user = userEvent.setup();
  render(<Root />);
  const pin = await screen.findByLabelText("The owner's PIN");
  await user.type(pin, '9999{Enter}');
  expect((await screen.findByRole('alert')).textContent).toMatch(/not the owner's PIN/);
  await user.clear(pin);
  await user.type(pin, '1234{Enter}');

  expect(await screen.findByText(/Table detection is off/)).toBeTruthy();
  expect(server.asked).toEqual(['/cv/status', '/cv/status']); // looking only, nothing downloaded yet
  await user.click(screen.getByRole('button', { name: 'Activate CV' }));
  expect(screen.getByRole('progressbar', { name: 'Downloading the CV pack' })).toBeTruthy();
  expect(screen.getByText('0.0 MB of 50 MB')).toBeTruthy();

  expect((await screen.findByRole('alert', {}, { timeout: 4000 })).textContent).toMatch(/yolox_nano\.onnx is damaged/);
  expect(screen.queryByRole('dialog')).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByText(/Table detection is ready/, {}, { timeout: 4000 })).toBeTruthy();
  expect(server.tries).toBe(2);
});
