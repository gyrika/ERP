import { useEffect, useRef, useState } from 'react';
import { fmt, quickCashAmounts } from '../domain/money.ts';
import { toLkMobile } from '../domain/phone.ts';
import type { Cents, Tender } from '../domain/types.ts';
import { crmClient, type Greeting } from '../services/crmClient.ts';

interface Props {
  total: Cents;
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

type Who = { at: 'none' } | { at: 'checking'; phone: string } | { at: 'known'; phone: string; customer: Greeting } | { at: 'new'; phone: string } | { at: 'away'; phone: string };

export function PaySheet({ total, onPay, onClose, customers = false }: Props) {
  const mobile = useRef<HTMLInputElement>(null);
  const exactRef = useRef<HTMLButtonElement>(null);
  const [typed, setTyped] = useState('');
  const [who, setWho] = useState<Who>({ at: 'none' });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return; }
      // Typing a number anywhere on the sheet goes into Mobile: no hunting for the box.
      if (customers && /^[0-9+]$/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey
        && !(document.activeElement instanceof HTMLInputElement)) mobile.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, customers]);

  // Who this number is, looked up as soon as it is a whole mobile number. Nothing is made yet.
  const check = customers ? toLkMobile(typed) : null;
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

  const [exact, ...more] = quickCashAmounts(total);
  const hint = !customers || !typed.trim() ? null
    : !phone ? (check && 'reason' in check && typed.replace(/\D/g, '').length >= 9 ? check.reason : 'like 077 123 4567')
      : who.at === 'known' ? (who.customer.name ? `${who.customer.name} · on the list` : 'On the list')
        : who.at === 'new' ? 'New customer: added as they pay'
          : who.at === 'away' ? 'The list is not answering: the sale still goes in' : 'Looking…';

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="sheet" role="dialog" aria-modal="true" aria-label="Payment">
        <div className="sheet__body">
          <div className="sheet__title">
            <h1 className="pay-total num">{fmt(total)}</h1>
          </div>

          {customers && (
            <section className="group pay-customer">
              <label className="pay-customer__field">
                <span>Mobile <span className="pay-customer__optional">optional</span></span>
                <input
                  ref={mobile} className="num" inputMode="tel" autoComplete="off" value={typed} placeholder="077 123 4567"
                  onChange={(e) => setTyped(e.target.value)}
                  // Enter: back to Exact, so a second Enter pays.
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); exactRef.current?.focus(); } }}
                />
              </label>
              {hint && <span className={`pay-customer__who${who.at === 'known' ? ' pay-customer__who--known' : ''}`} aria-live="polite">{hint}</span>}
            </section>
          )}

          <section className="group">
            <h2>Cash</h2>
            <div className="chips">
              <button ref={exactRef} type="button" className="chip chip--solid num" autoFocus onClick={() => void pay('cash', exact)}>
                Exact · {fmt(exact)}
              </button>
              {more.map((a) => (
                <button key={a} type="button" className="chip chip--solid num" onClick={() => void pay('cash', a)}>
                  {fmt(a)}
                </button>
              ))}
            </div>
          </section>

          <section className="group">
            <h2>Other</h2>
            <div className="chips">
              <button type="button" className="chip chip--solid" onClick={() => void pay('transfer', total)}>Bank transfer</button>
              <button type="button" className="chip chip--solid" onClick={() => void pay('card', total)}>Card</button>
              <button type="button" className="chip chip--solid" onClick={() => void pay('qr', total)}>QR</button>
            </div>
          </section>
        </div>
        <div className="sheet__foot" />
      </div>
    </>
  );
}
