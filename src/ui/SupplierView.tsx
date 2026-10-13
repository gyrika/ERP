import { useMemo } from 'react';
import { summariseSuppliers } from '../domain/inventory.ts';
import { useInventory } from '../services/inventoryStore.ts';
import { InventoryHeader } from './InventoryHeader.tsx';
import { SupplierCard } from './SupplierCard.tsx';
import { splitSupplierName } from './supplierName.ts';

export function SupplierView() {
  const { items, suppliers } = useInventory();

  const cards = useMemo(
    () => summariseSuppliers(items, suppliers)
      .sort((a, b) => splitSupplierName(a.supplier.name).title.localeCompare(splitSupplierName(b.supplier.name).title)),
    [items, suppliers],
  );

  return (
    <div className="inv-page">
      <InventoryHeader active="suppliers" />

      <main className="inv-shell" aria-label="Suppliers">
        <div className="inv-scroll">
          <section className="inv-command-bar" aria-labelledby="supplier-heading">
            <div className="inv-command-bar__top">
              <div>
                <h1 className="supplier-heading" id="supplier-heading">Suppliers</h1>
                <p className="inv-page__lead">Primary and backup suppliers from your inventory list</p>
              </div>
              <span className="inv-metric-badge">
                <span className="dot dot--ok" aria-label="In stock" title="In stock" />
                <strong>{suppliers.length}</strong> suppliers
              </span>
            </div>
          </section>

          <div className="inv-workspace">
            <div className="sup-grid">
              {cards.map((summary) => (
                <SupplierCard key={summary.supplier.id} summary={summary} variant="directory" />
              ))}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
