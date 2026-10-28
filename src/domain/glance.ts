import { answersFromEvents, menuCost, type CostContext } from './costing.ts';
import { salesFrom, ticketTimes, type Insight, type ShopData } from './insights.ts';
import { stockFromEvents, stockStatus } from './inventory.ts';
import { queue, ticketsFromEvents } from './kitchen.ts';
import { menuItems } from './menu.ts';
import { fmt, unitPrice } from './money.ts';
import { OUT_TOO_LONG_MS } from './online.ts';
import { grnValueCents, purchasesFromEvents } from './purchaseOrders.ts';
import { formatStock } from './itemStory.ts';
import type { SyncEvent } from './sync.ts';
import type { Cents, Tender } from './types.ts';
import { valuationOf, valueAt } from './valuation.ts';
import { wasteRecords } from './waste.ts';
import { wasteCents } from './wasteInsights.ts';

/**
 * Today at a glance (SCRUM-173): the whole shop in one look for the owner, and in words for
 * whatever he taps. Pure, like insights.ts: events in, the picture and its explanations out, so
 * the counter, the owner's phone and the tests all see the same. Every explanation says where
 * its number comes from, so nothing on the screen has to be taken on trust.
 *
 * "Usual" is the same weekday over the last 4 weeks, days the shop was open only; with fewer
 * than 2 such days there is no usual yet, and the screen says so instead of guessing.
 */
export type StationId = 'deliveries' | 'shelves' | 'kitchen' | 'counter' | 'money';
export type StationTone = 'ok' | 'warn';

export interface Station {
  id: StationId;
  label: string;
  /** The one number on it. */
  value: string;
  tone: StationTone;
  /** Things to look at; 0: none. */
  badge: number;
  explain: string;
  /** Where its records are, on the counter (the owner's phone has no such screens). */
  href: string | null;
}

export interface HourBar {
  hour: number;
  label: string;
  /** Sold in this hour today; null: still to come. */
  today: Cents | null;
  usual: Cents | null;
  explain: string;
}

export type DotStatus = 'ok' | 'low' | 'out' | 'unknown';
export interface StockDot { id: string; name: string; status: DotStatus; explain: string }

export interface Glance {
  sales: Cents;
  orders: number;
  /** A usual day for this weekday, all day; null: not enough history yet. */
  usualDay: Cents | null;
  /** Today against that day, 0..; null: no usual yet. */
  share: number | null;
  ringExplain: string;
  stations: Station[];
  hours: HourBar[];
  /** Of every Rs 100 sold today, whole rupees; null: nothing sold yet. */
  split: { food: number; waste: number; kept: number; explain: string } | null;
  stock: { value: Cents; dots: StockDot[]; low: number; out: number; unknown: number; explain: string };
  summary: string;
}

const DAY = 24 * 60 * 60 * 1000;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const startOfDay = (t: number) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
const weeksBack = (day: number, k: number) => { const d = new Date(day); d.setDate(d.getDate() - 7 * k); return d.getTime(); };
const hourOf = (t: number) => new Date(t).getHours();
const hourLabel = (h: number) => `${h % 12 || 12} ${h < 12 ? 'am' : 'pm'}`;
const clock = (t: number) => { const d = new Date(t); return `${d.getHours() % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')} ${d.getHours() < 12 ? 'am' : 'pm'}`; };
const rs = (c: Cents) => `Rs ${fmt(Math.round(c / 100) * 100)}`;
const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
const TENDER: Record<Tender, string> = { cash: 'Cash', transfer: 'Bank transfer', card: 'Card', qr: 'QR', comp: 'Free' };

/**
 * Today's deliveries (SCRUM-193) sent to the kitchen and not paid yet: the rider still has the food
 * or the cash. `due` is their lines at the price they were sent at plus the fee (a later discount
 * would make it less, hence "about").
 */
export const unpaidDeliveries = (events: readonly SyncEvent[], today: number, now: number): { number: number; due: Cents; readyBy: number }[] => {
  const out = new Map<number, { number: number; due: Cents; readyBy: number }>();
  for (const e of events) {
    if (e.at < today || e.at > now) continue;
    if (e.type === 'order.sent' && e.online?.delivery) {
      const lines = e.lines.reduce((n, l) => n + (l.unit ?? 0) * l.qty, 0);
      out.set(e.orderNumber, { number: e.orderNumber, due: lines + e.online.delivery.fee, readyBy: e.online.pickupBy });
    } else if (e.type === 'order.sent' && out.has(e.orderNumber)) {
      out.get(e.orderNumber)!.due += e.lines.reduce((n, l) => n + (l.unit ?? 0) * l.qty, 0);
    } else if (e.type === 'order.paid') out.delete(e.orderNumber);
  }
  return [...out.values()];
};

