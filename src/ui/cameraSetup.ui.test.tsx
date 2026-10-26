import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Root } from './Root.tsx';
import { addEvents } from './eventLog.ts';
import type { SyncEvent } from '../domain/sync.ts';

const owner = { id: 'owner-1', name: 'Nisal Vimukthi', role: 'owner' as const };
let seq = 0;
const ev = (fields: Record<string, unknown>) =>
  ({ id: `srv-${++seq}`, shopId: 'shop-1', at: Date.now(), actor: owner, orderNumber: 0, ...fields }) as unknown as SyncEvent;

/** The shop server's #cameras endpoints: the pack is ready, one Tapo answers the scan, its password is hunter2. */
function fakeShopServer() {
  const s = { asked: [] as { step: string; body: Record<string, unknown> }[], logins: {} as Record<string, { user: string; passwordSet: boolean }> };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const step = String(url).replace('/api/v1/setup', '');
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (!step.startsWith('/cv/')) return new Response('{}', { status: 404 });
    s.asked.push({ step, body });
    if (body.ownerPin !== '1234') return Response.json({ message: "that is not the owner's PIN" }, { status: 401 });
    const { ownerPin: _pin, ...fields } = body;
    switch (step) {
      case '/cv/status': return Response.json({ active: true, phase: 'ready', version: '1' });
      case '/cv/setup': return Response.json({ logins: s.logins, packReady: true });
      case '/cv/scan': return Response.json({ found: [{ ip: '192.168.1.20', name: 'TP-IPC C200' }] });
      case '/cv/test': return Response.json(body.password === 'hunter2'
        ? { ok: true, jpeg: '/9j/2Q==' }
        : { ok: false, cause: 'login', message: 'The camera refused the login: check the username and password.' });
      case '/cv/cameras': {
        for (const c of body.cameras) if (c.user) s.logins[c.id] = { user: c.user, passwordSet: Boolean(c.password) || Boolean(s.logins[c.id]?.passwordSet) };
        const cameras = body.cameras.map(({ user: _u, password: _p, ...c }: Record<string, unknown>) => c);
        return Response.json({ events: [ev({ type: 'vision.cameras_set', cameras })], logins: s.logins });
      }
      case '/cv/tables': return Response.json({ events: [ev({ type: 'table.layout_set', ...fields })] });
      case '/cv/zones': return Response.json({ events: [ev({ type: 'vision.zones_set', ...fields })] });
      case '/cv/settings': return Response.json({ events: [ev({ type: 'vision.settings_set', ...fields })] });
    }
    return new Response('{}', { status: 404 });
  }));
  return s;
}

