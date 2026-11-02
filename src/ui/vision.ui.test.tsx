import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Actor } from '../domain/auth.ts';
import type { SyncEvent } from '../domain/sync.ts';
import { lock } from '../services/serverAuth.ts';
import { addEvents, readAll } from './eventLog.ts';
import { Root } from './Root.tsx';

const owner: Actor = { id: 'owner-1', name: 'Nisal Vimukthi', role: 'owner' };
let seq = 0;
const ev = (fields: Record<string, unknown>) =>
  ({ id: `srv-${++seq}`, shopId: 'shop-1', at: Date.now() - 60_000, actor: owner, orderNumber: 0, ...fields }) as unknown as SyncEvent;
const square = [{ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.1 }, { x: 0.3, y: 0.6 }];
/** Two tables, one camera; only table 1 has a zone. */
const shop = () => [
  ev({ type: 'table.layout_set', tables: [{ id: 't1', label: '1', seats: 4 }, { id: 't2', label: '2', seats: 2 }] }),
  ev({ type: 'vision.cameras_set', cameras: [{ id: 'c1', name: 'Front', ip: '192.168.1.20', rtspPath: '/stream2', enabled: true }] }),
  ev({ type: 'vision.zones_set', cameraId: 'c1', zones: [{ id: 'z1', tableId: 't1', points: square }] }),
];

/** The shop server's CV endpoints: no pack until Activate, which downloads, then it is ready. */
function fakeShopServer() {
  const s = { settings: [] as Record<string, unknown>[], tables: [] as Record<string, unknown>[], activated: false, looks: 0 };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const step = String(url).replace('/api/v1/setup', '');
    if (!step.startsWith('/cv/')) return new Response('{}', { status: 404 });
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    // Camera views open with the same PIN; their pictures are cameraViews.ui.test.tsx's.
    if (step === '/cv/views/frame') return Response.json({ state: 'starting' });
    if (step === '/cv/views/close') return Response.json({ closed: true });
    if (body.ownerPin !== '1234') return Response.json({ message: "that is not the owner's PIN" }, { status: 401 });
    const { ownerPin: _pin, ...fields } = body;
    if (step === '/cv/views/open') return Response.json({ key: 'k', packReady: true });
    if (step === '/cv/setup') return Response.json({ logins: {}, packReady: true });
    if (step === '/cv/test-video') return Response.json({ testVideos: {} });
    if (step === '/cv/activate') { s.activated = true; return Response.json({ active: true, phase: 'downloading', bytes: 0, total: 50_000_000 }); }
    if (step === '/cv/status') {
      if (!s.activated) return Response.json({ active: false, phase: 'idle' });
      s.looks += 1;
      return Response.json(s.looks < 2 ? { active: true, phase: 'downloading', bytes: 20_000_000, total: 50_000_000 } : { active: true, phase: 'ready', version: '1' });
    }
    if (step === '/cv/settings') { s.settings.push(body); return Response.json({ events: [ev({ type: 'vision.settings_set', ...fields, at: Date.now() })] }); }
    if (step === '/cv/tables') { s.tables.push(body); return Response.json({ events: [ev({ type: 'table.layout_set', ...fields, at: Date.now() })] }); }
    return new Response('{}', { status: 404 });
  }));
  return s;
}

beforeEach(() => { localStorage.clear(); });
afterEach(() => { act(() => lock()); cleanup(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); history.replaceState(null, '', '/'); });

const toggle = () => screen.getByRole('switch', { name: 'Computer vision' });
const panel = () => screen.getByRole('complementary', { name: 'Details' });

