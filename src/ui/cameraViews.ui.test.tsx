import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

/**
 * The shop server: camera views (the PIN opens a key; the store room is offline; frames count up),
 * the camera setup (one Tapo answers the scan, its password is hunter2; a Tiandy has two lenses)
 * and the TEMPORARY test video.
 */
function fakeShopServer(o: { packReady?: boolean; pauseAfter?: number; seen?: () => unknown } = {}) {
  const s = {
    asks: [] as { step: string; body: Record<string, unknown> }[], frames: 0, closed: [] as string[],
    logins: {} as Record<string, { user: string; passwordSet: boolean }>, testVideos: {} as Record<string, string>,
  };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const step = String(url).replace('/api/v1/setup', '');
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    s.asks.push({ step, body });
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
    if (body.ownerPin !== '1234') return Response.json({ message: "that is not the owner's PIN" }, { status: 401 });
    const { ownerPin: _pin, ...fields } = body;
    switch (step) {
      case '/cv/views/open': return Response.json({ key: 'k-1', packReady: o.packReady ?? true });
      case '/cv/status': return Response.json({ active: true, phase: 'ready', version: '1' });
      case '/cv/setup': return Response.json({ logins: s.logins, packReady: true });
      case '/cv/test-video': return Response.json({ testVideos: s.testVideos });
      case '/cv/test-video/stop': delete s.testVideos[body.cameraId]; return Response.json({ testVideos: s.testVideos });
      case '/cv/scan': return Response.json({ found: [{ ip: '192.168.1.20', name: 'TP-IPC C200' }] });
      case '/cv/ask': return Response.json(body.password === 'hunter2' || (body.cameraId && s.logins[body.cameraId]?.passwordSet)
        ? { ok: true, streams: [{ path: '/1/2', label: 'Lens 1', width: 640, height: 360 }, { path: '/2/2', label: 'Lens 2', width: 704, height: 576 }] }
        : { ok: false, cause: 'login', message: 'The camera refused the login: check the username and password.' });
      case '/cv/test': return Response.json(body.password === 'hunter2'
        ? { ok: true, jpeg: '/9j/2Q==' }
        : { ok: false, cause: 'login', message: 'The camera refused the login: check the username and password.' });
      case '/cv/cameras': {
        for (const c of body.cameras) if (c.user) s.logins[c.id] = { user: c.user, passwordSet: Boolean(c.password) || Boolean(s.logins[c.id]?.passwordSet) };
        const list = body.cameras.map(({ user: _u, password: _p, loginFrom: _l, ...c }: Record<string, unknown>) => c);
        return Response.json({ events: [ev({ type: 'vision.cameras_set', cameras: list, at: Date.now() })], logins: s.logins });
      }
      case '/cv/zones': return Response.json({ events: [ev({ type: 'vision.zones_set', ...fields, at: Date.now() })] });
    }
    return new Response('{}', { status: 404 });
  }));
  // The page's close goes as a beacon; jsdom has none, so it falls back to fetch.
  Object.defineProperty(navigator, 'sendBeacon', { configurable: true, value: undefined });
  return s;
}

/** The test video's upload goes by XMLHttpRequest, for its progress. */
function fakeUpload(s: ReturnType<typeof fakeShopServer>) {
  const sent: { url: string; pin: string | null; name: string }[] = [];
  class Xhr {
    upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = { onprogress: null };
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    status = 0;
    responseText = '';
    private url = '';
    private headers: Record<string, string> = {};
    open(_m: string, url: string) { this.url = url; }
    setRequestHeader(k: string, v: string) { this.headers[k] = v; }
    send(file: File) {
      sent.push({ url: this.url, pin: this.headers['x-owner-pin'] ?? null, name: file.name });
      const cameraId = new URL(this.url, 'http://x').searchParams.get('cameraId')!;
      setTimeout(() => {
        this.upload.onprogress?.({ lengthComputable: true, loaded: 5, total: 10 });
        s.testVideos[cameraId] = file.name;
        this.status = 200;
        this.responseText = JSON.stringify({ testVideos: s.testVideos });
        this.onload?.();
      }, 20);
    }
  }
  vi.stubGlobal('XMLHttpRequest', Xhr);
  return sent;
}

