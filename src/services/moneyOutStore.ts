import { useEffect, useState } from 'react';
import type { Actor } from '../domain/auth.ts';
import { moneyOutFromEvents, type MoneyEvent, type MoneyOut } from '../domain/moneyOut.ts';
import { appendEvent, readAll, subscribeEvents } from '../ui/eventLog.ts';

type Entry = Pick<Extract<MoneyEvent, { type: 'money.out' }>, 'what' | 'from' | 'cents' | 'note' | 'supplierId' | 'month'>;

/** Records it; returns its Undo. */
export const recordMoneyOut = (entry: Entry, actor: Actor): (() => void) => {
  const e = appendEvent({ type: 'money.out', at: Date.now(), orderNumber: 0, actor, ...entry });
  return () => { appendEvent({ type: 'money.out_undone', at: Date.now(), orderNumber: 0, actor, outId: e.id }); };
};

/** A manager or the owner takes out a mistake; returns its Undo. */
export const removeMoneyOut = (outId: string, actor: Actor): (() => void) => {
  appendEvent({ type: 'money.out_undone', at: Date.now(), orderNumber: 0, actor, outId });
  return () => { appendEvent({ type: 'money.out_restored', at: Date.now(), orderNumber: 0, actor, outId }); };
};

export function useMoneyOut(): MoneyOut[] {
  const [all, setAll] = useState(() => moneyOutFromEvents(readAll()));
  useEffect(() => subscribeEvents(() => setAll(moneyOutFromEvents(readAll()))), []);
  return all;
}
