import { useEffect, useRef, useState, type KeyboardEvent as ReactKey } from 'react';
import { checkGrnPayment, grnsOwed, type GrnOwed } from '../domain/supplierOwed.ts';
import { fmt, parseLKR } from '../domain/money.ts';
import {
  CHOICE_ASK, FROM_LABEL, MONEY_LABEL, MONEY_WHATS, cashierWhats, checkChoiceChosen, checkChoices, checkMoneyOut, defaultMonth, isChoiceWhat,
  isMonthly, lastPaidEach, monthLabel, monthOf, rentsPaid, shiftMonth, type ChoiceWhat, type MoneyChoice, type MoneyFrom, type MoneyWhat,
} from '../domain/moneyOut.ts';
import { currentCashier } from '../services/auth.ts';
import { recordMoneyOut, setMoneyChoices, useMoneyChoices, useMoneyOut, useRemovedGrns } from '../services/moneyOutStore.ts';
import { useCatalog, usePurchases } from '../services/inventoryStore.ts';
import type { Actor } from '../domain/auth.ts';
import { NumberInput } from './NumberInput.tsx';

/** Rupees as the number box shows them: 1647 or 1250.50. */
const amountText = (cents: number) => `${Math.trunc(cents / 100)}${cents % 100 ? `.${String(cents % 100).padStart(2, '0')}` : ''}`;
const shortDay = (at: number) => new Date(at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

/** The sizes or rents, as a manager or the owner wants them. Nothing changes until Save, which offers Undo. */
export function ChoiceEditor({ what, choices, onSave, onCancel }: {
  what: ChoiceWhat; choices: MoneyChoice[]; onSave: (next: MoneyChoice[]) => void; onCancel: () => void;
}) {
  const [rows, setRows] = useState(choices);
  const [nextId] = useState(() => Date.now());
  const next = rows.map((r) => ({ ...r, label: r.label.trim() }));
  const problem = checkChoices(what, next);
  return (
    <div className="money-out__edit" onKeyDown={(e) => { if (e.key === 'Enter') e.stopPropagation(); }}>
      {rows.map((r, i) => (
        <div key={r.id} className="money-out__edit-row">
          <input className="note" type="text" value={r.label} maxLength={40} aria-label={`Name ${i + 1}`}
            onChange={(e) => setRows(rows.map((x) => (x.id === r.id ? { ...x, label: e.target.value } : x)))} />
          <button type="button" className="linkbtn" aria-label={`Remove ${r.label}`} onClick={() => setRows(rows.filter((x) => x.id !== r.id))}>Remove</button>
        </div>
      ))}
      <div className="money-out__edit-actions">
        <button type="button" className="chip" onClick={() => setRows([...rows, { id: `${what}-${nextId}-${rows.length}`, label: '' }])}>{CHOICE_ASK[what].add}</button>
        <button type="button" className="chip" disabled={Boolean(problem)} onClick={() => onSave(next)}>{problem ?? 'Save'}</button>
        <button type="button" className="linkbtn" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

/**
 * Money out (SCRUM-105). Serves a cashier handing over cash with someone waiting, or the owner
 * with a bill in his hand. Already knows who is acting and the date; needs only: what for, how
 * much, and where it came from. Saved at once with Undo in the toast: no confirmation.
 * Gas asks the size and rent asks which (SCRUM-204). A supplier is paid only against a GRN: the
 * Register lists the same unpaid GRNs the owner sees. Each fills in the amount, which stays editable.
 * `full`: rent, wages and the bank too (managers and the owner); a cashier gets the drawer only.
 */
export function MoneyOutSheet({ actor = currentCashier(), full, payGrn, payRent, onClose, onDone }: {
  actor?: Actor;
  full: boolean;
  /** Opens already paying this GRN. */
  payGrn?: string;
  /** Opens already paying this rent, for this month. */
  payRent?: { choiceId: string; month: string };
  onClose: () => void;
  /** After recording: what to say, and its Undo. */
  onDone: (message: string, undo: () => void) => void;
}) {
  const { suppliers } = useCatalog();
  const purchases = usePurchases();
  const paid = useMoneyOut();
  const removed = useRemovedGrns();
  const choices = useMoneyChoices();
  const [what, setWhat] = useState<MoneyWhat | null>(payGrn ? 'supplier' : payRent ? 'rent' : null);
  const [amount, setAmount] = useState('');
  /** The amount is one this sheet worked out, so it may follow the choice; once typed it is left alone. */
  const [worked, setWorked] = useState(false);
  const [choiceId, setChoiceId] = useState<string | null>(null);
  const [qty, setQty] = useState('1');
  const [grnIds, setGrnIds] = useState<string[]>([]);
  const [editing, setEditing] = useState(false);
  const [undoEdit, setUndoEdit] = useState<(() => void) | null>(null);
  const [from, setFrom] = useState<MoneyFrom>('drawer');
  const [note, setNote] = useState('');
  const [supplierId, setSupplierId] = useState<string | null>(null);
  const [month, setMonth] = useState<string | null>(payRent?.month ?? null);
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
  const list = isChoiceWhat(what) ? choices[what] : null;
  const chosen = list?.find((c) => c.id === choiceId);
  const count = Number(qty);
  const unpaid = grnsOwed(purchases.grns, paid, removed).filter((g) => g.owed > 0);
  const entry = {
    what, from, cents,
    ...(what === 'other' ? { note: note.trim() } : what === 'supplier' && supplier ? { note: supplier.name } : chosen ? { note: chosen.label } : {}),
    ...(what === 'supplier' && supplierId ? { supplierId } : {}),
    ...(what === 'supplier' && grnIds.length > 0 ? { grnIds } : {}),
    ...(chosen ? { choiceId: chosen.id } : {}),
    ...(what === 'gas' ? { qty: count } : {}),
    ...(what && isMonthly(what) && month ? { month } : {}),
  };
  const noGrn = what === 'supplier' ? checkGrnPayment(grnIds, cents, unpaid) : null;
  const problem = checkChoiceChosen(what, chosen?.id) ?? noGrn ?? (amount === '' && what ? 'Type the amount' : checkMoneyOut(entry));
  // Which of the list a key picks: until one is chosen, 1-3 mean the size or the GRN, not what it was for.
  const picking = list && !chosen ? list : null;
  const pickingGrn = what === 'supplier' && grnIds.length === 0 ? unpaid.slice(0, 9) : null;
  const paidRents = rentsPaid(paid, month ?? monthOf(now));

  /** Fills the amount, unless someone typed their own. */
  const work = (value: number | null) => {
    if (amount !== '' && !worked) return;
    setAmount(value === null ? '' : amountText(value));
    setWorked(value !== null);
  };
  const focusAmount = () => setTimeout(() => { amountRef.current?.focus(); amountRef.current?.select(); }, 0);

  const choose = (w: MoneyWhat) => {
    setWhat(w);
    setMonth(isMonthly(w) ? defaultMonth(w, now) : null);
    setChoiceId(null);
    setQty('1');
    setEditing(false);
    if (worked) { setAmount(''); setWorked(false); }
    if (worked || w !== 'supplier') { setGrnIds([]); setSupplierId(null); }
    if (!isChoiceWhat(w) && w !== 'supplier') focusAmount();
  };
  const pick = (c: MoneyChoice) => {
    setChoiceId(c.id);
    const each = lastPaidEach(paid, c.id);
    work(each === null ? null : each * (what === 'gas' && count > 0 ? count : 1));
    focusAmount();
  };
  const changeQty = (text: string) => {
    setQty(text);
    const each = chosen ? lastPaidEach(paid, chosen.id) : null;
    if (each !== null && Number(text) > 0) work(each * Number(text));
  };
  /** The amount follows the ticks. */
  const owing = (ids: string[]) => {
    setGrnIds(ids);
    setSupplierId(ids.length === 0 ? null : unpaid.find((g) => g.id === ids[0])?.supplierId ?? null);
    work(ids.length === 0 ? null : unpaid.filter((g) => ids.includes(g.id)).reduce((n, g) => n + g.owed, 0));
  };
  /** One payment goes to one supplier: ticking another's GRN starts again from that one. */
  const tickGrn = (g: GrnOwed) => {
    if (g.supplierId !== supplierId) owing([g.id]);
    else owing(grnIds.includes(g.id) ? grnIds.filter((x) => x !== g.id) : [...grnIds, g.id]);
    focusAmount();
  };
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (payGrn && unpaid.some((g) => g.id === payGrn)) {
      owing([payGrn]);
      focusAmount();
    }
    const rent = payRent && choices.rent.find((c) => c.id === payRent.choiceId);
    if (rent) pick(rent);
    // Once, when opened to pay this GRN or rent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = () => {
    if (problem || !what || cents === null) return;
    const undo = recordMoneyOut({ ...entry, what, cents, from }, actor);
    onDone(`Rs ${fmt(cents)} ${MONEY_LABEL[what].toLowerCase()}${chosen ? `, ${chosen.label}` : ''}, from the ${from}`, undo);
  };

  // 1-7 choose what it was for (outside a box); Enter records.
  const onKeyDown = (e: ReactKey) => {
    if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) { e.preventDefault(); submit(); return; }
    if (e.target instanceof HTMLInputElement) return;
    const n = Number(e.key) - 1;
    if (picking?.[n]) { e.preventDefault(); pick(picking[n]); return; }
    if (pickingGrn?.[n]) { e.preventDefault(); tickGrn(pickingGrn[n]); return; }
    if (!picking && !pickingGrn && whats[n]) { e.preventDefault(); choose(whats[n]); }
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
                  {!picking && !pickingGrn && <kbd>{i + 1}</kbd>}{MONEY_LABEL[w]}
                </button>
              ))}
            </div>
            {what === 'other' && (
              <input className="note" type="text" value={note} onChange={(e) => setNote(e.target.value)} placeholder="What was it?" aria-label="What was it?" maxLength={120} />
            )}
          </section>

          {isChoiceWhat(what) && list && (
            <section className="group">
              <h2>{CHOICE_ASK[what].title}</h2>
              {editing
                ? <ChoiceEditor key={what} what={what} choices={list}
                    onCancel={() => setEditing(false)}
                    onSave={(next) => {
                      setUndoEdit(() => setMoneyChoices(what, next, actor));
                      setEditing(false);
                      if (!next.some((c) => c.id === choiceId)) setChoiceId(null);
                    }} />
                : (
                  <div className="chips chips--tight" role="group" aria-label={CHOICE_ASK[what].title}>
                    {list.map((c, i) => (
                      <button key={c.id} type="button" className="chip" aria-pressed={choiceId === c.id} onClick={() => pick(c)}>
                        {picking && <kbd>{i + 1}</kbd>}{c.label}{what === 'rent' && paidRents.has(c.id) && <small className="money-out__paid"> paid</small>}
                      </button>
                    ))}
                    {full && <button type="button" className="linkbtn" onClick={() => { setEditing(true); setUndoEdit(null); }}>{CHOICE_ASK[what].edit}</button>}
                    {undoEdit && <button type="button" className="linkbtn" onClick={() => { undoEdit(); setUndoEdit(null); setChoiceId(null); }}>Undo</button>}
                  </div>
                )}
            </section>
          )}

          {what === 'gas' && (
            <section className="group">
              <h2>How many</h2>
              <div className="money-out__amount">
                <NumberInput className="note" value={qty} onText={changeQty} decimals={0} unit="cylinders" aria-label="How many cylinders" />
              </div>
            </section>
          )}

          {what === 'supplier' && (
            <section className="group">
              <h2>Which GRN</h2>
              {unpaid.length === 0
                ? <p className="money-out__hint">No GRN is waiting to be paid. A supplier is paid once its delivery is received.</p>
                : (
                  <div className="chips chips--tight" role="group" aria-label="Which GRN">
                    {unpaid.map((g, i) => (
                      <button key={g.id} type="button" className="chip" aria-pressed={grnIds.includes(g.id)} onClick={() => tickGrn(g)}>
                        {pickingGrn && i < 9 && <kbd>{i + 1}</kbd>}
                        {g.grnNo} · {suppliers.find((s) => s.id === g.supplierId)?.name ?? 'Supplier'} · {shortDay(g.at)} · <span className="num">Rs {fmt(g.owed)}</span>
                      </button>
                    ))}
                  </div>
                )}
            </section>
          )}

          <section className="group">
            <h2>How much</h2>
            <div className="money-out__amount">
              <NumberInput ref={amountRef} className="note" value={amount} onText={(t) => { setAmount(t); setWorked(false); }} decimals={2} unit="Rs" aria-label="How much, in rupees" />
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
