import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Actor } from '../domain/auth.ts';
import type { SyncEvent } from '../domain/sync.ts';
import { lock } from '../services/serverAuth.ts';
import { addEvents } from './eventLog.ts';
import { Root } from './Root.tsx';

const owner: Actor = { id: 'owner-1', name: 'Nisal Vimukthi', role: 'owner' };
let seq = 0;
const ev = (fields: Record<string, unknown>) =>
  ({ id: `srv-${++seq}`, shopId: 'shop-1', at: Date.now() - 60_000, actor: owner, orderNumber: 0, ...fields }) as unknown as SyncEvent;
/** The shop's Tiandy cameras: the front garden's two lenses, the store room and the kitchen; only one used for CV. */
const cameras = [
  { id: 'front-1', name: 'Front garden 1', ip: '192.168.1.31', rtspPath: '/1/2', enabled: true },
  { id: 'front-2', name: 'Front garden 2', ip: '192.168.1.31', rtspPath: '/2/2', enabled: false },
  { id: 'store', name: 'Store room', ip: '192.168.1.32', rtspPath: '/1/2', enabled: false },
  { id: 'kitchen', name: 'Kitchen', ip: '192.168.1.34', rtspPath: '/1/2', enabled: false },
];
const JPEG = 'iVBORw0KGgo='; // any bytes: the screen only shows them

/** The shop server's camera views: the PIN opens a key; the store room is offline; frames count up. */
function fakeShopServer(o: { packReady?: boolean; pauseAfter?: number; seen?: () => unknown } = {}) {
  const s = { asks: [] as { step: string; body: Record<string, unknown> }[], frames: 0, closed: [] as string[], beacons: 0 };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const step = String(url).replace('/api/v1/setup', '');
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    s.asks.push({ step, body });
    if (step === '/cv/views/open') {
      if (body.ownerPin !== '1234') return Response.json({ message: "that is not the owner's PIN" }, { status: 401 });
      return Response.json({ key: 'k-1', packReady: o.packReady ?? true });
    }
    if (step === '/cv/views/frame') {
      if (body.key !== 'k-1') return Response.json({ message: "the owner's PIN is needed again" }, { status: 401 });
      if (o.pauseAfter !== undefined && s.frames >= o.pauseAfter && !body.use) return Response.json({ state: 'paused' });
      if (body.cameraId === 'store') return Response.json({ state: 'offline', cause: 'rtsp', message: 'The camera did not answer: check the IP address, and turn RTSP on in the camera’s app.' });
      if (body.mode === 'live') await new Promise((r) => setTimeout(r, 40));
      s.frames += 1;
      const seen = body.mode === 'live' ? o.seen?.() : undefined;
      return Response.json({ state: 'frame', seq: s.frames, at: Date.now(), jpeg: JPEG, ...(seen ? { seen } : {}) });
    }
    if (step === '/cv/views/close') { s.closed.push(body.key); return Response.json({ closed: true }); }
    return new Response('{}', { status: 404 });
  }));
  // The page's close goes as a beacon; jsdom has none, so it falls back to fetch.
  Object.defineProperty(navigator, 'sendBeacon', { configurable: true, value: undefined });
  return s;
}

beforeEach(() => { localStorage.clear(); });
afterEach(() => { act(() => lock()); cleanup(); vi.unstubAllGlobals(); history.replaceState(null, '', '/'); });

