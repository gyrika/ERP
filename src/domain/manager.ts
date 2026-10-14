import { canManage, type Actor } from './auth.ts';
import type { NewOrderEvent } from './events.ts';
import { itemById } from './menu.ts';
import { unitPrice } from './money.ts';
import { lineGross, totals } from './totals.ts';
import type { Cents, Discount, LineSpec, Order, OrderLine } from './types.ts';

/**
 * Manager mode, as pure functions. EVERY manager change goes through
 * `applyManagerChange`: it returns the new order, exactly one audit event,
 * and the inverse that Undo applies. Undo is itself a change with its own
 * audit event: the log is append-only, nothing is rewritten.
 *
 * Menu prices are never touched: discounts live in `order.adjust`.
 */
export type ManagerChange =
  /** Remove a line. A line already sent to the kitchen needs a reason (owner rule). */
  | { kind: 'void'; lineId: string; reason?: string }
  /** Change size / extras / quantity / note. Sent lines need a reason. */
  | { kind: 'edit'; lineId: string; after: LineSpec; reason?: string }
  /** Cents off one line (capped at the line's price). 0 removes the adjustment. */
  | { kind: 'adjustLine'; lineId: string; cents: Cents }
  /** Percentage off, Free (comp), or null to remove the order discount. */
  | { kind: 'discount'; discount: Discount | null };

export type Inverse =
  | { kind: 'restoreLine'; line: OrderLine; index: number }
  | { kind: 'replaceLine'; line: OrderLine }
  | { kind: 'adjustLine'; lineId: string; cents: Cents }
  | { kind: 'discount'; discount: Discount | null };

/** What the kitchen must be told: a sent line changed (after) or was cancelled (null). */
export interface KitchenEffect { lineId: string; after: OrderLine | null }

export interface Applied {
  order: Order;
  event: NewOrderEvent;
  inverse: Inverse;
  kitchen?: KitchenEffect;
}

export type Refusal = { refused: 'not-a-manager' | 'no-such-line' | 'reason-required' | 'no-change' };

const sameLine = (a: Omit<OrderLine, 'id'>, b: Omit<OrderLine, 'id'>): boolean =>
  a.itemId === b.itemId && (a.half ?? '') === (b.half ?? '') && a.qty === b.qty && a.size === b.size && (a.note ?? '') === (b.note ?? '') &&
  [...a.adds].sort().join() === [...b.adds].sort().join() && [...a.outs].sort().join() === [...b.outs].sort().join();

const sameDiscount = (a: Discount | null | undefined, b: Discount | null | undefined): boolean =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

const setLineAdjust = (order: Order, lineId: string, cents: Cents): Order => {
  const lines = { ...order.adjust?.lines };
  if (cents > 0) lines[lineId] = cents; else delete lines[lineId];
  return { ...order, adjust: { ...order.adjust, lines } };
};

const setDiscount = (order: Order, discount: Discount | null): Order => {
  const { discount: _old, ...rest } = order.adjust ?? {};
  return { ...order, adjust: discount ? { ...rest, discount } : rest };
};

/** Applies an inverse (used by Undo). Pure. */
export const applyInverse = (order: Order, inv: Inverse): Order => {
  switch (inv.kind) {
    case 'restoreLine': {
      const lines = [...order.lines];
      lines.splice(Math.min(inv.index, lines.length), 0, inv.line);
      return { ...order, lines };
    }
    case 'replaceLine':
      return { ...order, lines: order.lines.map((l) => (l.id === inv.line.id ? inv.line : l)) };
    case 'adjustLine':
      return setLineAdjust(order, inv.lineId, inv.cents);
    case 'discount':
      return setDiscount(order, inv.discount);
  }
};

