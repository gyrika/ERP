import { answersFromEvents } from './costing.ts';
import { salesFrom, type Insight, type ShopData } from './insights.ts';
import { stockFromEvents } from './inventory.ts';
import { fmt } from './money.ts';
import { PREP_STOCK } from './prep.ts';
import type { RecipeLine } from './stockUsage.ts';
import type { SyncEvent } from './sync.ts';
import type { Cents } from './types.ts';
import { valuationOf } from './valuation.ts';
import { wasteReasonLabel, wasteRecords, type WasteRecord } from './waste.ts';

/**
 * Waste the owner should hear about (SCRUM-178). Waste shows in each item's history, the
 * Rs 100 bar and count gaps, but nothing said when it was unusual. Two cards for Today's To do,
 * silent when waste is normal:
 * - this week's waste at cost well above the usual week, with the top items and reasons;
 * - one reason repeating ("Burnt 5 times this week, mostly 7–9 pm").
 * "This week" is the last 7 days; "usual" is the 4 weeks before, weeks the shop sold in only,
 * at least 2 of them. Everything is costed at today's unit costs, so weeks compare fairly.
 */

const DAY_MS = 24 * 60 * 60_000;
const WEEK_MS = 7 * DAY_MS;
/** Well above usual: half again as much, and at least Rs 500 more (smaller is not worth his time). */
const ABOVE = 1.5;
const MIN_EXTRA: Cents = 50_000;
/** With no usual week to compare, this much in a week is worth a look on its own. */
const MIN_NO_HISTORY: Cents = 200_000;
/** A reason "keeps repeating" from this many times in a week. */
const REPEATS = 5;

const rs = (c: Cents) => `Rs ${fmt(Math.round(c / 100) * 100)}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const hourLabel = (h: number) => `${h % 12 || 12} ${h % 24 < 12 ? 'am' : 'pm'}`;
/** "7–9 pm", or "11 am–1 pm" across noon. */
const hours2 = (h: number) => {
  const end = hourLabel(h + 2);
  return (h % 24 < 12) === ((h + 2) % 24 < 12) ? `${h % 12 || 12}–${end}` : `${hourLabel(h)}–${end}`;
};
const when = (t: number) => {
  const d = new Date(t);
  return `${d.toLocaleDateString('en-GB', { weekday: 'short' })} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** A waste's cost: what it took from stock × each item's unit cost (`stock:<id>` / `semi:<name>`). */
export const wasteCents = (takes: readonly RecipeLine[], unitCost: ReadonlyMap<string, number | null>): Cents =>
  Math.round(takes.reduce((n, t) => {
    const id = t.inventoryId.startsWith(PREP_STOCK) ? `semi:${t.inventoryId.slice(PREP_STOCK.length)}` : `stock:${t.inventoryId}`;
    return n + (unitCost.get(id) ?? 0) * t.qtyBaseUnits;
  }, 0));

interface Costed extends WasteRecord { cents: Cents }

const costed = (events: readonly SyncEvent[], stock: NonNullable<ShopData['stock']>, now: number): Costed[] => {
  const valuation = valuationOf(stockFromEvents(stock.items, events, { now }), answersFromEvents(events));
  const unitCost = new Map(valuation.items.map((v) => [v.id, v.unitCents]));
  return wasteRecords(events, stock.items).filter((w) => w.at <= now).map((w) => ({ ...w, cents: wasteCents(w.takes, unitCost) }));
};

