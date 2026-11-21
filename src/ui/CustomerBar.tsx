import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { toLkMobile } from '../domain/phone.ts';
import { fmt } from '../domain/money.ts';
import type { Cents, OrderCustomer } from '../domain/types.ts';
import type { Usual } from '../domain/usualOrder.ts';
import { crmClient, rememberName, type Greeting } from '../services/crmClient.ts';
import { NameMatches, useNameSearch } from './useNameSearch.tsx';

interface Props {
  customer?: OrderCustomer;
  /** Non-null while the cashier types a number (it may start with the key that opened it). */
  typing: string | null;
  onTyping: (text: string | null) => void;
  onAttach: (customer: OrderCustomer) => void;
  onRemove: () => void;
  /** How many times this customer has paid before (from the event log). */
  visits: (id: string) => number;
  /** Offered while the order is still empty. */
  usual: Usual | null;
  onUsual: () => void;
  /** What "the usual" holds, in a few words. */
  describeUsual: (u: Usual) => string;
  /** What this customer owes on credit (credit.ts, from the log); 0 for none. */
  owes?: (id: string) => Cents;
  /** They came to pay their credit back: Charge opens for it. */
  onTakePayment?: (customer: OrderCustomer) => void;
}

type Who =
  | { at: 'none' } | { at: 'checking'; phone: string } | { at: 'known'; phone: string; customer: Greeting }
  | { at: 'new'; phone: string } | { at: 'away'; phone: string };

const ordinal = (n: number): string => {
  const s = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th';
  return `${n}${s}`;
};

/**
 * The customer on the order (CRM), in the order panel under the order number. The cashier types the
 * mobile (or just presses 0 on the Register): a number the list knows is greeted by name, a new one
 * becomes a customer with Enter, a name if they give one. The customer list stays on the shop PC
 * (crmClient); this screen is told only the id and the first name. No customer is fine: Esc.
 */
