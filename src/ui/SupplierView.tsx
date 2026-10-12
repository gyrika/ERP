import { useMemo } from 'react';
import { useInventory } from '../services/inventoryStore.ts';

/** Split "Name (Wholesale)" into display name + trailing detail for cards. */
const splitSupplierName = (name: string): { title: string; detail: string } => {
  const match = name.match(/^(.*)\s+\(([^)]+)\)\s*$/);
  if (!match) return { title: name, detail: '' };
  return { title: match[1].trim(), detail: match[2].trim() };
};

const supplierDetails = (
  detail: string,
  name: string,
): { type: string; location: string } => {
  const parts = detail.split(',').map((p) => p.trim()).filter(Boolean);
  const locationPart = parts.find((part) => /^(Thalwila|Marawila|Pambala)$/i.test(part));
  const locationInName = name.match(/\b(Thalwila|Marawila|Pambala)\b/i)?.[0] ?? '';
  return {
    type: parts.filter((part) => part !== locationPart).join(', '),
    location: locationPart ?? locationInName,
  };
};

export function SupplierView() {
  const { items, suppliers } = useInventory();

  const cards = useMemo(() => suppliers.map((supplier) => {
    const primary = items.filter((i) => i.mainSupplierId === supplier.id).length;
    const backup = items.filter((i) => i.backupSupplierId === supplier.id).length;
    const { title, detail } = splitSupplierName(supplier.name);
    const { type, location } = supplierDetails(detail, supplier.name);
    return { supplier, title, type, location, primary, backup };
  }).sort((a, b) => a.title.localeCompare(b.title)), [items, suppliers]);

  return (
    <div className="inv-page">
      <header className="inv-page__head">
        <span className="brand">CheesyBeez</span>
        <nav className="inv-page__nav" aria-label="Inventory sections">
          <a className="inv-page__link" href="#inventory">Inventory</a>
          <a className="inv-page__link inv-page__link--on" href="#suppliers">Suppliers</a>
          <a className="inv-page__link" href="#">Register</a>
        </nav>
      </header>

      <main className="inv-page__main" aria-label="Suppliers">
        <p className="inv-page__lead">
          {suppliers.length} suppliers · primary and backup item counts from your inventory list
        </p>
        <div className="sup-grid">
          {cards.map(({ supplier, title, type, location, primary, backup }) => (
            <article key={supplier.id} className="sup-card">
              <h2 className="sup-card__title">{title}</h2>
              <dl className="sup-card__stats">
                <div>
                  <dt>Primary items</dt>
                  <dd className="num">{primary}</dd>
                </div>
                <div>
                  <dt>Backup items</dt>
                  <dd className="num">{backup}</dd>
                </div>
              </dl>
              {(type || location) && (
                <div className="sup-card__contact">
                  {type && <p><span className="sup-card__k">Type</span> {type}</p>}
                  {location && <p><span className="sup-card__k">Location</span> {location}</p>}
                </div>
              )}
              <p className="sup-card__contact sup-card__contact--muted">No contact details on file</p>
            </article>
          ))}
        </div>
      </main>
    </div>
  );
}