beforeEach(() => { localStorage.clear(); });
afterEach(() => { act(() => lock()); cleanup(); vi.unstubAllGlobals(); history.replaceState(null, '', '/'); });

const strip = () => screen.getByRole('region', { name: /^Cameras/ });
const panel = () => screen.getByRole('complementary', { name: 'Details' });
async function watch(user: ReturnType<typeof userEvent.setup>, pin = '1234') {
  await user.click(await within(await screen.findByRole('region', { name: /^Cameras/ })).findByRole('button', { name: 'Watch the cameras' }));
  await user.type(screen.getByLabelText("The owner's PIN to watch the cameras"), `${pin}{Enter}`);
}

test('the owner watches every camera: PIN once, a tile per lens, Enter opens one live in the panel, Esc closes it, leaving stops them', async () => {
  const server = fakeShopServer();
  addEvents([ev({ type: 'vision.cameras_set', cameras })]);
  history.replaceState(null, '', '/#vision');
  const user = userEvent.setup();
  render(<Root />);
  await screen.findByRole('heading', { name: 'Computer vision' });
  expect(server.asks.filter((a) => a.step.startsWith('/cv/views'))).toEqual([]); // nothing runs before the owner asks
  await watch(user);
  expect(screen.queryByRole('dialog')).toBeNull();

  // Every camera, used for CV or not; each lens its own tile.
  const front = await within(strip()).findByRole('button', { name: 'Front garden 1, Online. Open in the panel' });
  expect(within(strip()).getByRole('button', { name: 'Kitchen, Online. Open in the panel' })).toBeTruthy();
  expect(within(strip()).getByRole('button', { name: 'Store room, Offline. Open in the panel' })).toBeTruthy();
  expect(front.querySelector('img')!.getAttribute('src')).toBe(`data:image/jpeg;base64,${JPEG}`);
  const frames = server.asks.filter((a) => a.step === '/cv/views/frame');
  expect(frames.every((a) => a.body.key === 'k-1' && !('ownerPin' in a.body) && a.body.mode === 'tile')).toBe(true);

  // Keyboard: arrows move, Enter opens it in the panel, live.
  front.focus();
  await user.keyboard('{ArrowRight}');
  expect(document.activeElement).toBe(within(strip()).getByRole('button', { name: /^Front garden 2/ }));
  await user.keyboard('{ArrowLeft}{Enter}');
  expect(location.hash).toBe('#vision/camera-front-1');
  expect(within(panel()).getByRole('heading', { name: 'Front garden 1' })).toBeTruthy();
  expect(await within(panel()).findByText('Live')).toBeTruthy();
  expect(within(panel()).getByRole('img', { name: 'Front garden 1 now' })).toBeTruthy();
  expect(within(panel()).getByText(/^Detection is Off: Shadow or Live/)).toBeTruthy(); // CV is Off in this shop
  await waitFor(() => expect(server.asks.filter((a) => a.step === '/cv/views/frame' && a.body.mode === 'live').length).toBeGreaterThan(2));
  expect(server.asks.filter((a) => a.body.mode === 'live').every((a) => a.body.cameraId === 'front-1')).toBe(true);
  await user.keyboard('{Escape}');
  await waitFor(() => expect(location.hash).toBe('#vision'));
  expect(within(panel()).getByRole('heading', { name: 'Settings' })).toBeTruthy();

  // Leaving the page stops every view on the shop server.
  await user.click(screen.getByRole('link', { name: 'Today' }));
  await waitFor(() => expect(server.closed).toEqual(['k-1']));
});

