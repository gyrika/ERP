import type { Actor } from '../domain/auth.ts';
import { MENU } from '../domain/menu.ts';
import type { SyncEvent } from '../domain/sync.ts';
import { lineGross, percentOf } from '../domain/totals.ts';
import type { OrderLine, SizeId } from '../domain/types.ts';
import { FAKE_SHOP_ID, FAKE_STAFF } from './data.ts';

/**
 * FAKE: five weeks of believable CheesyBeez trading, for the Owner view in
 * /?demo and for tests. Deterministic (seeded), so a demo looks the same every
 * time. Normal days have a lunch and a dinner rush, mostly cash, a discount or
 * a void now and then. TODAY is deliberately a bad day, so every kind of
 * insight has something to show: fewer sales than a usual same weekday, a
 * burst of voids by one manager, a slow kitchen in the last two hours, two
 * items running low, and one pizza nobody has ordered for three weeks.
 * Nothing here is real, and none of it is ever synced.
 */

const DAY = 24 * 60 * 60_000;
const MIN = 60_000;
const nimal: Actor = FAKE_STAFF.find((s) => s.actor.role === 'cashier')!.actor;
const ravi: Actor = FAKE_STAFF.find((s) => s.actor.role === 'manager')!.actor;

/** mulberry32: a small seeded random generator, so the demo is the same every time. */
const seeded = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/** How often each item is ordered (pizzas lead, the specials trail). */
const POPULAR: Record<string, number> = {
  'devilled-chicken': 10, margherita: 9, 'cheese-onion': 7, 'bbq-chicken': 7, sausages: 6, 'chicken-burger': 6,
  'crispy-chicken-burger': 5, veggie: 4, 'italian-pasta': 4, 'bbq-mix': 4, 'bbq-sausages': 3, 'tonno-cipolla': 3,
  seafood: 2, 'bacon-onion': 2, 'fish-burger': 2, 'egg-burger': 2, 'bacon-egg-burger': 2, 'bbq-pork': 2,
};
/** Nobody has ordered it for three weeks: the "not selling" card. */
const FORGOTTEN = 'bbq-pork';

export function demoHistory(now: number, shopId = FAKE_SHOP_ID): SyncEvent[] {
  const events: SyncEvent[] = [];
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  let orderNumber = 1001;
  let n = 0;
  const id = (p: string) => `demo-${p}-${++n}`;

  for (let back = 35; back >= 0; back--) {
    const day = new Date(today); day.setDate(day.getDate() - back);
    const dayStart = day.getTime();
    const isToday = back === 0;
    const rand = seeded(dayStart / DAY);
    const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
    const weekend = day.getDay() === 5 || day.getDay() === 6;
    let orders = Math.round((weekend ? 44 : 30) * (0.9 + rand() * 0.2));
    if (isToday) orders = Math.round(orders * 0.7); // a slow day

    const menu = MENU.filter((m) => !(m.id === FORGOTTEN && back <= 21));
    const weights = menu.map((m) => POPULAR[m.id] ?? 1);
    const totalWeight = weights.reduce((a, b) => a + b, 0);
    const chooseItem = () => {
      let r = rand() * totalWeight;
      for (let i = 0; i < menu.length; i++) { r -= weights[i]; if (r <= 0) return menu[i]; }
      return menu[menu.length - 1];
    };

    for (let o = 0; o < orders; o++) {
      // Lunch 12-2 pm for a third, dinner 6-9:30 pm for the rest.
      const minute = rand() < 0.35 ? 12 * 60 + rand() * 120 : 18 * 60 + rand() * 210;
      const sentAt = dayStart + Math.floor(minute) * MIN + Math.floor(rand() * 60_000);
      if (sentAt > now) continue;
      const number = orderNumber++;
      const lines: OrderLine[] = Array.from({ length: 1 + Math.floor(rand() * 3) }, () => {
        const item = chooseItem();
        const size = item.variants ? (pick(item.variants.map((v) => v.id)) as SizeId) : undefined;
        return {
          id: id('line'), itemId: item.id, qty: rand() < 0.8 ? 1 : 2, ...(size ? { size } : {}),
          adds: item.adds.length && rand() < 0.2 ? [item.adds[0].id] : [], outs: [], sent: true,
        };
      });
      const ticketId = id('ticket');
      events.push({ type: 'order.sent', id: id('sent'), shopId, at: sentAt, actor: nimal, orderNumber: number, ticketId, lines, addOn: false });

      // The kitchen: 7-12 minutes normally; 18-26 in tonight's last two hours.
      const slow = isToday && sentAt >= now - 2 * 60 * MIN;
      const cook = (slow ? 18 + rand() * 8 : 7 + rand() * 5) * MIN;
      if (sentAt + cook <= now) events.push({ type: 'kitchen.bumped', id: id('bump'), shopId, at: sentAt + cook, orderNumber: number, ticketId });

      let total = lines.reduce((s, l) => s + lineGross(l), 0);
      // A void now and then; today, a burst of them, all by the same manager.
      const voidChance = isToday ? 0.45 : 0.015;
      if (lines.length > 1 && rand() < voidChance && sentAt + 3 * MIN <= now) {
        const gone = lines[lines.length - 1];
        const after = total - lineGross(gone);
        events.push({
          type: 'order.item_cancelled', id: id('void'), shopId, at: sentAt + 3 * MIN, actor: ravi, orderNumber: number,
          lineId: gone.id, index: lines.length - 1, before: gone, reason: pick(['Customer changed mind', 'Wrong item', 'Too long a wait']),
          totalBefore: total, totalAfter: after,
        });
        total = after;
      }
      // About one 10% discount a day.
      if (rand() < 0.03 && sentAt + 20 * MIN <= now) {
        const after = total - percentOf(total, 10);
        events.push({
          type: 'order.discount_set', id: id('disc'), shopId, at: sentAt + 20 * MIN, actor: ravi, orderNumber: number,
          before: null, after: { kind: 'percent', pct: 10 }, totalBefore: total, totalAfter: after,
        });
        total = after;
      }
      // Customers eat first, pay after.
      const paidAt = sentAt + (25 + rand() * 20) * MIN;
      if (paidAt <= now) {
        const cash = rand() < 0.8;
        const tendered = cash ? Math.ceil(total / 100000) * 100000 : total;
        events.push({
          type: 'order.paid', id: id('paid'), shopId, at: paidAt, actor: nimal, orderNumber: number,
          total, tender: cash ? 'cash' : 'transfer', tendered,
        });
      }
    }
  }

  // Stock, counted by the manager three days ago and used since: pizza flour and mozzarella run low.
  const counted = today.getTime() - 3 * DAY + 10 * 60 * MIN;
  const stock: [string, number][] = [['inv-0001', 4], ['inv-0006', 3], ['inv-0024', 6], ['inv-0025', 5]]; // flour, mozzarella, onion, tomato
  for (const [itemId, packs] of stock) {
    events.push({ type: 'stock.adjusted', id: id('stock'), shopId, at: counted, orderNumber: 0, actor: ravi, itemId, deltaPacks: packs });
  }
  events.push({ type: 'stock.adjusted', id: id('stock'), shopId, at: counted + DAY, orderNumber: 0, actor: ravi, itemId: 'inv-0001', deltaPacks: -3 });
  events.push({ type: 'stock.adjusted', id: id('stock'), shopId, at: counted + 2 * DAY, orderNumber: 0, actor: ravi, itemId: 'inv-0006', deltaPacks: -3 });

  return events.filter((e) => e.at <= now).sort((a, b) => a.at - b.at);
}
