import { useEffect, useRef, useState } from 'react';
import { RECEIPT_WIDTH, changedBill, receipt, type ChangeBlock, type ReceiptLine } from '../domain/receipt.ts';
import { RECEIPT_LOGO } from '../domain/receiptLogo.ts';
import { totals } from '../domain/totals.ts';
import type { Order, PaidOrder } from '../domain/types.ts';
import { canPrint, printReceipt, receiptOffers } from '../services/printer.ts';

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

export const samplePaid = (): PaidOrder => {
  const total = totals(SAMPLE).total;
  return { ...SAMPLE, total, tender: 'cash', tendered: 1000000, change: 1000000 - total, paidAt: Date.now() };
};

/**
 * The same sale changed after paying (SCRUM-255): full cheese on the Devilled Chicken and one more
 * burger, paid in cash; then the crispy burger taken off, given back.
 */
export const sampleChanged = (): { paid: PaidOrder; blocks: ChangeBlock[] } => {
  // No discount here, so each change's price is what changed hands.
  const { adjust: _a, ...plain } = samplePaid();
  const first = totals(plain).total;
  const at = plain.paidAt;
  const step1 = { ...plain, lines: [plain.lines[0], { ...plain.lines[1], adds: ['full-cheese'] }, ...plain.lines.slice(2), { id: 'd', itemId: 'chicken-burger', qty: 1, adds: [], outs: [] }] };
  const step2 = { ...step1, lines: step1.lines.filter((l) => l.id !== 'c') };
  const t1 = totals(step1).total;
  const t2 = totals(step2).total;
  const blocks: ChangeBlock[] = [
    { at: at + 12 * 60_000, entries: [{ text: 'Devilled Chicken: + Full cheese', amount: 60000 }, { text: '+ 1 x Chicken Burger', amount: 45000 }], amount: t1 - first, tender: 'cash', tendered: 200000 },
    { at: at + 20 * 60_000, entries: [{ text: '- 1 x Crispy Chicken Burger', amount: -65000 }], amount: t2 - t1, tender: 'cash', tendered: t1 - t2 },
  ];
  return { paid: { ...step2, total: first, tendered: 1000000, change: 1000000 - first, settled: t2 - first }, blocks };
};

function Paper({ lines, label }: { lines: ReceiptLine[]; label: string }) {
  return (
    <figure className="paper" aria-label={label}>
      {lines.map((l, i) => (
        <div key={i} className={`paper__line${l.big ? ' paper__line--big' : ''}${l.bold ? ' paper__line--bold' : ''}${l.invert ? ' paper__line--invert' : ''}`}
          style={{ textAlign: l.center ? 'center' : 'left' }}>
          {/* The printer draws the QR code itself; here a square of its size says where it goes. */}
          {l.qr && <span className="paper__qr" role="img" aria-label={`QR code: ${l.qr}`}>QR</span>}
          {l.logo ? <PaperLogo name={l.text} /> : (l.text || ' ')}
        </div>
      ))}
    </figure>
  );
}

/** The logo drawn from the very dots the printer gets, so the preview shows the paper, not the artwork. */
function PaperLogo({ name }: { name: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const ctx = ref.current?.getContext('2d');
    if (!ctx) return;
    const { width, height, bits } = RECEIPT_LOGO;
    const raw = atob(bits);
    const row = Math.ceil(width / 8);
    const img = ctx.createImageData(width, height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const on = (raw.charCodeAt(y * row + (x >> 3)) >> (7 - (x & 7))) & 1;
        const p = (y * width + x) * 4;
        img.data[p] = img.data[p + 1] = img.data[p + 2] = on ? 17 : 255;
        img.data[p + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }, []);
  return <canvas ref={ref} className="paper__logo" width={RECEIPT_LOGO.width} height={RECEIPT_LOGO.height} role="img" aria-label={`${name} logo`} />;
}

export function ReceiptPreview() {
  const [paid] = useState(samplePaid);
  const [test, setTest] = useState<'idle' | 'printing' | 'printed' | 'failed'>('idle');
  const lines = receipt(paid, { cashier: 'Nimal', offers: receiptOffers() });
  const [changed] = useState(sampleChanged);
  const changedLines = changedBill(changed.paid, changed.blocks, { cashier: 'Nimal' });

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
        <p>80 mm paper, {RECEIPT_WIDTH} characters a line. A sample sale as it prints, and the same sale changed after paying.</p>
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
      <div className="rpreview__papers">
        <Paper lines={lines} label="Receipt preview" />
        <Paper lines={changedLines} label="Changed bill preview" />
      </div>
    </main>
  );
}
