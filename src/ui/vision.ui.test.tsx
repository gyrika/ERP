import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
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

const radio = (name: string) => screen.getByRole('radio', { name });
const toggle = () => screen.getByRole('switch', { name: 'Computer vision' });
const panel = () => screen.getByRole('complementary', { name: 'Details' });

test('one page: the switch turns CV on (PIN in the line, the CV pack arrives, Shadow), Live waits for every zone, the CPU limit is one event', async () => {
  const server = fakeShopServer();
  addEvents(shop());
  history.replaceState(null, '', '/#vision');
  const user = userEvent.setup();
  render(<Root />);
  expect(await screen.findByRole('heading', { name: 'Computer vision' })).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Computer vision' }).getAttribute('aria-current')).toBe('page');
  expect(screen.queryByRole('link', { name: 'How to set up' })).toBeNull();
  // Off: the switch says so (red); the panel holds the settings.
  expect(toggle().getAttribute('aria-checked')).toBe('false');
  expect(within(toggle()).getByText('Off')).toBeTruthy();
  expect(within(panel()).getByRole('heading', { name: 'Settings' })).toBeTruthy();

  // Live: not until table 2 has a zone, said in the panel with the way to it.
  expect(radio('Live').getAttribute('aria-disabled')).toBe('true');
  expect(screen.getByText('Live: Table 2 has no zone yet.')).toBeTruthy();
  await user.click(radio('Live'));
  expect(screen.queryByLabelText(/owner's PIN/)).toBeNull();

  // On: the owner's PIN in the page's line, no dialog; the pack downloads; then Shadow, the first time.
  await user.click(toggle());
  const pin = await screen.findByLabelText("The owner's PIN to switch to Shadow");
  expect(screen.queryByRole('dialog')).toBeNull();
  await user.type(pin, '1234{Enter}');
  expect(await screen.findByRole('progressbar', { name: 'Downloading the CV pack' })).toBeTruthy();
  expect(await screen.findByText('Shadow on.', {}, { timeout: 4000 })).toBeTruthy();
  expect(server.settings).toEqual([{ ownerPin: '1234', mode: 'shadow', shortVisitS: 180, leftCheckS: 10, autoFreeS: 300, cpuLimit: 15 }]);
  expect(toggle().getAttribute('aria-checked')).toBe('true');
  expect(radio('Shadow').getAttribute('aria-checked')).toBe('true');
  expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();

  // The CPU limit: 5% to 50% in steps of 5; one event once the slider settles; the PIN is known now.
  const cpu = screen.getByRole('slider');
  expect([cpu.getAttribute('min'), cpu.getAttribute('max'), cpu.getAttribute('step'), (cpu as HTMLInputElement).value]).toEqual(['5', '50', '5', '15']);
  fireEvent.change(cpu, { target: { value: '25' } });
  expect(await screen.findByText('CPU limit 25%.', {}, { timeout: 3000 })).toBeTruthy();
  expect(server.settings.at(-1)).toMatchObject({ cpuLimit: 25 });

  // Off again by the switch: no PIN asked twice.
  await user.click(toggle());
  expect(await screen.findByText('Computer vision is off.')).toBeTruthy();
  expect(server.settings.at(-1)).toMatchObject({ mode: 'off', cpuLimit: 25 });
  expect(server.settings).toHaveLength(3);
}, 15_000);

test('a table opens in the panel: why it is so, its day, its zone; Esc closes it; the owner edits and adds tables there', async () => {
  const server = fakeShopServer();
  addEvents([...shop(), ev({ type: 'table.state_set', tableId: 't2', from: 'free', to: 'reserved', actor: { id: 'n', name: 'Nimal', role: 'cashier' } })]);
  history.replaceState(null, '', '/#vision');
  const user = userEvent.setup();
  render(<Root />);
  const tiles = await screen.findByRole('listbox', { name: 'Tables by number' });
  expect(within(tiles).getAllByRole('option').map((o) => o.getAttribute('aria-label')?.split(',').slice(0, 2).join(','))).toEqual(['Table 1, free', 'Table 2, reserved']);
  expect(within(tiles).getAllByText('no zone')).toHaveLength(1);
  expect(screen.getByText('No camera data yet.')).toBeTruthy();

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

test('the demo: the Shadow week card goes to #vision with Live picked; Enter switches', async () => {
  history.replaceState(null, '', '/?demo#owner');
  const user = userEvent.setup();
  render(<Root />);
  const card = await screen.findByRole('article', { name: /^Cameras were right \d+% of the time this week$/ });
  // Today's To do shows the title; tapping it explains it on the black screen (SCRUM-173).
  await user.click(within(card).getByRole('button', { name: /^Cameras were right/ }));
  expect(within(screen.getByRole('region', { name: 'Shop screen' })).getByText(/Switch to Live\?/)).toBeTruthy();
  await user.click(within(card).getByRole('button', { name: 'Switch to Live' }));

  expect(await screen.findByRole('heading', { name: 'Computer vision' })).toBeTruthy();
  expect(location.hash).toBe('#vision/live');
  await screen.findByText('Enter switches to Live.');
  expect(document.activeElement).toBe(radio('Live'));
  expect(radio('Shadow').getAttribute('aria-checked')).toBe('true');
  expect(toggle().getAttribute('aria-checked')).toBe('true');
  // The demo heartbeat: the front camera works, the back one is offline.
  expect(within(panel()).getByText(/1 of 2 cameras online · using 11% now/)).toBeTruthy();

  await user.keyboard('{Enter}');
  expect(await screen.findByText('Live on.')).toBeTruthy();
  expect(radio('Live').getAttribute('aria-checked')).toBe('true');
}, 15_000);

test("on the owner's phone the page is read only, without the cameras' pictures", async () => {
  vi.stubEnv('VITE_SITE', 'cloud');
  history.replaceState(null, '', '/?demo#vision');
  render(<Root />);
  expect(await screen.findByRole('heading', { name: 'Computer vision' })).toBeTruthy();
  expect(screen.queryByRole('navigation', { name: 'Owner sections' })).toBeNull();
  expect(screen.getAllByText('Change it on the shop PC.').length).toBeGreaterThan(0);
  expect((toggle() as HTMLButtonElement).disabled).toBe(true);
  expect(radio('Live').getAttribute('aria-disabled')).toBe('true');
  expect((screen.getByRole('slider') as HTMLInputElement).disabled).toBe(true);
  expect(screen.queryByRole('button', { name: '+ Add table' })).toBeNull();
  expect(screen.queryByRole('button', { name: /Open in the panel/ })).toBeNull();
});

test('the camera worker slowed itself for the CPU limit: the panel says so', async () => {
  addEvents([...shop(), ev({ type: 'vision.heartbeat', cameras: [{ id: 'c1', online: true, fps: 0.5 }], cpu: 17, slowed: true })]);
  history.replaceState(null, '', '/#vision');
  render(<Root />);
  expect(await screen.findByText(/Slowed to protect the Register/)).toBeTruthy();
  expect(screen.getByText(/using 17% now/)).toBeTruthy();
});

test('a manager sees the page but cannot change CV, the mode, the CPU limit or the tables', async () => {
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
  for (const m of ['Shadow', 'Live']) expect(radio(m).getAttribute('aria-disabled')).toBe('true');
  await user.click(radio('Shadow'));
  expect(screen.queryByLabelText(/owner's PIN/)).toBeNull();
  expect((screen.getByRole('slider') as HTMLInputElement).disabled).toBe(true);
  expect(screen.getByText('Only the owner watches the cameras, on the shop PC.')).toBeTruthy();
  await user.click(screen.getByRole('option', { name: /^Table 1/ }));
  expect(within(panel()).getByRole('heading', { name: 'Table 1' })).toBeTruthy();
  expect(within(panel()).queryByText('Edit the table')).toBeNull();
});
