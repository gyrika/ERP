import { useState } from 'react';
import { canManage } from '../domain/auth.ts';
import { fmt } from '../domain/money.ts';
import {
  FROM_LABEL, MONEY_LABEL, drawerOutToday, moneyMonth, monthLabel, monthOf, rentRows, shiftMonth, type MoneyOut,
} from '../domain/moneyOut.ts';
import { grnsOwed } from '../domain/supplierOwed.ts';
import { currentCashier, currentOwner } from '../services/auth.ts';
import { useCatalog, usePurchases } from '../services/inventoryStore.ts';
import { removeGrnFromOwed, removeMoneyOut, setMoneyChoices, useMoneyChoices, useMoneyOut, useRemovedGrns } from '../services/moneyOutStore.ts';
import { ChoiceEditor, MoneyOutSheet } from './MoneyOutSheet.tsx';
import { OwnerNav } from './OwnerNav.tsx';

/**
 * Money out (SCRUM-105). Serves the owner: what did the shop pay this month, and for what?
 * He already knows the bills exist; the next thing he needs is the total, and where it went.
 * One number and a bar per kind, then the entries. One primary action: add a bill.
 */
const dayOf = (at: number) => new Date(at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

export function MoneyOutView({ onRegister }: { onRegister?: () => void }) {
  const all = useMoneyOut();
  const [now] = useState(() => Date.now());
  const [month, setMonth] = useState(() => monthOf(now));
  const [adding, setAdding] = useState(false);
  const [paying, setPaying] = useState<string | undefined>(undefined);
  const [payingRent, setPayingRent] = useState<{ choiceId: string; month: string } | undefined>(undefined);
  const [editingRents, setEditingRents] = useState(false);
  const purchases = usePurchases();
  const { suppliers } = useCatalog();
  const choices = useMoneyChoices();
  const [done, setDone] = useState<{ message: string; undo: () => void } | null>(null);
  const shown = moneyMonth(all, month);
  const biggest = Math.max(1, ...shown.byWhat.map((w) => w.cents));
  const drawer = drawerOutToday(all, Date.now());
  const removedList = useRemovedGrns();
  const owed = grnsOwed(purchases.grns, all, removedList).filter((g) => g.owed > 0);
  const owedTotal = owed.reduce((n, g) => n + g.owed, 0);
  const owner = currentOwner();
  const grnNo = new Map(purchases.grns.map((g) => [g.id, g.grnNo]));
  const supplierName = (id: string) => suppliers.find((s) => s.id === id)?.name ?? 'Supplier';
  const rents = rentRows(all, choices.rent, month);
  const onList = new Set(choices.rent.map((c) => c.id));

  const me = currentCashier();
  const remove = (o: MoneyOut) => {
    const undo = removeMoneyOut(o.id, me);
    setDone({ message: `Removed Rs ${fmt(o.cents)} ${MONEY_LABEL[o.what].toLowerCase()}`, undo });
  };

  return (
    <div className="inv-page">
      <OwnerNav current="money" onRegister={onRegister} />
      <div className="inv-page__head">
        <h1 className="supplier-heading">Money out</h1>
        <div className="inv-page__actions">
          <button type="button" className="inv-page__primary" onClick={() => setAdding(true)}>Add money out</button>
        </div>
      </div>
      {done && (
        <div className="inv-notice" role="status">
          {done.message}
          <button type="button" onClick={() => { done.undo(); setDone(null); }}>Undo</button>
        </div>
      )}
      <main className="inv-rows money-out" aria-label="Money out">
        <div className="money-out__month" role="group" aria-label="Month">
          <button type="button" className="money-out__step" aria-label="Month before" onClick={() => setMonth(shiftMonth(month, -1))}>‹</button>
          <span>{monthLabel(month)}</span>
          <button type="button" className="money-out__step" aria-label="Month after" disabled={month >= monthOf(now)} onClick={() => setMonth(shiftMonth(month, 1))}>›</button>
        </div>

        <p className="money-out__total"><b className="num">Rs {fmt(shown.costs)}</b> <span>bills and other costs</span></p>

        {shown.byWhat.length > 0 && (
          <ul className="money-out__bars" aria-label="Where it went">
            {shown.byWhat.map((w) => (
              <li key={w.what} className="money-out__bar">
                <span>{MONEY_LABEL[w.what]}</span>
                <span className="money-out__track"><i style={{ width: `${(w.cents / biggest) * 100}%` }} /></span>
                <span className="num">Rs {fmt(w.cents)}</span>
                {w.what === 'gas' && shown.parts.gas.length > 0 && (
                  <ul className="money-out__parts" aria-label="Gas by size">
                    {shown.parts.gas.map((p) => (
                      <li key={p.label}>
                        <span>{`${p.qty} × ${p.label}`}</span>
                        <span className="num">Rs {fmt(p.cents)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}

        <section className="money-out__owed" aria-label="Rent">
          <div className="money-out__head">
            <h2>Rent</h2>
            {!editingRents && <button type="button" className="linkbtn" onClick={() => setEditingRents(true)}>Add or change rents</button>}
          </div>
          {editingRents
            ? <ChoiceEditor what="rent" choices={choices.rent}
                onCancel={() => setEditingRents(false)}
                onSave={(next) => {
                  const undo = setMoneyChoices('rent', next, me);
                  setEditingRents(false);
                  setDone({ message: 'Rents changed', undo });
                }} />
            : (
              <ul className="money-out__list">
                {rents.map((r) => (
                  <li key={r.id || 'not-said'} className="money-out__row">
                    <span className="money-out__what"><b>{r.label}</b></span>
                    {r.cents > 0
                      ? <span className="num">Rs {fmt(r.cents)}</span>
                      : <span className="money-out__unpaid">Not paid</span>}
                    {onList.has(r.id) && (
                      <button type="button" className="linkbtn" aria-label={`Pay ${r.label}`} onClick={() => setPayingRent({ choiceId: r.id, month })}>Pay</button>
                    )}
                  </li>
                ))}
              </ul>
            )}
        </section>

        {owed.length > 0 && (
          <section className="money-out__owed" aria-label="Unpaid GRNs">
            <p className="money-out__total"><b className="num">Rs {fmt(owedTotal)}</b> <span>{owed.length} unpaid {owed.length === 1 ? 'GRN' : 'GRNs'}</span></p>
            <ul className="money-out__list">
              {owed.map((g) => (
                <li key={g.id} className="money-out__row">
                  <span className="money-out__what">
                    <b>{g.grnNo} · {supplierName(g.supplierId)}</b>
                    <small>{dayOf(g.at)}{g.paid > 0 ? ` · Rs ${fmt(g.paid)} of Rs ${fmt(g.value)} paid` : ''}</small>
                  </span>
                  <span className="num">Rs {fmt(g.owed)}</span>
                  <button type="button" className="linkbtn" aria-label={`Pay ${g.grnNo}`} onClick={() => setPaying(g.id)}>Pay</button>
                  {owner && (
                    <button type="button" className="linkbtn" aria-label={`Remove ${g.grnNo}`}
                      onClick={() => setDone({ message: `${g.grnNo} is off the unpaid list`, undo: removeGrnFromOwed(g.id, owner) })}>Remove</button>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}

        <div className="money-out__facts">
          <span>Cash from the drawer today <b className="num">Rs {fmt(drawer)}</b></span>
          {shown.suppliers > 0 && <span>Paid to suppliers, already in food cost <b className="num">Rs {fmt(shown.suppliers)}</b></span>}
        </div>

        {shown.entries.length === 0
          ? <p className="money-out__none">Nothing recorded for {monthLabel(month)}.</p>
          : (
            <ul className="money-out__list" aria-label="Entries">
              {shown.entries.map((o) => (
                <li key={o.id} className="money-out__row">
                  <span className="money-out__what">
                    <b>{MONEY_LABEL[o.what]}{o.what === 'gas' && o.qty ? ` · ${o.qty} ×` : o.note ? ' ·' : ''}{o.note ? ` ${o.note}` : ''}</b>
                    <small>
                      {dayOf(o.at)} · {FROM_LABEL[o.from]} · {o.actor.name}
                      {o.grnIds && ` · ${o.grnIds.map((id) => grnNo.get(id) ?? 'GRN').join(', ')}`}
                    </small>
                  </span>
                  <span className="num">Rs {fmt(o.cents)}</span>
                  {(canManage(me) || o.actor.id === me.id) && <button type="button" className="linkbtn" aria-label={`Remove Rs ${fmt(o.cents)} ${MONEY_LABEL[o.what]}`} onClick={() => remove(o)}>Remove</button>}
                </li>
              ))}
            </ul>
          )}
      </main>
      {(adding || paying || payingRent) && (
        <MoneyOutSheet
          full
          payGrn={paying}
          payRent={payingRent}
          onClose={() => { setAdding(false); setPaying(undefined); setPayingRent(undefined); }}
          onDone={(message, undo) => { setAdding(false); setPaying(undefined); setPayingRent(undefined); setDone({ message, undo }); }}
        />
      )}
    </div>
  );
}