test('the owner watches every camera: PIN once, a tile per lens, Enter opens one large and live, Esc goes back, leaving stops them', async () => {
  const server = fakeShopServer();
  addEvents([ev({ type: 'vision.cameras_set', cameras })]);
  history.replaceState(null, '', '/#vision');
  const user = userEvent.setup();
  render(<Root />);
  const part = await screen.findByRole('region', { name: 'Camera views' });
  expect(within(part).getByText(/4 views\. They run only while you watch\./)).toBeTruthy();
  expect(server.asks.filter((a) => a.step.startsWith('/cv/views'))).toEqual([]); // nothing runs before the owner asks

  await user.click(within(part).getByRole('button', { name: 'Watch the cameras' }));
  const pin = within(part).getByLabelText("The owner's PIN to watch the cameras");
  expect(screen.queryByRole('dialog')).toBeNull();
  await user.type(pin, '1234{Enter}');

  // Every camera, used for CV or not; each lens its own tile.
  const front = await within(part).findByRole('button', { name: 'Front garden 1, Online. Open large' });
  expect(within(part).getByRole('button', { name: 'Front garden 2, Online. Open large' })).toBeTruthy();
  expect(within(part).getByRole('button', { name: 'Kitchen, Online. Open large' })).toBeTruthy();
  const store = within(part).getByRole('button', { name: 'Store room, Offline. Open large' });
  expect(within(store).getByText(/turn RTSP on/)).toBeTruthy();
  expect(front.querySelector('img')!.getAttribute('src')).toBe(`data:image/jpeg;base64,${JPEG}`);
  const frames = server.asks.filter((a) => a.step === '/cv/views/frame');
  expect(frames.every((a) => a.body.key === 'k-1' && !('ownerPin' in a.body) && a.body.mode === 'tile')).toBe(true);

  // Keyboard: arrows move, Enter opens it large and live; Esc goes back to the same tile.
  front.focus();
  await user.keyboard('{ArrowRight}');
  expect(document.activeElement).toBe(within(part).getByRole('button', { name: /^Front garden 2/ }));
  await user.keyboard('{ArrowLeft}{Enter}');
  const large = await within(part).findByRole('figure', { name: 'Front garden 1, large' });
  expect(document.activeElement).toBe(within(large).getByRole('button', { name: /Back/ }));
  expect(await within(large).findByText('Live')).toBeTruthy();
  expect(within(large).getByRole('img', { name: 'Front garden 1 now' })).toBeTruthy();
  await waitFor(() => expect(server.asks.filter((a) => a.step === '/cv/views/frame' && a.body.mode === 'live').length).toBeGreaterThan(2));
  expect(server.asks.filter((a) => a.body.mode === 'live').every((a) => a.body.cameraId === 'front-1')).toBe(true);
  await user.keyboard('{Escape}');
  expect(within(part).queryByRole('figure')).toBeNull();
  expect(document.activeElement).toBe(within(part).getByRole('button', { name: /^Front garden 1/ }));

  // Leaving the page stops every view on the shop server.
  await user.click(screen.getByRole('link', { name: 'Today' }));
  await waitFor(() => expect(server.closed).toEqual(['k-1']));
});

