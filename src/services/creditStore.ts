import type { Actor } from '../domain/auth.ts';
import { creditOf, type CreditSetting, type CreditTender } from '../domain/credit.ts';
import type { Cents } from '../domain/types.ts';
import { appendEvent, readAll } from '../ui/eventLog.ts';

/**
 * Credit (credit.ts) as the screens write it: each write is one event, and returns its Undo.
 * What someone owes is always read from the log (creditOf), never kept here.
 */

/** The owner turns a customer's credit on (with a limit, or none) or off. */
export const setCredit = (customerId: string, after: CreditSetting | null, owner: Actor): (() => void) => {
  const before = creditOf(readAll(), customerId).setting;
  appendEvent({ type: 'credit.limit_set', at: Date.now(), orderNumber: 0, actor: owner, customerId, before, after });
  return () => { appendEvent({ type: 'credit.limit_set', at: Date.now(), orderNumber: 0, actor: owner, customerId, before: after, after: before }); };
};

/**
 * The customer pays credit back: `amount` comes off what they owe (never more than they owe), and
 * `tendered` is what they handed over (cash: the rest is change). Returns what was recorded and its Undo.
 */
export const payCreditBack = (customerId: string, tender: CreditTender, tendered: Cents, by: Actor, most?: Cents):
  { amount: Cents; tendered: Cents; owesAfter: Cents; undo: () => void } | null => {
  const owes = most ?? creditOf(readAll(), customerId).owes;
  const amount = Math.min(owes, tendered);
  if (amount <= 0) return null;
  const given = tender === 'cash' ? tendered : amount;
  const e = appendEvent({ type: 'credit.paid', at: Date.now(), orderNumber: 0, actor: by, customerId, amount, tender, tendered: given });
  return {
    amount, tendered: given, owesAfter: creditOf(readAll(), customerId).owes,
    undo: () => { appendEvent({ type: 'credit.paid_undone', at: Date.now(), orderNumber: 0, actor: by, paidId: e.id }); },
  };
};
