import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FAKE_CUSTOMER_SHEET } from '../fake/data.ts';
import { planImport, type KnownCustomer } from '../domain/customerImport.ts';
import type { ModuleEvent } from '../domain/modules.ts';
import type { SyncEvent } from '../domain/sync.ts';

// Customers (CRM): on only where the developers turned it on; the owner's list in, previewed, saved.

const shop = vi.hoisted(() => ({ events: [] as SyncEvent[] }));
vi.mock('../services/ownerData.ts', async (real) => ({
  ...(await real<typeof import('../services/ownerData.ts')>()),
  useShopEvents: () => ({ state: 'ready', events: shop.events, at: Date.UTC(2026, 10, 11, 6, 0) }),
}));
const crm = vi.hoisted(() => ({ count: vi.fn(), preview: vi.fn(), save: vi.fn() }));
vi.mock('../services/crmClient.ts', () => ({ crmClient: crm, CrmFailed: Error }));

const { default: CustomersView } = await import('./customers/CustomersView.tsx');

const LIST = new Map<string, KnownCustomer>([
  ['+94770000003', { id: 'cus-0000000000000003', name: 'Chamara Silva' }],
  ['+94770000005', { id: 'cus-0000000000000005', name: 'Ruwan W' }],
]);
const crmOn = (on: boolean): ModuleEvent => ({
  id: `m-${on}`, shopId: 's', at: 1, orderNumber: 0, actor: { id: 'developers', name: 'Developers', role: 'owner' },
  type: 'shop.module_set', module: 'crm', on, codeId: '0123456789abcdef',
});
const file = () => new File(['(the file)'], 'customers.xlsx');

beforeEach(() => {
  localStorage.clear();
  shop.events = [crmOn(true)];
  crm.count.mockResolvedValue({ customers: 2 });
  crm.preview.mockImplementation(async (_f: File, rename: boolean) => ({ plan: planImport(FAKE_CUSTOMER_SHEET, LIST, { renameExisting: rename }) }));
  crm.save.mockImplementation(async (_f: File, rename: boolean) => ({
    plan: planImport(FAKE_CUSTOMER_SHEET, LIST, { renameExisting: rename }), saved: { added: 34, updated: rename ? 1 : 0 }, customers: 36,
  }));
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

test('off: the sidebar has no Customers, and the page says it is not on', async () => {
  shop.events = [crmOn(true), crmOn(false)];
  render(<CustomersView onRegister={() => {}} />);
  expect(screen.getByText('Customers are not on for this shop.')).toBeTruthy();
  expect(screen.queryByRole('link', { name: /^Customers/ })).toBeNull();
  expect(crm.count).not.toHaveBeenCalled();
});

test('on: pick the file, see what would happen and why rows are left out, then Save does it', async () => {
  const user = userEvent.setup();
  render(<CustomersView onRegister={() => {}} />);
  expect(screen.getByRole('link', { name: /^Customers/ })).toBeTruthy();
  expect(await screen.findByText('2 customers on the list.')).toBeTruthy();

  await user.upload(screen.getByLabelText('Customer file'), file());
  const counts = within(await screen.findByRole('list', { name: 'What importing would do' }));
  expect(counts.getByText(/new/).textContent).toBe('34 new (2 without a name)');
  expect(counts.getByText(/already on the list/).textContent).toBe('2 already on the list');
  expect(counts.getByText(/cannot be used/).textContent).toBe('6 cannot be used');
  expect(counts.getByText(/the same number again/).textContent).toBe('2 the same number again');
  expect(crm.save).not.toHaveBeenCalled();

  // Row by row where it matters: Excel's row number, what was there, and why.
  const table = within(screen.getByRole('table'));
  const landline = table.getByText('a landline, not a mobile').closest('tr')!;
  expect(within(landline).getAllByRole('cell').map((c) => c.textContent)).toEqual(['21', '0112345678', 'a landline, not a mobile']);
  expect(table.getByText('the same number as row 2')).toBeTruthy();
  expect(table.getByText('already on the list as “Ruwan W”; the file says “Ruwan Wickramasinghe”')).toBeTruthy();
  expect(table.getByText('also in the cell, not imported: +94710000027')).toBeTruthy();

  await user.click(screen.getByRole('button', { name: 'Save 34 customers' }));
  expect((await screen.findByRole('status')).textContent).toBe('34 customers added.');
  expect(crm.save).toHaveBeenCalledWith(expect.any(File), false);
  expect(screen.getByText('36 customers on the list.')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Import another file' })).toBeTruthy();
});

test('a name already on the list is kept unless the owner ticks to use the file\'s', async () => {
  const user = userEvent.setup();
  render(<CustomersView onRegister={() => {}} />);
  await user.upload(screen.getByLabelText('Customer file'), file());
  const tick = await screen.findByRole('checkbox', { name: /Use the file’s names for 1 customer already on the list/ });
  await user.click(tick);
  expect(crm.preview).toHaveBeenLastCalledWith(expect.any(File), true);
  expect(await screen.findByText(/names filled in or changed/)).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Save 35 customers' }));
  expect(crm.save).toHaveBeenCalledWith(expect.any(File), true);
  expect((await screen.findByRole('status')).textContent).toBe('34 customers added, 1 name filled in or changed.');
});

test('a file that is not a list says why, and nothing can be saved', async () => {
  crm.preview.mockResolvedValueOnce({ plan: planImport([['Name'], ['Kasun']], new Map()) });
  const user = userEvent.setup();
  render(<CustomersView onRegister={() => {}} />);
  await user.upload(screen.getByLabelText('Customer file'), file());
  expect((await screen.findByRole('alert')).textContent).toBe('customers.xlsx: no column of phone numbers was found.');
  expect(screen.queryByRole('button', { name: /^Save/ })).toBeNull();
  expect(screen.getByRole('button', { name: 'Choose file' })).toBeTruthy();
});

test('the same file again: nothing to save', async () => {
  const all = new Map(planImport(FAKE_CUSTOMER_SHEET, new Map()).rows.flatMap((r) => (r.kind === 'add' ? [[r.phone, { id: `id-${r.row}`, name: r.name }] as const] : [])));
  crm.preview.mockResolvedValueOnce({ plan: planImport(FAKE_CUSTOMER_SHEET, all) });
  const user = userEvent.setup();
  render(<CustomersView onRegister={() => {}} />);
  await user.upload(screen.getByLabelText('Customer file'), file());
  expect(((await screen.findByRole('button', { name: 'Nothing to save' })) as HTMLButtonElement).disabled).toBe(true);
});
