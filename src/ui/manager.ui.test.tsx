import { act } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FAKE_STAFF } from '../fake/data.ts';
import { App } from './App.tsx';
import { Kitchen } from './Kitchen.tsx';
import { readEvents } from './eventLog.ts';
import { MANAGER_IDLE_MS } from './useManagerMode.ts';

beforeEach(() => localStorage.clear());
afterEach(() => { cleanup(); vi.useRealTimers(); });

type User = ReturnType<typeof userEvent.setup>;
const pinFor = (role: string) => FAKE_STAFF.find((s) => s.actor.role === role)!.pin;
const managerName = FAKE_STAFF.find((s) => s.actor.role === 'manager')!.actor.name;
const panel = () => within(screen.getByRole('complementary', { name: 'Current order' }));
const kitchen = () => within(screen.getByRole('main', { name: 'Orders to make' }));
const managing = () => screen.queryByText(`Managing · ${managerName}`) !== null;
const total = () => screen.getByRole('complementary', { name: 'Current order' }).querySelector('.total')!.textContent;
const auditEvents = () => readEvents().filter((e) => 'totalBefore' in e);

/** 1001 = Margherita M (1,450) + Chicken Burger (450) = 1,900, sent, then opened from "Waiting to pay". */
const sendAndReopen = async (user: User) => {
  await user.click(screen.getAllByRole('button', { name: 'M 1450' })[0]);
  await user.click(screen.getAllByRole('button', { name: '450' })[0]);
  await user.click(panel().getByRole('button', { name: 'Send to kitchen' }));
  await user.click(panel().getByRole('button', { name: /^1001/ }));
};

/** Ctrl+M, then the PIN: the field is focused and checks itself at four digits. */
const unlock = async (user: User, pin = pinFor('manager')) => {
  await user.keyboard('{Control>}m{/Control}');
  await user.keyboard(pin);
};

test('Ctrl+M + manager PIN lifts the card and reads "Managing · <name>"; a cashier PIN does not', async () => {
  const user = userEvent.setup();
  render(<App />);
  await sendAndReopen(user);
  expect(panel().queryByRole('button', { name: /Margherita/ })).toBeNull(); // cashier: sent lines locked

  await unlock(user, pinFor('cashier'));
  expect(screen.getByRole('alert').textContent).toContain('PIN not accepted');
  await user.keyboard('{Escape}');
  expect(managing()).toBe(false);

  await unlock(user);
  expect(managing()).toBe(true);
  expect(screen.getByRole('complementary', { name: 'Current order' }).className).toContain('panel--managing');
  expect(screen.queryByText(/ADMIN/i)).toBeNull();
});

test('discount chips 1-4 give exact cent totals; Free is instant, says "Free · Undo", and Undo restores it exactly', async () => {
  const user = userEvent.setup();
  render(<App />);
  await sendAndReopen(user);
  await unlock(user);
  expect(total()).toBe('1,900');
  await user.keyboard('1');
  expect(total()).toBe('1,710');
  await user.keyboard('2');
  expect(total()).toBe('1,520');
  await user.keyboard('3');
  expect(total()).toBe('950');
  await user.keyboard('4');
  expect(total()).toBe('0');
  const toast = document.querySelector('.toast') as HTMLElement;
  expect(toast.textContent).toBe('FreeUndo');
  expect(auditEvents().at(-1)?.type).toBe('order.comped');

  await user.keyboard('{Control>}z{/Control}');
  expect(total()).toBe('950'); // back to exactly the 50% state
  await user.keyboard('3'); // the active chip again removes it
  expect(total()).toBe('1,900');
});

