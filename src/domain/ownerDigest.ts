import { answersFromEvents, marginOf, menuCost, openQuestions, sizesOf } from './costing.ts';
import { rulesSuggestions, type Insight } from './insights.ts';
import { stockFromEvents, stockStatus, suppliersFromEvents, type InventoryRow } from './inventory.ts';
import { SEED_INVENTORY, SEED_SUPPLIERS } from './inventoryData.ts';
import { MENU } from './menu.ts';
import { effectiveMenu, menuStateFromEvents } from './menuEdits.ts';
import { prepItems, prepStatus } from './prep.ts';
import { canMake } from './production.ts';
import { onOrder, purchasesFromEvents } from './purchaseOrders.ts';
import { formatQuantity } from './quantity.ts';
import { orderLinesFrom } from './salesLedger.ts';
import type { SyncEvent } from './sync.ts';
import type { OrderEvent } from './events.ts';
import type { Cents } from './types.ts';

/**
 * What the owner's ChatGPT may read about the shop beyond its sales (SCRUM-198). The shop server
 * builds this and uploads it, only while ChatGPT is connected: the cloud's free plan cannot fold
 * the whole history on every question, and these rules run on the shop's local time.
 *
 * Everything here goes to OpenAI, so it is built from an allowlist: no staff names, order numbers,
 * free-text notes, customers or phone numbers. A card not listed in CARDS is not sent.
 */
export const OWNER_DIGEST_VERSION = 1;
const DAY_MS = 24 * 60 * 60_000;
const SOLD_DAYS = 28;

export interface DigestCard {
  tone: Insight['tone'];
  title: string;
  detail: string;
  items: { what: string; note?: string; amountCents?: Cents }[];
}

export interface DigestStockItem {
  id: string;
  name: string;
  category: string;
  /** out, low, unsure (sales it could not take from), ok; unknown: never counted. */
  status: ReturnType<typeof stockStatus>;
  onHand: string | null;
  usedPerDay: string | null;
  lastsDays: number | null;
  pack: string;
  packPriceCents: Cents;
  onHandPacks: number | null;
  suggestedPacks: number;
  onOrderPacks: number;
  supplierIds: string[];
  countedAt: number | null;
}

export interface DigestDish {
  name: string;
  size: string;
  priceCents: Cents;
  /** Null until every part of its recipe has a price. */
  foodCostCents: Cents | null;
  marginPercent: number | null;
  soldLast28Days: number;
  canMake: number | null;
}

export interface DigestLine { itemId: string; name: string; packs: number; unitPriceCents?: Cents }

export interface DigestSupplier {
  id: string;
  name: string;
  leadDays: number | null;
  /** What is waiting on the Order page, not yet placed. */
  draft: DigestLine[];
  /** What the reorder rule says to buy from this supplier now. */
  suggested: DigestLine[];
  openOrders: { number: string; status: string; placedAt: number; lines: DigestLine[] }[];
}

export interface OwnerDigest {
  version: number;
  computedAt: number;
  attention: DigestCard[];
  stock: DigestStockItem[];
  semiProcessed: { name: string; onHand: string; status: string }[];
  dishes: DigestDish[];
  unansweredCosts: number;
  suppliers: DigestSupplier[];
}

/** list: title, detail and the list behind the card. words: title and detail only, because its list names people or orders. */
const CARDS: Readonly<Record<string, 'list' | 'words'>> = {
  'running-low': 'list',
  'counted-short': 'list',
  'short-streak': 'list',
  'waste-week': 'list',
  'sold-without-recipe': 'list',
  'margins-fell': 'list',
  'costs-to-answer': 'list',
  'not-selling': 'list',
  'best-seller': 'list',
  'camera-offline': 'words',
  'sales-vs-usual': 'words',
  'tables-vs-usual': 'words',
  voids: 'words',
  discounts: 'words',
  'kitchen-slow': 'words',
  'waste-reason': 'words',
  'stock-value-rose': 'words',
  'visit-length': 'words',
  'table-use': 'words',
};