test('the panel draws what detection sees: zones in their table colour, people with score and foot point, how old the check is', async () => {
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
  await watch(user);
  await user.click(await within(strip()).findByRole('button', { name: 'Front garden 1, Online. Open in the panel' }));

  const overlay = await within(panel()).findByRole('img', { name: /^Detection: 2 people\. Table 1 free\. Table 2 occupied$/ });
  // Each zone in its table's colour; the table without a zone on this camera is not drawn.
  const zones = [...overlay.querySelectorAll('.overlay__zone')];
  expect(zones.map((z) => [z.getAttribute('data-table'), z.getAttribute('class')])).toEqual([
    ['t1', 'overlay__zone overlay__zone--free'], ['t2', 'overlay__zone overlay__zone--occupied'],
  ]);
  // Each person: the box, its score, and the foot point (centre, 80% down).
  expect(within(panel()).getByText('87%')).toBeTruthy();
  expect(within(panel()).getByText('42%')).toBeTruthy();
  const feet = [...overlay.querySelectorAll('circle')];
  expect(feet).toHaveLength(2);
  expect(Number(feet[0].getAttribute('cx'))).toBeCloseTo(150);
  expect(Number(feet[0].getAttribute('cy'))).toBeCloseTo((0.2 + 0.8 * 0.7) * 562.5);
  expect(within(panel()).getByText(/^Last checked [34] s ago · 2 people$/)).toBeTruthy();
  expect(within(panel()).getByText('Zones on 2 tables')).toBeTruthy();
  // The tiles never carry it.
  expect(within(strip()).queryByRole('img', { name: /^Detection/ })).toBeNull();
});

test('without the CV pack the strip says so, with Activate CV inline; untouched for 2 minutes it pauses until a touch', async () => {
  fakeShopServer({ packReady: false });
  addEvents([ev({ type: 'vision.cameras_set', cameras })]);
  history.replaceState(null, '', '/#vision');
  const user = userEvent.setup();
  render(<Root />);
  await watch(user);
  expect(await within(strip()).findByText('Camera views need the CV pack.')).toBeTruthy();
  expect(within(strip()).getByRole('button', { name: 'Activate CV' })).toBeTruthy();
  cleanup();

  const server = fakeShopServer({ pauseAfter: 4 });
  render(<Root />);
  await watch(user);
  expect(await within(strip()).findByText(/Paused to spare the shop PC/, {}, { timeout: 6000 })).toBeTruthy();
  const before = server.asks.length;
  await user.keyboard('{Shift}');
  await waitFor(() => expect(server.asks.slice(before).some((a) => a.step === '/cv/views/frame' && a.body.use === true)).toBe(true));
  expect(within(strip()).queryByText(/Paused to spare/)).toBeNull();
}, 15_000);

test('a wrong PIN watches nothing and is asked again', async () => {
  const server = fakeShopServer();
  addEvents([ev({ type: 'vision.cameras_set', cameras })]);
  history.replaceState(null, '', '/#vision');
  const user = userEvent.setup();
  render(<Root />);
  await watch(user, '9999');
  expect((await screen.findByRole('alert')).textContent).toBe("that is not the owner's PIN");
  expect(screen.getByLabelText("The owner's PIN to watch the cameras")).toBeTruthy();
  expect(server.asks.some((a) => a.step === '/cv/views/frame')).toBe(false);
});

