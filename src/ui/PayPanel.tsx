import { useEffect, useRef, useState, type ReactNode } from 'react';
import { fmt, parseLKR, quickCashAmounts } from '../domain/money.ts';
import { toLkMobile } from '../domain/phone.ts';
import { lineItemName } from '../domain/halves.ts';
import { cleanPick, paidSoFar, pickAmount, picksAllLeft, unitsLeft, type Pick } from '../domain/split.ts';
import { lineNet } from '../domain/totals.ts';
import type { Cents, Order, OrderCustomer, OrderLine, Tender } from '../domain/types.ts';
import { crmClient, rememberName, type Greeting } from '../services/crmClient.ts';
import { NameMatches, useNameSearch } from './useNameSearch.tsx';

interface Props {
  number: number;
  total: Cents;
  /** The order's lines, compact. Shown while the keypad is folded away. */
  lines: ReactNode;
  /**
   * One tap completes the sale; there is no second confirmation, only Undo. `customerId`: the
   * customer whose mobile was given (CRM), if any; `unlinked`: a number was given but could not be
   * matched in time (the sale went through anyway).
   */
  onPay: (tender: Tender, tendered: Cents, customerId?: string, unlinked?: boolean) => void;
  onClose: () => void;
  /** Customers (CRM) is on and this screen can reach the list: show the optional Mobile field. */
  customers?: boolean;
  /** Already put on the order (in the order panel): the payment is theirs, no Mobile to ask. */
  customer?: OrderCustomer;
  /**
   * Split bill (split.ts): the order, so its items can be picked person by person. `total` is then
   * what is still owed. Without it (a paid order's difference) there is no Split.
   */
  order?: Order;
  /** One person pays for the units picked; the panel stays open for the next. */
  onPayPart?: (tender: Tender, tendered: Cents, pick: Pick, customerId?: string, unlinked?: boolean) => void;
}

const PAD_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '00', '0', '⌫'];
/** The touch keypad folds itself away this long after the last key, once the amount covers the total. */
export const FOLD_MS = 1500;
/** Keys for the tenders that need no amount. Digits are the amount; Enter takes it. */
const TENDER_KEYS: Record<string, Tender> = { b: 'transfer', c: 'card', q: 'qr' };

type Who = { at: 'none' } | { at: 'checking'; phone: string } | { at: 'known'; phone: string; customer: Greeting } | { at: 'new'; phone: string } | { at: 'away'; phone: string };

/**
 * Charge, inside the order panel: the cashier's eyes stay in one column from the order to the change.
 * The total and the big button stay where Charge was, so Enter, Enter is still exact cash.
 * The keypad is for touch only and folds away by itself; the keyboard types the amount without it.
 * With Customers on, a number starting 0 or + is a mobile (an amount never starts with 0), so it goes
 * to Mobile; any other digit is the cash given.
 */
