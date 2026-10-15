import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { setMenuState } from '../domain/menu.ts';
import { EMPTY_MENU_STATE } from '../domain/menuEdits.ts';
import { OrderSite } from './OrderSite.tsx';

/** The cloud's /api/v1/shop: each call takes the next answer; 'fail' is a network error. */
let answers: ('open' | 'closed' | 'fail')[] = [];
let hours: { opens: number; closes: number } | null = null;
let phone: string | null = null;
const shopCalls = () => vi.mocked(fetch).mock.calls.filter(([url]) => url === '/api/v1/shop').length;

beforeEach(() => {
  localStorage.clear();
  setMenuState(EMPTY_MENU_STATE);
  answers = [];
  hours = null;
  phone = null;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url !== '/api/v1/shop') throw new Error(`unexpected ${url}`);
    const next = answers.shift() ?? 'open';
    if (next === 'fail') throw new TypeError('Failed to fetch');
    return new Response(JSON.stringify({ name: 'CheesyBeez Thalwila', open: next === 'open', hours, phone }), { status: 200 });
  }));
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); setMenuState(EMPTY_MENU_STATE); });

/** The header's one state: the pill, or the Retry pill. */
const pill = () => screen.queryAllByRole('status').map((b) => b.textContent);
const RETRY = "We couldn't check if we're open. Retry";
/** A menu card (not its + , which is "Add <name>"). */
const card = (name: RegExp) => screen.getAllByRole('button', { name }).find((b) => b.classList.contains('o-item'))!;

test('closed, then a check fails: one message, "we couldn\'t check", never closed and unreachable at once', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  answers = ['closed', 'fail'];
  render(<OrderSite />);
  expect(await screen.findByText('Closed')).toBeTruthy();

  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(await screen.findByRole('button', { name: RETRY })).toBeTruthy();
  expect(pill()).toEqual([]);
  expect(screen.queryByText(/closed/i)).toBeNull();
});

test('a failed first check offers Retry, which checks again; open shows no banner', async () => {
  answers = ['fail', 'open'];
  const user = userEvent.setup();
  render(<OrderSite />);
  await user.click(await screen.findByRole('button', { name: RETRY }));
  expect(await screen.findByText('Open for pickup')).toBeTruthy();
  expect(pill()).toEqual(['Open for pickup']);
  expect(screen.queryByRole('button', { name: RETRY })).toBeNull();
  expect(shopCalls()).toBe(2);
});

test('while loading: no banner and no open/closed claim', () => {
  vi.mocked(fetch).mockImplementation(() => new Promise(() => {}));
  render(<OrderSite />);
  expect(pill()).toEqual([]);
  expect(screen.queryByText(/closed|Open for pickup/i)).toBeNull();
});

test('closed: items can be looked at but not added', async () => {
  answers = ['closed'];
  const user = userEvent.setup();
  render(<OrderSite />);
  await screen.findByText('Closed');
  await user.click(card(/Margherita/));
  const sheet = within(screen.getByRole('dialog', { name: 'Margherita' }));
  expect((sheet.getByRole('button', { name: 'Closed for online orders' }) as HTMLButtonElement).disabled).toBe(true);
});

test('open: an item goes into the order', async () => {
  answers = ['open'];
  const user = userEvent.setup();
  render(<OrderSite />);
  await screen.findByText('Open for pickup');
  await user.click(card(/Margherita/));
  await user.click(screen.getByRole('button', { name: /^Add · Rs 1,450/ }));
  expect(screen.getByRole('button', { name: /View order/ })).toBeTruthy();
});

test('+ on a one-size item adds it at once: toast, and the bar says "1 item · Rs 450 · View order"', async () => {
  const user = userEvent.setup();
  render(<OrderSite />);
  await screen.findByText('Open for pickup');
  expect(screen.queryByRole('button', { name: /View order/ })).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Add Fish Burger' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.getByText('Added to order')).toBeTruthy();
  expect(screen.getByRole('button', { name: /View order/ }).textContent).toBe('1 item · Rs 450 · View order');
  await user.click(screen.getByRole('button', { name: 'Add Fish Burger' }));
  expect(screen.getByRole('button', { name: /View order/ }).textContent).toBe('2 items · Rs 900 · View order');
});