test('void a sent line (reason required) then Undo restores it in its original position, and the kitchen follows', async () => {
  const user = userEvent.setup();
  render(<><App /><Kitchen /></>);
  // Three lines, so "original position" means the middle one comes back in the middle.
  await user.click(screen.getAllByRole('button', { name: 'M 1450' })[0]);
  await user.click(screen.getAllByRole('button', { name: '450' })[0]);
  await user.click(screen.getAllByRole('button', { name: '650' })[0]);
  await user.click(panel().getByRole('button', { name: 'Send to kitchen' }));
  await user.click(panel().getByRole('button', { name: /^1001/ }));
  await unlock(user);

  await user.keyboard('{ArrowDown}{Delete}');
  expect(panel().getByRole('group', { name: 'Why void this item?' })).toBeTruthy(); // reason first, inline
  expect(panel().getByText('Chicken Burger')).toBeTruthy(); // nothing voided yet
  await user.keyboard('2'); // "Wrong item entered"
  expect(panel().queryByText('Chicken Burger')).toBeNull();
  expect(kitchen().getByText('Cancelled')).toBeTruthy();
  expect(auditEvents().at(-1)).toMatchObject({ type: 'order.item_cancelled', reason: 'Wrong item entered', index: 1 });

  await user.keyboard('{Control>}z{/Control}');
  const names = [...screen.getByRole('complementary', { name: 'Current order' }).querySelectorAll('.line__name')].map((el) => el.textContent);
  expect(names).toEqual(['Margherita', 'Chicken Burger', 'Crispy Chicken Burger']);
  expect(kitchen().queryByText('Cancelled')).toBeNull();
  expect(auditEvents().at(-1)?.type).toBe('order.change_undone');
});

test('P adjusts one line in cents without touching the menu price, and the order is stamped', async () => {
  const user = userEvent.setup();
  render(<App />);
  await sendAndReopen(user);
  await unlock(user);
  await user.keyboard('p');
  await user.keyboard('150.50{Enter}');
  expect(panel().getByText('−150.50 off this line')).toBeTruthy();
  expect(total()).toBe('1,749.50');
  expect(panel().getByText(new RegExp(`^Edited by ${managerName}, `))).toBeTruthy();
  expect(auditEvents().at(-1)).toMatchObject({ type: 'order.line_adjusted', before: 0, after: 15050, totalBefore: 190000, totalAfter: 174950 });
  expect(screen.getAllByRole('button', { name: 'M 1450' }).length).toBeGreaterThan(0); // menu price unchanged
});

test('the line price box takes only rupees, refuses 0, and Remove takes the adjustment off (SCRUM-137)', async () => {
  const user = userEvent.setup();
  render(<App />);
  await sendAndReopen(user);
  await unlock(user);
  await user.keyboard('p');
  const box = () => screen.getByRole('textbox', { name: 'Take off this line' }) as HTMLInputElement;
  await user.keyboard('abc');
  expect(box().value).toBe(''); // letters never appear
  const before = auditEvents().length;
  await user.keyboard('0{Enter}');
  expect(auditEvents().length).toBe(before); // 0 no longer secretly removes anything
  await user.clear(box());
  await user.keyboard('100{Enter}');
  expect(auditEvents().at(-1)).toMatchObject({ type: 'order.line_adjusted', after: 10000 });
  await user.keyboard('p');
  await user.click(screen.getByRole('button', { name: /^Remove the Rs 100/ }));
  expect(auditEvents().at(-1)).toMatchObject({ type: 'order.line_adjusted', before: 10000, after: 0 });
});

test('every change creates exactly one audit entry with the manager name and before/after', async () => {
  const user = userEvent.setup();
  render(<App />);
  await sendAndReopen(user);
  await unlock(user);
  await user.keyboard('1');
  await user.keyboard('p');
  await user.keyboard('100{Enter}');
  await user.keyboard('4');
  await user.keyboard('{Control>}z{/Control}');
  const audit = auditEvents();
  expect(audit.map((e) => e.type)).toEqual(['order.discount_set', 'order.line_adjusted', 'order.comped', 'order.change_undone']);
  for (const e of audit) {
    expect(e.actor.name).toBe(managerName);
    expect(Number.isInteger((e as { totalBefore: number }).totalBefore)).toBe(true);
    expect(Number.isInteger((e as { totalAfter: number }).totalAfter)).toBe(true);
    expect(e.shopId).toBeTruthy();
  }
});

test('auto-return after 10 s idle, and any key press resets the timer', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  render(<App />);
  await sendAndReopen(user);
  await unlock(user);
  act(() => { vi.advanceTimersByTime(MANAGER_IDLE_MS - 1000); });
  expect(managing()).toBe(true);
  await user.keyboard('{ArrowDown}'); // a key press resets it
  act(() => { vi.advanceTimersByTime(MANAGER_IDLE_MS - 1000); });
  expect(managing()).toBe(true);
  act(() => { vi.advanceTimersByTime(1500); });
  expect(managing()).toBe(false);
  expect(screen.getByRole('complementary', { name: 'Current order' }).className).not.toContain('panel--managing');
});

