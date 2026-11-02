import { useEffect, useState } from 'react';
import type { Actor } from '../domain/auth.ts';
import {
  moneyChoices, moneyOutFromEvents, type ChoiceWhat, type MoneyChoice, type MoneyChoices, type MoneyEvent, type MoneyOut,
} from '../domain/moneyOut.ts';
import { appendEvent, readAll, subscribeEvents } from '../ui/eventLog.ts';

type Entry = Pick<Extract<MoneyEvent, { type: 'money.out' }>, 'what' | 'from' | 'cents' | 'note' | 'supplierId' | 'month' | 'choiceId' | 'qty' | 'grnIds'>;

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

/** A manager or the owner changes the sizes or rents; returns its Undo. */
export const setMoneyChoices = (what: ChoiceWhat, choices: MoneyChoice[], actor: Actor): (() => void) => {
  const before = moneyChoices(readAll())[what];
  appendEvent({ type: 'money.choices_set', at: Date.now(), orderNumber: 0, actor, what, choices });
  return () => { appendEvent({ type: 'money.choices_set', at: Date.now(), orderNumber: 0, actor, what, choices: before }); };
};

export function useMoneyChoices(): MoneyChoices {
  const [choices, setChoices] = useState(() => moneyChoices(readAll()));
  useEffect(() => subscribeEvents(() => setChoices(moneyChoices(readAll()))), []);
  return choices;
}