test('Add camera in the panel: scan, log in, test, save; then it opens and its zone is drawn by keyboard on its live picture', async () => {
  const server = fakeShopServer();
  addEvents([ev({ type: 'table.layout_set', tables: [{ id: 't1', label: '1', seats: 4 }] })]);
  history.replaceState(null, '', '/#vision');
  const user = userEvent.setup();
  render(<Root />);
  await user.click(await within(await screen.findByRole('region', { name: /^Cameras/ })).findByRole('button', { name: '+ Add camera' }));
  expect(location.hash).toBe('#vision/add-camera');
  expect(within(panel()).getByRole('heading', { name: 'Add a camera' })).toBeTruthy();

  await user.click(within(panel()).getByRole('button', { name: 'Scan for cameras' }));
  await user.type(await screen.findByLabelText("The owner's PIN to scan for cameras"), '1234{Enter}');
  await user.click(await within(panel()).findByRole('button', { name: 'Add 192.168.1.20 · TP-IPC C200' }));
  expect((within(panel()).getByLabelText('IP address') as HTMLInputElement).value).toBe('192.168.1.20');
  expect(within(panel()).getByRole('radio', { name: 'Tapo' }).getAttribute('aria-checked')).toBe('true');
  await user.type(within(panel()).getByLabelText('Username'), 'admin');
  await user.type(within(panel()).getByLabelText('Password'), 'nope');
  await user.click(within(panel()).getByRole('button', { name: 'Test' }));
  expect((await within(panel()).findByRole('alert')).textContent).toMatch(/refused the login/);
  await user.clear(within(panel()).getByLabelText('Password'));
  await user.type(within(panel()).getByLabelText('Password'), 'hunter2');
  await user.click(within(panel()).getByRole('button', { name: 'Test' }));
  expect(await within(panel()).findByRole('img', { name: 'What TP-IPC C200 sees' })).toBeTruthy();
  expect(within(panel()).getByRole('switch', { name: 'Use for CV' }).getAttribute('aria-checked')).toBe('true');
  await user.click(within(panel()).getByRole('button', { name: 'Add camera' }));

  const saved = (await vi.waitFor(() => server.asks.find((a) => a.step === '/cv/cameras')!)).body.cameras as Record<string, unknown>[];
  expect(saved).toEqual([expect.objectContaining({ name: 'TP-IPC C200', ip: '192.168.1.20', rtspPath: '/stream2', enabled: true, user: 'admin', password: 'hunter2' })]);
  await vi.waitFor(() => expect(location.hash).toBe(`#vision/camera-${saved[0].id}`));
  expect(JSON.stringify(localStorage)).not.toMatch(/hunter2/);

  // The PIN is known: the views open by themselves; draw the zone on the live picture.
  const draw = within(panel()).getByRole('button', { name: 'Draw a zone' });
  await vi.waitFor(() => expect((draw as HTMLButtonElement).disabled).toBe(false));
  await user.click(draw);
  const frame = within(panel()).getByRole('application', { name: /TP-IPC C200: click the corners/ });
  expect(document.activeElement).toBe(frame);
  await user.keyboard('{ArrowLeft>5/}{ArrowUp>5/} {ArrowRight>10/} {ArrowDown>10/} {ArrowLeft>3/} {Backspace}');
  expect(within(panel()).getByText('3 corners · Enter closes the zone')).toBeTruthy();
  await user.keyboard('{Enter}');
  await user.click(within(within(panel()).getByRole('group', { name: 'Pick its table' })).getByRole('button', { name: 'Table 1' }));
  const zones = (await vi.waitFor(() => server.asks.find((a) => a.step === '/cv/zones')!)).body;
  expect(zones.zones).toEqual([{ id: expect.any(String), tableId: 't1', points: [{ x: 0.4, y: 0.4 }, { x: 0.6, y: 0.4 }, { x: 0.6, y: 0.6 }] }]);
  expect(await within(panel()).findByRole('button', { name: 'Remove the zone of table 1' })).toBeTruthy();
  // Esc with nothing drawn leaves the drawing; the panel stays.
  await user.keyboard('{Escape}');
  expect(within(panel()).getByText('Zones on 1 table')).toBeTruthy();
  expect(location.hash).toBe(`#vision/camera-${saved[0].id}`);
}, 15_000);

