# Inventory, purchase orders and GRN

How stock, ordering and receiving work. Inventory is **managers and owners only**.

## The flow

1. **Stock goes down by itself**: each pizza sent to the kitchen takes its recipe from stock (`src/domain/stockUsage.ts`).
2. **The app suggests what to order** (`suggestions` in `src/domain/ordering.ts`, the only place that decides):
   - daily use = sales over the last *usageDays* ÷ *usageDays*
   - delivery time = average of the supplier's last first deliveries (default 3 days)
   - suggest when *on hand + still on order* ≤ use × (delivery time + spare days)
   - packs = use × (delivery time + order days) − (on hand + on order), rounded **up**; never 0
   - items never counted, with no use, archived, or with no active supplier are skipped
   - **Low** means "the rule suggests ordering it"; **Out** is nothing left; **Not counted** is grey
3. **Purchase order (PO)**: the *Purchase orders* button or an item's *Order* tab show the same card (`src/ui/OrderSheet.tsx`). An item already on a supplier's open PO is **added to it** (never ordered twice); a partly received PO blocks it. A PO can be edited or cancelled (with a reason) until goods are received.
4. **GRN** (`src/ui/GoodsReceivingSheet.tsx`): lists Open and Partly received POs; lines are what is still owed. Anything short or over needs a manager's PIN, then the manager chooses:
   - short: **wait for the rest** (PO stays Partly received) or **close order**
   - extra: **accept** (all goes in) or **return** (only what was owed goes in; the rest is recorded as returned)
   - then **Approve** or **Don't approve** (nothing is saved). The approver is kept on the record, never shown.
5. **Undo a GRN**: only the latest GRN of an order, within *grnUndoHours*, with a manager's PIN and a reason. The GRN stays listed, marked Undone.
6. **Count**: needs a reason when the gap is over *countGapShare* of what was expected **or** worth over *countGapCents*: Spoiled, Spilled, Wrong entry, or Other (with a note). Big gaps go to the owner's **count review**; marking one Reviewed changes no stock.

## Rules that hold everywhere

- Stock is the sum of movements (`GRN`, `GRN_UNDO`, `COUNT_ADJUST`, and sales worked out from orders). A GRN is one record that carries its own stock movement; nothing edits a stock figure.
- Saved records are never deleted; Undo writes a reversal. Every record has a UUID made on the device, so a sync retry changes nothing.
- PO and GRN numbers (PO-0001, GRN-0001) come from the shop server (`server/numbering.ts`); until they arrive a document shows *PO (pending)*. A device with no server (demo, development) numbers its own.
- The **server re-checks** every purchasing rule against what it has stored (`server/stockRules.ts`): order exists and is still editable, a GRN matches what is owed, the approver is a real active manager or owner, the stock amount is the one the decisions allow, undo is allowed, a big count gap has a reason. A refused record is not stored; the device keeps the reason, stops counting it, and tells the person what to do next.

## The owner's numbers

`src/domain/stockSettings.ts` holds every number (defaults: 10% or Rs 2,000 for counts, 14 days of use, 3 days delivery, last 5 deliveries, 2 spare days, 7 order days, 24 hours to undo). The owner changes them on *Stock rules* (owner PIN); each change is an audited record with Undo.

## Where things live

| What | File |
|---|---|
| Reorder maths | `src/domain/ordering.ts` |
| PO / GRN state, statuses, checks | `src/domain/purchaseOrders.ts` |
| Numbers | `src/domain/docNumbers.ts`, `server/numbering.ts` |
| Stock from records | `src/domain/inventory.ts` |
| Counts and reasons | `src/domain/counting.ts`, `src/domain/gapReview.ts` |
| Server rules | `server/stockRules.ts`, `server/validate.ts` |
| Writing records | `src/services/inventoryStore.ts` |
