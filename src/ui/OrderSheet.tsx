import { useEffect, useMemo, useState } from 'react';
import { stockStatus } from '../domain/inventory.ts';
import type { Supplier } from '../domain/inventoryData.ts';
import { orderMessage, suggestPacks, whatsAppLink } from '../domain/ordering.ts';
import type { InventoryRow } from '../services/inventoryStore.ts';

/**
 * Order from a supplier (SCRUM-92). Serves the manager when an item runs low: the
 * message is already written (the low items this supplier carries, enough for a
 * week each), they change a number if they like and send it on WhatsApp, or call.
 * Nothing is sent from here: WhatsApp opens with the text and the manager presses send.
 */
const isLow = (row: InventoryRow) => { const s = stockStatus(row); return s === 'low' || s === 'out'; };

export function OrderSheet({ item, items, suppliers, onClose }: {
  item: InventoryRow;
  items: InventoryRow[];
  suppliers: Supplier[];
  onClose: () => void;
}) {
  const sources = suppliers.filter((s) => item.supplierIds.includes(s.id));
  const [supplierId, setSupplierId] = useState(sources[0]?.id ?? null);
  const [copied, setCopied] = useState(false);
  const supplier = sources.find((s) => s.id === supplierId) ?? null;
  // The item asked about first, then this supplier's other low items.
  const lines = useMemo(() => [item, ...items.filter((i) => i.id !== item.id && isLow(i) && supplier !== null && i.supplierIds.includes(supplier.id))],
    [item, items, supplier]);
  const [packs, setPacks] = useState<Record<string, number>>({});
  const packsOf = (row: InventoryRow) => packs[row.id] ?? suggestPacks(row);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const text = orderMessage(lines.map((r) => ({ name: r.name, packs: packsOf(r), packQty: r.packQty, baseUnit: r.baseUnit })));
  const nothing = lines.every((r) => packsOf(r) === 0);
  const step = (row: InventoryRow, by: number) => { setPacks({ ...packs, [row.id]: Math.max(0, packsOf(row) + by) }); setCopied(false); };
  const copy = () => { void navigator.clipboard?.writeText(text).then(() => setCopied(true), () => {}); };

  return (
    <div className="inv-modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <section className="inv-modal order" role="dialog" aria-modal="true" aria-labelledby="order-title">
        <button type="button" className="count__close" aria-label="Close" onClick={onClose}>×</button>
        <h2 id="order-title">{supplier ? `Order from ${supplier.name}` : `Order ${item.name}`}</h2>
        {sources.length > 1 && (
          <div className="chips" role="group" aria-label="Supplier">
            {sources.map((s) => (
              <button key={s.id} type="button" className="chip" aria-pressed={s.id === supplierId} onClick={() => { setSupplierId(s.id); setCopied(false); }}>{s.name}</button>
            ))}
          </div>
        )}

        <ul className="order__lines" aria-label="To order">
          {lines.map((row) => (
            <li key={row.id}>
              <span className="delivery__name">{row.name}</span>
              <button type="button" className="chip" aria-label={`One pack less of ${row.name}`} onClick={() => step(row, -1)}>−</button>
              <strong className="num order__packs" aria-label={`Packs of ${row.name}`}>{packsOf(row)}</strong>
              <button type="button" className="chip" aria-label={`One pack more of ${row.name}`} onClick={() => step(row, 1)}>+</button>
            </li>
          ))}
        </ul>

        <pre className="order__message" aria-label="Message">{text}</pre>

        <div className="order__send">
          {supplier?.phone ? (
            <>
              <a className={`restock-action restock-action--wa${nothing ? ' order__off' : ''}`} href={whatsAppLink(supplier.phone, text)}
                target="_blank" rel="noreferrer" aria-disabled={nothing}>WhatsApp</a>
              <a className="restock-action order__call" href={`tel:${supplier.phone}`}>Call {supplier.phone}</a>
            </>
          ) : (
            <p className="order__nophone">No phone saved for {supplier?.name ?? 'this item'}. Add it on <a href="#suppliers">Suppliers</a>.</p>
          )}
          <button type="button" className="linkbtn" onClick={copy}>{copied ? 'Copied' : 'Copy message'}</button>
        </div>
      </section>
    </div>
  );
}