test('the large view draws what detection sees: zones in their table colour, people with score and foot point, how old the check is', async () => {
  const detectedAt = Date.now() - 3000; // the motion gate has reused it for 3 s
  fakeShopServer({ seen: () => ({ at: Date.now(), detectedAt, persons: [
    { x1: 0.1, y1: 0.2, x2: 0.2, y2: 0.9, score: 0.87 },
    { x1: 0.6, y1: 0.1, x2: 0.7, y2: 0.8, score: 0.42 },
  ] }) });
  const box = (x: number) => [{ x, y: 0.3 }, { x: x + 0.3, y: 0.3 }, { x: x + 0.3, y: 0.95 }, { x, y: 0.95 }];
  addEvents([
    ev({ type: 'table.layout_set', tables: [{ id: 't1', label: '1', seats: 2 }, { id: 't2', label: '2', seats: 4 }, { id: 't3', label: '3', seats: 4 }] }),
    ev({ type: 'vision.cameras_set', cameras }),
    ev({ type: 'vision.zones_set', cameraId: 'front-1', zones: [{ id: 'z1', tableId: 't1', points: box(0.05) }, { id: 'z2', tableId: 't2', points: box(0.55) }] }),
    ev({ type: 'table.state_set', tableId: 't2', from: 'free', to: 'occupied' }),
  ]);
  history.replaceState(null, '', '/#vision');
  const user = userEvent.setup();
  render(<Root />);
  const part = await screen.findByRole('region', { name: 'Camera views' });
  await user.click(within(part).getByRole('button', { name: 'Watch the cameras' }));
  await user.type(within(part).getByLabelText("The owner's PIN to watch the cameras"), '1234{Enter}');
  await user.click(await within(part).findByRole('button', { name: 'Front garden 1, Online. Open large' }));
  const large = await within(part).findByRole('figure', { name: 'Front garden 1, large' });

  const overlay = await within(large).findByRole('img', { name: /^Detection: 2 people\. Table 1 free\. Table 2 occupied$/ });
  // Each zone in its table's colour; the table without a zone on this camera is not drawn.
  const zones = [...overlay.querySelectorAll('.overlay__zone')];
  expect(zones.map((z) => [z.getAttribute('data-table'), z.getAttribute('class')])).toEqual([
    ['t1', 'overlay__zone overlay__zone--free'], ['t2', 'overlay__zone overlay__zone--occupied'],
  ]);
  expect(within(large).getByText('Table 2')).toBeTruthy();
  // Each person: the box, its score, and the foot point (centre, 80% down).
  expect(within(large).getByText('87%')).toBeTruthy();
  expect(within(large).getByText('42%')).toBeTruthy();
  const feet = [...overlay.querySelectorAll('circle')];
  expect(feet).toHaveLength(2);
  expect(Number(feet[0].getAttribute('cx'))).toBeCloseTo(150);
  expect(Number(feet[0].getAttribute('cy'))).toBeCloseTo((0.2 + 0.8 * 0.7) * 562.5);
  expect(within(large).getByText(/^Last checked [34] s ago · 2 people$/)).toBeTruthy();

  // Back to the tiles: no overlay there.
  await user.keyboard('{Escape}');
  expect(within(part).queryByRole('img', { name: /^Detection/ })).toBeNull();
});

test('without the CV pack the section says so, with Activate CV inline; untouched for 2 minutes it pauses until a touch', async () => {
  fakeShopServer({ packReady: false });
  addEvents([ev({ type: 'vision.cameras_set', cameras })]);
  history.replaceState(null, '', '/#vision');
  const user = userEvent.setup();
  render(<Root />);
  const part = await screen.findByRole('region', { name: 'Camera views' });
  await user.click(within(part).getByRole('button', { name: 'Watch the cameras' }));
  await user.type(within(part).getByLabelText("The owner's PIN to watch the cameras"), '1234{Enter}');
  expect(await within(part).findByText('Camera views need the CV pack.')).toBeTruthy();
  expect(within(part).getByRole('button', { name: 'Activate CV' })).toBeTruthy();
  cleanup();

  const server = fakeShopServer({ pauseAfter: 4 });
  render(<Root />);
  const again = await screen.findByRole('region', { name: 'Camera views' });
  await user.click(within(again).getByRole('button', { name: 'Watch the cameras' }));
  await user.type(within(again).getByLabelText("The owner's PIN to watch the cameras"), '1234{Enter}');
  expect(await within(again).findByText(/Paused to spare the shop PC/, {}, { timeout: 6000 })).toBeTruthy();
  const before = server.asks.length;
  await user.keyboard('{Shift}');
  await waitFor(() => expect(server.asks.slice(before).some((a) => a.step === '/cv/views/frame' && a.body.use === true)).toBe(true));
  expect(within(again).queryByText(/Paused to spare/)).toBeNull();
}, 15_000);

test('a wrong PIN watches nothing; managers only read that the owner watches', async () => {
  const server = fakeShopServer();
  addEvents([ev({ type: 'vision.cameras_set', cameras })]);
  history.replaceState(null, '', '/#vision');
  const user = userEvent.setup();
  render(<Root />);
  const part = await screen.findByRole('region', { name: 'Camera views' });
  await user.click(within(part).getByRole('button', { name: 'Watch the cameras' }));
  await user.type(within(part).getByLabelText("The owner's PIN to watch the cameras"), '9999{Enter}');
  expect((await within(part).findByRole('alert')).textContent).toBe("that is not the owner's PIN");
  expect(server.asks.some((a) => a.step === '/cv/views/frame')).toBe(false);
});