test('a 5th camera stays off: "Use for CV" says the limit inline', async () => {
  fakeShopServer();
  addEvents([ev({ type: 'vision.cameras_set', cameras: Array.from({ length: 5 }, (_, i) => ({ id: `c${i}`, name: `Cam ${i + 1}`, ip: `192.168.1.${20 + i}`, rtspPath: '/stream2', enabled: i < 4 })) })]);
  history.replaceState(null, '', '/#vision/camera-c4');
  const user = userEvent.setup();
  render(<Root />);
  // The camera panel comes with the camera code, loaded when first needed.
  await user.click(await within(await screen.findByRole('complementary', { name: 'Details' })).findByText('Connection', {}, { timeout: 4000 }));
  const use = within(panel()).getByRole('switch', { name: 'Use for CV' });
  await user.click(use);
  expect(use.getAttribute('aria-checked')).toBe('false');
  expect(within(panel()).getByRole('status').textContent).toBe('Limit 4 cameras - turn one off first');
  expect((within(panel()).getByRole('button', { name: 'Save camera' }) as HTMLButtonElement).disabled).toBe(true);
});

test('a Tiandy: Ask the camera fills its stream path; its second lens is saved beside it, sharing the login', async () => {
  const server = fakeShopServer();
  history.replaceState(null, '', '/#vision/add-camera');
  const user = userEvent.setup();
  render(<Root />);
  const p = await screen.findByRole('complementary', { name: 'Details' });
  await user.type(await within(p).findByLabelText('Name'), 'Front garden');
  await user.type(within(p).getByLabelText('IP address'), '192.168.1.31');
  await user.click(within(p).getByRole('radio', { name: 'Tiandy' }));
  expect((within(p).getByLabelText(/Stream path/) as HTMLInputElement).value).toBe('');
  expect(within(p).getByRole('button', { name: 'Test' }).hasAttribute('disabled')).toBe(true);
  await user.type(within(p).getByLabelText('Username'), 'admin');
  await user.type(within(p).getByLabelText('Password'), 'hunter2');
  await user.click(within(p).getByRole('button', { name: 'Ask the camera' }));
  await user.type(await screen.findByLabelText("The owner's PIN to ask the camera"), '1234{Enter}');
  expect(await within(p).findByText(/This camera has 2 lenses: each becomes its own camera when you save\./)).toBeTruthy();
  expect((within(p).getByLabelText(/Stream path/) as HTMLInputElement).value).toBe('/1/2');
  expect(server.asks.find((a) => a.step === '/cv/ask')!.body).toEqual({ ownerPin: '1234', ip: '192.168.1.31', user: 'admin', password: 'hunter2' });

  await user.click(within(p).getByRole('button', { name: 'Add camera' }));
  const saved = (await vi.waitFor(() => server.asks.find((a) => a.step === '/cv/cameras')!)).body.cameras as Record<string, unknown>[];
  expect(saved.map((c) => [c.name, c.ip, c.rtspPath])).toEqual([['Front garden', '192.168.1.31', '/1/2'], ['Front garden 2', '192.168.1.31', '/2/2']]);
  expect(saved[1]).toMatchObject({ user: 'admin', password: 'hunter2' }); // typed once, kept for both lenses
});

