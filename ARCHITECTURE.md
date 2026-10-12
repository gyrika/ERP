# ERP · POS module — architecture v0

## Decisions
- **Client:** TypeScript PWA (installable on tablets/phones, one codebase for counter, kitchen, owner). Not native: no app-store friction, instant updates for a 4-person team.
- **Offline-first:** the device is the first database (IndexedDB). Every action writes locally, then appends to an **outbox**; a background sync pushes it. Sales never wait on the network.
- **Server:** Node + **MySQL** (team knows it). Each shop = `tenant_id` on every row, enforced in every query. Orders use client-generated UUIDs so offline devices never collide.
- **Realtime:** WebSocket fan-out (counter → kitchen → owner phone). Falls back to polling.
- **Money:** integer LKR cents only.
- **Eat first, pay after** (owner, 2026-10-10): an order goes to the kitchen on **Send**, waits under "Waiting to pay", and is charged later. Later rounds go as separate "Added" tickets; sent lines are locked. Paying sends anything unsent, and never recalls kitchen tickets.
- **Kitchen works from the screen only** (owner, 2026-10-10): there is no printed kitchen ticket and no printed cancel slip, and no ticket-printing data is prepared. The kitchen therefore needs a screen it can always see (a second monitor, or a spare phone or tablet at `/#kitchen`). Every arrival, change and cancellation plays a short chime and flashes the ticket until the kitchen taps it. This replaces the earlier "kitchen printer fallback" rule. The thermal printer is for the **customer receipt and the cash drawer only**.
- **Changing sent items** (owner, 2026-10-10): only a manager or owner, with their PIN, may change (size, extras, quantity) or cancel an item already sent. The cashier keeps only the quick Undo straight after Send (the next action or the 6 s toast timeout seals the send). Adding items stays open to everyone ("Added" ticket). Voiding or editing a sent item still needs a short reason (owner, 2026-10-11, kept over the manager-mode spec's one-key void). The kitchen sees **Changed** with the old item struck through in red beside the new one, or the item struck through in red with **Cancelled**; the ticket reopens even if already Done.
- **Manager mode** (branch `manager-mode`, 2026-10-11; replaces the old one-change "Ask manager" flow): **Ctrl+M** (or the corner **Manager** key) → PIN → the order card lifts with a spring, a soft depth and a thin gold edge, a quiet clunk plays, and the corner reads "Managing · <name>". Arrows select a line, **Enter** edits, **Delete** voids (a sent line asks for a reason inline: keys 1-3), **P** takes cents off one line, chips **1/2/3/4** = 10% / 20% / 50% / Free (comp), **Ctrl+Z** undoes the last manager change, **Ctrl+K** opens the command palette. **Esc** or **10 s idle** returns to cashier mode (the spring reverses). No dialogs, no banner, no PIN per action. Every change stamps "Edited by <name>, <time>" on the order. Manager Undo works only inside the manager session; the cashier can never undo a manager change. Out of scope: menu prices, menu items, staff (owner only). Discounts on paid orders (refunds) are not built.
- **Money with discounts** (`src/domain/totals.ts`): menu prices never change; adjustments live on the order. total = subtotal − per-line adjustments − order discount; a percentage rounds **once**, half up, in integer cents, at the order level; Free = the whole remainder. A test checks every amount up to Rs 2,500 against exact arithmetic. A comped order closes with tender `comp` at 0.
- **One function for manager changes:** `applyManagerChange()` (`src/domain/manager.ts`) returns the new order, exactly one audit event (who, when, before/after in cents, and line before/after or reason) and the inverse used by Undo. The register calls it only through `manage()`, which also tells the kitchen and returns the Undo. Undo is a new `order.change_undone` event: nothing is ever rewritten.
- **Auth:** `AuthService` interface (`src/domain/auth.ts`: shopId, current cashier, verify manager PIN). Today `fakeAuth` (`src/fake/fakeAuth.ts`); swap it in **one place**, `src/services/auth.ts`, when real logins land (sprint 3, SCRUM-40/41). `requireManager()` stays the single manager check.
- **Fake data:** all of it in `src/fake/data.ts` (staff + PINs, shop id, demo orders). `/?demo` loads the demo orders into a separate storage namespace (`cb.demo.*`), so real orders, kitchen and log are never touched.
- **shopId:** every synced row carries it: every event (stamped by the event log) and every kitchen ticket. The server maps it to `tenant_id`. The register's working snapshot is a device-local cache rebuilt from events by the server, so it does not.
- **Event log:** append-only, `src/domain/events.ts` (types) + `src/ui/eventLog.ts` (device store; becomes the sync outbox in slice 4). Events: `order.sent`, `order.send_undone`, `order.paid`, `order.payment_undone`, and the audited manager events `order.item_changed`, `order.item_cancelled`, `order.line_removed`, `order.line_adjusted`, `order.discount_set`, `order.comped`, `order.change_undone`. Each has id, shopId, actor, time and order number; manager events add totalBefore/totalAfter in cents.
- **Identifying orders:** by order number only. No name or phone field until the CRM + loyalty card slice; build nothing for it before then.
- **Input layer:** screens depend on `OrderInterpreter` only. Today: `ShorthandInterpreter` (rules, offline, instant). Later: voice / LLM implementing the same interface.
- **Intelligence:** a `SuggestionsService` interface (prep load, stock, anomalies, pricing) with a simple rules engine first; swappable later.

## Build order (vertical slices)
1. ✅ Domain core: real menu, pricing, order math, shorthand parser (tested)
2. ✅ Register + Extras sheet from the design (tap, type, Undo, light/dark)
3. ✅ Payment v0: cash quick amounts + change, Card, QR (no gateway yet)
4. Outbox + MySQL sync + realtime
5. ✅ Kitchen display at `/#kitchen` (one column, oldest first, colour = wait, one-tap Done + Undo, chime + flash until tapped, Changed/Cancelled lines). Manager PIN changes + event log. Built before 4: tickets travel tab-to-tab via BroadcastChannel + localStorage (`src/ui/kitchenStore.ts`); slice 4 replaces only that file.
6. Owner feed (rules-based insights)
7. Customer receipt printing (ESC/POS) + cash drawer, scanner. No kitchen printing.

## Run
`npm i && npm run dev` · `npm test` (domain + UI) · `npm run test:domain` · `npm run test:ui` · `npm run build` · demo: `/?demo` (manager PIN in `src/fake/data.ts`)

## Deliberately left out of v0
Accounts/roles UI, reports, inventory screens, i18n switcher (labels already carry en/si/ta), split bills — each arrives in its own slice.

## Menu source of truth
`src/domain/menu.ts` is copied from the printed menus (12 pizzas, 5 burgers, pasta, extras). Prices match; tests lock them.

## Open questions for the owner
- Half & half: pricing rule (not built, button omitted)
- Sinhala / Tamil item names (labels exist in the type but are empty; do not guess them)
- Pasta sauce choice (the photos show white and red sauce; not on the menu, so not modelled)
- Menu numbers: pizzas are numbered 1-12 in the order of the printed menu (5 = Devilled Chicken, per SCRUM-66). Check against the printed menu; burgers and pasta have no numbers.
- Kitchen urgency: amber at 10 min, red at 15 min are placeholders (`src/domain/kitchen.ts`); owner will supply real cook times per item (promised 2026-10-12).

## Answered by the owner (2026-10-12)
- Printer: Xprinter XP-80T, 80 mm thermal, ESC/POS, USB to the PC. Network port not confirmed.
- Cash drawer: RJ11 into the printer; opened by an ESC/POS kick command sent with the receipt.
- Counter PC: Windows 10 Pro (out of Microsoft support since Oct 2025).
- Payments: no card machine; customers pay cash or bank transfer. "Bank transfer" tender added; Card and QR buttons stay and get real integrations later.
- Decision: printing and the drawer kick go through a local helper program (SCRUM-71) that sends raw ESC/POS to the Windows printer queue. WebUSB was rejected: it needs the printer's Windows driver replaced, which breaks normal printing.
- Flow: customers eat first, pay after (confirms Send to kitchen → Charge).
