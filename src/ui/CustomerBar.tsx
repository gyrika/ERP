import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { toLkMobile } from '../domain/phone.ts';
import { fmt } from '../domain/money.ts';
import type { Cents, OrderCustomer } from '../domain/types.ts';
import type { Usual } from '../domain/usualOrder.ts';
import { crmClient, rememberName, type Greeting } from '../services/crmClient.ts';
import { CustomerName, NameMatches, useNameSearch } from './useNameSearch.tsx';

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
 * (crmClient); this screen is told only the id, the full name and the nickname. No customer is fine: Esc.
 */
export function CustomerBar({ customer, typing, onTyping, onAttach, onRemove, visits, usual, onUsual, describeUsual, owes = () => 0, onTakePayment }: Props) {
  const phoneRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const usualRef = useRef<HTMLButtonElement>(null);
  const [name, setName] = useState('');
  const [nickname, setNickname] = useState('');
  const [who, setWho] = useState<Who>({ at: 'none' });
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  /** + New (the cashier adds someone on purpose): the mobile, then the name, both in sight at once. */
  const [adding, setAdding] = useState(false);

  const text = typing ?? '';
  // Letters: a name, so the list is searched by name and Enter (or a tap) puts the match on.
  const search = useNameSearch(text, typing !== null && !adding);
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

  useEffect(() => { if (typing === null) { setName(''); setNickname(''); setFailed(false); setAdding(false); } }, [typing]);

  // Just put on an empty order: "the usual" takes Enter.
  const offered = Boolean(customer && usual);
  useEffect(() => { if (offered) usualRef.current?.focus(); }, [offered, customer?.id]);

  const attach = async () => {
    if (saving || !phone) return;
    if (who.at === 'known' && who.phone === phone) { onAttach(who.customer); onTyping(null); return; }
    if (who.at !== 'new' || who.phone !== phone) return;
    setSaving(true);
    try {
      const r = await crmClient.ensure(phone, name.trim() || undefined, undefined, nickname.trim() || undefined);
      onAttach(r.customer);
      onTyping(null);
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  };

  const pickByName = (m: Greeting) => { rememberName(m); onAttach({ id: m.id, name: m.name, nickname: m.nickname ?? null }); onTyping(null); };
  /** Came only to pay their credit back: Charge opens for it from the search, no bill needed, the bill on screen untouched. */
  const repay = (c: Greeting) => { rememberName(c); onTakePayment?.({ id: c.id, name: c.name, nickname: c.nickname ?? null }); onTyping(null); };
  const repayButton = (c: Greeting) => {
    const due = owes(c.id);
    if (!onTakePayment || due <= 0) return null;
    return (
      <button type="button" className="cust__repay cust__repay--find" onMouseDown={(e) => e.preventDefault()} onClick={() => repay(c)}
        aria-label={`Take payment from ${c.name ?? 'this customer'}, owes ${fmt(due)}`}>
        Owes {fmt(due)} · Take payment
      </button>
    );
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onTyping(null); return; }
    if (search.byName && search.move(e.key)) { e.preventDefault(); e.stopPropagation(); return; }
    if (e.key === 'Enter' && search.byName) {
      e.preventDefault(); e.stopPropagation();
      if (search.matches.length) pickByName(search.matches[search.sel]);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault(); e.stopPropagation();
      // + New: Enter on the mobile goes on to the name (as at Charge); Enter on the name adds them.
      if (adding && e.target === phoneRef.current && who.at === 'new' && !name.trim()) { nameRef.current?.focus(); return; }
      void attach();
    }
  };

  if (typing !== null) {
    const hint = !text.trim() ? (adding ? 'Their mobile, like 077 123 4567' : 'Their mobile, like 077 123 4567, or their name')
      : search.byName ? (search.found.at === 'found' ? (search.matches.length ? null : 'No one by that name: type their mobile')
        : search.found.at === 'away' ? 'The customer list is not answering. Esc to go on without'
          : search.found.at === 'looking' ? 'Looking…' : 'Keep typing the name')
      : !phone ? (check && 'reason' in check && text.replace(/\D/g, '').length >= 9 ? check.reason : 'Keep typing the mobile')
        : who.at === 'checking' ? 'Looking…'
          : who.at === 'away' ? 'The customer list is not answering. Esc to go on without'
            : failed ? 'Not saved: the shop PC did not answer. Enter to try again'
              : adding && who.at === 'known' ? 'Already on the list'
                : null;
    return (
      <div className="cust cust--open" onKeyDown={onKeyDown}>
        <label className="cust__label" htmlFor="cust-phone">{adding ? 'New customer: mobile' : 'Customer'}</label>
        <input
          id="cust-phone" ref={phoneRef} className="cust__phone num" autoComplete="off" autoFocus
          inputMode={adding ? 'tel' : undefined}
          value={text} placeholder={adding ? '077 123 4567' : '077 123 4567 or a name'} onChange={(e) => onTyping(e.target.value)}
        />
        {hint && <span className="cust__hint" aria-live="polite">{hint}</span>}
        {search.byName && <NameMatches matches={search.matches} sel={search.sel} onPick={pickByName} extra={repayButton} />}
        {who.at === 'known' && (
          <div className="cust__found">
            <button type="button" className="cust__pick" onClick={() => void attach()}>
              <span className="cust__who">
                <span className="cust__names"><CustomerName name={who.customer.name} nickname={who.customer.nickname} fallback="On the list" /></span>
                <span className="num">{visits(who.customer.id) ? `${visits(who.customer.id)} ${visits(who.customer.id) === 1 ? 'visit' : 'visits'}` : 'No visits yet'}</span>
              </span>
              <kbd>Enter</kbd>
            </button>
            {repayButton(who.customer)}
          </div>
        )}
        {(who.at === 'new' || (adding && who.at !== 'known')) && (
          <>
            {/* Straight after the number, so Tab goes to the name. */}
            <label className="cust__label" htmlFor="cust-name">{adding ? 'Name' : 'Name, if they give it'}</label>
            <input
              id="cust-name" ref={nameRef} className="cust__name" autoComplete="off" maxLength={60} value={name}
              placeholder={adding ? 'Their name' : 'Tab, then the name'} onChange={(e) => setName(e.target.value)}
            />
            {/* What the shop calls them: the counter finds them by it next time (2026-11-25). */}
            <label className="cust__label" htmlFor="cust-nick">Nickname, if any</label>
            <input
              id="cust-nick" className="cust__name" autoComplete="off" maxLength={40} value={nickname}
              placeholder="What you call them" onChange={(e) => setNickname(e.target.value)}
            />
          </>
        )}
        {who.at === 'new' && (
          <>
            <button type="button" className="cust__pick" onClick={() => void attach()} disabled={saving}>
              <span className="cust__who"><b>{name.trim() || nickname.trim() ? `New customer: ${[name.trim(), nickname.trim() && `“${nickname.trim()}”`].filter(Boolean).join(' ')}` : 'New customer'}</b><span className="num">{text.trim()}</span></span>
              <kbd>Enter</kbd>
            </button>
          </>
        )}
        <span className="cust__keys">{adding ? 'Enter add them to the order · Esc cancel' : 'Enter put on the order · Esc no customer'}</span>
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
            <span className="cust__names"><CustomerName name={customer.name} nickname={customer.nickname} /></span>
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

  // No customer yet: one row, always in sight on an unpaid bill (Anton, 2026-11-21, replacing the
  // owner's "nothing on screen" of 2026-11-16): find someone (0 on the Register opens it too), or
  // + New to add someone on purpose. Searching is also how a customer who only came to pay credit
  // back is found: their row says what they owe, with Take payment.
  return (
    <div className="cust">
      <div className="cust__idle">
        <button type="button" className="cust__find" onClick={() => onTyping('')}>
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" strokeWidth="2" />
            <path d="M16 16l4.5 4.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
          <span>Customer <span className="cust__soft">mobile or name</span></span>
          <kbd aria-hidden="true">0</kbd>
        </button>
        <button type="button" className="cust__new" onClick={() => { setAdding(true); onTyping(''); }}>+ New</button>
      </div>
    </div>
  );
}