test('one page: the switch turns CV on (PIN in the line, the CV pack arrives): On is Live; no CPU slider, no timers; Off again', async () => {
  const server = fakeShopServer();
  addEvents(shop());
  history.replaceState(null, '', '/#vision');
  const user = userEvent.setup();
  render(<Root />);
  expect(await screen.findByRole('heading', { name: 'Computer vision' })).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Computer vision' }).getAttribute('aria-current')).toBe('page');
  // Off: the switch says so (red); the panel holds the settings; no Shadow, no mode to pick.
  expect((await screen.findByRole('switch', { name: 'Computer vision' })).getAttribute('aria-checked')).toBe('false');
  expect(within(toggle()).getByText('Off')).toBeTruthy();
  expect(within(panel()).getByRole('heading', { name: 'Settings' })).toBeTruthy();
  expect(screen.queryByRole('radio', { name: 'Shadow' })).toBeNull();
  // One table seen is enough; the other is said, and stays staff's.
  expect(within(panel()).getByText('Table 2 has no zone: staff set it.')).toBeTruthy();

  // On: the owner's PIN in the page's line, no dialog; the pack downloads; then Live.
  await user.click(toggle());
  const pin = await screen.findByLabelText("The owner's PIN to turn computer vision on");
  expect(screen.queryByRole('dialog')).toBeNull();
  await user.type(pin, '1234{Enter}');
  expect(await screen.findByRole('progressbar', { name: 'Downloading the CV pack' })).toBeTruthy();
  expect(await screen.findByText('Computer vision is on.', {}, { timeout: 4000 })).toBeTruthy();
  expect(server.settings).toEqual([{ ownerPin: '1234', mode: 'live' }]);
  expect(toggle().getAttribute('aria-checked')).toBe('true');
  expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();

  // The rules and the CPU limit are fixed (owner, 2026-10-30): no slider, no timers.
  expect(screen.queryByRole('slider')).toBeNull();
  expect(screen.queryByText('Timers')).toBeNull();

  // Off again by the switch: no PIN asked twice.
  await user.click(toggle());
  expect(await screen.findByText('Computer vision is off.')).toBeTruthy();
  expect(server.settings.at(-1)).toEqual({ ownerPin: '1234', mode: 'off' });
  expect(server.settings).toHaveLength(2);
}, 15_000);

test('the switch waits for a zone: with no table the cameras can see, it says what to do', async () => {
  fakeShopServer();
  addEvents(shop().filter((e) => e.type !== 'vision.zones_set'));
  history.replaceState(null, '', '/#vision');
  render(<Root />);
  const sw = await screen.findByRole('switch', { name: 'Computer vision' });
  expect((sw as HTMLButtonElement).disabled).toBe(true);
  expect(within(panel()).getByText('Draw a zone on a table first.')).toBeTruthy();
});