test('+ on an item with sizes asks which size; one tap adds it', async () => {
  const user = userEvent.setup();
  render(<OrderSite />);
  await screen.findByText('Open for pickup');
  await user.click(screen.getByRole('button', { name: 'Add Margherita' }));
  const sheet = within(screen.getByRole('dialog', { name: 'Margherita: choose a size' }));
  await user.click(sheet.getByRole('button', { name: /Large/ }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.getByRole('button', { name: /View order/ }).textContent).toBe('1 item · Rs 1,990 · View order');
});

test('the desktop panel lists the order and opens checkout', async () => {
  const user = userEvent.setup();
  render(<OrderSite />);
  await screen.findByText('Open for pickup');
  const panel = within(screen.getByRole('region', { name: 'Your order' }));
  expect(panel.getByText('Your order is empty')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Add Fish Burger' }));
  expect(panel.getByText('Fish Burger')).toBeTruthy();
  await user.click(panel.getByRole('button', { name: 'One more' }));
  expect(panel.getByText('Rs 900')).toBeTruthy();
  await user.click(panel.getByRole('button', { name: 'Checkout' }));
  expect(screen.getByRole('dialog', { name: 'Your order' })).toBeTruthy();
});

test('the browser install prompt is offered as an app button', async () => {
  const user = userEvent.setup();
  const prompt = vi.fn().mockResolvedValue(undefined);
  const event = new Event('beforeinstallprompt', { cancelable: true });
  Object.defineProperty(event, 'prompt', { value: prompt });
  render(<OrderSite />);

  await act(async () => { window.dispatchEvent(event); });
  const button = await screen.findByRole('button', { name: 'Install app' });
  await user.click(button);
  expect(prompt).toHaveBeenCalledOnce();
  expect(screen.queryByRole('button', { name: 'Install app' })).toBeNull();
});

test('pickup info: the town with a Maps link, how to pay; hours, Call and WhatsApp only once the owner gave them', async () => {
  render(<OrderSite />);
  await screen.findByText('Open for pickup');
  let info = within(screen.getByRole('region', { name: 'Pickup info' }));
  expect(info.getByText(/CheesyBeez, Thalwila/)).toBeTruthy();
  expect(info.getByRole('link', { name: 'Open in Maps' }).getAttribute('href')).toBe('https://www.google.com/maps/search/?api=1&query=CheesyBeez%20Thalwila');
  expect(info.getByText('Pay when you collect: cash or bank transfer')).toBeTruthy();
  expect(info.queryByText(/Daily/)).toBeNull();
  expect(info.queryByRole('link', { name: 'Call' })).toBeNull();
  cleanup();

  hours = { opens: 660, closes: 1260 };
  phone = '0771817968';
  render(<OrderSite />);
  await screen.findByText('Open · Closes 9 PM');
  info = within(screen.getByRole('region', { name: 'Pickup info' }));
  expect(info.getByText('Daily 11 AM – 9 PM')).toBeTruthy();
  expect(info.getByText('077 181 7968')).toBeTruthy();
  expect(info.getByRole('link', { name: 'Call' }).getAttribute('href')).toBe('tel:+94771817968');
  expect(info.getByRole('link', { name: 'WhatsApp' }).getAttribute('href')).toBe('https://wa.me/94771817968');
});

test('mood strips: two at most, after Pizza and before the footer, never back to back, never above the menu', async () => {
  render(<OrderSite />);
  await screen.findByText('Open for pickup');
  const strips = [...document.querySelectorAll<HTMLElement>('.o-strip')];
  expect(strips.map((el) => el.querySelector('.o-strip__line')!.textContent)).toEqual(['Stone-baked. Straight from the fire.', 'Thalwila. Collect it hot.']);
  expect(document.getElementById('pizza')!.nextElementSibling).toBe(strips[0]);
  expect(strips[0].compareDocumentPosition(document.getElementById('pizza')!) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
  // Between the two: at least one section of 3+ items.
  const between = [...document.querySelectorAll('.o-section')].filter((sec) =>
    strips[0].compareDocumentPosition(sec) & Node.DOCUMENT_POSITION_FOLLOWING && sec.compareDocumentPosition(strips[1]) & Node.DOCUMENT_POSITION_FOLLOWING);
  expect(between.some((sec) => sec.querySelectorAll('.o-items > li').length >= 3)).toBe(true);
  expect(strips[1].nextElementSibling?.tagName).toBe('FOOTER');
  const end = within(strips[1]);
  expect(end.getByText(/CheesyBeez, Thalwila/)).toBeTruthy();
  expect(end.queryByText(/Daily/)).toBeNull();
  expect(end.getByRole('link', { name: 'Open in Maps' })).toBeTruthy();
  for (const img of document.querySelectorAll('.o-strip img')) expect([img.getAttribute('loading'), img.getAttribute('width'), img.getAttribute('height')]).toEqual(['lazy', '800', '600']);
});

test('reveal: hidden only once observed, shown once on entering; nothing with reduced motion', async () => {
  const watched: Element[] = [];
  let fire: (e: { target: Element; isIntersecting: boolean }[]) => void = () => {};
  vi.stubGlobal('IntersectionObserver', class {
    constructor(cb: typeof fire) { fire = cb; }
    observe(el: Element) { watched.push(el); }
    unobserve(el: Element) { watched.splice(watched.indexOf(el), 1); }
    disconnect() {}
  });
  document.documentElement.classList.remove('o-motion');
  render(<OrderSite />);
  expect(document.documentElement.classList.contains('o-motion')).toBe(true);
  const heading = screen.getByRole('heading', { name: 'Burgers' });
  expect(watched).toContain(heading);
  act(() => fire([{ target: heading, isIntersecting: true }]));
  expect(heading.classList.contains('o-in')).toBe(true);
  expect(watched).not.toContain(heading);
  cleanup();

  document.documentElement.classList.remove('o-motion');
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('reduce'), addEventListener() {}, removeEventListener() {} }));
  render(<OrderSite />);
  expect(document.documentElement.classList.contains('o-motion')).toBe(false);
});

