import { formatInUnit, unitName, unitPrice, type CountUnit } from '../domain/counting.ts';
import { fmt } from '../domain/money.ts';
import { grnLineCents, grnValueCents, type PurchaseGrn } from '../domain/purchaseOrders.ts';
import { SHOP_HEADER } from '../domain/receipt.ts';

const SHORT = { wait: 'Waiting for the rest', close: 'Order closed: the rest was dropped' } as const;
const OVER = { accept: 'Extra accepted into stock', return: 'Extra returned to the supplier' } as const;

const when = (at: number) => new Date(at).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

/**
 * One GRN as a document: on screen in GRN history, and the page that is saved as a PDF
 * (printGrn). Quantities and prices in what each item is received in (packs, kg), money in
 * rupees from integer cents. The approver is kept on the record, never shown.
 */
export function GrnDocument({ grn, supplier, itemName, unitOf, warehouseName }: {
  grn: PurchaseGrn;
  supplier: string;
  itemName: (id: string) => string;
  /** The warehouse a line went into (SCRUM-184), when it says. */
  warehouseName?: (id: string) => string;
  /** What an item is received in; null: shown in packs. */
  unitOf: (id: string) => { unit: CountUnit; packQty: number } | null;
}) {
  const returned = grn.lines.some((l) => (l.returned ?? 0) > 0);
  const notes = [
    grn.shortDecision && SHORT[grn.shortDecision],
    grn.overDecision && OVER[grn.overDecision],
  ].filter(Boolean);
  return (
    <article className="grn-doc" aria-label={`${grn.grnNo} document`}>
      <header className="grn-doc__head">
        <div>
          <p className="grn-doc__shop">{SHOP_HEADER.name}</p>
          {SHOP_HEADER.lines.map((l) => <p key={l} className="grn-doc__meta">{l}</p>)}
        </div>
        <div className="grn-doc__id">
          <p className="grn-doc__title">Goods received note</p>
          <p className="grn-doc__no num">{grn.grnNo}</p>
        </div>
      </header>
      <dl className="grn-doc__facts">
        <div><dt>Supplier</dt><dd>{supplier}</dd></div>
        <div><dt>Purchase order</dt><dd className="num">{grn.poNo}</dd></div>
        <div><dt>Received</dt><dd className="num">{when(grn.at)}</dd></div>
      </dl>
      {grn.undone && <p className="grn-doc__undone">Undone {when(grn.undone.at)}: {grn.undone.reason}. Its stock was taken back off.</p>}
      <table className="bill grn-doc__table" aria-label={`${grn.grnNo} lines`}>
        <thead>
          <tr>
            <th scope="col">Item</th><th scope="col" className="bill__num">Ordered</th><th scope="col" className="bill__num">Received</th>
            {returned && <th scope="col" className="bill__num">Returned</th>}
            <th scope="col" className="bill__num">Price</th><th scope="col" className="bill__num">Total</th>
          </tr>
        </thead>
        <tbody>
          {grn.lines.map((l) => {
            const cents = grnLineCents(l);
            const u = unitOf(l.itemId) ?? { unit: { id: 'pack', label: 'pack', base: 1 }, packQty: 1 };
            const qty = (packs: number) => formatInUnit(packs, u.unit, u.packQty);
            return (
              <tr key={l.itemId}>
                <td>{itemName(l.itemId)}{l.warehouseId && warehouseName && <> <span className="bill__sub">Into {warehouseName(l.warehouseId)}</span></>}</td>
                <td className="bill__num num">{qty(l.ordered)}</td>
                <td className="bill__num num">{qty(l.received)}</td>
                {returned && <td className="bill__num num">{qty(l.returned ?? 0)}</td>}
                <td className="bill__num num">{l.unitPriceCents === undefined ? '—' : `Rs ${fmt(unitPrice(l.unitPriceCents, u.unit, u.packQty))} / ${unitName(u.unit)}`}</td>
                <td className="bill__num num">{cents === null ? '—' : `Rs ${fmt(cents)}`}</td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr>
            <th colSpan={returned ? 5 : 4} scope="row" className="bill__sum">Final total</th>
            <td className="bill__num bill__grand num" aria-label={`${grn.grnNo} final total`}>Rs {fmt(grnValueCents(grn.lines))}</td>
          </tr>
        </tfoot>
      </table>
      {notes.length > 0 && <ul className="grn-doc__notes">{notes.map((n) => <li key={n}>{n}</li>)}</ul>}
      {grn.note && <p className="grn-doc__note" aria-label="Manager's note">Manager's note: {grn.note}</p>}
    </article>
  );
}

/**
 * Saves the GRN on screen as a PDF through the browser's print dialog ("Save as PDF"): only
 * the .grn-doc prints (styles.css, @media print), and the file is named after the GRN.
 * No PDF library: it works offline and keeps the text selectable.
 */
export const printGrn = (fileName: string) => {
  const before = document.title;
  document.title = fileName;
  document.body.classList.add('print-grn');
  const restore = () => { document.title = before; document.body.classList.remove('print-grn'); window.removeEventListener('afterprint', restore); };
  window.addEventListener('afterprint', restore);
  window.print();
};
