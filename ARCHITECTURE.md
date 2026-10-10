# ERP · POS module — architecture v0

## Decisions
- **Client:** TypeScript PWA (installable on tablets/phones, one codebase for counter, kitchen, owner). Not native: no app-store friction, instant updates for a 4-person team.
- **Offline-first:** the device is the first database (IndexedDB). Every action writes locally, then appends to an **outbox**; a background sync pushes it. Sales never wait on the network.
- **Server:** Node + **MySQL** (team knows it). Each shop = `tenant_id` on every row, enforced in every query. Orders use client-generated UUIDs so offline devices never collide.
- **Realtime:** WebSocket fan-out (counter → kitchen → owner phone). Falls back to polling.
- **Money:** integer LKR cents only.
- **Eat first, pay after** (owner, 2026-10-10): an order goes to the kitchen on **Send**, waits under "Waiting to pay", and is charged later. Later rounds go as separate "Added" tickets; sent lines are locked. Paying sends anything unsent, and never recalls kitchen tickets.
- **Kitchen works from the screen only** (owner, 2026-10-10): there is no printed kitchen ticket and no printed cancel slip, and no ticket-printing data is prepared. The kitchen therefore needs a screen it can always see (a second monitor, or a spare phone or tablet at `/#kitchen`). Every arrival, change and cancellation plays a short chime and flashes the ticket until the kitchen taps it. This replaces the earlier "kitchen printer fallback" rule. The thermal printer is for the **customer receipt and the cash drawer only**.
- **Changing sent items** (owner, 2026-10-10): only a manager or owner, with their PIN, may change (size, extras, quantity) or cancel an item already sent. The cashier keeps only the quick Undo straight after Send (the next action or the 6 s toast timeout seals the send). Adding items stays open to everyone ("Added" ticket). Flow: **Ask manager** → PIN → manager taps the sent item, picks a reason, saves → control returns to the cashier. The kitchen sees **Changed** with the old item struck through in red beside the new one, or the item struck through in red with **Cancelled**; the ticket reopens even if already Done.
- **Manager check:** one function, `requireManager(pin)` in `src/domain/auth.ts`, with dev-only PINs. Swap it (and `currentCashier`) for real PIN login and roles in SCRUM-40 / SCRUM-41; nothing else changes.
- **Event log:** append-only, `src/domain/events.ts` (types) + `src/ui/eventLog.ts` (device store; becomes the sync outbox in slice 4). Events: `order.sent`, `order.send_undone`, `order.paid`, `order.payment_undone`, `order.item_changed`, `order.item_cancelled`, each with actor, time and order number; changes also carry the item before/after and a reason.
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
`npm i && npm run dev` · `npm test` (domain) · `npm run test:ui` · `npm run build`

## Deliberately left out of v0
Accounts/roles UI, reports, inventory screens, i18n switcher (labels already carry en/si/ta), split bills — each arrives in its own slice.

## Menu source of truth
`src/domain/menu.ts` is copied from the printed menus (12 pizzas, 5 burgers, pasta, extras). Prices match; tests lock them.

## Open questions for the owner
- Half & half: pricing rule (not built, button omitted)
- Sinhala / Tamil item names (labels exist in the type but are empty; do not guess them)
- Pasta sauce choice (the photos show white and red sauce; not on the menu, so not modelled)
- Menu numbers (1-12) are what customers say: support "5 L" as shorthand?
- Kitchen urgency: amber at 10 min, red at 15 min are placeholders (`src/domain/kitchen.ts`); owner will supply real cook times.
