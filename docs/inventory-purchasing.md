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
   - only a count makes an item counted: a delivery adds its packs but says nothing about what was already on the shelf, so a never-counted item stays **Not counted** (and is not suggested) until its first count, its opening stock
3. **Draft, then purchase order (PO)**: an item's *Order* tab only **adds it to its supplier's draft** (packs, *Add to draft*, Undo); it never places a PO. Each supplier has at most one draft, shared by every device (a `stock.draft_set` record holding the whole draft; no lines clears it). The *Order* page lists suppliers with a draft under *Needs ordering* ("Draft · 3 items") and opens the draft as the bill; a supplier without one starts from what the rule suggests. Every change on the bill is saved to the draft at once. **Place order** makes the PO and leaves on the draft only what was not placed; its Undo cancels the PO and puts the draft back (`src/ui/OrderSheet.tsx`). An item already on a supplier's open PO is **added to it** (never ordered twice); a partly received PO blocks it. A PO records the agreed price per pack as well as quantity, and can be edited or cancelled (with a reason) until goods are received.
4. **GRN** (`src/ui/GoodsReceivingSheet.tsx`): lists Open and Partly received POs; lines are what is still owed. Checking and saving is one bill (tick, item, qty, price per pack, total, then the final total): tick each item and enter its delivered price per pack from the supplier's bill; Back returns to the list of deliveries. The PO price and delivered price are shown together; a price difference, short delivery, or extra needs a manager's PIN. The manager can correct the delivered price before approving, and chooses for quantity differences:
   - short: **wait for the rest** (PO stays Partly received) or **close order**
   - extra: **accept** (all goes in) or **return** (only what was owed goes in; the rest is recorded as returned)
   - then **Approve** or **Don't approve** (nothing is saved). The approver is kept on the record, never shown.
   - **GRN history** lists every GRN, newest first, with its value; one opens as a document (supplier, PO, date, ordered / received / returned, price per pack, line totals, final total, decisions, undone or not) with **Export PDF** (the browser's Save as PDF, only the document prints; `src/ui/GrnDocument.tsx`) and Undo when it is allowed. Done has *View GRN*.
5. **Undo a GRN**: only the latest GRN of an order, within *grnUndoHours*, with a manager's PIN and a reason. The GRN stays listed, marked Undone.
6. **Count**: needs a reason when the gap is over *countGapShare* of what was expected **or** worth over *countGapCents*: Spoiled, Spilled, Wrong entry, or Other (with a note). Big gaps go to the owner's **count review**; marking one Reviewed changes no stock.

7. **Production** (SCRUM-161, `src/domain/production.ts`): *Send to kitchen* on Items › Semi-processed or Visual Flow sends first what the item is made from and is not there (whole batches, every level), and the item waits ("Waiting for Culture") until the shop server sees its inputs on hand and releases it to the kitchen. A batch in the kitchen holds its inputs (*held for the kitchen*). When a counted raw item is short for a waiting batch, Items shows *Kitchen waits for X more* and *+ Cart* orders it; the batch goes once a GRN puts the stock in. Finished dishes show *Can make N* from what is on hand.

8. **Warehouses** (SCRUM-184, `src/domain/warehouses.ts`): the shop starts with *Warehouse 1/2/3* (placeholders the owner renames); the owner adds, renames and archives them and picks the one **next to the kitchen** on *Items › Warehouses › Edit warehouses* (his PIN, one Save, one Undo). Every raw and semi-processed item has a **home** (Warehouse 1 until set). What comes in goes to a warehouse: a GRN line where its chip says (the item's home by default; *Put all in…* sets every line), a batch made into its home. What goes out (sales, a batch's inputs, waste) is taken automatically: next to the kitchen first, then the item's home, then the rest, so the counter never picks a warehouse and the split is close, not exact. **Move** (from → to, amount, Undo) carries stock between warehouses without changing the total; a count can be of one warehouse when an item is kept in more than one. Stock recorded before warehouses is in Warehouse 1. *Items › Warehouses* lists each warehouse with what it holds and its value (every item also shows in its home); Visual Flow's **Warehouse** view puts each card's home and split on the drawing.

## Rules that hold everywhere

- Stock is the sum of movements (`GRN`, `GRN_UNDO`, `COUNT_ADJUST`, and sales worked out from orders). A GRN is one record that carries its own stock movement; nothing edits a stock figure.
- Saved records are never deleted; Undo writes a reversal. Every record has a UUID made on the device, so a sync retry changes nothing.
- PO and GRN numbers (PO-0001, GRN-0001) come from the shop server (`server/numbering.ts`); until they arrive a document shows *PO (pending)*. A device with no server (demo, development) numbers its own.
- The **server re-checks** every purchasing rule against what it has stored (`server/stockRules.ts`): order exists and is still editable, a GRN matches what is owed, changed delivered prices and quantity differences have a real active manager or owner approval, the stock amount is the one the decisions allow, undo is allowed, a big count gap has a reason (worked out from the server's own price; an item's first count is its opening stock and needs none), and stock never changes by a bare movement, only by a count, a GRN, a sale or waste. A refused record is not stored; the device keeps the reason, stops counting it, and tells the person what to do next.

## The owner's numbers

`src/domain/stockSettings.ts` holds every number (defaults: 10% or Rs 2,000 for counts, 14 days of use, 3 days delivery, last 5 deliveries, 2 spare days, 7 order days, 24 hours to undo). The owner changes them on *Stock rules* (owner PIN); each change is an audited record with Undo.

## Where things live

| What | File |
|---|---|
| Reorder maths | `src/domain/ordering.ts` |
| PO / GRN state, statuses, checks | `src/domain/purchaseOrders.ts` |
| Numbers | `src/domain/docNumbers.ts`, `server/numbering.ts` |
| Stock from records | `src/domain/inventory.ts` |
| One ledger, production planning, release | `src/domain/production.ts`, `src/domain/itemStock.ts`, `src/domain/scheduler.ts`, `server/scheduler.ts` |
| Counts and reasons | `src/domain/counting.ts`, `src/domain/gapReview.ts` |
| Warehouses, homes, moves, where stock is | `src/domain/warehouses.ts`, `src/ui/WarehousesView.tsx` |
| Server rules | `server/stockRules.ts`, `server/validate.ts` |
| Writing records | `src/services/inventoryStore.ts` |
