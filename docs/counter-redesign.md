# Counter redesign: recognition over recall (SCRUM-243, 2026-11-16)

Staff came from an older POS and found the flow-based Register hard: actions hid behind the flow,
Undo, shortcuts and the command palette. The counter now shows every daily action as a labelled
button in the layout they know. No logic was removed: instant add, Undo, typed ordering, cash and
change, whole-cent money and the offline save all work as before.

## Layout (1366x768 and up, no scrolling for actions)

- **Left, always in sight: order history.** Held bills (count, number, what, total, Paid / Not paid, Dine in), then
  Paid today, newest first. A tap opens the bill on the right (a paid one to see or print again).
- **Middle, the menu:** "Type or search… e.g. 2 L pepperoni" field (always visible), the section tabs, the item tiles.
- **Right, about 36%, the bill:** Bill No, date and time, Take away | Dine in, the customer's mobile (Customers on);
  a table of lines (Item + extras, Qty − / +, Price, Total, ✕) with the selected
  line highlighted; Subtotal, Discount, NET AMOUNT.
- **Bottom bar, always visible:** PAY F2 · SEND TO KITCHEN F3 · VOID ITEM F4 · CLEAR BILL F5 · NEW BILL F6 ·
  HOLD F7 · PRINT LAST BILL F8. A button that cannot be used now is greyed, never hidden.

## What moved where

| Before | Now |
|---|---|
| Orders list on the left | Still on the left, as **order history**: Held bills · N, then Paid today (now tappable) |
| + New order (Esc) | **NEW BILL** (F6); Esc still works |
| Send / Pay pair under the order (Ctrl+Enter) | **SEND TO KITCHEN** (F3) and **PAY** (F2) in the bottom bar; Ctrl+Enter still does the likelier one |
| Charge X more / Give back X / Close · Free / Close · Uber Eats | The PAY button says it |
| Given (made order waiting) | **Given** button in the bill header |
| Remove a line: tap it, then Remove; − / + only on the last line | **✕** on every row, **VOID ITEM** (F4) or Delete on the selected line; − / + on every unsent line; + / − keys |
| Clear the order: remove lines one by one | **CLEAR BILL** (F5), instant, with Undo |
| Leave an order for later: Esc | **HOLD** (F7), with Undo |
| Print again: only on the paid bill | **PRINT LAST BILL** (F8), from any bill |
| "Type an order…" button, or just start typing | The search field is always there; typing anywhere still opens it |
| ••• More: Receive, Manager, Uber Eats, Voice | All on the top bar by name |
| Money out F6, Receive F7, Uber Eats F8 | Buttons on the top bar (their keys went to the bill actions) |
| Today F3 | Today F10 |
| Switch user F4 | The name button on the top bar ("<name> · Switch user") |
| Kitchen: F2 or the Kitchen key | **Hidden** for now (below) |
| A sent line: the cashier could remove it from its extras, no PIN | VOID asks for a **manager PIN**, then the reason (audited). Changing a sent line's extras is still the cashier's (SCRUM-242) |

New: **Take away | Dine in** on each bill (kept on the bill, shown on Held bills).

## Kitchen view hidden (2026-11-16)

Until the staff are at home with the counter, the counter shows no Kitchen view: no Kitchen key, no
Send to kitchen, and `#kitchen` opens the Register. Paying sends the order with it (not held) and
hands it over, so the sale, stock and reports are exactly as before. A paired kitchen device or a
kitchen login still shows the Kitchen. To bring it back: Manager mode → Ctrl+K → "Kitchen screen: show
it" (per counter, `src/ui/kitchenScreen.ts`).

## Languages

Button words live in `src/ui/labels.ts` as `{ en, si, ta }`; Sinhala and Tamil stay empty until the
owner gives them, and English shows meanwhile.

## Light mode

The counter starts light unless someone chose a look (Ctrl+K → Light / Dark / Follow Windows).
