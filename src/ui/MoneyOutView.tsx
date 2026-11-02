import { useState } from 'react';
import { canManage } from '../domain/auth.ts';
import { fmt } from '../domain/money.ts';
import {
  FROM_LABEL, MONEY_LABEL, drawerOutToday, moneyMonth, monthLabel, monthOf, rentsPaid, shiftMonth, type MoneyOut,
} from '../domain/moneyOut.ts';
import { grnsOwed, suppliersOwed } from '../domain/supplierOwed.ts';
import { currentCashier } from '../services/auth.ts';
import { useCatalog, usePurchases } from '../services/inventoryStore.ts';
import { removeMoneyOut, useMoneyChoices, useMoneyOut } from '../services/moneyOutStore.ts';
import { MoneyOutSheet } from './MoneyOutSheet.tsx';
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
  const purchases = usePurchases();
  const { suppliers } = useCatalog();
  const choices = useMoneyChoices();
  const [done, setDone] = useState<{ message: string; undo: () => void } | null>(null);
  const shown = moneyMonth(all, month);
  const biggest = Math.max(1, ...shown.byWhat.map((w) => w.cents));
  const drawer = drawerOutToday(all, Date.now());
  const owed = suppliersOwed(grnsOwed(purchases.grns, all));
  const owedTotal = owed.reduce((n, s) => n + s.owed, 0);
  const grnNo = new Map(purchases.grns.map((g) => [g.id, g.grnNo]));
  const supplierName = (id: string) => suppliers.find((s) => s.id === id)?.name ?? 'Supplier';
  // Which rent is still to pay: this month, or a month where some were paid.
  const paidRents = rentsPaid(all, month);
  const rentsLeft = month === monthOf(now) || shown.parts.rent.length > 0 ? choices.rent.filter((c) => !paidRents.has(c.id)) : [];

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
                {(w.what === 'gas' || w.what === 'rent') && shown.parts[w.what].length > 0 && (
                  <ul className="money-out__parts" aria-label={`${MONEY_LABEL[w.what]} by ${w.what === 'gas' ? 'size' : 'which'}`}>
                    {shown.parts[w.what].map((p) => (
                      <li key={p.label}>
                        <span>{w.what === 'gas' ? `${p.qty} × ${p.label}` : p.label}</span>
                        <span className="num">Rs {fmt(p.cents)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}

        {rentsLeft.length > 0 && <p className="money-out__left">Rent not paid yet: {rentsLeft.map((c) => c.label).join(', ')}</p>}

        {owed.length > 0 && (
          <section className="money-out__owed" aria-label="Owed to suppliers">
            <p className="money-out__total"><b className="num">Rs {fmt(owedTotal)}</b> <span>owed to suppliers</span></p>
            <ul className="money-out__list">
              {owed.map((s) => (
                <li key={s.supplierId} className="money-out__row">
                  <span className="money-out__what">
                    <b>{supplierName(s.supplierId)}</b>
                    <small>{s.grns} {s.grns === 1 ? 'GRN' : 'GRNs'}</small>
                  </span>
                  <span className="num">Rs {fmt(s.owed)}</span>
                  <button type="button" className="linkbtn" aria-label={`Pay ${supplierName(s.supplierId)}`} onClick={() => setPaying(s.supplierId)}>Pay</button>
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
      {(adding || paying) && (
        <MoneyOutSheet
          full
          paySupplier={paying}
          onClose={() => { setAdding(false); setPaying(undefined); }}
          onDone={(message, undo) => { setAdding(false); setPaying(undefined); setDone({ message, undo }); }}
        />
      )}
    </div>
  );
}
