import { useState } from 'react';
import { RECEIPT_WIDTH, receipt } from '../domain/receipt.ts';
import { totals } from '../domain/totals.ts';
import type { Order, PaidOrder } from '../domain/types.ts';
import { canPrint, printReceipt } from '../services/printer.ts';

/**
 * /#receipt: the customer receipt as the XP-80T will print it, for the owner
 * to approve and for setting up the printer (CLAUDE.md, SCRUM-71). Not part of
 * the cashier's screens. Built from the same lines that become the printer's
 * bytes, so the paper matches this page.
 */
const SAMPLE: Order = {
  number: 1043,
  lines: [
    { id: 'a', itemId: 'margherita', qty: 2, size: 'M', adds: ['full-cheese'], outs: [] },
    { id: 'b', itemId: 'devilled-chicken', qty: 1, size: 'L', adds: [], outs: [] },
    { id: 'c', itemId: 'crispy-chicken-burger', qty: 1, adds: [], outs: [] },
  ],
  adjust: { discount: { kind: 'percent', pct: 10 } },
};

const samplePaid = (): PaidOrder => {
  const total = totals(SAMPLE).total;
  return { ...SAMPLE, total, tender: 'cash', tendered: 1000000, change: 1000000 - total, paidAt: Date.now() };
};

export function ReceiptPreview() {
  const [paid] = useState(samplePaid);
  const [test, setTest] = useState<'idle' | 'printing' | 'printed' | 'failed'>('idle');
  const lines = receipt(paid, { cashier: 'Nimal' });

  const printTest = async () => {
    setTest('printing');
    // As a reprint: marked COPY, and the cash drawer stays shut.
    const r = await printReceipt(paid, 'Nimal', { reprint: true });
    setTest(r === 'printed' ? 'printed' : 'failed');
  };

  return (
    <main className="rpreview">
      <header className="rpreview__head">
        <h1>Customer receipt</h1>
        <p>80 mm paper, {RECEIPT_WIDTH} characters a line. A sample sale, as it prints.</p>
        {canPrint() && (
          <p className="rpreview__actions">
            <button type="button" className="chip" onClick={() => void printTest()} disabled={test === 'printing'}>
              Print a test receipt
            </button>
            <span role="status">
              {test === 'printed' && 'Sent to the printer'}
              {test === 'failed' && 'The printer did not take it'}
            </span>
          </p>
        )}
      </header>
      <figure className="paper" aria-label="Receipt preview">
        {lines.map((l, i) => (
          <div key={i} className={`paper__line${l.big ? ' paper__line--big' : ''}${l.bold ? ' paper__line--bold' : ''}`}
            style={{ textAlign: l.center ? 'center' : 'left' }}>
            {l.text || ' '}
          </div>
        ))}
      </figure>
    </main>
  );
}
