import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Root } from './Root.tsx';

const FRIDAY_EVENING = new Date(2026, 9, 9, 20, 30);

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers({ now: FRIDAY_EVENING, toFake: ['Date'] }); // only the clock: the demo history is built from "now"
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  history.replaceState(null, '', '/');
});

test('the demo owner feed: today in one line, then cards with one tap each', async () => {
  history.replaceState(null, '', '/?demo#owner');
  const user = userEvent.setup();
  render(<Root />);
  const feed = within(await screen.findByRole('region', { name: 'Needs your attention' }));
  const cards = await feed.findAllByRole('article');
  expect(cards.map((c) => c.getAttribute('aria-label'))).toEqual([
    expect.stringMatching(/^Sales \d+% below a usual Friday$/),
    expect.stringMatching(/voids today, \d+ by Ravi$/),
    expect.stringMatching(/^Kitchen slow/),
    '3 items running low',
    expect.stringMatching(/sold \d+ times this week; its stock isn't counted$|^\d+ dishes sold this week without a recipe$/),
    'Food costs: 22 answers to go',
    "BBQ Pork hasn't sold in 2 weeks",
    expect.stringMatching(/best seller$/),
  ]);
  expect(within(screen.getByRole('region', { name: 'Today' })).getByText(/^Rs [\d,]+$/)).toBeTruthy();

  await user.click(within(feed.getByRole('article', { name: '3 items running low' })).getByRole('button', { name: 'Order list' }));
  const sheet = within(screen.getByRole('dialog', { name: '3 items running low' }));
  expect(sheet.getByText('Pizza Flour')).toBeTruthy();
  expect(sheet.getByText(/Prima/)).toBeTruthy();
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('dialog')).toBeNull();
});

test('no history yet: a calm screen, not an empty error; only the food-cost questions wait', async () => {
  history.replaceState(null, '', '/#owner');
  render(<Root />);
  const feed = within(await screen.findByRole('region', { name: 'Needs your attention' }));
  expect((await feed.findAllByRole('article')).map((c) => c.getAttribute('aria-label'))).toEqual(['Food costs: 22 answers to go']);
  expect(screen.getByText('Rs 0')).toBeTruthy();
});
