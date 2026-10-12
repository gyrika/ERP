import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { restartApp } from './restart.ts';
import { Root } from './Root.tsx';
import { SetupWizard } from './SetupWizard.tsx';

vi.mock('./restart.ts', () => ({ restartApp: vi.fn() }));

interface Person { id: string; name: string; role: string; pin: string; active: boolean }

/** The shop server's setup endpoints, remembering what they are told (and refusing as the real one does). */
function fakeShopServer({ done = false, status = 200 } = {}) {
  const s = { version: '1.0.0', done, cloud: false, shop: null as null | { id: string; name: string; place: string }, printer: null as string | null, staff: [] as Person[] };
  const pub = () => s.staff.map(({ pin: _p, ...m }) => m);
  const ownerOk = (pin: unknown) => !s.done || s.staff.some((m) => m.active && m.role === 'owner' && m.pin === pin);
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (status !== 200) return new Response('{}', { status });
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const step = String(url).replace('/api/v1/setup', '');
    const ok = (b: unknown) => Response.json(b);
    const no = (code: number, message: string) => Response.json({ message }, { status: code });
    if (String(url) === '/api/v1/health') return ok({ ok: true, version: s.version });
    if (step === '') return ok({ done: s.done, shop: s.shop, printer: s.printer, printers: ['XP-80T'], cloud: s.cloud, ...(s.done ? {} : { staff: pub() }) });
    if (!ownerOk(body.ownerPin)) return no(401, "that is not the owner's PIN");
    if (step === '/shop') { const first = !s.shop; s.shop = { id: 'cheesybeez-thalwila', name: body.name, place: body.place }; return ok({ shopId: s.shop.id, ...(first ? { counterToken: 'counter-token' } : {}) }); }
    if (step === '/printer') { s.printer = body.name; return ok({ printer: body.name }); }
    if (step === '/staff') {
      if (s.staff.some((m) => m.active && m.pin === body.pin)) return no(409, 'someone already has that PIN: choose another');
      s.staff.push({ id: `s${s.staff.length}`, name: body.name, role: body.role, pin: body.pin, active: true });
      return ok({ staff: pub() });
    }
    if (step === '/staff/list') return ok({ staff: pub() });
    if (step === '/pair') return ok(body.kind === 'counter' ? { counterToken: 'second-screen', shopId: 'cheesybeez-thalwila' } : { link: `http://10.0.0.5:8080/?pair=k&as=${body.kind}` });
    if (step === '/cloud') { if (body.code !== 'CB-7K3M-Q9XZ') return no(403, 'that shop code is not right'); s.cloud = true; return ok({ cloud: true }); }
    if (step === '/finish') { s.done = true; return ok({ done: true }); }
    if (step === '/update/check') return ok({ current: s.version, latest: '1.0.1', newer: s.version !== '1.0.1' });
    if (step === '/update/install') { setTimeout(() => { s.version = '1.0.1'; }, 100); return ok({ started: true, from: s.version }); }
    return no(404, 'no such step');
  }));
  return s;
}

beforeEach(() => {
  localStorage.clear();
  vi.stubEnv('VITE_SETUP_CHECK', '1');
  vi.mocked(restartApp).mockClear();
});
afterEach(() => { cleanup(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); history.replaceState(null, '', '/'); });

