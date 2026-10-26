import type { Actor } from '../domain/auth.ts';
import { MENU } from '../domain/menu.ts';
import type { SyncEvent } from '../domain/sync.ts';
import { lineGross, percentOf } from '../domain/totals.ts';
import type { OrderLine, SizeId } from '../domain/types.ts';
import type { TableState } from '../domain/tables.ts';
import { FAKE_SHOP_ID, FAKE_STAFF, FAKE_TABLES } from './data.ts';

/**
 * FAKE: five weeks of believable CheesyBeez trading, for the Owner view in
 * /?demo and for tests. Deterministic (seeded), so a demo looks the same every
 * time. Normal days have a lunch and a dinner rush, mostly cash, a discount or
 * a void now and then. TODAY is deliberately a bad day, so every kind of
 * insight has something to show: fewer sales than a usual same weekday, a
 * burst of voids by one manager, a slow kitchen in the last two hours, two
 * items running low, and one pizza nobody has ordered for three weeks.
 * Two cameras watch the six tables: today fewer tables are taken, guests stay
 * longer (the kitchen is slow), table 6 by the door is hardly used, and the
 * back camera has been offline for the last 40 minutes. The cameras have been in
 * Shadow all along (SCRUM-174): staff seat guests and wipe tables, and twice a day
 * they free a table the cameras wrongly saw taken, so the Shadow week card has
 * something to say; the worker's last heartbeat is 15 seconds old.
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

/** A seed from the calendar date, not the millisecond, so the demo is the same in every time zone. */
const dateSeed = (dayStart: number): number => { const d = new Date(dayStart); return d.getFullYear() * 372 + d.getMonth() * 31 + d.getDate(); };

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
      const startAt = sentAt + Math.min(cook / 3, 3 * MIN);
      if (startAt <= now) events.push({ type: 'kitchen.started', id: id('start'), shopId, at: startAt, orderNumber: number, ticketId });
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

  events.push(...demoTables(today.getTime(), now, shopId, id));

  return events.filter((e) => e.at <= now).sort((a, b) => a.at - b.at);
}

const cameras: Actor = { id: 'vision', name: 'Cameras', role: 'vision' };
const owner: Actor = FAKE_STAFF.find((s) => s.actor.role === 'owner')!.actor;
/** How often each table is taken: the big table most, table 6 by the door hardly. */
const TABLE_WEIGHT: Record<string, number> = { 'demo-t1': 3, 'demo-t2': 4, 'demo-t3': 4, 'demo-t4': 7, 'demo-t5': 2, 'demo-t6': 0.4 };
const FRONT = ['demo-t1', 'demo-t2', 'demo-t3'];