test('a table opens in the panel: why it is so, its day, its zone; Esc closes it; the owner edits and adds tables there', async () => {
  const server = fakeShopServer();
  addEvents([...shop(), ev({ type: 'table.state_set', tableId: 't2', from: 'free', to: 'reserved', actor: { id: 'n', name: 'Nimal', role: 'cashier' } })]);
  history.replaceState(null, '', '/#vision');
  const user = userEvent.setup();
  render(<Root />);
  const tiles = await screen.findByRole('listbox', { name: 'Tables by number' });
  expect(within(tiles).getAllByRole('option').map((o) => o.getAttribute('aria-label')?.split(',').slice(0, 2).join(','))).toEqual(['Table 1, free', 'Table 2, reserved']);
  expect(within(tiles).getAllByText('no zone')).toHaveLength(1);
  expect(screen.getByText('CV is off: nothing runs.')).toBeTruthy();

  // Arrows move, Enter opens it in the panel; the address says which.
  within(tiles).getAllByRole('option')[0].focus();
  await user.keyboard('{ArrowRight}{Enter}');
  expect(location.hash).toBe('#vision/table-t2');
  expect(within(panel()).getByRole('heading', { name: 'Table 2' })).toBeTruthy();
  expect(within(panel()).getByText(/^Set by Nimal at \d\d:\d\d\.$/)).toBeTruthy(); // Off: the cameras play no part
  expect(within(panel()).getByText('Nobody seated today · 2 seats')).toBeTruthy();
  expect(within(panel()).getByText('No zone yet: the cameras cannot see it.')).toBeTruthy();
  expect(within(panel()).getByRole('button', { name: 'Draw it on Front' })).toBeTruthy();

  // Edit: the PIN in the line, then one table.layout_set with the rest as they were.
  await user.click(within(panel()).getByText('Edit the table'));
  const seats = within(panel()).getByLabelText('Seats');
  await user.clear(seats);
  await user.type(seats, '6');
  await user.click(within(panel()).getByRole('button', { name: 'Save table' }));
  await user.type(await screen.findByLabelText("The owner's PIN to save the table"), '1234{Enter}');
  expect(await within(panel()).findByText('Saved.')).toBeTruthy();
  expect(server.tables[0].tables).toEqual([{ id: 't1', label: '1', seats: 4 }, { id: 't2', label: '2', seats: 6 }]);

  // Esc closes the panel: the settings again.
  await user.keyboard('{Escape}');
  await vi.waitFor(() => expect(location.hash).toBe('#vision'));
  expect(within(panel()).getByRole('heading', { name: 'Settings' })).toBeTruthy();

  // Add table: the next number, then it opens.
  await user.click(screen.getByRole('button', { name: '+ Add table' }));
  expect(within(panel()).getByRole('heading', { name: 'Add a table' })).toBeTruthy();
  expect((within(panel()).getByLabelText('Table') as HTMLInputElement).value).toBe('3');
  await user.click(within(panel()).getByRole('button', { name: 'Add table' }));
  await vi.waitFor(() => expect(location.hash).toMatch(/^#vision\/table-t-/));
  expect(within(panel()).getByRole('heading', { name: 'Table 3' })).toBeTruthy();
  expect(server.tables[1].tables).toHaveLength(3);
});

test('the old #cameras address opens Computer vision', async () => {
  fakeShopServer();
  addEvents(shop());
  history.replaceState(null, '', '/#cameras');
  render(<Root />);
  expect(await screen.findByRole('heading', { name: 'Computer vision' })).toBeTruthy();
});

test('the demo: a shop that ran the old Shadow is Off; On is Live, and Performance shows the cameras now', async () => {
  history.replaceState(null, '', '/?demo#owner');
  const user = userEvent.setup();
  render(<Root />);
  // The Shadow week card is gone from Today.
  await screen.findByRole('article', { name: /^Back camera offline/ });
  expect(screen.queryByRole('article', { name: /^Cameras were right/ })).toBeNull();
  act(() => { location.hash = '#vision'; });
  expect(await screen.findByRole('heading', { name: 'Computer vision' })).toBeTruthy();
  expect((await screen.findByRole('switch', { name: 'Computer vision' })).getAttribute('aria-checked')).toBe('false');
  await user.click(toggle());
  expect(await screen.findByText('Computer vision is on.')).toBeTruthy();
  // Performance: live while the owner watches (the demo's numbers): CPU against the limit, each camera.
  const perf = within(await within(panel()).findByRole('region', { name: 'Performance' }));
  expect(await perf.findByText('Live', {}, { timeout: 4000 })).toBeTruthy();
  expect(perf.getByText(/of 50%/)).toBeTruthy();
  const rows = perf.getAllByRole('row').slice(1).map((r) => r.textContent);
  expect(rows[0]).toMatch(/^Front[\d.]+1\d+ ms$/);
  expect(rows[1]).toMatch(/^Back00–$/);
}, 15_000);

test("on the owner's phone the page is read only, without the cameras' pictures", async () => {
  vi.stubEnv('VITE_SITE', 'cloud');
  history.replaceState(null, '', '/?demo#vision');
  render(<Root />);
  expect(await screen.findByRole('heading', { name: 'Computer vision' })).toBeTruthy();
  expect(screen.queryByRole('navigation', { name: 'Owner sections' })).toBeNull();
  expect(screen.getAllByText('Change it on the shop PC.').length).toBeGreaterThan(0);
  expect((toggle() as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByRole('button', { name: '+ Add table' })).toBeNull();
  expect(screen.queryByRole('button', { name: /Open in the panel/ })).toBeNull();
});

test('the camera worker slowed itself for the CPU limit: the panel says so', async () => {
  addEvents([...shop(), ev({ type: 'vision.heartbeat', cameras: [{ id: 'c1', online: true, fps: 0.5 }], cpu: 17, slowed: true })]);
  history.replaceState(null, '', '/#vision');
  render(<Root />);
  expect(await screen.findByText(/slowed to protect the Register/)).toBeTruthy();
  expect(screen.getByText(/of 50%/).textContent).toMatch(/^CPU 17% of 50%/);
});

test('a manager sees the page but cannot change CV or the tables', async () => {
  localStorage.setItem('cb.sync.token', 'device-token');
  localStorage.setItem('cb.sync.kind', 'counter');
  const stored = shop();
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const u = String(url);
    if (u.includes('/api/v1/login')) return Response.json({ actor: { id: 'ravi', name: 'Ravi', role: 'manager' }, expiresAt: Date.now() + 3_600_000, serverTime: Date.now() });
    if (u.includes('/api/v1/events')) {
      return Response.json({ events: stored.map((event, i) => ({ event, deviceId: 'd', seq: i + 1, receivedAt: 0 })), lastSeq: stored.length, more: false, serverTime: Date.now() });
    }
    return new Response('{}', { status: 404 });
  }));
  history.replaceState(null, '', '/');
  const user = userEvent.setup();
  render(<Root />);
  await user.keyboard('2580');
  await screen.findByRole('button', { name: 'Ravi: switch user' });
  act(() => { location.hash = '#vision'; });
  expect(await screen.findByRole('heading', { name: 'Computer vision' })).toBeTruthy();
  expect(screen.getAllByText('Only the owner changes this.').length).toBeGreaterThan(0);
  expect((toggle() as HTMLButtonElement).disabled).toBe(true);
  await user.click(toggle());
  expect(screen.queryByLabelText(/owner's PIN/)).toBeNull();
  expect(screen.getByText('Only the owner watches the cameras, on the shop PC.')).toBeTruthy();
  await user.click(screen.getByRole('option', { name: /^Table 1/ }));
  expect(within(panel()).getByRole('heading', { name: 'Table 1' })).toBeTruthy();
  expect(within(panel()).queryByText('Edit the table')).toBeNull();
});

test('the first time: Activate computer vision downloads the pack with its progress here, then CV is on, and the switch turns it off', async () => {
  const server = fakeShopServer();
  const pack = { phase: 'idle' as string, looks: 0 };
  const fetchCv = globalThis.fetch;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url) === '/api/v1/setup' && !init?.method) {
      // The pack, without the PIN: idle until Activate, then downloading for a look, then ready.
      if (pack.phase === 'downloading' && ++pack.looks > 1) pack.phase = 'ready';
      const cv = pack.phase === 'downloading' ? { active: true, phase: 'downloading', bytes: 20_000_000, total: 50_000_000 }
        : pack.phase === 'ready' ? { active: true, phase: 'ready', version: '1' } : { active: false, phase: 'idle' };
      return Response.json({ done: true, shop: null, printer: null, printers: [], cloud: false, cv });
    }
    if (String(url).endsWith('/cv/activate')) pack.phase = 'downloading';
    return fetchCv(url, init);
  }));
  addEvents(shop());
  history.replaceState(null, '', '/#vision');
  const user = userEvent.setup();
  render(<Root />);
  const card = await screen.findByRole('region', { name: 'Activate computer vision' });
  expect(within(card).getByRole('heading', { name: 'Computer vision is not activated yet' })).toBeTruthy();
  expect(screen.queryByRole('switch', { name: 'Computer vision' })).toBeNull();

  await user.click(within(card).getByRole('button', { name: 'Activate computer vision' }));
  await user.type(await screen.findByLabelText("The owner's PIN to activate computer vision"), '1234{Enter}');
  expect(await screen.findByRole('progressbar', { name: 'Downloading the CV pack' })).toBeTruthy();
  expect(await screen.findByRole('switch', { name: 'Computer vision' }, { timeout: 4000 })).toBeTruthy();
  expect(screen.queryByRole('region', { name: 'Activate computer vision' })).toBeNull();
  await vi.waitFor(() => expect(server.settings.map((b) => b.mode)).toEqual(['live']));
  await vi.waitFor(() => expect(toggle().getAttribute('aria-checked')).toBe('true'));
  await user.click(toggle());
  await vi.waitFor(() => expect(server.settings.map((b) => b.mode)).toEqual(['live', 'off']));
}, 15_000);

