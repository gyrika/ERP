import { useEffect, useRef, useState, type ReactNode } from 'react';
import { canTakeCredit, type CreditAccount } from '../domain/credit.ts';
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
  onPay: (tender: Tender, tendered: Cents, customerId?: string, unlinked?: boolean, payBack?: Cents) => void;
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
  /**
   * Credit (credit.ts), with Customers on: a customer's credit, from the log. Gives the Credit key,
   * and for someone who owes, "Add to this payment" (their credit paid back with this bill:
   * `onPay`'s `payBack`, which `tendered` includes).
   */
  creditOf?: (customerId: string) => { setting: CreditAccount['setting']; owes: CreditAccount['owes'] };
  /** Manager mode is on: a bill may go past a customer's credit limit. */
  managerOn?: boolean;
  /**
   * Paying credit back (credit.ts): `total` is what they owe and less is fine (part of it), so the
   * amount typed is what they pay; no Credit key, no Split. `title` replaces the order number.
   */
  repay?: { title: string };
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
export function PayPanel({ number, total, lines, onPay, onClose, customers: crmOn = false, customer, order, onPayPart, creditOf, managerOn = false, repay }: Props) {
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
  const canSplit = Boolean(!repay && order && onPayPart && order.lines.reduce((n, l) => n + unitsLeft(order, l), 0) > 1);
  const [splitting, setSplitting] = useState(Boolean(order?.parts?.length) && canSplit);
  const [pick, setPick] = useState<Pick>({});
  const picked = splitting && order ? cleanPick(order, pick) : {};
  const pickedAny = Object.keys(picked).length > 0;
  /** A part, not the rest: what the picked items come to. Nothing picked = the rest of the order. */
  const partly = Boolean(order && pickedAny && !picksAllLeft(order, picked));
  const billDue = order && pickedAny ? pickAmount(order, picked) : total;
  // Their credit paid back with this bill (credit.ts): added to what is due, on one tap.
  const [adding, setAdding] = useState(false);
  const amount = parseLKR(typed);
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
  const typePhone = (t: string) => { setPhoneTyped(t); setChosen(null); setAddedNote(null); };
  const pickByName = (m: Greeting) => { rememberName(m); setChosen({ id: m.id, name: m.name }); field.current?.focus(); };
  // Who this number is, looked up as soon as it is a whole mobile number. Nothing is made yet.
  const mobileCheck = customers && !search.byName ? toLkMobile(phoneTyped) : null;
  const phone = mobileCheck && 'phone' in mobileCheck ? mobileCheck.phone : null;
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

  // New customer, on purpose (the cashier's + New): mobile and name, added now; the payment is then theirs.
  const [adder, setAdder] = useState<{ phone: string; name: string; state: 'typing' | 'saving' | string } | null>(null);
  const newMobile = useRef<HTMLInputElement>(null);
  const newName = useRef<HTMLInputElement>(null);
  /** Opens the form with what was typed: digits are the mobile, letters the name. */
  const openAdder = () => {
    const t = phoneTyped.trim();
    const letters = /\p{L}/u.test(t);
    setAdder({ phone: letters ? '' : t, name: letters ? t : '', state: 'typing' });
    setTimeout(() => (letters || !t ? newMobile : newName).current?.focus(), 0);
  };
  const addNew = async () => {
    if (!adder || adder.state === 'saving') return;
    const m = toLkMobile(adder.phone);
    if (!('phone' in m)) { setAdder({ ...adder, state: adder.phone.trim() ? m.reason : 'Type their mobile, like 077 123 4567' }); newMobile.current?.focus(); return; }
    setAdder({ ...adder, state: 'saving' });
    try {
      const r = await crmClient.ensure(m.phone, adder.name.trim() || undefined);
      setPhoneTyped(adder.phone.trim());
      setChosen({ id: r.customer.id, name: r.customer.name });
      setAddedNote(r.created ? 'added' : 'already on the list');
      setAdder(null);
      field.current?.focus();
    } catch {
      setAdder((a) => a && { ...a, state: 'Not added: the shop PC did not answer. Add again, or pay without' });
    }
  };
  const [addedNote, setAddedNote] = useState<string | null>(null);

  // Whose payment this is, once known: on the order, picked by name, or a number the list knows.
  const payerId = customer?.id ?? chosen?.id ?? (who.at === 'known' && who.phone === phone ? who.customer.id : null);
  const account = !repay && creditOf && payerId ? creditOf(payerId) : null;
  const owes = account && account.owes > 0 && !splitting ? account.owes : 0;
  const addingNow = adding && owes > 0;
  const due = billDue + (addingNow ? owes : 0);
  // Paying credit back: any amount up to what they owe (more is change).
  const enough = amount !== null && (repay ? amount > 0 : amount >= due);
  const check = account ? canTakeCredit(account, billDue) : null;
  const creditOk = Boolean(check && (check.ok || (check.why === 'over' && managerOn)));
  const creditWhy = !crmOn || repay ? null
    : !payerId ? 'Add customer'
      : !check ? '' : check.ok ? (account!.setting!.limit === null ? 'No limit' : `Rs ${fmt(account!.setting!.limit - account!.owes)} left`)
        : check.why === 'off' ? 'No credit' : managerOn ? `Over by ${fmt(check.over)} · manager` : `Over limit by ${fmt(check.over)}`;
  /** Bank, card and QR: what is due, or (paying back) the part typed. */
  const nonCash = repay && typed && enough ? amount : due;

  /** The sale goes in now; a new number becomes a customer first (a moment on this PC), never holding the sale up for long. */
  const pay = async (tender: Tender, tendered: Cents) => {
    // One person of a split: their part goes in, and the panel is ready for the next person.
    // Credit paid back with the bill rides along (never when the bill itself goes on credit).
    const back = addingNow && tender !== 'credit' ? owes : undefined;
    const done: Props['onPay'] = partly && onPayPart
      ? (t, given, id, unlinked) => { onPayPart(t, given, picked, id, unlinked); setPick({}); setTyped(''); setPad(false); field.current?.focus(); }
      : (...args) => (back ? onPay(args[0], args[1], args[2], args[3], back) : onPay(...args));
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
      // The New customer form types its own keys; Enter adds, Esc closes it.
      if (adder && (e.target === newMobile.current || e.target === newName.current)) {
        if (e.key === 'Enter') { e.preventDefault(); if (e.target === newMobile.current && !adder.name) newName.current?.focus(); else void addNew(); }
        if (e.key === 'Escape') { e.preventDefault(); setAdder(null); mobile.current?.focus(); }
        return;
      }
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
      if (e.key.toLowerCase() === 'r' && creditOk) { e.preventDefault(); void pay('credit', billDue); return; }
      const tender = TENDER_KEYS[e.key.toLowerCase()];
      if (tender) { e.preventDefault(); void pay(tender, nonCash); return; }
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
  const change = enough ? Math.max(0, amount - due) : 0;
  const note = !typed ? { label: repay ? 'Owes' : partly ? 'Their part' : addingNow ? 'Bill + credit' : order?.parts?.length ? 'Left to pay' : 'Total', big: fmt(due), tone: '' }
    : amount === null ? { label: 'Check the amount', big: '', tone: ' payfoot__note--short' }
    : repay && amount < due ? { label: 'Still owes after', big: fmt(due - amount), tone: '' }
    : enough ? { label: 'Change', big: fmt(change), tone: ' payfoot__note--change' }
    : { label: 'Short', big: fmt(due - amount), tone: ' payfoot__note--short' };
  const hint = !customers || !phoneTyped.trim() || adder ? null
    : chosen && addedNote ? `${chosen.name ?? 'Customer'} · ${addedNote}`
    : search.byName ? (chosen ? `${chosen.name ?? 'Customer'} · on the list`
      : search.found.at === 'found' ? (search.matches.length ? null : 'No one by that name: type their mobile')
        : search.found.at === 'away' ? 'The list is not answering: the sale still goes in'
          : search.found.at === 'looking' ? 'Looking…' : 'Keep typing the name')
    : !phone ? (mobileCheck && 'reason' in mobileCheck && phoneTyped.replace(/\D/g, '').length >= 9 ? mobileCheck.reason : 'like 077 123 4567')
      : who.at === 'known' ? (who.customer.name ? `${who.customer.name} · on the list` : 'On the list')
        : who.at === 'new' ? (nameTyped.trim() ? `New customer: ${nameTyped.trim()}, added as they pay` : 'New customer: added as they pay')
          : who.at === 'away' ? 'The list is not answering: the sale still goes in' : 'Looking…';

  return (
    <section className="pay" aria-label="Payment">
      <div className="panel__no num">
        <span>{repay ? repay.title : number}<span className="status status--paying">{repay ? 'Paying back' : 'Paying'}</span></span>
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
          {customer && !repay && <div className="paymobile"><span className="paymobile__who paymobile__who--known">{customer.name ?? 'Customer'} · on the list</span></div>}
          {owes > 0 && !partly && (
            // They owe on credit: one tap pays it back with this bill (credit.ts).
            <button type="button" className={`paycredit${addingNow ? ' paycredit--on' : ''}`} aria-pressed={addingNow} onClick={() => setAdding((v) => !v)}>
              <span className="num">Owes {fmt(owes)} on credit</span>
              <b>{addingNow ? 'Added to this payment' : 'Add to this payment'}</b>
            </button>
          )}
          {customers && !pad && (
            <div className="paymobile">
              <div className="payfield payfield--search">
                <label className="payfield__find">
                  {/* Search: a mobile finds them, a name lists who it may be. */}
                  <svg className="payfield__icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                    <circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" strokeWidth="2" />
                    <path d="M16 16l4.5 4.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  </svg>
                  <span className="payfield__label">Customer <span className="payfield__optional">optional</span></span>
                  <input
                    ref={mobile} className="payfield__input num" autoComplete="off" value={phoneTyped} aria-label="Mobile or name"
                    placeholder="Search mobile or name" onChange={(e) => typePhone(e.target.value)}
                  />
                </label>
                <button type="button" className="payfield__toggle payfield__new" aria-expanded={Boolean(adder)} onClick={() => (adder ? setAdder(null) : openAdder())}>
                  {adder ? 'Cancel' : '+ New customer'}
                </button>
              </div>
              {adder && (
                <div className="paynew" role="group" aria-label="New customer">
                  <label className="payfield">
                    <span className="payfield__label">Mobile</span>
                    <input ref={newMobile} className="payfield__input num" inputMode="tel" autoComplete="off" value={adder.phone} placeholder="077 123 4567"
                      onChange={(e) => setAdder({ ...adder, phone: e.target.value, state: 'typing' })} />
                  </label>
                  <label className="payfield">
                    <span className="payfield__label">Name</span>
                    <input ref={newName} className="payfield__input" autoComplete="off" maxLength={60} value={adder.name} placeholder="Their name"
                      onChange={(e) => setAdder({ ...adder, name: e.target.value, state: 'typing' })} />
                  </label>
                  <button type="button" className="paykey paykey--solid paynew__add" disabled={adder.state === 'saving'} onClick={() => void addNew()}>
                    {adder.state === 'saving' ? 'Adding…' : 'Add customer'} <kbd aria-hidden="true">Enter</kbd>
                  </button>
                  {adder.state !== 'typing' && adder.state !== 'saving' && <span className="paymobile__who paynew__why" role="alert">{adder.state}</span>}
                </div>
              )}
              {/* A number the list does not know: its name, if they give it (Enter from Mobile lands here). */}
              {isNew && !chosen && !adder && (
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
            <button type="button" className="paykey paykey--solid" aria-label="Bank transfer" onClick={() => void pay('transfer', nonCash)}>Bank <kbd aria-hidden="true">B</kbd></button>
            <button type="button" className="paykey paykey--solid" aria-label="Card" onClick={() => void pay('card', nonCash)}>Card <kbd aria-hidden="true">C</kbd></button>
            <button type="button" className="paykey paykey--solid" aria-label="QR" onClick={() => void pay('qr', nonCash)}>QR <kbd aria-hidden="true">Q</kbd></button>
            {creditWhy !== null && (
              // Always there with Customers on, greyed with the reason when it cannot be used (credit.ts).
              <button type="button" className="paykey paykey--solid paykey--credit" aria-label="Credit" disabled={!creditOk} onClick={() => void pay('credit', billDue)}>
                <span>Credit <kbd aria-hidden="true">R</kbd></span>
                {creditWhy && <small>{creditWhy}</small>}
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="panel__foot">
        <div className={`payfoot__note${note.tone}`} role="status">
          <span>{note.label}</span>{note.big && <>{' '}<b className="num">{note.big}</b></>}
        </div>
        {typed && enough && (
          <div className="payfoot__sub num"><span>Cash {fmt(amount)}</span><span>{repay ? 'Owes' : partly ? 'Their part' : 'Total'} {fmt(due)}</span></div>
        )}
        <button type="button" className="cta num" autoFocus disabled={Boolean(typed) && !enough} onClick={take}>
          {!typed ? `${repay ? 'All in cash' : 'Exact cash'} ${fmt(due)}` : enough ? `Take ${fmt(amount)}` : 'Take'}
        </button>
      </div>
    </section>
  );
}
