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
  const s = { settings: [] as Record<string, unknown>[], activated: false, looks: 0 };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const step = String(url).replace('/api/v1/setup', '');
    if (!step.startsWith('/cv/')) return new Response('{}', { status: 404 });
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    // Camera views (SCRUM-180) open with the same PIN; their pictures are cameraViews.ui.test.tsx's.
    if (step === '/cv/views/frame') return Response.json({ state: 'starting' });
    if (step === '/cv/views/close') return Response.json({ closed: true });
    if (step === '/cv/views/open' && body.ownerPin === '1234') return Response.json({ key: 'k', packReady: true });
    if (body.ownerPin !== '1234') return Response.json({ message: "that is not the owner's PIN" }, { status: 401 });
    const { ownerPin: _pin, ...fields } = body;
    if (step === '/cv/activate') { s.activated = true; return Response.json({ active: true, phase: 'downloading', bytes: 0, total: 50_000_000 }); }
    if (step === '/cv/status') {
      if (!s.activated) return Response.json({ active: false, phase: 'idle' });
      s.looks += 1;
      return Response.json(s.looks < 2 ? { active: true, phase: 'downloading', bytes: 20_000_000, total: 50_000_000 } : { active: true, phase: 'ready', version: '1' });
    }
    if (step === '/cv/settings') { s.settings.push(body); return Response.json({ events: [ev({ type: 'vision.settings_set', ...fields, at: Date.now() })] }); }
    return new Response('{}', { status: 404 });
  }));
  return s;
}

beforeEach(() => { localStorage.clear(); });
afterEach(() => { act(() => lock()); cleanup(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); history.replaceState(null, '', '/'); });

const radio = (name: string) => screen.getByRole('radio', { name });

