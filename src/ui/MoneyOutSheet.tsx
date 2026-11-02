import { useEffect, useRef, useState, type KeyboardEvent as ReactKey } from 'react';
import { fmt, parseLKR } from '../domain/money.ts';
import {
  FROM_LABEL, MONEY_LABEL, MONEY_WHATS, cashierWhats, checkMoneyOut, defaultMonth, isMonthly, monthLabel, monthOf, shiftMonth,
  type MoneyFrom, type MoneyWhat,
} from '../domain/moneyOut.ts';
import { currentCashier } from '../services/auth.ts';
import { recordMoneyOut } from '../services/moneyOutStore.ts';
import { useCatalog } from '../services/inventoryStore.ts';
import type { Actor } from '../domain/auth.ts';
import { NumberInput } from './NumberInput.tsx';

/**
 * Money out (SCRUM-105). Serves a cashier handing over cash with someone waiting, or the owner
 * with a bill in his hand. Already knows who is acting and the date; needs only: what for, how
 * much, and where it came from. Saved at once with Undo in the toast: no confirmation.
 * `full`: rent, wages and the bank too (managers and the owner); a cashier gets the drawer only.
 */
export function MoneyOutSheet({ actor = currentCashier(), full, onClose, onDone }: {
  actor?: Actor;
  full: boolean;
  onClose: () => void;
  /** After recording: what to say, and its Undo. */
  onDone: (message: string, undo: () => void) => void;
}) {
  const { suppliers } = useCatalog();
  const [what, setWhat] = useState<MoneyWhat | null>(null);
  const [amount, setAmount] = useState('');
  const [from, setFrom] = useState<MoneyFrom>('drawer');
  const [note, setNote] = useState('');
  const [supplierId, setSupplierId] = useState<string | null>(null);
  const [month, setMonth] = useState<string | null>(null);
  const amountRef = useRef<HTMLInputElement>(null);
  const [now] = useState(() => Date.now());

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const whats = full ? MONEY_WHATS : cashierWhats;
  const supplier = suppliers.find((s) => s.id === supplierId);
  const cents = parseLKR(amount);
  const entry = {
    what, from, cents,
    ...(what === 'other' ? { note: note.trim() } : what === 'supplier' && supplier ? { note: supplier.name } : {}),
    ...(what === 'supplier' && supplierId ? { supplierId } : {}),
    ...(what && isMonthly(what) && month ? { month } : {}),
  };
  const problem = amount === '' && what ? 'Type the amount' : checkMoneyOut(entry);

  const choose = (w: MoneyWhat) => {
    setWhat(w);
    setMonth(isMonthly(w) ? defaultMonth(w, now) : null);
    setTimeout(() => amountRef.current?.focus(), 0);
  };

  const submit = () => {
    if (problem || !what || cents === null) return;
    const undo = recordMoneyOut({ ...entry, what, cents, from }, actor);
    onDone(`Rs ${fmt(cents)} ${MONEY_LABEL[what].toLowerCase()}, from the ${from}`, undo);
  };

  // 1-7 choose what it was for (outside a box); Enter records.
  const onKeyDown = (e: ReactKey) => {
    if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) { e.preventDefault(); submit(); return; }
    const picked = whats[Number(e.key) - 1];
    if (picked && !(e.target instanceof HTMLInputElement)) { e.preventDefault(); choose(picked); }
  };

  const thisMonth = monthOf(now);

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="sheet" role="dialog" aria-modal="true" aria-label="Money out" onKeyDown={onKeyDown} tabIndex={-1} ref={(el) => { if (el && !el.contains(document.activeElement)) el.focus(); }}>
        <div className="sheet__body">
          <div className="sheet__title">
            <h1>Money out</h1>
            <span>A bill paid, or cash taken from the drawer.</span>
          </div>

          <section className="group">
            <h2>What for</h2>
            <div className="chips" role="group" aria-label="What for">
              {whats.map((w, i) => (
                <button key={w} type="button" className="chip" aria-pressed={what === w} onClick={() => choose(w)}>
                  <kbd>{i + 1}</kbd>{MONEY_LABEL[w]}
                </button>
              ))}
            </div>
            {what === 'other' && (
              <input className="note" type="text" value={note} onChange={(e) => setNote(e.target.value)} placeholder="What was it?" aria-label="What was it?" maxLength={120} />
            )}
            {what === 'supplier' && (
              <div className="chips chips--tight" role="group" aria-label="Which supplier">
                {suppliers.map((s) => (
                  <button key={s.id} type="button" className="chip" aria-pressed={supplierId === s.id} onClick={() => setSupplierId(s.id)}>{s.name}</button>
                ))}
              </div>
            )}
          </section>

          <section className="group">
            <h2>How much</h2>
            <div className="money-out__amount">
              <NumberInput ref={amountRef} className="note" value={amount} onText={setAmount} decimals={2} unit="Rs" aria-label="How much, in rupees" />
            </div>
          </section>

          {what && isMonthly(what) && (
            <section className="group">
              <h2>For which month</h2>
              <div className="chips chips--tight" role="group" aria-label="For which month">
                {[shiftMonth(thisMonth, -1), thisMonth].map((m) => (
                  <button key={m} type="button" className="chip" aria-pressed={month === m} onClick={() => setMonth(m)}>{monthLabel(m)}</button>
                ))}
              </div>
            </section>
          )}

          {full && (
            <section className="group">
              <h2>Paid from</h2>
              <div className="chips chips--tight" role="group" aria-label="Paid from">
                {(['drawer', 'bank'] as const).map((f) => (
                  <button key={f} type="button" className="chip" aria-pressed={from === f} onClick={() => setFrom(f)}>{FROM_LABEL[f]}</button>
                ))}
              </div>
            </section>
          )}
        </div>

        <div className="sheet__foot">
          <button type="button" className="cta" disabled={Boolean(problem)} onClick={submit}>
            {problem ?? `Record Rs ${fmt(cents ?? 0)}`}
          </button>
        </div>
      </div>
    </>
  );
}