export function PayPanel({ number, total, lines, onPay, onClose, customers: crmOn = false, customer, order, onPayPart }: Props) {
  // A customer on the order already: no Mobile field, and 0 is an amount key again.
  const customers = crmOn && !customer;
  const [typed, setTyped] = useState('');
  const [pad, setPad] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const mobile = useRef<HTMLInputElement>(null);
  const nameField = useRef<HTMLInputElement>(null);
  const [phoneTyped, setPhoneTyped] = useState('');
  /** A new number's name, if the customer gives it: kept with them as they pay. */
  const [nameTyped, setNameTyped] = useState('');
  const [who, setWho] = useState<Who>({ at: 'none' });
  // Split bill: picked units of this person; an order already part-paid opens split.
  const canSplit = Boolean(order && onPayPart && order.lines.reduce((n, l) => n + unitsLeft(order, l), 0) > 1);
  const [splitting, setSplitting] = useState(Boolean(order?.parts?.length) && canSplit);
  const [pick, setPick] = useState<Pick>({});
  const picked = splitting && order ? cleanPick(order, pick) : {};
  const pickedAny = Object.keys(picked).length > 0;
  /** A part, not the rest: what the picked items come to. Nothing picked = the rest of the order. */
  const partly = Boolean(order && pickedAny && !picksAllLeft(order, picked));
  const due = order && pickedAny ? pickAmount(order, picked) : total;
  const amount = parseLKR(typed);
  const enough = amount !== null && amount >= due;
  const toggleSplit = () => { setSplitting((v) => !v); setPick({}); };
  /** A tap adds one more unit of the line; past the units left it goes back to none. */
  const tapLine = (l: OrderLine) => {
    if (!order) return;
    const left = unitsLeft(order, l);
    setPick((p) => { const n = (p[l.id] ?? 0) + 1; return { ...p, [l.id]: n > left ? 0 : n }; });
  };

  // Letters: a name, so the list is searched by name and a match is picked (by id), never made.
  const search = useNameSearch(phoneTyped, customers);
  const [chosen, setChosen] = useState<Greeting | null>(null);
  const typePhone = (t: string) => { setPhoneTyped(t); setChosen(null); };
  const pickByName = (m: Greeting) => { rememberName(m); setChosen({ id: m.id, name: m.name }); field.current?.focus(); };
  // Who this number is, looked up as soon as it is a whole mobile number. Nothing is made yet.
  const check = customers && !search.byName ? toLkMobile(phoneTyped) : null;
  const phone = check && 'phone' in check ? check.phone : null;
  useEffect(() => {
    setNameTyped(''); // a name belongs to the number it was typed for
    if (!phone) { setWho({ at: 'none' }); return; }
    let live = true;
    setWho({ at: 'checking', phone });
    crmClient.lookup(phone).then(
      (r) => { if (live) setWho(r.customer ? { at: 'known', phone, customer: r.customer } : { at: 'new', phone }); },
      () => { if (live) setWho({ at: 'away', phone }); },
    );
    return () => { live = false; };
  }, [phone]);
  const isNew = who.at === 'new' && who.phone === phone;

  /** The sale goes in now; a new number becomes a customer first (a moment on this PC), never holding the sale up for long. */
  const pay = async (tender: Tender, tendered: Cents) => {
    // One person of a split: their part goes in, and the panel is ready for the next person.
    const done: Props['onPay'] = partly && onPayPart
      ? (t, given, id, unlinked) => { onPayPart(t, given, picked, id, unlinked); setPick({}); setTyped(''); setPad(false); field.current?.focus(); }
      : onPay;
    if (customer) { done(tender, tendered, customer.id); return; }
    if (chosen) { done(tender, tendered, chosen.id); return; }
    if (!phone) { done(tender, tendered); return; }
    if (who.at === 'known' && who.phone === phone) { done(tender, tendered, who.customer.id); return; }
    const name = isNew ? nameTyped.trim() : '';
    try {
      const r = await (name ? crmClient.ensure(phone, name) : crmClient.ensure(phone));
      done(tender, tendered, r.customer.id);
    } catch {
      done(tender, tendered, undefined, true);
    }
  };

  const take = () => {
    if (!typed) void pay('cash', due);
    else if (enough) void pay('cash', amount);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const inName = customers && e.target === nameField.current;
      const inMobile = customers && (e.target === mobile.current || inName);
      if (e.key === 'Escape') {
        // Picking: Esc clears the pick, then leaves Split, then closes.
        if (!typed && !pad && !phoneTyped && pickedAny) { setPick({}); return; }
        if (!typed && !pad && !phoneTyped && splitting && !order?.parts?.length) { setSplitting(false); return; }
        if (!typed && !pad && !phoneTyped) { onClose(); return; }
        setTyped('');
        setPad(false);
        typePhone('');
        setNameTyped('');
        field.current?.focus();
        return;
      }
      // A focused button answers Enter itself (Take, a quick amount, Bank...).
      if (e.key === 'Enter') {
        // A picked item keeps its focus, but Enter is still the money: Space picks.
        if (e.target instanceof HTMLButtonElement && !e.target.classList.contains('splitrow')) return;
        e.preventDefault();
        // Enter in Mobile goes to Name for a new number, else back to the amount; Enter in Name goes
        // to the amount. Either way the next Enter pays.
        if (inMobile && !inName && isNew) { nameField.current?.focus(); return; }
        // A name: Enter takes the highlighted customer.
        if (inMobile && !inName && search.byName && !chosen && search.matches.length) { pickByName(search.matches[search.sel]); return; }
        if (inMobile) { field.current?.focus(); return; }
        take();
        return;
      }
      if (inMobile && !inName && !chosen && search.move(e.key)) { e.preventDefault(); return; }
      if (inMobile) return; // Mobile and Name type their own keys (B, C, Q are letters of a name too)
      if (e.key.toLowerCase() === 's' && canSplit) { e.preventDefault(); toggleSplit(); return; }
      // Picking: the arrows walk the items, Space picks one (the button answers itself); Enter still takes the money.
      if (splitting && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        const rows = [...document.querySelectorAll<HTMLButtonElement>('.splitrow:not(:disabled)')];
        if (!rows.length) return;
        e.preventDefault();
        const i = rows.indexOf(document.activeElement as HTMLButtonElement);
        rows[i < 0 ? 0 : (i + (e.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length].focus();
        return;
      }
      const tender = TENDER_KEYS[e.key.toLowerCase()];
      if (tender) { e.preventDefault(); void pay(tender, due); return; }
      // A mobile number starts 0 or +; an amount never does.
      if (customers && !typed && /^[0+]$/.test(e.key)) {
        e.preventDefault();
        mobile.current?.focus();
        typePhone(phoneTyped + e.key);
        return;
      }
      // Digits go straight to the amount: the cashier just starts typing what the customer gave.
      if (/^\d$/.test(e.key) && e.target !== field.current) {
        e.preventDefault();
        field.current?.focus();
        setTyped((t) => t + e.key);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // Typed enough on the keypad: a moment later it folds away, and the order and the change are in view again.
  useEffect(() => {
    if (!pad || !enough) return;
    const t = setTimeout(() => setPad(false), FOLD_MS);
    return () => clearTimeout(t);
  }, [pad, enough, typed]);

  const pressPad = (key: string) => {
    setTyped((t) => {
      if (key === '⌫') return t.slice(0, -1);
      if (!t && key.startsWith('0')) return t; // no leading zeros
      return (t + key).slice(0, 9);
    });
    field.current?.focus(); // so Enter takes the amount, not the last key pressed again
  };

  const quick = quickCashAmounts(due).filter((a) => a > due).slice(0, 4);
  const change = enough ? amount - due : 0;
  const note = !typed ? { label: partly ? 'Their part' : order?.parts?.length ? 'Left to pay' : 'Total', big: fmt(due), tone: '' }
    : amount === null ? { label: 'Check the amount', big: '', tone: ' payfoot__note--short' }
    : enough ? { label: 'Change', big: fmt(change), tone: ' payfoot__note--change' }
    : { label: 'Short', big: fmt(due - amount), tone: ' payfoot__note--short' };
  const hint = !customers || !phoneTyped.trim() ? null
    : search.byName ? (chosen ? `${chosen.name ?? 'Customer'} · on the list`
      : search.found.at === 'found' ? (search.matches.length ? null : 'No one by that name: type their mobile')
        : search.found.at === 'away' ? 'The list is not answering: the sale still goes in'
          : search.found.at === 'looking' ? 'Looking…' : 'Keep typing the name')
    : !phone ? (check && 'reason' in check && phoneTyped.replace(/\D/g, '').length >= 9 ? check.reason : 'like 077 123 4567')
      : who.at === 'known' ? (who.customer.name ? `${who.customer.name} · on the list` : 'On the list')
        : who.at === 'new' ? (nameTyped.trim() ? `New customer: ${nameTyped.trim()}, added as they pay` : 'New customer: added as they pay')
          : who.at === 'away' ? 'The list is not answering: the sale still goes in' : 'Looking…';

  return (
    <section className="pay" aria-label="Payment">
      <div className="panel__no num">
        <span>{number}<span className="status status--paying">Paying</span></span>
        <span className="pay__head">
          {canSplit && (
            <button type="button" className={`panel__back${splitting ? ' panel__back--on' : ''}`} aria-pressed={splitting} aria-keyshortcuts="S" onClick={toggleSplit}>
              Split bill <kbd>S</kbd>
            </button>
          )}
          <button type="button" className="panel__back" aria-keyshortcuts="Escape" onClick={onClose}>Back to order <kbd>Esc</kbd></button>
        </span>
      </div>

      <div className="pay__body">
        {order?.parts?.length ? (
          <div className="pay__summary num" aria-live="polite">Paid {fmt(paidSoFar(order))} · {fmt(total)} left</div>
        ) : null}
        {pad
          ? <div className="pay__summary num">{partly ? 'Their part' : 'Total'} {fmt(due)}</div>
          : splitting && order ? (
            <ul className="paylines splitlines num" aria-label="Tap this person's items">
              {order.lines.map((l) => {
                const left = unitsLeft(order, l);
                const n = picked[l.id] ?? 0;
                return (
                  <li key={l.id}>
                    <button type="button" className={`splitrow${n ? ' splitrow--on' : ''}`} disabled={left === 0} aria-pressed={n > 0} onClick={() => tapLine(l)}>
                      <span className="splitrow__tick" aria-hidden="true">{left === 0 ? '' : n ? (left > 1 ? `${n}/${left}` : '✓') : ''}</span>
                      <span className="paylines__name">
                        {l.qty > 1 ? `${l.qty} × ` : ''}{lineItemName(l)}
                        {left === 0 ? <small>Paid</small> : left < l.qty ? <small>{l.qty - left} paid</small> : null}
                      </span>
                      <span>{fmt(lineNet(order, l))}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : lines}

        {/* The controls sit on the bottom, by the thumb and the big button; the keypad opens upward into the free room. */}
        <div className="pay__controls">
          {customer && <div className="paymobile"><span className="paymobile__who paymobile__who--known">{customer.name ?? 'Customer'} · on the list</span></div>}
          {customers && !pad && (
            <div className="paymobile">
              <label className="payfield">
                <span className="payfield__label">Mobile or name <span className="payfield__optional">optional</span></span>
                <input
                  ref={mobile} className="payfield__input num" autoComplete="off" value={phoneTyped}
                  placeholder="077 123 4567 or a name" onChange={(e) => typePhone(e.target.value)}
                />
              </label>
              {/* A number the list does not know: its name, if they give it (Enter from Mobile lands here). */}
              {isNew && (
                <label className="payfield">
                  <span className="payfield__label">Name <span className="payfield__optional">if they give it</span></span>
                  <input
                    ref={nameField} className="payfield__input" autoComplete="off" maxLength={60} value={nameTyped}
                    placeholder="Enter, then the name" onChange={(e) => setNameTyped(e.target.value)}
                  />
                </label>
              )}
              {search.byName && !chosen && <NameMatches matches={search.matches} sel={search.sel} onPick={pickByName} />}
              {hint && <span className={`paymobile__who${who.at === 'known' || chosen ? ' paymobile__who--known' : ''}`} aria-live="polite">{hint}</span>}
            </div>
          )}

          <div className={`payfield${pad ? ' payfield--on' : ''}`}>
            <input
              ref={field}
              className="payfield__input num"
              inputMode="none"
              autoComplete="off"
              maxLength={12}
              placeholder="Other amount"
              aria-label="Other amount"
              value={typed}
              onClick={() => setPad(true)}
              onChange={(e) => setTyped(e.target.value.replace(/[^\d.,]/g, ''))}
            />
            <button type="button" className="payfield__toggle" aria-expanded={pad} onClick={() => { setPad(!pad); field.current?.focus(); }}>
              {pad ? 'Hide' : 'Keypad'}
            </button>
          </div>

          {pad && (
            <div className="pay__pad num">
              {PAD_KEYS.map((k) => (
                <button key={k} type="button" className="paykey" onClick={() => pressPad(k)} aria-label={k === '⌫' ? 'Delete' : k}>{k}</button>
              ))}
            </div>
          )}

          {!pad && quick.length > 0 && (
            <div className="pay__quick num" role="group" aria-label="Cash given">
              {quick.map((a) => (
                // Each tile says the change it means, so the cashier reads it before the tap.
                <button key={a} type="button" className="paykey paykey--solid paykey--cash" aria-label={fmt(a)} onClick={() => void pay('cash', a)}>
                  <span aria-hidden="true">{fmt(a)}</span>
                  <small aria-hidden="true">Change {fmt(a - due)}</small>
                </button>
              ))}
            </div>
          )}

          <div className="pay__other">
            <button type="button" className="paykey paykey--solid" aria-label="Bank transfer" onClick={() => void pay('transfer', due)}>Bank <kbd aria-hidden="true">B</kbd></button>
            <button type="button" className="paykey paykey--solid" aria-label="Card" onClick={() => void pay('card', due)}>Card <kbd aria-hidden="true">C</kbd></button>
            <button type="button" className="paykey paykey--solid" aria-label="QR" onClick={() => void pay('qr', due)}>QR <kbd aria-hidden="true">Q</kbd></button>
          </div>
        </div>
      </div>

      <div className="panel__foot">
        <div className={`payfoot__note${note.tone}`} role="status">
          <span>{note.label}</span>{note.big && <>{' '}<b className="num">{note.big}</b></>}
        </div>
        {typed && enough && (
          <div className="payfoot__sub num"><span>Cash {fmt(amount)}</span><span>{partly ? 'Their part' : 'Total'} {fmt(due)}</span></div>
        )}
        <button type="button" className="cta num" autoFocus disabled={Boolean(typed) && !enough} onClick={take}>
          {!typed ? `Exact cash ${fmt(due)}` : enough ? `Take ${fmt(amount)}` : 'Take'}
        </button>
      </div>
    </section>
  );
}
