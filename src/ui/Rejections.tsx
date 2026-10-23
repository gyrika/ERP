import { dismissRejection, useRejections } from '../services/inventoryStore.ts';

/** What the shop server said about each kind of record it refused, to start the sentence. */
const WHAT: Record<string, string> = {
  'stock.ordered': 'The purchase order',
  'stock.order_edited': 'The change to the purchase order',
  'stock.order_cancelled': 'The cancellation',
  'stock.order_reopened': 'Bringing the order back',
  'stock.grn': 'The GRN',
  'stock.grn_undone': 'The undo',
};

/**
 * The shop server refused something this device recorded (another device got there first,
 * or a rule). It was not saved and no longer counts; the reason says what to do next.
 */
export function RejectionNotices() {
  const refused = useRejections();
  return (
    <>
      {refused.map((r) => (
        <div key={r.id} className="inv-notice inv-notice--error" role="alert">
          {WHAT[r.type] ?? 'A stock change'} was not saved: {r.reason || 'the shop server did not accept it.'}
          <button type="button" onClick={() => dismissRejection(r.id)}>OK</button>
        </div>
      ))}
    </>
  );
}