beforeEach(() => { localStorage.clear(); history.replaceState(null, '', '/#cameras'); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function unlock() {
  const user = userEvent.setup();
  render(<Root />);
  await user.type(await screen.findByLabelText("The owner's PIN"), '1234{Enter}');
  await screen.findByRole('heading', { name: 'Tables' });
  return user;
}

test('the owner scans, logs a camera in, tests it and draws a table by keyboard; Off / Shadow / Live live on #vision', async () => {
  const server = fakeShopServer();
  const user = await unlock();

  await user.click(screen.getByRole('button', { name: 'Scan for cameras' }));
  await user.click(await screen.findByRole('button', { name: 'Add 192.168.1.20 · TP-IPC C200' }));
  const cam = screen.getByRole('listitem', { name: 'TP-IPC C200' });
  expect((within(cam).getByLabelText('IP address') as HTMLInputElement).value).toBe('192.168.1.20');
  expect(within(cam).getByRole('radio', { name: 'Tapo' }).getAttribute('aria-checked')).toBe('true');
  await user.type(within(cam).getByLabelText('Username'), 'admin');
  await user.type(within(cam).getByLabelText('Password'), 'nope');
  await user.click(within(cam).getByRole('button', { name: 'Test' }));
  expect((await within(cam).findByRole('alert')).textContent).toMatch(/refused the login/);
  await user.clear(within(cam).getByLabelText('Password'));
  await user.type(within(cam).getByLabelText('Password'), 'hunter2');
  await user.click(within(cam).getByRole('button', { name: 'Test' }));
  expect(await within(cam).findByRole('img', { name: 'What TP-IPC C200 sees' })).toBeTruthy();
  expect(server.asked.find((a) => a.step === '/cv/test' && a.body.password === 'hunter2')?.body.rtspPath).toBe('/stream2');

  await user.click(within(cam).getByRole('switch', { name: 'Use for CV' }));
  await user.click(screen.getByRole('button', { name: 'Save cameras' }));
  expect(await screen.findByText('Cameras saved.')).toBeTruthy();
  const saved = server.asked.find((a) => a.step === '/cv/cameras')!.body.cameras as Record<string, unknown>[];
  expect(saved).toEqual([expect.objectContaining({ name: 'TP-IPC C200', ip: '192.168.1.20', rtspPath: '/stream2', enabled: true, user: 'admin', password: 'hunter2' })]);
  expect((within(cam).getByLabelText('Password') as HTMLInputElement).value).toBe('');
  expect(within(cam).getByLabelText('Password').getAttribute('placeholder')).toBe('Password set');

  await user.click(screen.getByRole('button', { name: 'Add table' }));
  await user.click(screen.getByRole('button', { name: 'Add table' }));
  await user.click(screen.getByRole('button', { name: 'Save tables' }));
  expect(await screen.findByText('Tables saved.')).toBeTruthy();
  // The mode is in one place only: Computer vision.
  expect(screen.queryByRole('radio', { name: /Live/ })).toBeNull();
  expect(within(screen.getByRole('region', { name: 'Timers' })).getByRole('link', { name: 'Computer vision' }).getAttribute('href')).toBe('#vision');

  // The zone, by keyboard: three corners, Backspace takes one back, Enter closes, then its table.
  const frame = screen.getByRole('application', { name: /TP-IPC C200: click the corners/ });
  frame.focus();
  await user.keyboard('{ArrowLeft>5/}{ArrowUp>5/} {ArrowRight>10/} {ArrowDown>10/} {ArrowLeft>3/} {Backspace}');
  expect(screen.getByText('3 corners · Enter closes the zone')).toBeTruthy();
  await user.keyboard('{Enter}');
  await user.click(within(screen.getByRole('group', { name: 'Pick its table' })).getByRole('button', { name: 'Table 1' }));
  const zones = server.asked.find((a) => a.step === '/cv/zones')!.body;
  expect(zones.zones).toEqual([{ id: expect.any(String), tableId: expect.any(String), points: [{ x: 0.4, y: 0.4 }, { x: 0.6, y: 0.4 }, { x: 0.6, y: 0.6 }] }]);
  expect(await screen.findByRole('button', { name: 'Remove the zone of table 1' })).toBeTruthy();

  // The timers keep the mode and the CPU limit as they are.
  const seat = screen.getByLabelText('Seated after (seconds of people at the table)');
  await user.clear(seat);
  await user.type(seat, '90');
  await user.click(screen.getByRole('button', { name: 'Save timers' }));
  await vi.waitFor(() => expect(server.asked.find((a) => a.step === '/cv/settings')).toBeTruthy());
  expect(server.asked.find((a) => a.step === '/cv/settings')!.body).toEqual({ ownerPin: '1234', mode: 'off', seatS: 90, leaveS: 180, cleanAlertS: 300, cpuLimit: 15 });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(JSON.stringify(localStorage)).not.toMatch(/hunter2/);
});

test('a 5th camera stays off: "Use for CV" says the limit inline', async () => {
  fakeShopServer();
  addEvents([ev({ type: 'vision.cameras_set', cameras: Array.from({ length: 5 }, (_, i) => ({ id: `c${i}`, name: `Cam ${i + 1}`, ip: `192.168.1.${20 + i}`, rtspPath: '/stream2', enabled: i < 4 })) })]);
  const user = await unlock();
  const fifth = screen.getByRole('listitem', { name: 'Cam 5' });
  await user.click(within(fifth).getByRole('switch', { name: 'Use for CV' }));
  expect(within(fifth).getByRole('switch', { name: 'Use for CV' }).getAttribute('aria-checked')).toBe('false');
  expect(within(fifth).getByRole('status').textContent).toBe('Limit 4 cameras - turn one off first');
  expect((screen.getByRole('button', { name: 'Save cameras' }) as HTMLButtonElement).disabled).toBe(true);
  await user.click(within(screen.getByRole('listitem', { name: 'Cam 1' })).getByRole('switch', { name: 'Use for CV' }));
  await user.click(within(fifth).getByRole('switch', { name: 'Use for CV' }));
  expect(within(fifth).getByRole('switch', { name: 'Use for CV' }).getAttribute('aria-checked')).toBe('true');
});