/** Everyone the events name, longest first so "Ann Marie" goes before "Ann". */
const peopleIn = (events: readonly SyncEvent[]): string[] => {
  const names = new Set<string>();
  for (const e of events) {
    for (const key of ['actor', 'approvedBy'] as const) {
      const person = (e as unknown as Record<string, { name?: unknown } | null | undefined>)[key];
      if (person && typeof person.name === 'string' && person.name.trim()) names.add(person.name.trim());
    }
  }
  return [...names].sort((a, b) => b.length - a.length);
};

/** Takes names out of words the rules wrote, in any script. */
const nameRemover = (names: readonly string[]): ((text: string) => string) => {
  if (!names.length) return (text) => text;
  const alternatives = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const pattern = new RegExp(`(?<![\\p{L}\\p{M}\\p{N}])(?:${alternatives})(?![\\p{L}\\p{M}\\p{N}])`, 'gu');
  return (text) => text.replace(pattern, 'someone');
};

const cardsFrom = (insights: readonly Insight[], clean: (text: string) => string): DigestCard[] => insights.flatMap((card): DigestCard[] => {
  // A gap's title can quote the manager's own note, so only the count goes out.
  if (card.id === 'gaps-to-check') {
    const n = card.cases?.length ?? 0;
    return [{ tone: card.tone, title: `${n} ${n === 1 ? 'gap' : 'gaps'} in the count review`, detail: 'Open the count review in the app to read and mark them.', items: [] }];
  }
  const rule = CARDS[card.id];
  if (!rule) return [];
  return [{
    tone: card.tone,
    title: clean(card.title),
    detail: clean(card.detail),
    items: rule === 'words' ? [] : card.action.items.map((i) => ({
      what: clean(i.primary),
      ...(i.secondary ? { note: clean(i.secondary) } : {}),
      ...(i.amount === undefined ? {} : { amountCents: i.amount }),
    })),
  }];
});

/** Dishes in orders paid in the window, as those orders stood when paid; an undone payment does not count. */
const soldSince = (events: readonly SyncEvent[], since: number): Map<string, number> => {
  const open = new Map<number, OrderEvent[]>();
  const paid = new Map<number, { at: number; events: OrderEvent[] }[]>();
  for (const e of events) {
    if (!e.type.startsWith('order.')) continue;
    const event = e as OrderEvent;
    if (event.type === 'order.paid') {
      paid.set(event.orderNumber, [...(paid.get(event.orderNumber) ?? []), { at: event.at, events: open.get(event.orderNumber) ?? [] }]);
      open.delete(event.orderNumber);
    } else if (event.type === 'order.payment_undone') {
      const taken = paid.get(event.orderNumber)?.pop();
      if (taken) open.set(event.orderNumber, [...taken.events, ...(open.get(event.orderNumber) ?? [])]);
    } else {
      open.set(event.orderNumber, [...(open.get(event.orderNumber) ?? []), event]);
    }
  }
  const sold = new Map<string, number>();
  const add = (id: string, size: string | undefined, qty: number) => {
    const key = `${id}:${size ?? ''}`;
    sold.set(key, (sold.get(key) ?? 0) + qty);
  };
  for (const payments of paid.values()) {
    for (const payment of payments) {
      if (payment.at < since) continue;
      for (const line of orderLinesFrom(payment.events).lines) {
        add(line.itemId, line.size, line.half ? line.qty / 2 : line.qty);
        if (line.half) add(line.half, line.size, line.qty / 2);
      }
    }
  }
  return sold;
};