test('TEMPORARY test video: the file explorer picks a video for a camera; it uploads with the PIN, the tile says "Test video", Stop gives the stream back', async () => {
  const server = fakeShopServer();
  const sent = fakeUpload(server);
  addEvents([ev({ type: 'vision.cameras_set', cameras })]);
  history.replaceState(null, '', '/#vision/camera-front-1');
  const user = userEvent.setup();
  render(<Root />);
  const box = await within(await screen.findByRole('complementary', { name: 'Details' })).findByRole('region', { name: 'Test video (temporary)' });
  expect(within(box).getByText('Testing only')).toBeTruthy();
  const picker = within(box).getByLabelText('A test video for Front garden 1') as HTMLInputElement;
  expect(picker.type).toBe('file');
  expect(picker.accept).toMatch(/video\/\*/);
  const click = vi.spyOn(picker, 'click');
  await user.click(within(box).getByRole('button', { name: 'Test with a video…' }));
  expect(click).toHaveBeenCalled(); // the file explorer opens

  // Too big: said at once, nothing sent.
  const huge = new File(['x'], 'long.mp4', { type: 'video/mp4' });
  Object.defineProperty(huge, 'size', { value: 201 * 1024 * 1024 });
  fireEvent.change(picker, { target: { files: [huge] } });
  expect(within(box).getByRole('alert').textContent).toBe('The video is over 200 MB: pick a shorter one.');

  fireEvent.change(picker, { target: { files: [new File(['frames'], 'cafe.mp4', { type: 'video/mp4' })] } });
  await user.type(await screen.findByLabelText("The owner's PIN to play a test video"), '1234{Enter}');
  expect(await within(box).findByText(/plays in place of Front garden 1\. Turn CV on to see detection\./)).toBeTruthy();
  expect(within(box).getByText('cafe.mp4')).toBeTruthy();
  expect(sent).toEqual([{ url: '/api/v1/setup/cv/test-video/upload?cameraId=front-1&name=cafe.mp4', pin: '1234', name: 'cafe.mp4' }]);
  expect(await within(strip()).findByRole('button', { name: 'Front garden 1, Test video. Open in the panel' })).toBeTruthy();

  await user.click(within(box).getByRole('button', { name: 'Stop test' }));
  expect(await within(box).findByRole('button', { name: 'Test with a video…' })).toBeTruthy();
  expect(server.asks.find((a) => a.step === '/cv/test-video/stop')!.body).toEqual({ ownerPin: '1234', cameraId: 'front-1' });
  expect(await within(strip()).findByRole('button', { name: /^Front garden 1, (Online|Connecting…)\. Open in the panel$/ })).toBeTruthy();
});

test('Ask the camera could not reach it: Add camera still works (saved with no path, for a test video); a phone takes its port', async () => {
  const server = fakeShopServer();
  history.replaceState(null, '', '/#vision/add-camera');
  const user = userEvent.setup();
  render(<Root />);
  const p = await screen.findByRole('complementary', { name: 'Details' });
  await user.type(await within(p).findByLabelText('IP address', {}, { timeout: 4000 }), '192.168.1.40');
  await user.click(within(p).getByRole('radio', { name: 'Tiandy' }));
  await user.click(within(p).getByRole('button', { name: 'Ask the camera' }));
  await user.type(await screen.findByLabelText("The owner's PIN to ask the camera"), '1234{Enter}');
  expect((await within(p).findByRole('alert')).textContent).toMatch(/refused the login/);
  expect(within(p).getByText(/No stream path yet/)).toBeTruthy();
  await user.click(within(p).getByRole('button', { name: 'Add camera' }));
  const first = (await vi.waitFor(() => server.asks.find((a) => a.step === '/cv/cameras')!)).body.cameras as Record<string, unknown>[];
  expect(first).toEqual([expect.objectContaining({ ip: '192.168.1.40', rtspPath: '/' })]);

  // A phone running IP Webcam: its preset path, and the port typed after the IP.
  history.replaceState(null, '', '/#vision/add-camera');
  cleanup();
  render(<Root />);
  const q = await screen.findByRole('complementary', { name: 'Details' });
  await user.click(await within(q).findByRole('radio', { name: 'Phone (IP Webcam)' }, { timeout: 4000 }));
  expect(within(q).getByText(/In IP Webcam, press Start server/)).toBeTruthy();
  expect(within(q).getByLabelText('IP address').getAttribute('placeholder')).toBe('192.168.1.5:8080');
  await user.type(within(q).getByLabelText('Name'), 'My phone');
  await user.type(within(q).getByLabelText('IP address'), '192.168.1.5:8080');
  await user.click(within(q).getByRole('button', { name: 'Add camera' }));
  await user.type(await screen.findByLabelText("The owner's PIN to save the camera"), '1234{Enter}');
  await vi.waitFor(() => expect(server.asks.filter((a) => a.step === '/cv/cameras')).toHaveLength(2));
  const phone = server.asks.filter((a) => a.step === '/cv/cameras')[1].body.cameras as Record<string, unknown>[];
  expect(phone.at(-1)).toMatchObject({ name: 'My phone', ip: '192.168.1.5:8080', rtspPath: '/h264_ulaw.sdp' });
}, 15_000);