test("with the owner's hours set, the pill says when it closes; no hours, no times", async () => {
  hours = { opens: 660, closes: 1260 };
  answers = ['open'];
  render(<OrderSite />);
  expect(await screen.findByText('Open · Closes 9 PM')).toBeTruthy();
});

test('the hero: two lines, a short subtitle, and the three trust items', async () => {
  render(<OrderSite />);
  const hero = screen.getByRole('heading', { level: 1 });
  expect(hero.textContent).toBe('Order ahead.Collect it hot.');
  expect(screen.getAllByRole('listitem').slice(0, 3).map((li) => li.textContent)).toEqual(['Pickup only', 'Pay when you collect', 'We confirm your ready time']);
});

test('cards: a photo, Popular from the printed menu, "from" and the price apart, + hidden when closed', async () => {
  answers = ['closed'];
  render(<OrderSite />);
  await screen.findByText('Closed');
  const c = within(card(/Margherita/));
  expect(c.getByText('Popular')).toBeTruthy();
  expect(c.getByText('from')).toBeTruthy();
  expect(c.getByText('Rs 1,450')).toBeTruthy();
  expect(card(/Margherita/).querySelector('.o-item__photo img')?.getAttribute('src')).toMatch(/margherita/);
  expect(screen.queryByRole('button', { name: 'Add Margherita' })).toBeNull();
  expect(within(card(/Cheese & Onion/)).queryByText('Popular')).toBeNull();
});

test('section chips: the section under the chips is highlighted, the last one at the page end; a tap scrolls smoothly there', async () => {
  type Cb = (entries: { target: Element; isIntersecting: boolean }[]) => void;
  const observers: { cb: Cb; targets: Element[] }[] = [];
  vi.stubGlobal('IntersectionObserver', class {
    o: { cb: Cb; targets: Element[] };
    constructor(cb: Cb) { this.o = { cb, targets: [] }; observers.push(this.o); }
    observe(el: Element) { this.o.targets.push(el); }
    disconnect() { this.o.targets = []; }
  });
  /** The browser reports this element crossing (or leaving) its observer's area. */
  const cross = (el: Element, isIntersecting = true) =>
    act(() => observers.filter((o) => o.targets.includes(el)).forEach((o) => o.cb([{ target: el, isIntersecting }])));
  const scrolled: string[] = [];
  Element.prototype.scrollIntoView = function (this: Element) { scrolled.push(this.id); };
  const user = userEvent.setup();
  render(<OrderSite />);
  const chip = (name: string) => screen.getByRole('link', { name });
  expect(chip('Pizza').getAttribute('aria-current')).toBe('true');
  expect(chip('Burgers').getAttribute('aria-current')).toBeNull();

  cross(document.getElementById('burger')!);
  expect(chip('Burgers').getAttribute('aria-current')).toBe('true');
  expect(chip('Pizza').getAttribute('aria-current')).toBeNull();
  cross(document.querySelector('.o-foot')!);
  expect(chip('Pasta').getAttribute('aria-current')).toBe('true');
  cross(document.querySelector('.o-foot')!, false);
  expect(chip('Burgers').getAttribute('aria-current')).toBe('true');

  await user.click(chip('Pizza'));
  expect(scrolled).toEqual(['pizza']);
  expect(chip('Pizza').getAttribute('aria-current')).toBe('true');
  cross(document.getElementById('burger')!);
  expect(chip('Pizza').getAttribute('aria-current')).toBe('true'); // sections passed on the way do not steal it
});
