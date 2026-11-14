import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FAKE_CUSTOMER_SHEET } from '../fake/data.ts';
import { planImport, type KnownCustomer } from '../domain/customerImport.ts';
import type { Customer } from '../domain/customers.ts';
import type { ModuleEvent } from '../domain/modules.ts';
import type { SyncEvent } from '../domain/sync.ts';

// Customers (CRM): on only where the developers turned it on; the list, a customer, Import, Campaigns.

const NOW = Date.UTC(2026, 10, 11, 6, 0);
const DAY = 86_400_000;
const shop = vi.hoisted(() => ({ events: [] as SyncEvent[], role: 'owner' as 'owner' | 'manager' }));
vi.mock('../services/ownerData.ts', async (real) => ({
  ...(await real<typeof import('../services/ownerData.ts')>()),
  useShopEvents: () => ({ state: 'ready', events: shop.events, at: NOW }),
}));
vi.mock('../services/serverAuth.ts', async (real) => ({
  ...(await real<typeof import('../services/serverAuth.ts')>()),
  signedIn: () => ({ id: 'o', name: 'Owner', role: shop.role }),
}));
const crm = vi.hoisted(() => ({ list: vi.fn(), optOut: vi.fn(), add: vi.fn(), remove: vi.fn(), restore: vi.fn(), preview: vi.fn(), save: vi.fn(), reach: vi.fn(), send: vi.fn(), setAuto: vi.fn(), results: vi.fn(), setReceipt: vi.fn() }));
vi.mock('../services/crmClient.ts', () => ({ crmClient: crm, CrmFailed: Error }));

const { default: CustomersView } = await import('./customers/CustomersView.tsx');

const crmOn = (on: boolean): ModuleEvent => ({
  id: `m-${on}`, shopId: 's', at: 1, orderNumber: 0, actor: { id: 'developers', name: 'Developers', role: 'owner' },
  type: 'shop.module_set', module: 'crm', on, codeId: '0123456789abcdef',
});
const customer = (n: number, name: string | null, over: Partial<Customer> = {}): Customer => ({
  id: `cus-${String(n).padStart(16, '0')}`, phone: `+9477000000${n}`, name, source: 'import', optedOut: false, createdAt: NOW - 200 * DAY, ...over,
});
const KASUN = customer(1, 'Kasun Perera');
const NIMALI = customer(2, 'නිමලි ප්‍රනාන්දු');
const RUWAN = customer(3, null);
let n = 0;
const paid = (c: Customer, daysAgo: number, total: number): SyncEvent[] => {
  n++;
  return [
    { id: `s${n}`, shopId: 's', at: NOW - daysAgo * DAY - 60_000, orderNumber: 1000 + n, actor: { id: 'c', name: 'Nimal', role: 'cashier' }, type: 'order.sent', ticketId: `t${n}`, addOn: false,
      lines: [{ id: `l${n}`, itemId: 'devilled-chicken', qty: 1, size: 'L', adds: [], outs: [], sent: true, unit: total }] },
    { id: `p${n}`, shopId: 's', at: NOW - daysAgo * DAY, orderNumber: 1000 + n, actor: { id: 'c', name: 'Nimal', role: 'cashier' }, type: 'order.paid', total, tender: 'cash', tendered: total, customerId: c.id },
  ] as SyncEvent[];
};
let list: Customer[] = [];