test('the owner switches to Shadow by keyboard: PIN in the line, the CV pack arrives, one event, Undo; Live waits for every zone', async () => {
  const server = fakeShopServer();
  addEvents(shop());
  history.replaceState(null, '', '/#vision');
  const user = userEvent.setup();
  render(<Root />);
  expect(await screen.findByRole('heading', { name: 'Computer vision' })).toBeTruthy();
  const part = screen.getByRole('link', { name: 'Computer vision' });
  expect(part.getAttribute('aria-current')).toBe('page');
  expect(within(screen.getByRole('navigation', { name: 'Owner sections' })).getByText('Off')).toBeTruthy();

  // Live: not until table 2 has a zone, said inline with the way to fix it.
  expect(radio('Live').getAttribute('aria-disabled')).toBe('true');
  expect(screen.getByText('Live: Table 2 has no zone yet.')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Set up zones' }).getAttribute('href')).toBe('#cameras');
  await user.click(radio('Live'));
  expect(screen.queryByLabelText(/owner's PIN/)).toBeNull();

  // Arrows move, Enter chooses; the owner's PIN is asked in the page's line, no dialog.
  radio('Off').focus();
  await user.keyboard('{ArrowRight}{Enter}');
  const pin = await screen.findByLabelText("The owner's PIN to switch to Shadow");
  expect(screen.queryByRole('dialog')).toBeNull();
  await user.type(pin, '1234{Enter}');
  expect(await screen.findByRole('progressbar', { name: 'Downloading the CV pack' })).toBeTruthy();
  expect(await screen.findByText('Shadow on.', {}, { timeout: 4000 })).toBeTruthy();
  expect(server.settings).toEqual([{ ownerPin: '1234', mode: 'shadow', seatS: 60, leaveS: 180, cleanAlertS: 300, cpuLimit: 15 }]);
  expect(radio('Shadow').getAttribute('aria-checked')).toBe('true');

  await user.click(screen.getByRole('button', { name: 'Undo' }));
  expect(server.settings[1]).toEqual({ ownerPin: '1234', mode: 'off', seatS: 60, leaveS: 180, cleanAlertS: 300, cpuLimit: 15 });

  // The CPU limit: 5% to 50% in steps of 5; one event once the slider settles.
  const cpu = screen.getByRole('slider');
  expect([cpu.getAttribute('min'), cpu.getAttribute('max'), cpu.getAttribute('step'), (cpu as HTMLInputElement).value]).toEqual(['5', '50', '5', '15']);
  fireEvent.change(cpu, { target: { value: '25' } });
  expect(await screen.findByText('CPU limit 25%.', {}, { timeout: 3000 })).toBeTruthy();
  expect(server.settings.at(-1)).toMatchObject({ cpuLimit: 25 });
  expect(server.settings).toHaveLength(3);
});

test('the tables and cameras before the worker exists: tiles like F1, why each is so, "No camera data yet"', async () => {
  fakeShopServer();
  addEvents([...shop(), ev({ type: 'table.state_set', tableId: 't2', from: 'free', to: 'reserved', actor: { id: 'n', name: 'Nimal', role: 'cashier' } })]);
  history.replaceState(null, '', '/#vision');
  const user = userEvent.setup();
  render(<Root />);
  const tiles = await screen.findByRole('listbox', { name: 'Tables by number' });
  expect(within(tiles).getAllByRole('option').map((o) => o.getAttribute('aria-label')?.split(',').slice(0, 2).join(','))).toEqual(['Table 1, free', 'Table 2, reserved']);
  expect(within(tiles).getAllByText('Nobody seated today')).toHaveLength(2);
  expect(screen.getByText(/^Free since the tables were set up/)).toBeTruthy();
  within(tiles).getAllByRole('option')[0].focus();
  await user.keyboard('{ArrowRight}');
  expect(screen.getByText(/^Set by Nimal at \d\d:\d\d\.$/)).toBeTruthy(); // Off: the cameras play no part
  expect(screen.getByText('No camera data yet.')).toBeTruthy();
  // Read only here: no C/F/R/O.
  await user.keyboard('c');
  expect(within(tiles).getAllByRole('option')[1].getAttribute('aria-label')).toMatch(/reserved/);
});

test('the demo: the Shadow week card goes to #vision with Live picked; Enter switches, with Undo', async () => {
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
  expect(screen.getByText(/in Shadow the cameras only watch/)).toBeTruthy();
  // The demo heartbeat: the front camera works, the back one is offline.
  const health = within(screen.getByRole('region', { name: 'Cameras' }));
  expect(health.getByText('Front').closest('li')?.textContent).toMatch(/Online.*5 fps/);
  expect(health.getByText('Back').closest('li')?.textContent).toMatch(/Offline.*0 fps/);
  expect(screen.getByText(/using 11% now/)).toBeTruthy();

  await user.keyboard('{Enter}');
  expect(await screen.findByText('Live on.')).toBeTruthy();
  expect(radio('Live').getAttribute('aria-checked')).toBe('true');
  await user.click(screen.getByRole('button', { name: 'Undo' }));
  await vi.waitFor(() => expect(radio('Shadow').getAttribute('aria-checked')).toBe('true'));
});

test("on the owner's phone the page is read only", async () => {
  vi.stubEnv('VITE_SITE', 'cloud');
  history.replaceState(null, '', '/?demo#vision');
  render(<Root />);
  expect(await screen.findByRole('heading', { name: 'Computer vision' })).toBeTruthy();
  expect(screen.queryByRole('navigation', { name: 'Owner sections' })).toBeNull();
  expect(screen.getByText('Change it on the shop PC.')).toBeTruthy();
  expect(radio('Live').getAttribute('aria-disabled')).toBe('true');
  expect((screen.getByRole('slider') as HTMLInputElement).disabled).toBe(true);
  expect(screen.queryByRole('link', { name: 'Set up zones' })).toBeNull();
});

test('the camera worker slowed itself for the CPU limit: the page says so', async () => {
  addEvents([...shop(), ev({ type: 'vision.heartbeat', cameras: [{ id: 'c1', online: true, fps: 0.5 }], cpu: 17, slowed: true })]);
  history.replaceState(null, '', '/#vision');
  render(<Root />);
  expect(await screen.findByText(/Slowed to protect the Register/)).toBeTruthy();
  expect(screen.getByText(/using 17% now/)).toBeTruthy();
});

test('a manager sees the page but cannot change the mode or the CPU limit', async () => {
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
  expect(screen.getByText('Only the owner changes this.')).toBeTruthy();
  for (const m of ['Off', 'Shadow', 'Live']) expect(radio(m).getAttribute('aria-disabled')).toBe('true');
  await user.click(radio('Shadow'));
  expect(screen.queryByLabelText(/owner's PIN/)).toBeNull();
  expect((screen.getByRole('slider') as HTMLInputElement).disabled).toBe(true);
});
