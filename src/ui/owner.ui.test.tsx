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

test('the demo Today: the shop at a glance, each part explained on the black screen, and the To do list with one tap each', async () => {
  history.replaceState(null, '', '/?demo#owner');
  const user = userEvent.setup();
  render(<Root />);
  const feed = within(await screen.findByRole('region', { name: 'Needs your attention' }));
  const cards = await feed.findAllByRole('article');
  expect(cards.map((c) => c.getAttribute('aria-label'))).toEqual([
    'Back camera offline for 40 min',
    expect.stringMatching(/^Sales \d+% below a usual Friday$/),
    expect.stringMatching(/^Tables \d+% quieter than a usual Friday$/),
    expect.stringMatching(/voids today, \d+ by Ravi$/),
    expect.stringMatching(/^Kitchen slow/),
    '3 items running low',
    expect.stringMatching(/sold \d+ times this week; its stock isn't counted$|^\d+ dishes sold this week without a recipe$/),
    'Food costs: 22 answers to go',
    expect.stringMatching(/^Guests staying \d+ min longer than usual$/),
    'Table 4 busiest, table 6 quietest',
    "BBQ Pork hasn't sold in 2 weeks",
    expect.stringMatching(/best seller$/),
  ]);
  // The shop at a glance: the sales ring, and the day in a sentence on the black screen.
  expect(screen.getByRole('button', { name: /^Sales today Rs [\d,]+/ })).toBeTruthy();
  const shopScreen = within(screen.getByRole('region', { name: 'Shop screen' }));
  expect(shopScreen.getByText('Today in a sentence')).toBeTruthy();
  expect(shopScreen.getByText(/below a usual Friday/)).toBeTruthy();
  // Tapping a station explains it there; tapping it again goes back to the summary.
  await user.click(screen.getByRole('button', { name: /^Shelves: / }));
  expect(shopScreen.getByText(/^Shelves: Rs [\d,]+ in stock \(on hand × latest price\)\./)).toBeTruthy();
  expect(shopScreen.getByRole('link', { name: 'See the records →' }).getAttribute('href')).toBe('#items');
  await user.click(screen.getByRole('button', { name: /^Shelves: / }));
  expect(shopScreen.getByText('Today in a sentence')).toBeTruthy();

  await user.click(within(feed.getByRole('article', { name: '3 items running low' })).getByRole('button', { name: 'Order list' }));
  const sheet = within(screen.getByRole('dialog', { name: '3 items running low' }));
  expect(sheet.getByText('Pizza Flour')).toBeTruthy();
  expect(sheet.getByText(/Prima/)).toBeTruthy();
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('dialog')).toBeNull();

  // The cameras (SCRUM-172): one tap names the camera, since when, and the tables it watches.
  await user.click(within(feed.getByRole('article', { name: 'Back camera offline for 40 min' })).getByRole('button', { name: 'See cameras' }));
  expect(within(screen.getByRole('dialog', { name: 'Back camera offline for 40 min' })).getByText('offline since 19:50 · tables 4, 5, 6')).toBeTruthy();
}, 15_000); // the whole demo history, worked out twice

test('no history yet: a calm screen, not an empty error; only the food-cost questions wait', async () => {
  history.replaceState(null, '', '/#owner');
  render(<Root />);
  const feed = within(await screen.findByRole('region', { name: 'Needs your attention' }));
  expect((await feed.findAllByRole('article')).map((c) => c.getAttribute('aria-label'))).toEqual(['Food costs: 22 answers to go']);
  expect(screen.getByRole('button', { name: 'Sales today Rs 0' })).toBeTruthy(); // no history: no ring yet
});