beforeEach(() => {
  localStorage.clear();
  shop.role = 'owner';
  n = 0;
  list = [KASUN, NIMALI, RUWAN];
  // Kasun: twice, lately. Nimali: once, 40 days ago (Inactive). Ruwan: never.
  shop.events = [crmOn(true), ...paid(KASUN, 50, 290000), ...paid(KASUN, 2, 1_900_000), ...paid(NIMALI, 40, 150000)];
  crm.list.mockImplementation(async () => ({ customers: list, withApp: [KASUN.id] }));
  crm.optOut.mockImplementation(async (id: string, optedOut: boolean) => { list = list.map((c) => (c.id === id ? { ...c, optedOut } : c)); return { optedOut }; });
  crm.add.mockImplementation(async (phone: string, name: string) => {
    if (phone.replace(/\D/g, '').endsWith('770000001')) throw new Error('already on the list as Kasun Perera');
    const c = customer(9, name || null, { source: 'manual', createdAt: NOW });
    list = [...list, c];
    return { customer: c };
  });
  crm.remove.mockImplementation(async (id: string) => { const removed = list.find((c) => c.id === id)!; list = list.filter((c) => c.id !== id); return { removed }; });
  crm.restore.mockImplementation(async (c: Customer) => { list = [...list, c]; return { customer: c }; });
  crm.reach.mockImplementation(async (a: string) => (a === 'vip' ? { customers: 1, reachable: 1 } : { customers: 3, reachable: 1 }));
  crm.send.mockImplementation(async (audience: string, title: string, body: string) => ({ events: [{
    id: 'c1', shopId: 's', at: NOW, orderNumber: 0, actor: { id: 'o', name: 'Owner', role: 'owner' }, type: 'crm.campaign_sent',
    audience, kind: 'campaign', title, body, customers: 1, reachable: 1, delivered: 1, failed: 0,
  }] }));
  crm.results.mockResolvedValue({ results: {} });
  crm.setAuto.mockImplementation(async (on: boolean, title: string, body: string) => ({ events: [{
    id: 'a1', shopId: 's', at: NOW, orderNumber: 0, actor: { id: 'o', name: 'Owner', role: 'owner' }, type: 'crm.auto_set', on, title, body,
  }] }));
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

test('off: the sidebar has no Customers, and the page says it is not on', async () => {
  shop.events = [crmOn(true), crmOn(false)];
  render(<CustomersView hash="#customers" onRegister={() => {}} />);
  expect(screen.getByText('Customers are not on for this shop.')).toBeTruthy();
  expect(screen.queryByRole('link', { name: /^Customers/ })).toBeNull();
  expect(crm.list).not.toHaveBeenCalled();
});

test('the list: the shop at a glance, segments to narrow it, search by name or number', async () => {
  const user = userEvent.setup();
  render(<CustomersView hash="#customers" onRegister={() => {}} />);
  const tiles = within(await screen.findByRole('list', { name: 'Customers at a glance' }));
  expect(tiles.getAllByRole('listitem').map((li) => li.textContent)).toEqual([
    '3customers', '0new this month', '1active', '2inactive (30+ days)', '50%came back', '1get offers',
  ]);
  const rows = () => within(screen.getByRole('table')).getAllByRole('row').slice(1).map((r) => within(r).getAllByRole('cell').map((c) => c.textContent));
  expect(rows()).toEqual([
    ['Kasun Perera', '077 000 0001', 'VIP', '2', 'Rs 21,900', '9 Nov 2026'],
    ['නිමලි ප්‍රනාන්දු', '077 000 0002', 'Inactive', '1', 'Rs 1,500', '2 Oct 2026'],
    ['No name', '077 000 0003', 'Inactive', '0', '–', 'Never'],
  ]);
  await user.click(screen.getByRole('button', { name: /^VIP/ }));
  expect(rows().map((r) => r[0])).toEqual(['Kasun Perera']);
  await user.click(screen.getByRole('button', { name: /^All/ }));
  await user.type(screen.getByRole('searchbox', { name: 'Search customers' }), '0002');
  expect(rows().map((r) => r[0])).toEqual(['නිමලි ප්‍රනාන්දු']);
  await user.clear(screen.getByRole('searchbox', { name: 'Search customers' }));
  await user.type(screen.getByRole('searchbox', { name: 'Search customers' }), 'kasun');
  expect(rows().map((r) => r[0])).toEqual(['Kasun Perera']);
  expect(within(screen.getByRole('table')).getByRole('link', { name: 'Kasun Perera' }).getAttribute('href')).toBe(`#customers/c/${KASUN.id}`);
});

test('a customer: what they bought, and no messages with one tap', async () => {
  const user = userEvent.setup();
  render(<CustomersView hash={`#customers/c/${KASUN.id}`} onRegister={() => {}} />);
  const page = within(await screen.findByRole('article', { name: 'Kasun Perera' }));
  expect(page.getByText('077 000 0001')).toBeTruthy();
  expect(page.getByText('VIP')).toBeTruthy();
  expect(within(page.getByRole('list', { name: 'This customer' })).getAllByRole('listitem').map((li) => li.textContent))
    .toEqual(['2orders', 'Rs 21,900spent', '22 Sept 2026first visit', '9 Nov 2026last visit']);
  const bought = within(page.getByRole('table')).getAllByRole('row').slice(1).map((r) => within(r).getAllByRole('cell').map((c) => c.textContent));
  expect(bought.map((r) => [r[1], r[2], r[3]])).toEqual([['1002', '1 × Devilled Chicken Large', 'Rs 19,000'], ['1001', '1 × Devilled Chicken Large', 'Rs 2,900']]);
  expect(page.getByText('Signed up for offers: campaigns can reach them.')).toBeTruthy();

  await user.click(page.getByRole('button', { name: 'No messages for this customer' }));
  expect(crm.optOut).toHaveBeenCalledWith(KASUN.id, true);
  expect(await page.findByText('Asked for no messages: no campaign reaches them.')).toBeTruthy();
  await user.click(page.getByRole('button', { name: 'Allow messages again' }));
  expect(crm.optOut).toHaveBeenLastCalledWith(KASUN.id, false);
});

test('Import: pick the file, see what would happen and why rows are left out, then Save does it', async () => {
  const LIST = new Map<string, KnownCustomer>([['+94770000003', { id: 'x3', name: 'Chamara Silva' }], ['+94770000005', { id: 'x5', name: 'Ruwan W' }]]);
  crm.preview.mockImplementation(async (_f: File, rename: boolean) => ({ plan: planImport(FAKE_CUSTOMER_SHEET, LIST, { renameExisting: rename }) }));
  crm.save.mockImplementation(async () => ({ plan: planImport(FAKE_CUSTOMER_SHEET, LIST), saved: { added: 34, updated: 0 }, customers: 37 }));
  const user = userEvent.setup();
  render(<CustomersView hash="#customers/import" onRegister={() => {}} />);
  expect(await screen.findByText('3 customers on the list.')).toBeTruthy();
  await user.upload(screen.getByLabelText('Customer file'), new File(['x'], 'customers.xlsx'));
  const counts = within(await screen.findByRole('list', { name: 'What importing would do' }));
  expect(counts.getByText(/new/).textContent).toBe('34 new (2 without a name)');
  expect(counts.getByText(/cannot be used/).textContent).toBe('6 cannot be used');
  const landline = within(screen.getByRole('table')).getByText('a landline, not a mobile').closest('tr')!;
  expect(within(landline).getAllByRole('cell').map((c) => c.textContent)).toEqual(['21', '0112345678', 'a landline, not a mobile']);
  await user.click(screen.getByRole('button', { name: 'Save 34 customers' }));
  expect((await screen.findByRole('status')).textContent).toBe('34 customers added.');
  expect(crm.list).toHaveBeenCalledTimes(2);
});

test('Campaigns: the owner picks who, sees the reach, writes two lines and sends; "we miss you" turns on', async () => {
  const user = userEvent.setup();
  render(<CustomersView hash="#customers/campaigns" onRegister={() => {}} />);
  expect(await screen.findByText('Reaches 1 of 3 inactive customers.')).toBeTruthy();
  const send = () => screen.getByRole('button', { name: /^Send( to \d+)?$/ }) as HTMLButtonElement;
  await user.click(screen.getByRole('button', { name: 'VIP' }));
  expect(await screen.findByText('Reaches 1 of 1 vip customers.')).toBeTruthy();
  expect(send().disabled, 'nothing written yet').toBe(true);
  const compose = within(screen.getByRole('region', { name: 'New campaign' }));
  await user.type(compose.getByRole('textbox', { name: /^Title/ }), 'Thank you');
  await user.type(compose.getByRole('textbox', { name: /^Message/ }), 'A free garlic bread with your next pizza.');
  await user.click(send());
  expect(crm.send).toHaveBeenCalledWith('vip', 'Thank you', 'A free garlic bread with your next pizza.', undefined);
  expect((await screen.findByRole('status')).textContent).toBe('Sent: reached 1 of 1.');
  expect(within(screen.getByRole('region', { name: 'Sent' })).getByText('Thank you')).toBeTruthy();

  await user.click(screen.getByRole('button', { name: 'Turn on' }));
  expect(crm.setAuto).toHaveBeenCalledWith(true, 'We miss you at CheesyBeez', 'It has been a while. Come by for a hot pizza this week.');
  expect(await screen.findByText('“We miss you” is on.')).toBeTruthy();
});

test('Campaigns are the owner\'s: a manager sees what was sent, nothing to send with', async () => {
  shop.role = 'manager';
  render(<CustomersView hash="#customers/campaigns" onRegister={() => {}} />);
  expect(await screen.findByText('Campaigns are sent by the owner. What was sent:')).toBeTruthy();
  expect(screen.queryByRole('button', { name: /^Send/ })).toBeNull();
  expect(crm.reach).not.toHaveBeenCalled();
});

test('On the receipt: the owner writes why to scan; a word the printer cannot print is caught before Save', async () => {
  crm.setReceipt.mockImplementation(async (headline: string, line: string) => ({ events: [{
    id: 'r1', shopId: 's', at: NOW, orderNumber: 0, actor: { id: 'o', name: 'Owner', role: 'owner' }, type: 'crm.receipt_set', headline, line,
  }] }));
  const user = userEvent.setup();
  render(<CustomersView hash="#customers/campaigns" onRegister={() => {}} />);
  const card = within(await screen.findByRole('region', { name: 'On the receipt' }));
  const first = card.getByRole('textbox', { name: /^First line/ }) as HTMLInputElement;
  const save = () => card.getByRole('button', { name: 'Save the receipt words' }) as HTMLButtonElement;
  expect(first.value).toBe('Scan for offers on your phone');
  expect(save().disabled, 'nothing changed yet').toBe(true);
  await user.type(card.getByRole('textbox', { name: /^Second line/ }), 'වට්ටම්');
  expect(card.getByText(/English letters/)).toBeTruthy();
  expect(save().disabled).toBe(true);
  await user.clear(card.getByRole('textbox', { name: /^Second line/ }));
  await user.type(card.getByRole('textbox', { name: /^Second line/ }), '10% off your next pizza');
  await user.click(save());
  expect(crm.setReceipt).toHaveBeenCalledWith('Scan for offers on your phone', '10% off your next pizza');
  expect(await screen.findByText('The receipt prints the new words from the next sale.')).toBeTruthy();
});

test('Sent: each campaign says what it brought in that week, beside the others in its audience', async () => {
  shop.events = [...shop.events, {
    id: 'c9', shopId: 's', at: NOW - 3 * DAY, orderNumber: 0, actor: { id: 'o', name: 'Owner', role: 'owner' }, type: 'crm.campaign_sent',
    audience: 'inactive', kind: 'campaign', title: 'We kept your table', body: 'A free drink this week.', customers: 30, reachable: 10, delivered: 10, failed: 0,
  } as SyncEvent];
  crm.results.mockResolvedValue({ results: { c9: { reached: 10, cameIn: 3, spent: 1_250_000, compared: 20, comparedCameIn: 2, final: false } } });
  render(<CustomersView hash="#customers/campaigns" onRegister={() => {}} />);
  const sent = within(screen.getByRole('region', { name: 'Sent' }));
  expect(await sent.findByText(/3 of 10 came in so far · Rs 12,500/)).toBeTruthy();
  expect(sent.getByText('Others in it: 2 of 20 (10%) vs 30%')).toBeTruthy();
  expect(sent.getByRole('columnheader', { name: 'Came in (7 days)' })).toBeTruthy();
});

test('Add customer: the mobile first, a name if known; a number already on the list says whose it is', async () => {
  const user = userEvent.setup();
  render(<CustomersView hash="#customers" onRegister={() => {}} />);
  await user.click(await screen.findByRole('button', { name: 'Add customer' }));
  const form = within(screen.getByRole('form', { name: 'Add customer' }));
  await user.type(form.getByRole('textbox', { name: 'Mobile' }), '077 000 0001');
  await user.click(form.getByRole('button', { name: 'Add' }));
  expect((await form.findByRole('alert')).textContent).toBe('already on the list as Kasun Perera');
  await user.clear(form.getByRole('textbox', { name: 'Mobile' }));
  await user.type(form.getByRole('textbox', { name: 'Mobile' }), '077 000 0056');
  await user.type(form.getByRole('textbox', { name: /^Name/ }), 'Test customer');
  await user.click(form.getByRole('button', { name: 'Add' }));
  expect((await screen.findByRole('status')).textContent).toBe('Added Test customer.');
  expect(crm.add).toHaveBeenLastCalledWith('077 000 0056', 'Test customer');
  expect(within(screen.getByRole('table')).getByRole('link', { name: 'Test customer' })).toBeTruthy();
  expect(screen.queryByRole('form', { name: 'Add customer' })).toBeNull();
});

test("Remove customer: the owner's, at once, back to the list; a manager is not offered it", async () => {
  const user = userEvent.setup();
  render(<CustomersView hash={`#customers/c/${KASUN.id}`} onRegister={() => {}} />);
  await user.click(await screen.findByRole('button', { name: 'Remove customer' }));
  expect(crm.remove).toHaveBeenCalledWith(KASUN.id);
  expect(location.hash).toBe('#customers');
  cleanup();

  shop.role = 'manager';
  render(<CustomersView hash={`#customers/c/${NIMALI.id}`} onRegister={() => {}} />);
  expect(await screen.findByRole('article')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Remove customer' })).toBeNull();
});

test('Undo after Remove puts the customer back', async () => {
  const user = userEvent.setup();
  const view = (hash: string) => <CustomersView hash={hash} onRegister={() => {}} />;
  const { rerender } = render(view(`#customers/c/${KASUN.id}`));
  await user.click(await screen.findByRole('button', { name: 'Remove customer' }));
  rerender(view('#customers'));
  const notice = await screen.findByRole('status');
  expect(notice.textContent).toMatch(/^Removed Kasun Perera\./);
  await user.click(within(notice).getByRole('button', { name: 'Undo' }));
  expect(crm.restore).toHaveBeenCalledWith(KASUN);
  await vi.waitFor(() => expect(within(screen.getByRole('table')).getByRole('link', { name: 'Kasun Perera' })).toBeTruthy());
});