/** The cameras' side of the five weeks: visits seen, tables wiped by the cashier, the back camera offline now. */
function demoTables(today: number, now: number, shopId: string, id: (p: string) => string): SyncEvent[] {
  const events: SyncEvent[] = [];
  const start = today - 36 * DAY;
  const base = { shopId, orderNumber: 0 as const };
  /** Each camera sees its three tables side by side: the first third, the middle, the last. */
  const zone = (tableId: string, i: number) => {
    const x = 0.04 + (i % 3) * 0.32;
    return { id: `zone-${tableId}`, tableId, points: [{ x, y: 0.3 }, { x: x + 0.28, y: 0.3 }, { x: x + 0.28, y: 0.95 }, { x, y: 0.95 }] };
  };
  events.push(
    { ...base, type: 'table.layout_set', id: id('layout'), at: start, actor: owner, tables: FAKE_TABLES },
    { ...base, type: 'vision.cameras_set', id: id('cams'), at: start, actor: owner, cameras: [
      { id: 'demo-cam-front', name: 'Front', ip: '192.168.1.21', rtspPath: '/stream1', enabled: true },
      { id: 'demo-cam-back', name: 'Back', ip: '192.168.1.22', rtspPath: '/stream1', enabled: true },
    ] },
    { ...base, type: 'vision.zones_set', id: id('zones'), at: start, actor: owner, cameraId: 'demo-cam-front', zones: FRONT.map((t, i) => zone(t, i)) },
    { ...base, type: 'vision.zones_set', id: id('zones'), at: start, actor: owner, cameraId: 'demo-cam-back', zones: FAKE_TABLES.filter((t) => !FRONT.includes(t.id)).map((t, i) => zone(t.id, i)) },
    // A shop that ran the old Shadow mode (gone 2026-10-27): CV shows Off; the cameras' changes are history the cards read.
    { ...base, type: 'vision.settings_set', id: id('vset'), at: start, actor: owner, mode: 'shadow', shortVisitS: 180, leftCheckS: 10, autoFreeS: 300 },
  );
  const backOffline = now - 40 * MIN;
  const heartbeat = (at: number, backOnline: boolean, cpu: number): SyncEvent => ({ ...base, type: 'vision.heartbeat', id: id('beat'), at, actor: cameras,
    cameras: [{ id: 'demo-cam-front', online: true, fps: 5 }, { id: 'demo-cam-back', online: backOnline, fps: backOnline ? 5 : 0 }], cpu });
  events.push(
    heartbeat(backOffline - MIN, true, 13),
    { ...base, type: 'vision.camera_offline', id: id('offline'), at: backOffline, actor: cameras, cameraId: 'demo-cam-back' },
    heartbeat(now - 15_000, false, 11),
  );
  const change = (tableId: string, at: number, from: TableState, to: TableState): SyncEvent =>
    ({ ...base, type: 'table.state_changed', id: id('seen'), at, actor: cameras, tableId, from, to, confidence: 0.9 });

  // Right now, whatever the hour (the front camera's tables; the back one is offline): two tables
  // seated, one the cameras saw empty 3 minutes ago that nobody has wiped yet, one reserved.
  const seat = (tableId: string, ago: number): SyncEvent[] => [change(tableId, now - ago * MIN, 'free', 'occupied'),
    { ...base, type: 'table.state_set', id: id('seat'), at: now - (ago - 1) * MIN, actor: nimal, tableId, from: 'free', to: 'occupied' }];
  events.push(...seat('demo-t1', 52), change('demo-t1', now - 3 * MIN, 'occupied', 'needs_cleaning'), ...seat('demo-t2', 24), ...seat('demo-t3', 9),
    { ...base, type: 'table.state_set', id: id('book'), at: now - 12 * MIN, actor: nimal, tableId: 'demo-t6', from: 'free', to: 'reserved' });


  for (let back = 35; back >= 0; back--) {
    const day = new Date(today); day.setDate(day.getDate() - back);
    const dayStart = day.getTime();
    const isToday = back === 0;
    // Its own seed, so the sales above stay exactly as they were.
    const rand = seeded(dateSeed(dayStart) + 505);
    // The staff's side in Shadow: its own seed, so the visits stay exactly as they were.
    const staff = seeded(dateSeed(dayStart) + 909);
    // Twice a day before lunch the cameras take a waiter for a guest; staff free the table within minutes (a miss).
    // The waiter leaves within 3 minutes, a short visit: straight back to free, no cleaning (the owner's rules).
    for (const k of [0, 1]) {
      const at = dayStart + Math.floor((11 * 60 + k * 25 + staff() * 15) * MIN);
      const table = FAKE_TABLES[Math.floor(staff() * FAKE_TABLES.length)].id;
      if (at > now || (isToday && at >= backOffline && !FRONT.includes(table))) continue;
      events.push(change(table, at, 'free', 'occupied'),
        { ...base, type: 'table.state_set', id: id('fix'), at: at + 2 * MIN, actor: nimal, tableId: table, from: 'free', to: 'free' },
        change(table, at + 2 * MIN + 10_000, 'occupied', 'free'));
    }
    const weekend = day.getDay() === 5 || day.getDay() === 6;
    let visits = Math.round((weekend ? 26 : 18) * (0.9 + rand() * 0.2));
    if (isToday) visits = Math.round(visits * 0.6); // fewer tables taken today, clearly past the 20% line in any time zone
    const freeAt = new Map(FAKE_TABLES.map((t) => [t.id, 0]));
    const starts = Array.from({ length: visits }, () => dayStart + Math.floor((rand() < 0.4 ? 12 * 60 + rand() * 120 : 18 * 60 + rand() * 210) * MIN))
      .sort((a, b) => a - b);
    for (const at of starts) {
      // Today the back camera sees nothing since it went offline.
      const open = FAKE_TABLES.filter((t) => freeAt.get(t.id)! <= at && !(isToday && at >= backOffline && !FRONT.includes(t.id))
        && !(isToday && at >= now - 60 * MIN && t.id !== 'demo-t4' && t.id !== 'demo-t5'));
      if (!open.length) continue;
      let r = rand() * open.reduce((n, t) => n + TABLE_WEIGHT[t.id], 0);
      const table = open.find((t) => (r -= TABLE_WEIGHT[t.id]) <= 0) ?? open[open.length - 1];
      // 25-45 minutes normally; 40-60 today, with the kitchen slow.
      const stay = Math.floor((isToday ? 40 + rand() * 20 : 25 + rand() * 20) * MIN);
      const wiped = at + stay + Math.floor((2 + rand() * 6) * MIN);
      freeAt.set(table.id, wiped);
      // Left after a long visit: needs cleaning, and the cameras' tracker frees it 5 minutes later.
      events.push(change(table.id, at, 'free', 'occupied'), change(table.id, at + stay, 'occupied', 'needs_cleaning'),
        change(table.id, at + stay + 5 * MIN, 'needs_cleaning', 'free'));
      // Staff seat them a minute or three after the cameras see them, and wipe the table after they leave.
      events.push({ ...base, type: 'table.state_set', id: id('seat'), at: at + Math.floor((1 + staff() * 2) * MIN), actor: nimal, tableId: table.id, from: 'free', to: 'occupied' });
      events.push({ ...base, type: 'table.state_set', id: id('wipe'), at: wiped, actor: nimal, tableId: table.id, from: 'occupied', to: 'free' });
    }
  }
  return events;
}
