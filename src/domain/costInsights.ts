import { answersFromEvents, marginOf, menuCost, openQuestions, questionText, recipeOf, sizesOf, type CostContext } from './costing.ts';
import type { Insight, ShopData } from './insights.ts';
import { stockFromEvents } from './inventory.ts';
import type { InventoryItem } from './inventoryData.ts';
import { MENU } from './menu.ts';
import { effectiveMenu, menuStateFromEvents } from './menuEdits.ts';
import type { SyncEvent } from './sync.ts';
import type { MenuItem } from './types.ts';

/**
 * The Owner view's food-cost cards (SCRUM-77). Pure, like insights.ts: events in,
 * cards out. They speak only of the owner's own numbers: no target margin is
 * invented; a margin card appears only when a price rise has lowered a margin.
 */
const WEEK_MS = 7 * 24 * 60 * 60_000;
const pct = (m: number) => Math.round(m * 100);
const label = (item: MenuItem, size: string) => `${item.name.en}${size ? ` ${size}` : ''}`;
const priceOf = (item: MenuItem, size: string) => (size ? item.variants?.find((v) => v.id === size)?.price ?? 0 : item.price ?? 0);

/** "Food costs: 22 answers to go": his recipes are in, a few gaps hold items back. */
export const costsToAnswer = (events: readonly SyncEvent[], stock: ShopData['stock'], now: number): Insight | null => {
  if (!stock) return null;
  const menu = effectiveMenu(MENU, menuStateFromEvents(events), now);
  const ctx: CostContext = { items: stock.items, answers: answersFromEvents(events) };
  const questions = openQuestions(menu, ctx);
  if (!questions.length) return null;
  const held = new Set(questions.flatMap((q) => q.blocks)).size;
  // The same gaps keep sales off the stock: say so, or the stock looks surer than it is.
  const { rows, untrackedSold } = stockFromEvents(stock.items, events, { now });
  const unsure = rows.filter((r) => !r.archived && r.counted && r.missedSales > 0).length;
  const stockNote = [
    untrackedSold ? `${untrackedSold} sold this week took no stock` : '',
    unsure ? `${unsure} stock ${unsure === 1 ? 'item needs' : 'items need'} a shelf check` : '',
  ].filter(Boolean).join('; ');
  return {
    id: 'costs-to-answer',
    tone: 'info',
    title: `Food costs: ${questions.length} ${questions.length === 1 ? 'answer' : 'answers'} to go`,
    detail: `${held} menu ${held === 1 ? 'item waits' : 'items wait'} for an answer before showing what ${held === 1 ? 'it earns' : 'they earn'}.${stockNote ? ` ${stockNote[0].toUpperCase()}${stockNote.slice(1)}.` : ''} Answer on the Recipes screen.`,
    action: {
      label: 'Questions',
      items: questions.slice(0, 10).map((q) => ({ primary: questionText(q.id, menu), secondary: `holds back ${q.blocks.length}` })),
    },
  };
};

/** Each item's working price as it was at `t`: the first change after t says what it was before. */
const pricesAt = (items: readonly InventoryItem[], events: readonly SyncEvent[], t: number): InventoryItem[] => {
  const firstAfter = new Map<string, number>();
  for (const e of events) {
    if (e.type === 'stock.price_set' && e.at > t && !firstAfter.has(e.itemId)) firstAfter.set(e.itemId, e.before);
  }
  return items.map((i) => (firstAfter.has(i.id) ? { ...i, workingPriceCents: firstAfter.get(i.id)! } : i));
};