/** This week's waste at cost against the usual week. */
export const wasteAboveUsual = (events: readonly SyncEvent[], stock: ShopData['stock'], now: number): Insight | null => {
  if (!stock) return null;
  const all = costed(events, stock, now);
  const week = all.filter((w) => w.at > now - WEEK_MS);
  const total = week.reduce((n, w) => n + w.cents, 0);
  const sales = salesFrom(events);
  const past = [1, 2, 3, 4].map((k) => [now - (k + 1) * WEEK_MS, now - k * WEEK_MS] as const)
    .filter(([from, to]) => sales.some((s) => s.at > from && s.at <= to));
  const usual = past.length >= 2
    ? Math.round(past.reduce((n, [from, to]) => n + all.filter((w) => w.at > from && w.at <= to).reduce((m, w) => m + w.cents, 0), 0) / past.length)
    : null;
  if (usual === null ? total < MIN_NO_HISTORY : total < usual * ABOVE || total - usual < MIN_EXTRA) return null;

  const ratio = usual ? total / usual : null;
  const vsUsual = usual === null ? 'no usual week yet to compare'
    : usual === 0 || ratio! >= 3 ? `usually ${usual === 0 ? 'almost none' : rs(usual)}`
    : ratio! >= 1.9 ? 'double the usual'
    : `${rs(total - usual)} more than usual`;
  // The list: each thing thrown away, most costly first, with how often and why.
  const by = new Map<string, { cents: Cents; times: number; reasons: Map<string, number> }>();
  for (const w of week) {
    const x = by.get(w.name) ?? { cents: 0, times: 0, reasons: new Map() };
    x.cents += w.cents;
    x.times += 1;
    x.reasons.set(w.reason, (x.reasons.get(w.reason) ?? 0) + 1);
    by.set(w.name, x);
  }
  const items = [...by.entries()].sort((a, b) => b[1].cents - a[1].cents).map(([name, x]) => ({
    primary: name,
    secondary: `${plural(x.times, 'time')} · ${[...x.reasons.entries()].sort((a, b) => b[1] - a[1]).map(([r, n]) => `${wasteReasonLabel(r)} ${n}`).join(', ')}`,
    amount: x.cents,
  }));
  const reasons = new Map<string, Cents>();
  for (const w of week) reasons.set(w.reason, (reasons.get(w.reason) ?? 0) + w.cents);
  const [topReason] = [...reasons.entries()].sort((a, b) => b[1] - a[1])[0];
  return {
    id: 'waste-week',
    tone: 'attention',
    title: `${rs(total)} wasted this week, ${vsUsual}`,
    detail: `Most of it: ${items.slice(0, 2).map((i) => i.primary).join(' and ')}. Top reason: ${wasteReasonLabel(topReason).toLowerCase()}.`,
    action: { label: 'See them', items },
  };
};

/** One reason thrown away again and again this week, and when in the day it happens. */
export const wasteReasonRepeats = (events: readonly SyncEvent[], now: number): Insight | null => {
  const week = wasteRecords(events).filter((w) => w.at > now - WEEK_MS && w.at <= now && w.reason !== 'other');
  const counts = new Map<string, WasteRecord[]>();
  for (const w of week) counts.set(w.reason, [...(counts.get(w.reason) ?? []), w]);
  const top = [...counts.values()].sort((a, b) => b.length - a.length)[0];
  if (!top || top.length < REPEATS) return null;
  // Mostly in one 2-hour window: at least 3 in 5 of them.
  const hours = top.map((w) => new Date(w.at).getHours());
  const [start, inWindow] = [...new Set(hours)].map((h) => [h, hours.filter((x) => x === h || x === h + 1).length] as const)
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
  const mostly = inWindow * 5 >= top.length * 3 ? `, mostly ${hours2(start)}` : '';
  const names = new Map<string, number>();
  for (const w of top) names.set(w.name, (names.get(w.name) ?? 0) + 1);
  const [name, n] = [...names.entries()].sort((a, b) => b[1] - a[1])[0];
  return {
    id: 'waste-reason',
    tone: 'attention',
    title: `${wasteReasonLabel(top[0].reason)} ${plural(top.length, 'time')} this week${mostly}`,
    detail: n * 2 > top.length ? `${n} of them ${name}.` : `Across ${plural(names.size, 'item')}.`,
    action: {
      label: 'See them',
      items: [...top].sort((a, b) => b.at - a.at).map((w) => ({ primary: `${w.qty === 1 ? '' : w.unit === 'pcs' ? `${w.qty} × ` : `${w.qty} ${w.unit} `}${w.name}`, secondary: `${when(w.at)} · ${w.by}`, at: w.at })),
    },
  };
};