test('Esc leaves manager mode from any state', async () => {
  const user = userEvent.setup();
  render(<App />);
  await sendAndReopen(user);
  const states: [string, () => Promise<void>][] = [
    ['plain', async () => {}],
    ['palette open', async () => { await user.keyboard('{Control>}k{/Control}'); expect(screen.getByRole('dialog', { name: 'Commands' })).toBeTruthy(); }],
    ['void reason pending', async () => { await user.keyboard('{Delete}'); expect(panel().getByRole('group', { name: 'Why void this item?' })).toBeTruthy(); }],
    ['adjusting a price', async () => { await user.keyboard('p'); await user.keyboard('12'); }],
    ['edit sheet open', async () => { await user.keyboard('{Enter}'); expect(screen.getByRole('dialog')).toBeTruthy(); }],
  ];
  for (const [name, into] of states) {
    await unlock(user);
    expect(managing(), name).toBe(true);
    await into();
    await user.keyboard('{Escape}');
    expect(managing(), name).toBe(false);
    expect(screen.queryByRole('dialog'), name).toBeNull();
    expect(panel().queryByRole('group', { name: 'Why void this item?' }), name).toBeNull();
  }
});

test('a manager change cannot be undone from cashier mode', async () => {
  const user = userEvent.setup();
  render(<App />);
  await sendAndReopen(user);
  await unlock(user);
  await user.keyboard('4');
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
  await user.keyboard('{Control>}z{/Control}');
  expect(total()).toBe('0');
});

test('a comped order closes with "Close · Free" and shows as Paid · Free', async () => {
  const user = userEvent.setup();
  render(<App />);
  await sendAndReopen(user);
  await unlock(user);
  await user.keyboard('4{Escape}');
  await user.click(panel().getByRole('button', { name: 'Close · Free' }));
  await user.click(panel().getByRole('button', { name: 'Next order' }));
  expect(within(panel().getByRole('region', { name: 'Paid today' })).getByText('Paid · Free')).toBeTruthy();
  expect(readEvents().at(-1)).toMatchObject({ type: 'order.paid', total: 0, tender: 'comp' });
});

test('editing a sent line still needs a reason', async () => {
  const user = userEvent.setup();
  render(<App />);
  await sendAndReopen(user);
  await unlock(user);
  await user.keyboard('{Enter}'); // edit Margherita
  const sheet = within(screen.getByRole('dialog'));
  await user.click(sheet.getByRole('button', { name: /^Large/ }));
  await user.click(sheet.getByRole('button', { name: /^Save change/ }));
  expect(sheet.getByRole('alert').textContent).toBe('Pick a reason first');
  await user.click(sheet.getByRole('button', { name: 'Customer changed mind' }));
  await user.click(sheet.getByRole('button', { name: /^Save change/ }));
  expect(total()).toBe('2,440');
  expect(auditEvents().at(-1)).toMatchObject({ type: 'order.item_changed', reason: 'Customer changed mind' });
});

test('cashier rules kept: sends share the event log; Undo of a send only straight after it', async () => {
  const user = userEvent.setup();
  render(<><App /><Kitchen /></>);
  await user.click(screen.getAllByRole('button', { name: 'M 1450' })[0]);
  await user.click(panel().getByRole('button', { name: 'Send to kitchen' }));
  await user.click(screen.getAllByRole('button', { name: '450' })[0]); // next customer: the send is sealed
  await user.keyboard('{Control>}z{/Control}{Control>}z{/Control}');
  expect(kitchen().getByRole('article', { name: 'Order 1001' })).toBeTruthy();
  expect(readEvents().map((e) => e.type)).toEqual(['order.sent']);
  expect(readEvents()[0].shopId).toBeTruthy();
});

test('light or dark for this screen, from the command palette; it stays after a restart', async () => {
  const user = userEvent.setup();
  render(<App />);
  await unlock(user);
  await user.keyboard('{Control>}k{/Control}');
  await user.keyboard('dark mode{Enter}');
  expect(document.documentElement.dataset.theme).toBe('dark');
  expect(localStorage.getItem('cb.theme')).toBe('dark');

  await user.keyboard('{Control>}k{/Control}');
  expect(screen.getByRole('option', { name: /Dark mode/ }).textContent).toContain('On');
  await user.keyboard('follow windows{Enter}');
  expect(document.documentElement.dataset.theme).toBeUndefined();
  expect(localStorage.getItem('cb.theme')).toBeNull();
});
