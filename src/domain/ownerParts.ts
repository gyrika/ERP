import { costsToAnswer, soldWithoutRecipe } from './costInsights.ts';
import { answersFromEvents, menuCost, sizesOf } from './costing.ts';
import { rulesSuggestions } from './insights.ts';
import { inventoryFromEvents, isLowStock, isOutOfStock, suppliersFromEvents } from './inventory.ts';
import { SEED_INVENTORY, SEED_SUPPLIERS } from './inventoryData.ts';
import { MENU } from './menu.ts';
import { effectiveMenu, menuStateFromEvents } from './menuEdits.ts';
import { fmt } from './money.ts';
import type { SyncEvent } from './sync.ts';

/**
 * The owner's sidebar (SCRUM-131): one line per part of the shop saying what is going on
 * there, and a badge only when something there needs a decision. Pure, like insights.ts:
 * events in, lines out. Nothing is a count for its own sake ("Onion out", not "60 items").
 */
export type PartId = 'owner' | 'manager' | 'menu' | 'recipes' | 'inventory' | 'suppliers' | 'setup';

export interface PartLine {
  preview: string;
  /** Decisions waiting there; 0 = all quiet. */
  badge: number;
}

const startOfDay = (t: number) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** "Onion", "Onion and 1 more": one line in a narrow sidebar, so one name at most. */
const names = (list: readonly string[]) => (list.length === 1 ? list[0] : `${list[0]} and ${list.length - 1} more`);

export const ownerParts = (events: readonly SyncEvent[], now: number): Record<PartId, PartLine> => {
  const items = inventoryFromEvents(SEED_INVENTORY, events, { now }).filter((r) => !r.archived);
  const suppliers = suppliersFromEvents(SEED_SUPPLIERS, events);
  const shop = { events, now, stock: { items, suppliers } };
  const summary = rulesSuggestions.summary(shop);
  const insights = rulesSuggestions.insights(shop);

  const counted = items.filter((r) => r.counted);
  const out = counted.filter(isOutOfStock);
  const low = counted.filter((r) => !isOutOfStock(r) && isLowStock(r));
  const countedToday = items.filter((r) => r.lastCountedAt !== null && r.lastCountedAt >= startOfDay(now)).length;

  const menu = effectiveMenu(MENU, menuStateFromEvents(events), now).filter((m) => !m.removed && !m.hidden);
  const ctx = { items, answers: answersFromEvents(events) };
  const sizes = menu.flatMap((m) => sizesOf(m).map((size) => ({ m, cost: menuCost(m.id, size, ctx) })));
  const noRecipe = menu.filter((m) => sizes.every((s) => s.m !== m || !s.cost.origin));
  const soldOut = menu.filter((m) => m.soldOut);
  const unrecipedSales = soldWithoutRecipe(events, now)?.action.items.length ?? 0;
  const gaps = costsToAnswer(events, shop.stock, now);
  const complete = sizes.filter((s) => s.cost.complete).length;

  return {
    owner: {
      preview: summary.orders ? `Rs ${fmt(summary.salesCents)} · ${plural(summary.orders, 'order')}` : 'No sales yet today',
      badge: insights.filter((i) => i.tone === 'attention').length,
    },
    inventory: {
      preview: out.length ? `${names(out.map((r) => r.name))} out`
        : low.length ? `${names(low.map((r) => r.name))} running low`
          : counted.length < items.length ? `${counted.length} of ${items.length} counted` : 'All counted',
      badge: out.length + low.length,
    },
    menu: {
      preview: soldOut.length ? `${names(soldOut.map((m) => m.name.en))} sold out today`
        : noRecipe.length ? `${plural(noRecipe.length, 'dish', 'dishes')} without a recipe`
          : plural(menu.length, 'dish', 'dishes'),
      badge: unrecipedSales,
    },
    recipes: {
      preview: gaps ? `${complete} of ${sizes.length} fully costed` : 'Every recipe complete',
      badge: 0,
    },
    manager: {
      preview: countedToday ? `${plural(countedToday, 'item')} counted today` : 'Nothing counted today',
      badge: 0,
    },
    suppliers: { preview: plural(suppliers.length, 'supplier'), badge: 0 },
    setup: { preview: 'Printer, staff and devices', badge: 0 },
  };
};
