import { useState } from 'react';
import { useInventory, usePurchases, useStockSettings } from '../services/inventoryStore.ts';
import { GoodsReceivingSheet } from './GoodsReceivingSheet.tsx';
import { OrderSheet } from './OrderSheet.tsx';
import { OwnerNav } from './OwnerNav.tsx';

/**
 * Two of the shop's daily jobs as their own places in the menu (the "Shop Day Navigation" plan):
 * Receive (a delivery came: the GRN) and Order (what to buy: purchase orders). The step-by-step
 * flow fills the panel beside the menu, in the page itself, not a sheet over it: the menu stays
 * where it is and the work is where the person looks. Finishing (or Esc on the first step) starts
 * the flow over, with what is waiting now.
 */
export function ReceiveView({ onRegister }: { onRegister?: () => void }) {
  const { items, suppliers } = useInventory();
  const purchases = usePurchases();
  const settings = useStockSettings();
  /** A new round starts the flow over, fresh. */
  const [round, setRound] = useState(0);
  const [said, setSaid] = useState<string | null>(null);
  return (
    <div className="owner work">
      <OwnerNav current="receive" onRegister={onRegister} />
      <main className="owner__main work__main" aria-label="Receive">
        {said && <p className="work__said" role="status">{said}</p>}
        <GoodsReceivingSheet key={round} inline items={items} suppliers={suppliers} purchases={purchases} settings={settings}
          onClose={() => setRound((r) => r + 1)} onDone={(message) => setSaid(message)} />
      </main>
    </div>
  );
}

export function OrderView({ onRegister }: { onRegister?: () => void }) {
  const { items, suppliers } = useInventory();
  const purchases = usePurchases();
  const [round, setRound] = useState(0);
  const [said, setSaid] = useState<{ message: string; undo: () => void } | null>(null);
  return (
    <div className="owner work">
      <OwnerNav current="order" onRegister={onRegister} />
      <main className="owner__main work__main" aria-label="Order">
        {said && (
          <p className="work__said" role="status">
            {said.message}
            <button type="button" className="linkbtn" onClick={() => { said.undo(); setSaid(null); }}>Undo</button>
          </p>
        )}
        <OrderSheet key={round} inline items={items} suppliers={suppliers} purchases={purchases}
          onClose={() => setRound((r) => r + 1)} onDone={(message, undo) => setSaid({ message, undo })} />
      </main>
    </div>
  );
}