const stockItem = (row: InventoryRow, onOrderPacks: number): DigestStockItem => ({
  id: row.id,
  name: row.name,
  category: row.category,
  status: stockStatus(row),
  onHand: row.counted ? formatQuantity(Math.max(0, row.onHandBaseUnits), row.baseUnit) : null,
  usedPerDay: row.usedPerDay > 0 ? formatQuantity(row.usedPerDay, row.baseUnit) : null,
  lastsDays: row.lastsDays === null ? null : Math.round(row.lastsDays * 10) / 10,
  pack: formatQuantity(row.packQty, row.baseUnit),
  packPriceCents: row.workingPriceCents,
  onHandPacks: row.counted ? row.onHandPacks : null,
  suggestedPacks: row.suggestedPacks,
  onOrderPacks,
  supplierIds: row.supplierIds,
  countedAt: row.lastCountedAt,
});

export const buildOwnerDigest = (events: readonly SyncEvent[], now: number): OwnerDigest => {
  const stock = stockFromEvents(SEED_INVENTORY, events, { now });
  const rows = stock.rows.filter((r) => !r.archived);
  const names = new Map(rows.map((r) => [r.id, r.name]));
  const suppliers = suppliersFromEvents(SEED_SUPPLIERS, events);
  const insights = rulesSuggestions.insights({ events, now, stock: { items: rows, suppliers } });

  const purchases = purchasesFromEvents(events);
  const coming = onOrder(purchases.open);
  const answers = answersFromEvents(events);
  const ctx = { items: rows, answers };
  const menu = effectiveMenu(MENU, menuStateFromEvents(events), now).filter((m) => !m.hidden);
  const sold = soldSince(events, now - SOLD_DAYS * DAY_MS);
  const dishes = menu.flatMap((item) => sizesOf(item).map((size): DigestDish => {
    const priceCents = (size ? item.variants?.find((v) => v.id === size)?.price : item.price) ?? 0;
    const cost = menuCost(item.id, size, ctx);
    const margin = cost.complete ? marginOf(priceCents, cost.cents) : null;
    return {
      name: item.name.en,
      size,
      priceCents,
      foodCostCents: cost.complete ? cost.cents : null,
      marginPercent: margin === null ? null : Math.round(margin * 100),
      soldLast28Days: sold.get(`${item.id}:${size}`) ?? 0,
      canMake: canMake(item.id, size, stock.ledger),
    };
  }));

  const line = (itemId: string, packs: number, unitPriceCents?: Cents): DigestLine => ({
    itemId, name: names.get(itemId) ?? itemId, packs, ...(unitPriceCents === undefined ? {} : { unitPriceCents }),
  });
  const prepNames = new Map(prepItems(answers).map((p) => [p.key, p.name]));

  return {
    version: OWNER_DIGEST_VERSION,
    computedAt: now,
    attention: cardsFrom(insights, nameRemover(peopleIn(events))),
    stock: rows.map((r) => stockItem(r, coming.get(r.id) ?? 0)),
    semiProcessed: stock.preps.filter((p) => p.tracked).map((p) => ({
      name: prepNames.get(p.key) ?? p.key,
      onHand: `${Math.max(0, Math.round(p.onHand * 10) / 10)} ${p.unit}`,
      status: prepStatus(p),
    })),
    dishes,
    unansweredCosts: openQuestions(menu, ctx).length,
    suppliers: suppliers.map((s): DigestSupplier => {
      const draftPrices = purchases.draftPrices.get(s.id) ?? {};
      return {
        id: s.id,
        name: s.name,
        leadDays: purchases.leadDays.get(s.id) ?? null,
        draft: Object.entries(purchases.drafts.get(s.id) ?? {}).map(([id, packs]) => line(id, packs, draftPrices[id])),
        suggested: rows.filter((r) => r.suggestedPacks > 0 && r.suggestedSupplierId === s.id).map((r) => line(r.id, r.suggestedPacks)),
        openOrders: purchases.open.filter((o) => o.supplierId === s.id).map((o) => ({
          number: o.poNo, status: o.status, placedAt: o.at, lines: o.lines.map((l) => line(l.itemId, l.packs, l.unitPriceCents)),
        })),
      };
    }),
  };
};
