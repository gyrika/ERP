import { useEffect, useRef, useState, type ReactNode } from 'react';
import { fmt, parseLKR, quickCashAmounts } from '../domain/money.ts';
import { toLkMobile } from '../domain/phone.ts';
import type { Cents, Tender } from '../domain/types.ts';
import { crmClient, type Greeting } from '../services/crmClient.ts';

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
export function PayPanel({ number, total, lines, onPay, onClose, customers = false }: Props) {
  const [typed, setTyped] = useState('');
  const [pad, setPad] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const mobile = useRef<HTMLInputElement>(null);
  const [phoneTyped, setPhoneTyped] = useState('');
  const [who, setWho] = useState<Who>({ at: 'none' });
  const amount = parseLKR(typed);
  const enough = amount !== null && amount >= total;

  // Who this number is, looked up as soon as it is a whole mobile number. Nothing is made yet.
  const check = customers ? toLkMobile(phoneTyped) : null;
  const phone = check && 'phone' in check ? check.phone : null;
  useEffect(() => {
    if (!phone) { setWho({ at: 'none' }); return; }
    let live = true;
    setWho({ at: 'checking', phone });
    crmClient.lookup(phone).then(
      (r) => { if (live) setWho(r.customer ? { at: 'known', phone, customer: r.customer } : { at: 'new', phone }); },
      () => { if (live) setWho({ at: 'away', phone }); },
    );
    return () => { live = false; };
  }, [phone]);

  /** The sale goes in now; a new number becomes a customer first (a moment on this PC), never holding the sale up for long. */
  const pay = async (tender: Tender, tendered: Cents) => {
    if (!phone) { onPay(tender, tendered); return; }
    if (who.at === 'known' && who.phone === phone) { onPay(tender, tendered, who.customer.id); return; }
    try {
      const r = await crmClient.ensure(phone);
      onPay(tender, tendered, r.customer.id);
    } catch {
      onPay(tender, tendered, undefined, true);
    }
  };

  const take = () => {
    if (!typed) void pay('cash', total);
    else if (enough) void pay('cash', amount);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const inMobile = customers && e.target === mobile.current;
      if (e.key === 'Escape') {
        if (!typed && !pad && !phoneTyped) { onClose(); return; }
        setTyped('');
        setPad(false);
        setPhoneTyped('');
        field.current?.focus();
        return;
      }
      // A focused button answers Enter itself (Take, a quick amount, Bank...).
      if (e.key === 'Enter') {
        if (e.target instanceof HTMLButtonElement) return;
        e.preventDefault();
        // Enter in Mobile goes back to the amount, so a second Enter pays.
        if (inMobile) { field.current?.focus(); return; }
        take();
        return;
      }
      if (inMobile) return; // Mobile types its own digits
      const tender = TENDER_KEYS[e.key.toLowerCase()];
      if (tender) { e.preventDefault(); void pay(tender, total); return; }
      // A mobile number starts 0 or +; an amount never does.
      if (customers && !typed && /^[0+]$/.test(e.key)) {
        e.preventDefault();
        mobile.current?.focus();
        setPhoneTyped((t) => t + e.key);
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

  const quick = quickCashAmounts(total).filter((a) => a > total).slice(0, 4);
  const change = enough ? amount - total : 0;
  const note = !typed ? { label: 'Total', big: fmt(total), tone: '' }
    : amount === null ? { label: 'Check the amount', big: '', tone: ' payfoot__note--short' }
    : enough ? { label: 'Change', big: fmt(change), tone: ' payfoot__note--change' }
    : { label: 'Short', big: fmt(total - amount), tone: ' payfoot__note--short' };
  const hint = !customers || !phoneTyped.trim() ? null
    : !phone ? (check && 'reason' in check && phoneTyped.replace(/\D/g, '').length >= 9 ? check.reason : 'like 077 123 4567')
      : who.at === 'known' ? (who.customer.name ? `${who.customer.name} · on the list` : 'On the list')
        : who.at === 'new' ? 'New customer: added as they pay'
          : who.at === 'away' ? 'The list is not answering: the sale still goes in' : 'Looking…';

  return (
    <section className="pay" aria-label="Payment">
      <div className="panel__no num">
        <span>{number}<span className="status status--paying">Paying</span></span>
        <button type="button" className="panel__back" onClick={onClose}>Back to order <kbd>Esc</kbd></button>
      </div>

      <div className="pay__body">
        {pad
          ? <div className="pay__summary num">Total {fmt(total)}</div>
          : lines}

        {/* The controls sit on the bottom, by the thumb and the big button; the keypad opens upward into the free room. */}
        <div className="pay__controls">
          {customers && !pad && (
            <div className="paymobile">
              <label className="payfield">
                <span className="payfield__label">Mobile <span className="payfield__optional">optional</span></span>
                <input
                  ref={mobile} className="payfield__input num" inputMode="tel" autoComplete="off" value={phoneTyped}
                  placeholder="077 123 4567" onChange={(e) => setPhoneTyped(e.target.value)}
                />
              </label>
              {hint && <span className={`paymobile__who${who.at === 'known' ? ' paymobile__who--known' : ''}`} aria-live="polite">{hint}</span>}
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
                <button key={a} type="button" className="paykey paykey--solid" onClick={() => void pay('cash', a)}>{fmt(a)}</button>
              ))}
            </div>
          )}

          <div className="pay__other">
            <button type="button" className="paykey paykey--solid" aria-label="Bank transfer" onClick={() => void pay('transfer', total)}>Bank <kbd aria-hidden="true">B</kbd></button>
            <button type="button" className="paykey paykey--solid" aria-label="Card" onClick={() => void pay('card', total)}>Card <kbd aria-hidden="true">C</kbd></button>
            <button type="button" className="paykey paykey--solid" aria-label="QR" onClick={() => void pay('qr', total)}>QR <kbd aria-hidden="true">Q</kbd></button>
          </div>
        </div>
      </div>

      <div className="panel__foot">
        <div className={`payfoot__note${note.tone}`} role="status">
          <span>{note.label}</span>{note.big && <>{' '}<b className="num">{note.big}</b></>}
        </div>
        {typed && enough && (
          <div className="payfoot__sub num"><span>Cash {fmt(amount)}</span><span>Total {fmt(total)}</span></div>
        )}
        <button type="button" className="cta num" autoFocus disabled={Boolean(typed) && !enough} onClick={take}>
          {!typed ? `Exact cash ${fmt(total)}` : enough ? `Take ${fmt(amount)}` : 'Take'}
        </button>
      </div>
    </section>
  );
}