test('a new shop: name, printer, staff (owner first), a QR code, finish', async () => {
  const server = fakeShopServer();
  const user = userEvent.setup();
  render(<Root />);

  expect(await screen.findByRole('heading', { name: 'Name your shop' })).toBeTruthy();
  await user.type(screen.getByRole('textbox', { name: 'Shop name' }), 'CheesyBeez');
  await user.type(screen.getByRole('textbox', { name: 'Town' }), 'Thalwila{Enter}');
  expect(await screen.findByRole('heading', { name: 'Your receipt printer' })).toBeTruthy();
  expect(localStorage.getItem('cb.sync.token')).toBe('counter-token'); // the PC paired itself as the counter

  await user.click(screen.getByRole('radio', { name: 'XP-80T' }));
  expect(server.printer).toBe('XP-80T');
  await user.click(screen.getByRole('button', { name: 'Next' }));

  expect(await screen.findByRole('heading', { name: 'Your staff' })).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(true); // no owner yet
  const form = within(screen.getByRole('form', { name: 'Add a person' }));
  await user.type(form.getByRole('textbox'), 'Nisal Vimukthi');
  expect(form.getByRole('radio', { name: 'Owner' }).getAttribute('aria-checked')).toBe('true'); // owner comes first
  await user.type(form.getByLabelText('Their own 4-digit PIN'), '1234');
  await user.click(form.getByRole('button', { name: 'Add' }));
  expect(await screen.findByText('Nisal Vimukthi')).toBeTruthy();

  await user.type(form.getByRole('textbox'), 'Kamal');
  await user.type(form.getByLabelText('Their own 4-digit PIN'), '1234');
  await user.click(form.getByRole('button', { name: 'Add' }));
  expect((await screen.findByRole('alert')).textContent).toContain('already has that PIN');

  await user.click(screen.getByRole('button', { name: 'Next' }));
  expect(await screen.findByRole('heading', { name: 'Connect to the cloud' })).toBeTruthy();
  await user.type(screen.getByRole('textbox', { name: 'Shop code' }), 'cb-0000-0000');
  await user.click(screen.getByRole('button', { name: 'Connect' }));
  expect((await screen.findByRole('alert')).textContent).toBe('that shop code is not right');
  await user.clear(screen.getByRole('textbox', { name: 'Shop code' }));
  await user.type(screen.getByRole('textbox', { name: 'Shop code' }), 'cb-7k3m-q9xz'); // typed in lower case: shown and sent in capitals
  await user.click(screen.getByRole('button', { name: 'Connect' }));
  expect(await screen.findByText('Connected: sales are copied to the cloud.')).toBeTruthy();
  expect(server.cloud).toBe(true);
  await user.click(screen.getByRole('button', { name: 'Next' }));

  expect(await screen.findByRole('heading', { name: 'Connect your devices' })).toBeTruthy();
  // Connected to the cloud, so the owner's phone can have its QR code too.
  expect(within(screen.getByRole('region', { name: "Owner's phone" })).getByRole('button', { name: 'Show QR code' })).toBeTruthy();
  await user.click(within(screen.getByRole('region', { name: 'Kitchen tablet' })).getByRole('button', { name: 'Show QR code' }));
  expect(await screen.findByRole('img', { name: 'QR code for the kitchen tablet' })).toBeTruthy();

  await user.click(screen.getByRole('button', { name: 'Finish' }));
  await vi.waitFor(() => expect(restartApp).toHaveBeenCalled());
  expect(server.done).toBe(true);
});

test('a tablet that has not scanned its code is told so, and never sees a register', async () => {
  fakeShopServer({ status: 403 });
  render(<Root />);
  expect(await screen.findByRole('heading', { name: 'This device is not connected yet' })).toBeTruthy();
  expect(screen.queryByRole('complementary', { name: 'Current order' })).toBeNull();
});

test("a second screen on the shop PC connects with the owner's PIN", async () => {
  const server = fakeShopServer({ done: true });
  server.staff.push({ id: 'o', name: 'Nisal Vimukthi', role: 'owner', pin: '1234', active: true });
  const user = userEvent.setup();
  render(<Root />);
  expect(await screen.findByRole('heading', { name: 'Connect this screen as the counter' })).toBeTruthy();
  await user.type(screen.getByLabelText("The owner's PIN"), '9999{Enter}');
  expect((await screen.findByRole('alert')).textContent).toContain("not the owner's PIN");
  await user.clear(screen.getByLabelText("The owner's PIN"));
  await user.type(screen.getByLabelText("The owner's PIN"), '1234{Enter}');
  await vi.waitFor(() => expect(restartApp).toHaveBeenCalled());
  expect(localStorage.getItem('cb.sync.token')).toBe('second-screen');
});

test("Shop setup → Updates: the owner's PIN, a newer version, Update now, back by itself", async () => {
  const server = fakeShopServer({ done: true });
  server.staff.push({ id: 'o', name: 'Nisal Vimukthi', role: 'owner', pin: '1234', active: true });
  const user = userEvent.setup();
  render(<SetupWizard mode="manage" />);
  await user.type(await screen.findByLabelText("The owner's PIN"), '1234{Enter}');
  await user.click(await screen.findByRole('button', { name: 'Updates' }));
  expect(await screen.findByText('1.0.0')).toBeTruthy();
  expect((await screen.findByText(/is ready/)).textContent).toBe('Version 1.0.1 is ready.');

  await user.click(screen.getByRole('button', { name: 'Update now' }));
  expect((await screen.findByText(/^Updating to 1.0.1/)).textContent).toContain("don't turn the PC off");
  await vi.waitFor(() => expect(restartApp).toHaveBeenCalled(), { timeout: 8000 }); // the new version answered
}, 15_000);
