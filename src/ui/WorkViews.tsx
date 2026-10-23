import { useState } from 'react';
import { expectedBy } from '../domain/purchaseOrders.ts';
import { useInventory, usePurchases, useStockSettings } from '../services/inventoryStore.ts';
import { InfoCard } from './flow/ChoiceCard.tsx';
import { GoodsReceivingSheet } from './GoodsReceivingSheet.tsx';
import { OrderSheet } from './OrderSheet.tsx';
import { OwnerNav } from './OwnerNav.tsx';

/**
 * Two of the shop's daily jobs as their own places in the menu (the "Shop Day Navigation" plan):
 * Receive (a delivery came: the GRN) and Order (what to buy: purchase orders). Each opens its
 * step-by-step flow at once, because that is why the person came; closed, the page shows what
 * is waiting, with one button to start again. The flows are the same ones as before.
 */
const day = (at: number) => new Date(at).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });

export function ReceiveView({ onRegister }: { onRegister?: () => void }) {
  const { items, suppliers } = useInventory();
  const purchases = usePurchases();
  const settings = useStockSettings();
  const [open, setOpen] = useState(true);
  const [said, setSaid] = useState<string | null>(null);
  const name = (id: string) => suppliers.find((s) => s.id === id)?.name ?? 'Supplier';
  const waiting = [...purchases.open].reverse();
  return (
    <div className="owner work">
      <OwnerNav current="receive" onRegister={onRegister} />
      <main className="owner__main work__main" aria-label="Receive">
        <h1 className="work__title">Receive</h1>
        <p className="work__lead">A delivery came? Check what came against its order, item by item.</p>
        {said && <p className="work__said" role="status">{said}</p>}
        <button type="button" className="cta work__cta" onClick={() => setOpen(true)}>A delivery came</button>
        <section className="flow__list" aria-label="Expected deliveries">
          <h2 className="work__group">{waiting.length ? 'Expected' : 'No deliveries expected'}</h2>
          {waiting.map((o) => (
            <InfoCard key={o.id} name={name(o.supplierId)} tone={o.status === 'partly' ? 'warn' : undefined}
              line={`${o.poNo} · expected ${day(expectedBy(o, purchases.leadDays, settings.defaultLeadDays))}${o.status === 'partly' ? ' · partly received' : ''}`} />
          ))}
        </section>
      </main>
      {open && <GoodsReceivingSheet items={items} suppliers={suppliers} purchases={purchases} settings={settings}
        onClose={() => setOpen(false)} onDone={(message) => setSaid(message)} />}
    </div>
  );
}

export function OrderView({ onRegister }: { onRegister?: () => void }) {
  const { items, suppliers } = useInventory();
  const purchases = usePurchases();
  const [open, setOpen] = useState(true);
  const [said, setSaid] = useState<{ message: string; undo: () => void } | null>(null);
  const toOrder = items.filter((i) => i.suggestedPacks > 0);
  return (
    <div className="owner work">
      <OwnerNav current="order" onRegister={onRegister} />
      <main className="owner__main work__main" aria-label="Order">
        <h1 className="work__title">Order</h1>
        <p className="work__lead">What to buy before it runs out, one supplier at a time, then the message to send.</p>
        {said && (
          <p className="work__said" role="status">
            {said.message}
            <button type="button" className="linkbtn" onClick={() => { said.undo(); setSaid(null); }}>Undo</button>
          </p>
        )}
        <button type="button" className="cta work__cta" onClick={() => setOpen(true)}>{toOrder.length ? `Order ${toOrder.length} ${toOrder.length === 1 ? 'item' : 'items'}` : 'Make an order'}</button>
        <section className="flow__list" aria-label="To order">
          <h2 className="work__group">{toOrder.length ? 'Running low' : 'Nothing needs ordering now'}</h2>
          {toOrder.map((i) => <InfoCard key={i.id} name={i.name} tone="warn" line={`${i.suggestedPacks} ${i.suggestedPacks === 1 ? 'pack' : 'packs'} suggested`} />)}
        </section>
        {purchases.open.length > 0 && <p className="work__lead">{purchases.open.length} on order. Open the flow and choose "On order" to change or cancel one.</p>}
      </main>
      {open && <OrderSheet items={items} suppliers={suppliers} purchases={purchases}
        onClose={() => setOpen(false)} onDone={(message, undo) => setSaid({ message, undo })} />}
    </div>
  );
}