export function CustomerBar({ customer, typing, onTyping, onAttach, onRemove, visits, usual, onUsual, describeUsual, owes = () => 0, onTakePayment }: Props) {
  const phoneRef = useRef<HTMLInputElement>(null);
  const usualRef = useRef<HTMLButtonElement>(null);
  const [name, setName] = useState('');
  const [who, setWho] = useState<Who>({ at: 'none' });
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);

  const text = typing ?? '';
  // Letters: a name, so the list is searched by name and Enter (or a tap) puts the match on.
  const search = useNameSearch(text, typing !== null);
  const check = typing !== null && !search.byName ? toLkMobile(text) : null;
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

  useEffect(() => { if (typing === null) { setName(''); setFailed(false); } }, [typing]);

  // Just put on an empty order: "the usual" takes Enter.
  const offered = Boolean(customer && usual);
  useEffect(() => { if (offered) usualRef.current?.focus(); }, [offered, customer?.id]);

  const attach = async () => {
    if (saving || !phone) return;
    if (who.at === 'known' && who.phone === phone) { onAttach(who.customer); onTyping(null); return; }
    if (who.at !== 'new' || who.phone !== phone) return;
    setSaving(true);
    try {
      const r = await crmClient.ensure(phone, name.trim() || undefined);
      onAttach(r.customer);
      onTyping(null);
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  };

  const pickByName = (m: Greeting) => { rememberName(m); onAttach({ id: m.id, name: m.name }); onTyping(null); };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onTyping(null); return; }
    if (search.byName && search.move(e.key)) { e.preventDefault(); e.stopPropagation(); return; }
    if (e.key === 'Enter' && search.byName) {
      e.preventDefault(); e.stopPropagation();
      if (search.matches.length) pickByName(search.matches[search.sel]);
      return;
    }
    if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); void attach(); }
  };

  if (typing !== null) {
    const hint = !text.trim() ? 'Their mobile, like 077 123 4567, or their name'
      : search.byName ? (search.found.at === 'found' ? (search.matches.length ? null : 'No one by that name: type their mobile')
        : search.found.at === 'away' ? 'The customer list is not answering. Esc to go on without'
          : search.found.at === 'looking' ? 'Looking…' : 'Keep typing the name')
      : !phone ? (check && 'reason' in check && text.replace(/\D/g, '').length >= 9 ? check.reason : 'Keep typing the mobile')
        : who.at === 'checking' ? 'Looking…'
          : who.at === 'away' ? 'The customer list is not answering. Esc to go on without'
            : failed ? 'Not saved: the shop PC did not answer. Enter to try again'
              : null;
    return (
      <div className="cust cust--open" onKeyDown={onKeyDown}>
        <label className="cust__label" htmlFor="cust-phone">Customer</label>
        <input
          id="cust-phone" ref={phoneRef} className="cust__phone num" autoComplete="off" autoFocus
          value={text} placeholder="077 123 4567 or a name" onChange={(e) => onTyping(e.target.value)}
        />
        {hint && <span className="cust__hint" aria-live="polite">{hint}</span>}
        {search.byName && <NameMatches matches={search.matches} sel={search.sel} onPick={pickByName} />}
        {who.at === 'known' && (
          <button type="button" className="cust__pick" onClick={() => void attach()}>
            <span className="cust__who">
              <b>{who.customer.name ?? 'On the list'}</b>
              <span className="num">{visits(who.customer.id) ? `${visits(who.customer.id)} ${visits(who.customer.id) === 1 ? 'visit' : 'visits'}` : 'No visits yet'}{owes(who.customer.id) > 0 ? ` · owes ${fmt(owes(who.customer.id))}` : ''}</span>
            </span>
            <kbd>Enter</kbd>
          </button>
        )}
        {who.at === 'new' && (
          <>
            {/* Straight after the number, so Tab goes to the name. */}
            <label className="cust__label" htmlFor="cust-name">Name, if they give it</label>
            <input
              id="cust-name" className="cust__name" autoComplete="off" maxLength={60} value={name}
              placeholder="Tab, then the name" onChange={(e) => setName(e.target.value)}
            />
            <button type="button" className="cust__pick" onClick={() => void attach()} disabled={saving}>
              <span className="cust__who"><b>{name.trim() ? `New customer: ${name.trim()}` : 'New customer'}</b><span className="num">{text.trim()}</span></span>
              <kbd>Enter</kbd>
            </button>
          </>
        )}
        <span className="cust__keys">Enter put on the order · Esc no customer</span>
      </div>
    );
  }

  if (customer) {
    const n = visits(customer.id);
    const due = owes(customer.id);
    return (
      <div className="cust">
        <div className="cust__on">
          <button type="button" className="cust__chip" onClick={() => onTyping('')} aria-label={`Customer ${customer.name ?? ''}: change`}>
            <b>{customer.name ?? 'Customer'}</b>
            <span className="num">{n ? `${ordinal(n + 1)} visit` : 'First visit'}</span>
          </button>
          <button type="button" className="cust__off" onClick={onRemove} aria-label="Take the customer off">×</button>
        </div>
        {due > 0 && (
          // On credit (credit.ts): what they owe is in sight before more goes on it; one tap takes it back.
          <div className="cust__owes">
            <span className="num">Owes <b>{fmt(due)}</b> on credit</span>
            {onTakePayment && <button type="button" className="cust__repay" onClick={() => onTakePayment(customer)}>Take payment</button>}
          </div>
        )}
        {usual && (
          <button type="button" ref={usualRef} className="cust__usual" onClick={onUsual}>
            <span className="cust__who">
              <b>{usual.kind === 'usual' ? 'The usual' : 'Same as last time'}</b>
              <span>{describeUsual(usual)}</span>
            </span>
            <kbd>Enter</kbd>
          </button>
        )}
      </div>
    );
  }

  // No customer yet: nothing on screen (owner, 2026-11-16). The mobile is asked at Charge; 0 on the
  // Register still opens this for someone who wants "the usual" before ordering.
  return null;
}
