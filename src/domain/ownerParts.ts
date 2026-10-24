import { soldWithoutRecipe } from './costInsights.ts';
import { answersFromEvents, menuCost, sizesOf } from './costing.ts';
import { rulesSuggestions } from './insights.ts';
import { inventoryFromEvents, isOutOfStock, suppliersFromEvents } from './inventory.ts';
import { SEED_INVENTORY, SEED_SUPPLIERS } from './inventoryData.ts';
import { MENU } from './menu.ts';
import { effectiveMenu, menuStateFromEvents } from './menuEdits.ts';
import { fmt } from './money.ts';
import { expectedBy, purchasesFromEvents } from './purchaseOrders.ts';
import { stockSettingsFromEvents } from './stockSettings.ts';
import { draftsFromEvents } from './recipeDrafts.ts';
import type { SyncEvent } from './sync.ts';

/**
 * The owner's sidebar (SCRUM-131), arranged by the shop's day: the work (Sell, Receive, Order,
 * Count, Today), then Items, then Settings. One line per part saying what is going on there,
 * and a badge only when something there needs a decision. Pure, like insights.ts: events in,
 * lines out. Nothing is a count for its own sake ("Onion out", not "60 items").
 */
export type PartId = 'sell' | 'receive' | 'order' | 'count' | 'owner' | 'items' | 'flow' | 'setup';

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
  const settings = stockSettingsFromEvents(events);
  const purchases = purchasesFromEvents(events, settings);

  const counted = items.filter((r) => r.counted);
  const out = counted.filter(isOutOfStock);
  // Low is the reorder rule's call (ordering.ts): what it says to order now.
  const toOrder = items.filter((r) => r.suggestedPacks > 0);
  const countedToday = items.filter((r) => r.lastCountedAt !== null && r.lastCountedAt >= startOfDay(now)).length;
  // A delivery past the day it was expected: worth a call to the supplier.
  const late = purchases.open.filter((o) => expectedBy(o, purchases.leadDays, settings.defaultLeadDays) < startOfDay(now));

  const menu = effectiveMenu(MENU, menuStateFromEvents(events), now).filter((m) => !m.removed && !m.hidden);
  const ctx = { items, answers: answersFromEvents(events) };
  const sizes = menu.flatMap((m) => sizesOf(m).map((size) => ({ m, cost: menuCost(m.id, size, ctx) })));
  const noRecipe = menu.filter((m) => sizes.every((s) => s.m !== m || !s.cost.origin));
  const soldOut = menu.filter((m) => m.soldOut);
  const unrecipedSales = soldWithoutRecipe(events, now)?.action.items.length ?? 0;

  return {
    sell: { preview: 'The register', badge: 0 },
    receive: {
      preview: late.length ? `${plural(late.length, 'delivery', 'deliveries')} late`
        : purchases.open.length ? `${plural(purchases.open.length, 'delivery', 'deliveries')} expected` : 'No deliveries expected',
      badge: late.length,
    },
    order: {
      preview: toOrder.length ? `${names(toOrder.map((r) => r.name))} to order` : 'Nothing to order',
      badge: toOrder.length,
    },
    count: {
      preview: countedToday ? `${plural(countedToday, 'item')} counted today` : 'Nothing counted today',
      badge: 0,
    },
    owner: {
      preview: summary.orders ? `Rs ${fmt(summary.salesCents)} · ${plural(summary.orders, 'order')}` : 'No sales yet today',
      badge: insights.filter((i) => i.tone === 'attention').length,
    },
    items: {
      preview: out.length ? `${names(out.map((r) => r.name))} out`
        : soldOut.length ? `${names(soldOut.map((m) => m.name.en))} sold out today`
          : noRecipe.length ? `${plural(noRecipe.length, 'dish', 'dishes')} without a recipe`
            : counted.length < items.length ? `${counted.length} of ${items.length} counted` : 'All counted',
      badge: out.length + unrecipedSales,
    },
    // Visual Flow: how each dish is made; unpublished changes are his to finish, not a decision waiting.
    flow: (() => {
      const drafts = draftsFromEvents(events).size;
      return { preview: drafts ? `${plural(drafts, 'change')} in draft` : 'How each dish is made', badge: 0 };
    })(),
    setup: { preview: 'Shop, staff, printer, stock rules', badge: 0 },
  };
};