/** "BBQ Mix L now earns 58%, down from 64%": a price rise this week lowered a margin. */
export const marginsFell = (events: readonly SyncEvent[], stock: ShopData['stock'], now: number): Insight | null => {
  if (!stock) return null;
  const since = now - WEEK_MS;
  const rises = new Map<string, { from: number; to: number }>();
  for (const e of events) {
    if (e.type !== 'stock.price_set' || e.at <= since || e.at > now) continue;
    const r = rises.get(e.itemId);
    rises.set(e.itemId, { from: r?.from ?? e.before, to: e.after });
  }
  const risen = [...rises].filter(([, r]) => r.to > r.from && r.from > 0);
  if (!risen.length) return null;

  const menu = effectiveMenu(MENU, menuStateFromEvents(events), now);
  const answers = answersFromEvents(events);
  const nowCtx: CostContext = { items: stock.items, answers };
  const thenCtx: CostContext = { items: pricesAt(stock.items, events, since), answers };
  const fell: { name: string; was: number; is: number }[] = [];
  for (const item of menu) {
    if (item.hidden) continue;
    for (const size of sizesOf(item)) {
      const price = priceOf(item, size); // today's menu price both times: only the ingredients moved
      const before = menuCost(item.id, size, thenCtx);
      const after = menuCost(item.id, size, nowCtx);
      const was = before.complete ? marginOf(price, before.cents) : null;
      const is = after.complete ? marginOf(price, after.cents) : null;
      if (was !== null && is !== null && pct(was) - pct(is) >= 1) fell.push({ name: label(item, size), was: pct(was), is: pct(is) });
    }
  }
  if (!fell.length) return null;
  fell.sort((a, b) => (b.was - b.is) - (a.was - a.is));
  const names = new Map(stock.items.map((i) => [i.id, i.name]));
  const why = risen
    .map(([id, r]) => ({ name: names.get(id) ?? id, up: Math.round(((r.to - r.from) / r.from) * 100) }))
    .sort((a, b) => b.up - a.up)
    .slice(0, 3)
    .map((r) => `${r.name} up ${r.up}%`)
    .join(', ');
  return {
    id: 'margins-fell',
    tone: 'attention',
    title: fell.length === 1
      ? `${fell[0].name} now earns ${fell[0].is}%, down from ${fell[0].was}%`
      : `${fell.length} menu items earn less after price rises`,
    detail: `This week: ${why}. Same menu price, dearer ingredients.`,
    action: { label: 'Items', items: fell.slice(0, 10).map((f) => ({ primary: f.name, secondary: `${f.was}% → ${f.is}%` })) },
  };
};

/**
 * "Test Pizza sold 6 times this week; its stock isn't counted" (SCRUM-129): dishes sold with no
 * recipe at all, by name, so the owner sees which recipe to write first.
 */
export const soldWithoutRecipe = (events: readonly SyncEvent[], now: number): Insight | null => {
  const menu = effectiveMenu(MENU, menuStateFromEvents(events), now);
  const answers = answersFromEvents(events);
  const sold = new Map<string, number>();
  for (const e of events) {
    if (e.type !== 'order.sent' || e.at < now - WEEK_MS || e.at > now) continue;
    for (const l of e.lines) {
      // A half-and-half pizza sold half of each.
      for (const id of l.half ? [l.itemId, l.half] : [l.itemId]) {
        if (recipeOf(id, l.size ?? '', answers)) continue;
        sold.set(id, (sold.get(id) ?? 0) + (l.half ? l.qty / 2 : l.qty)); // one dish, whatever its size
      }
    }
  }
  const rows = [...sold]
    .map(([id, qty]) => {
      const item = menu.find((m) => m.id === id);
      return item ? { name: item.name.en, qty } : null;
    })
    .filter((r): r is { name: string; qty: number } => r !== null)
    .sort((a, b) => b.qty - a.qty);
  if (!rows.length) return null;
  const times = (n: number) => `${n} ${n === 1 ? 'time' : 'times'}`;
  return {
    id: 'sold-without-recipe',
    tone: 'attention',
    title: rows.length === 1
      ? `${rows[0].name} sold ${times(rows[0].qty)} this week; its stock isn't counted`
      : `${rows.length} dishes sold this week without a recipe`,
    detail: 'Their sales take nothing from stock until you write what goes in them. Write the recipe on the Menu screen.',
    action: { label: 'Which ones', items: rows.slice(0, 10).map((r) => ({ primary: r.name, secondary: `sold ${times(r.qty)}` })) },
  };
};
