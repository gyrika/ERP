import { useEffect } from 'react';
import { fmt, quickCashAmounts } from '../domain/money.ts';
import type { Cents, Tender } from '../domain/types.ts';

interface Props {
  total: Cents;
  /** One tap completes the sale; there is no second confirmation, only Undo. */
  onPay: (tender: Tender, tendered: Cents) => void;
  onClose: () => void;
}

export function PaySheet({ total, onPay, onClose }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const [exact, ...more] = quickCashAmounts(total);

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="sheet" role="dialog" aria-modal="true" aria-label="Payment">
        <div className="sheet__body">
          <div className="sheet__title">
            <h1 className="pay-total num">{fmt(total)}</h1>
          </div>

          <section className="group">
            <h2>Cash</h2>
            <div className="chips">
              <button type="button" className="chip chip--solid num" autoFocus onClick={() => onPay('cash', exact)}>
                Exact · {fmt(exact)}
              </button>
              {more.map((a) => (
                <button key={a} type="button" className="chip chip--solid num" onClick={() => onPay('cash', a)}>
                  {fmt(a)}
                </button>
              ))}
            </div>
          </section>

          <section className="group">
            <h2>Other</h2>
            <div className="chips">
              <button type="button" className="chip chip--solid" onClick={() => onPay('transfer', total)}>Bank transfer</button>
              <button type="button" className="chip chip--solid" onClick={() => onPay('card', total)}>Card</button>
              <button type="button" className="chip chip--solid" onClick={() => onPay('qr', total)}>QR</button>
            </div>
          </section>
        </div>
        <div className="sheet__foot" />
      </div>
    </>
  );
}
