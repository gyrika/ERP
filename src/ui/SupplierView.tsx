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
          <a className="inv-page__link inv-page__link--on" href="#suppliers" aria-current="page">Suppliers</a>
          <a className="inv-page__link" href="#">Register</a>
        </nav>
      </header>

      <main className="inv-shell" aria-label="Suppliers">
        <div className="inv-scroll">
          <section className="inv-command-bar" aria-labelledby="supplier-heading">
            <div className="inv-command-bar__top">
              <div>
                <h1 className="supplier-heading" id="supplier-heading">Suppliers</h1>
                <p className="inv-page__lead">Primary and backup suppliers from your inventory list</p>
              </div>
              <span className="inv-metric-badge">
                <span className="inv-dot inv-dot--emerald" />
                <strong>{suppliers.length}</strong> suppliers
              </span>
            </div>
          </section>

          <div className="inv-workspace">
            <div className="inv-grid supplier-grid">
              {cards.map(({ supplier, title, type, location, primary, backup }) => (
                <article key={supplier.id} className="inv-card supplier-card">
                  <div>
                    <div className="inv-card__header">
                      <h2 className="inv-card__title">{title}</h2>
                      {type && <span className="inv-badge inv-badge--neutral">{type}</span>}
                    </div>
                    {location && <p className="inv-card__sub">{location}</p>}
                  </div>
                  <dl className="supplier-card__stats">
                    <div>
                      <dt>Primary items</dt>
                      <dd className="num">{primary}</dd>
                    </div>
                    <div>
                      <dt>Backup items</dt>
                      <dd className="num">{backup}</dd>
                    </div>
                  </dl>
                  <p className="supplier-card__contact">No contact details on file</p>
                </article>
              ))}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