/** The shop at a glance, now. `insights`: the To do list, so the summary names the first. */
export const glanceOf = (events: readonly SyncEvent[], shop: NonNullable<ShopData['stock']>, insights: readonly Insight[], now: number): Glance => {
  const today = startOfDay(now);
  const weekday = WEEKDAYS[new Date(now).getDay()];
  const sales = salesFrom(events).filter((s) => s.at <= now);
  const todays = sales.filter((s) => s.at >= today);
  const total = todays.reduce((n, s) => n + s.total, 0);

  // ----- usual: the same weekday, the last 4 weeks the shop was open -----
  const past = [1, 2, 3, 4].map((k) => weeksBack(today, k))
    .map((day) => sales.filter((s) => s.at >= day && s.at < day + DAY))
    .filter((day) => day.length > 0);
  const known = past.length >= 2;
  const avg = (f: (day: typeof todays) => number) => (known ? Math.round(past.reduce((n, d) => n + f(d), 0) / past.length) : null);
  const usualDay = avg((d) => d.reduce((n, s) => n + s.total, 0));
  const upTo = (t: number) => hourOf(t) * 60 + new Date(t).getMinutes();
  const usualSoFar = avg((d) => d.filter((s) => upTo(s.at) <= upTo(now)).reduce((n, s) => n + s.total, 0));

  // ----- sales by hour: from the first hour the shop sells in to the last -----
  const seen = [...todays, ...past.flat()].map((s) => hourOf(s.at));
  const first = seen.length ? Math.min(...seen) : 10;
  const last = Math.max(seen.length ? Math.max(...seen) : 21, first + 5);
  const hours: HourBar[] = [];
  for (let h = first; h <= last; h++) {
    const done = today + h * 60 * 60 * 1000 <= now;
    const t = done ? todays.filter((s) => hourOf(s.at) === h).reduce((n, s) => n + s.total, 0) : null;
    const u = avg((d) => d.filter((s) => hourOf(s.at) === h).reduce((n, s) => n + s.total, 0));
    const current = done && hourOf(now) === h;
    const lines = t === null
      ? [`${hourLabel(h)}: still to come.`, ...(u !== null ? [`A usual ${weekday} makes ${rs(u)} in this hour.`] : [])]
      : [`${hourLabel(h)}: ${rs(t)}${current ? ' so far' : ''}.`,
        ...(u !== null ? [`A usual ${weekday}: ${rs(u)}.`, ...(current ? [] : [t >= u ? `${rs(t - u)} more than usual.` : `${rs(u - t)} less than usual.`])] : ['No usual yet: it needs 2 weeks of history.'])];
    hours.push({ hour: h, label: hourLabel(h), today: t, usual: u, explain: lines.join('\n') });
  }

  // ----- stock and its value -----
  const stock = stockFromEvents(shop.items, events, { now });
  const answers = answersFromEvents(events);
  const valuation = valuationOf(stock, answers);
  const unitCost = new Map(valuation.items.map((v) => [v.id, v.unitCents]));
  const rows = stock.rows.filter((r) => !r.archived);
  const dotOf = (r: (typeof rows)[number]): DotStatus => {
    const s = stockStatus(r);
    return s === 'unsure' ? 'low' : s;
  };
  const dots: StockDot[] = rows.map((r) => {
    const status = dotOf(r);
    const value = valuation.items.find((v) => v.id === `stock:${r.id}`)?.cents ?? null;
    const lines = status === 'unknown'
      ? [`${r.name}: never counted.`, 'Count it once and its stock is kept from then on.']
      : [`${r.name}: ${status === 'out' ? 'out of stock' : status === 'low' ? (r.missedSales > 0 ? 'check the shelf' : 'low') : 'in stock'}.`,
        `${formatStock(r.onHandBaseUnits, r)} on hand${value !== null ? `, worth ${rs(value)}` : ''}.`,
        ...(r.lastsDays !== null ? [`Lasts about ${Math.max(1, Math.round(r.lastsDays))} ${Math.round(r.lastsDays) === 1 ? 'day' : 'days'} at this week's use.`] : []),
        ...(r.suggestedPacks > 0 ? [`Order ${plural(r.suggestedPacks, 'pack')}.`] : [])];
    return { id: r.id, name: r.name, status, explain: lines.join('\n') };
  });
  const count = (s: DotStatus) => dots.filter((d) => d.status === s).length;
  const weekAgo = valueAt(shop.items, events, now - 7 * DAY).total;
  const change = weekAgo > 0 ? Math.round(((valuation.total - weekAgo) / weekAgo) * 100) : null;
  const stockExplain = [
    `Shelves: ${rs(valuation.total)} in stock (on hand × latest price).`,
    ...(change !== null && Math.abs(change) >= 10 ? [`${change > 0 ? 'Up' : 'Down'} ${Math.abs(change)}% since last ${weekday}.`] : []),
    count('low') + count('out') > 0
      ? `${count('low')} low, ${count('out')} out: ${dots.filter((d) => d.status === 'low' || d.status === 'out').slice(0, 4).map((d) => d.name).join(', ')}.`
      : 'Nothing low or out.',
    ...(count('unknown') ? [`${plural(count('unknown'), 'item')} never counted: not in the value.`] : []),
  ].join('\n');

  // ----- the five stations -----
  const purchases = purchasesFromEvents(events);
  const supplier = (id: string) => shop.suppliers.find((x) => x.id === id)?.name ?? 'a supplier';
  const received = purchases.grns.filter((g) => !g.undone && g.at >= today && g.at <= now);
  const receivedCents = received.reduce((n, g) => n + grnValueCents(g.lines), 0);
  const late = purchases.open.filter((o) => now > o.at + ((purchases.leadDays.get(o.supplierId) ?? 3) + 1) * DAY);
  const daysAgo = (t: number) => { const d = Math.floor((now - t) / DAY); return d === 0 ? 'today' : d === 1 ? 'yesterday' : `${d} days ago`; };
  const deliveries: Station = {
    id: 'deliveries', label: 'Deliveries', value: rs(receivedCents), tone: late.length ? 'warn' : 'ok', badge: late.length, href: '#receive',
    explain: [
      received.length ? `Deliveries: ${rs(receivedCents)} received today.` : 'No deliveries received today.',
      ...received.slice(0, 4).map((g) => `${g.grnNo} · ${supplier(g.supplierId)} · ${rs(grnValueCents(g.lines))} · ${clock(g.at)}`),
      ...purchases.open.slice(0, 3).map((o) => `Still coming: ${o.poNo} from ${supplier(o.supplierId)}, ordered ${daysAgo(o.at)}${late.includes(o) ? ': late' : ''}.`),
    ].join('\n'),
  };
  const low = count('low') + count('out');
  const shelves: Station = {
    id: 'shelves', label: 'Shelves', value: rs(valuation.total), tone: low ? 'warn' : 'ok', badge: low, href: '#items', explain: stockExplain,
  };

  const times = ticketTimes(events);
  const mins = (xs: { minutes: number }[]) => (xs.length ? xs.reduce((n, t) => n + t.minutes, 0) / xs.length : null);
  const kitchenToday = mins(times.filter((t) => t.sentAt >= today && t.sentAt <= now));
  const kitchenUsual = mins(times.filter((t) => t.sentAt < today && t.sentAt >= today - 28 * DAY));
  const open = queue(ticketsFromEvents(events, now)).filter((t) => !t.prep);
  const oldest = open.length ? Math.round((now - Math.min(...open.map((t) => t.firedAt))) / 60_000) : 0;
  const slow = insights.some((i) => i.id === 'kitchen-slow');
  const kitchen: Station = {
    id: 'kitchen', label: 'Kitchen', value: kitchenToday === null ? '–' : `${Math.round(kitchenToday)} min`, tone: slow ? 'warn' : 'ok', badge: 0, href: null,
    explain: [
      kitchenToday === null ? 'Kitchen: nothing marked Done yet today.' : `Kitchen: ${Math.round(kitchenToday)} min from Send to Done on average today.`,
      ...(kitchenUsual !== null ? [`Usual: ${Math.round(kitchenUsual)} min (the last 4 weeks).`] : []),
      open.length ? `${plural(open.length, 'order')} in the kitchen now; the oldest is ${oldest} min in.` : 'Nothing in the kitchen now.',
    ].join('\n'),
  };

  const voids = insights.find((i) => i.id === 'voids');
  const discounts = insights.find((i) => i.id === 'discounts');
  const voidCount = events.filter((e) => (e.type === 'order.item_cancelled' || e.type === 'order.line_removed') && e.at >= today && e.at <= now).length;
  const counter: Station = {
    id: 'counter', label: 'Counter', value: String(todays.length), tone: voids || discounts ? 'warn' : 'ok', badge: voids ? voidCount : discounts ? 1 : 0, href: null,
    explain: [
      todays.length ? `Counter: ${plural(todays.length, 'order')} paid, ${rs(total / todays.length)} each on average.` : 'Counter: no orders paid yet today.',
      `${plural(voidCount, 'void')} today.${voids ? ` ${voids.detail}` : ''}`,
      ...(discounts ? [`${discounts.title}. ${discounts.detail}`] : []),
    ].join('\n'),
  };

  const byTender = new Map<Tender, Cents>();
  for (const s of todays) byTender.set(s.tender, (byTender.get(s.tender) ?? 0) + s.total);
  const unpaid = unpaidDeliveries(events, today, now);
  const owed = unpaid.reduce((n, d) => n + d.due, 0);
  const overdue = unpaid.filter((d) => now - d.readyBy > OUT_TOO_LONG_MS);
  const money: Station = {
    id: 'money', label: 'Money', value: rs(total), tone: overdue.length ? 'warn' : 'ok', badge: overdue.length, href: null,
    explain: [
      `Money: ${rs(total)} taken today.`,
      ...[...byTender].filter(([, c]) => c > 0).map(([t, c]) => `${TENDER[t]}: ${rs(c)}`),
      ...(byTender.get('cash') ? ['The drawer should hold the cash plus the opening float.'] : []),
      ...(unpaid.length ? [`About ${rs(owed)} still to come from ${plural(unpaid.length, 'delivery', 'deliveries')}, paid when the rider is back.`] : []),
      ...overdue.map((d) => `Delivery ${d.number} was ready at ${clock(d.readyBy)} and is not paid yet.`),
    ].join('\n'),
  };

  // ----- every Rs 100 sold: food (his recipes × latest prices), waste (at cost), the rest -----
  let split: Glance['split'] = null;
  if (total > 0) {
    const ctx: CostContext = { items: stock.rows, answers };
    let priced = 0;
    let cost = 0;
    let unknown = 0;
    for (const e of events) {
      if (e.type !== 'order.sent' || e.at < today || e.at > now) continue;
      for (const l of e.lines) {
        const item = menuItems().find((m) => m.id === l.itemId); // one since taken off the menu: no price to compare
        const c = menuCost(l.itemId, l.size ?? '', ctx);
        if (!item || !c.complete) { unknown += l.qty; continue; }
        priced += unitPrice(item, l) * l.qty;
        cost += c.cents * l.qty;
      }
    }
    const wasted = wasteRecords(events, shop.items).filter((w) => w.at >= today && w.at <= now)
      .reduce((n, w) => n + wasteCents(w.takes, unitCost), 0);
    const food = priced > 0 ? Math.round((cost / priced) * 100) : 0;
    const waste = Math.min(100 - food, Math.round((wasted / total) * 100));
    split = {
      food, waste, kept: Math.max(0, 100 - food - waste),
      explain: [
        'Of every Rs 100 sold today:',
        `Rs ${food} paid for the food (your recipes × latest prices).`,
        `Rs ${waste} went in the waste bin, at cost.`,
        `Rs ${Math.max(0, 100 - food - waste)} is left for wages, rent, power and profit.`,
        ...(unknown ? [`${plural(unknown, 'item')} sold without a recipe cost: not counted in food.`] : []),
      ].join('\n'),
    };
  }

  // ----- the ring and the day in a sentence -----
  const share = usualDay ? total / usualDay : null;
  const ringExplain = [
    `Sales today: ${rs(total)} from ${plural(todays.length, 'order')}.`,
    ...(usualDay !== null && usualSoFar !== null
      ? [`By ${clock(now)} a usual ${weekday} has made ${rs(usualSoFar)}, and ${rs(usualDay)} by closing.`, `The ring fills toward that full day: ${Math.round((share ?? 0) * 100)}% now.`]
      : ['No usual yet: the ring needs 2 weeks of history for this weekday.']),
  ].join('\n');
  const greeting = new Date(now).getHours() < 12 ? 'Good morning.' : new Date(now).getHours() < 17 ? 'Good afternoon.' : 'Good evening.';
  const pace = !todays.length ? 'No sales yet today.'
    : usualSoFar ? (() => {
      const pct = Math.round(((total - usualSoFar) / usualSoFar) * 100);
      return Math.abs(pct) < 10 ? `${rs(total)} so far, about usual for a ${weekday}.` : `${rs(total)} so far, ${Math.abs(pct)}% ${pct > 0 ? 'above' : 'below'} a usual ${weekday}.`;
    })()
      : `${rs(total)} from ${plural(todays.length, 'order')} so far.`;
  const peak = hours.filter((h) => (h.today ?? 0) > 0).sort((a, b) => (b.today ?? 0) - (a.today ?? 0))[0];
  const attention = insights.filter((i) => i.tone === 'attention');
  const summary = [
    `${greeting} ${pace}`,
    ...(peak ? [`Busiest hour: ${peak.label} (${rs(peak.today ?? 0)}).`] : []),
    attention.length === 0 ? 'Nothing needs you right now.'
      : attention.length === 1 ? `Needs you: ${attention[0].title}.` : `${attention.length} things need you, first: ${attention[0].title}.`,
  ].join('\n');

  return {
    sales: total, orders: todays.length, usualDay, share, ringExplain,
    stations: [deliveries, shelves, kitchen, counter, money],
    hours, split,
    stock: { value: valuation.total, dots, low: count('low'), out: count('out'), unknown: count('unknown'), explain: stockExplain },
    summary,
  };
};