export function applyManagerChange(order: Order, change: ManagerChange, actor: Actor, at: number): Applied | Refusal {
  if (!canManage(actor)) return { refused: 'not-a-manager' };
  const totalBefore = totals(order).total;
  const stamp = (o: Order): Order => ({ ...o, edited: { by: actor.name, at } });
  const base = { at, actor, orderNumber: order.number, totalBefore };

  switch (change.kind) {
    case 'void': {
      const index = order.lines.findIndex((l) => l.id === change.lineId);
      if (index < 0) return { refused: 'no-such-line' };
      const line = order.lines[index];
      const reason = change.reason?.trim() ?? '';
      if (line.sent && !reason) return { refused: 'reason-required' };
      const next = stamp({ ...order, lines: order.lines.filter((l) => l.id !== line.id) });
      const totalAfter = totals(next).total;
      return {
        order: next,
        inverse: { kind: 'restoreLine', line, index },
        event: line.sent
          ? { ...base, totalAfter, type: 'order.item_cancelled', lineId: line.id, index, before: line, reason }
          : { ...base, totalAfter, type: 'order.line_removed', lineId: line.id, index, before: line },
        ...(line.sent ? { kitchen: { lineId: line.id, after: null } } : {}),
      };
    }
    case 'edit': {
      const line = order.lines.find((l) => l.id === change.lineId);
      if (!line) return { refused: 'no-such-line' };
      const reason = change.reason?.trim() ?? '';
      if (line.sent && !reason) return { refused: 'reason-required' };
      // A changed sent line is priced as the menu has it now (a manager chose the new size or extras).
      const after: OrderLine = {
        ...change.after, id: line.id,
        ...(line.sent ? { sent: true, unit: unitPrice(itemById(change.after.itemId), change.after) } : {}),
      };
      if (sameLine(line, after)) return { refused: 'no-change' };
      const next = stamp({ ...order, lines: order.lines.map((l) => (l.id === line.id ? after : l)) });
      return {
        order: next,
        inverse: { kind: 'replaceLine', line },
        event: { ...base, totalAfter: totals(next).total, type: 'order.item_changed', lineId: line.id, before: line, after, reason },
        ...(line.sent ? { kitchen: { lineId: line.id, after } } : {}),
      };
    }
    case 'adjustLine': {
      const line = order.lines.find((l) => l.id === change.lineId);
      if (!line) return { refused: 'no-such-line' };
      const before = order.adjust?.lines?.[line.id] ?? 0;
      const cents = Math.max(0, Math.min(Math.round(change.cents), lineGross(line)));
      if (cents === before) return { refused: 'no-change' };
      const next = stamp(setLineAdjust(order, line.id, cents));
      return {
        order: next,
        inverse: { kind: 'adjustLine', lineId: line.id, cents: before },
        event: { ...base, totalAfter: totals(next).total, type: 'order.line_adjusted', lineId: line.id, before, after: cents },
      };
    }
    case 'discount': {
      const before = order.adjust?.discount ?? null;
      if (sameDiscount(before, change.discount)) return { refused: 'no-change' };
      const next = stamp(setDiscount(order, change.discount));
      const totalAfter = totals(next).total;
      return {
        order: next,
        inverse: { kind: 'discount', discount: before },
        event: change.discount?.kind === 'comp'
          ? { ...base, totalAfter, type: 'order.comped', before }
          : { ...base, totalAfter, type: 'order.discount_set', before, after: change.discount },
      };
    }
  }
}

/** Undo of an applied change: restores exactly, and is audited as its own event. */
export function undoManagerChange(
  order: Order, applied: { inverse: Inverse; eventId: string; eventType: string; kitchen?: KitchenEffect },
  actor: Actor, at: number,
): { order: Order; event: NewOrderEvent } {
  const next: Order = { ...applyInverse(order, applied.inverse), edited: { by: actor.name, at } };
  return {
    order: next,
    event: {
      type: 'order.change_undone', at, actor, orderNumber: order.number,
      totalBefore: totals(order).total, totalAfter: totals(next).total,
      undoneEventId: applied.eventId, undoneType: applied.eventType,
    },
  };
}

export const isRefusal = (r: Applied | Refusal): r is Refusal => 'refused' in r;

/** Chip keys 1-4 in manager mode. */
export const DISCOUNT_CHIPS: { key: string; discount: Discount; label: string }[] = [
  { key: '1', discount: { kind: 'percent', pct: 10 }, label: '10%' },
  { key: '2', discount: { kind: 'percent', pct: 20 }, label: '20%' },
  { key: '3', discount: { kind: 'percent', pct: 50 }, label: '50%' },
  { key: '4', discount: { kind: 'comp' }, label: 'Free' },
];