test('the owner sets a table from the panel: occupied, needs cleaning, free or reserved, one event each, with Undo', async () => {
  fakeShopServer();
  addEvents(shop());
  history.replaceState(null, '', '/#vision/table-t1');
  const user = userEvent.setup();
  render(<Root />);
  const states = within(await within(await screen.findByRole('complementary', { name: 'Details' })).findByRole('radiogroup', { name: 'Set it' }));
  expect(states.getAllByRole('radio').map((r) => r.textContent)).toEqual(['Occupied', 'Needs cleaning', 'Free', 'Reserved']);
  expect(states.getByRole('radio', { name: 'Free' }).getAttribute('aria-checked')).toBe('true');
  await user.click(states.getByRole('radio', { name: 'Reserved' }));
  expect(states.getByRole('radio', { name: 'Reserved' }).getAttribute('aria-checked')).toBe('true');
  expect(screen.getByRole('option', { name: /^Table 1, reserved/ })).toBeTruthy();
  expect(within(panel()).getByText('Table 1: reserved.')).toBeTruthy();
  const set = readAll().filter((e) => e.type === 'table.state_set');
  expect(set.map((e) => e.type === 'table.state_set' && [e.tableId, e.from, e.to])).toEqual([['t1', 'free', 'reserved']]);
  await user.click(within(panel()).getByRole('button', { name: 'Undo' }));
  expect(states.getByRole('radio', { name: 'Free' }).getAttribute('aria-checked')).toBe('true');
  expect(readAll().some((e) => e.type === 'table.state_set_undone')).toBe(true);
});
