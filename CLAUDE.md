# CheesyBeez ERP — POS module

Product design + engineering for a point-of-sale system for the pizza shop CheesyBeez (Thalwila). It is the first module of a larger ERP. Do not name it "BeePOS". Team of 4, tracked in Jira (space "My Scrum Space", key SCRUM, project named "ERP"). Owner is Anton (computer engineering student, Sri Lanka); he knows MySQL. Counter: a shared Windows 10 PC, one screen, keyboard first (touch still works, 48px targets); kitchen on its own screen.

Goal: the most advanced, premium POS the shop could use: faster than any competitor, almost no UI, built around how people actually think.

## The three minds (state which one a screen serves, what they already know, and the single next thing they need, BEFORE designing it)
1. **Cashier**: customer waiting, hands busy. Take an order in seconds, never hunt, never err.
2. **Kitchen**: sees only what to make next, in order, readable from a distance.
3. **Owner**: wants to be told what needs attention and what to decide, not read reports.

## Principles
- Zero-search ordering: likely items already on screen; repeat customers get "the usual" in one tap.
- Input by tap, keyboard, or typed shorthand ("2 L devilled chicken no onion, burger"). Screens depend only on `OrderInterpreter` (src/domain/types.ts) so voice/LLM can replace the rules parser later without changing screens.
- One primary action per screen: "Send to kitchen" while an order has new items, "Charge" once it is all sent (customers eat first, pay after). No confirmation dialogs: instant action + visible Undo.
- Modifiers appear only after the item is chosen, as big chips, sensible defaults.
- Payment in one gesture: cash quick amounts + automatic change, bank transfer, card, QR. All four stay on screen; card and QR get real provider integrations later.
- Default screen = current order + menu, nothing else. Settings/reports/admin live behind a command palette and role views.
- Kitchen display: ONE column of tickets, colour = urgency only, one tap to bump. Owner view: ONE feed of insights, each with a one-tap action. No chart walls.
- Offline-first (power/internet are unreliable), silent background sync, real-time between counter, kitchen, owner phone.
- Anticipation behind a swappable `SuggestionsService`: prep load, stock forecast + supplier order draft, unusual voids/discounts, price/menu suggestions. Upsell prompts subtle and ignorable.
- Kitchen works from the SCREEN ONLY: no printed kitchen ticket or cancel slip, and no ticket-printing data. For now the kitchen has NO screen of its own: it shares the counter PC, and F2 (or the Kitchen chip) flips the whole screen between Register and Kitchen; a kitchen device comes later (owner, 2026-10-12). Arrivals, changes and cancellations chime and flash until tapped.
- Hardware-aware: the thermal printer (Xprinter XP-80T, USB, ESC/POS) is for the customer receipt and cash drawer only (drawer on the printer's RJ11 port); barcode scanner. The browser talks to it through the server on the counter PC (it is the SCRUM-71 helper), which sends raw ESC/POS to the Windows printer queue, not WebUSB, so the Windows printer driver stays intact.
- Multi-tenant and secure by default: role-based access, audit trail, encrypted data, per-shop isolation (`tenant_id` on every row).
- Sent items: only a manager/owner (PIN via `requireManager()`) may change or cancel them, in manager mode, with a short reason; the cashier has only the quick Undo right after Send; adding items is open to all.
- Manager mode (Ctrl+M → PIN; Esc or 10 s idle to leave): every manager change goes through `applyManagerChange()` / `manage()`, writes one audited event (who, when, before/after in cents) and returns an Undo. Discounts round once at order level, in integer cents. No confirmation dialogs, no banners, no PIN per action.
- Auth behind `AuthService` (`src/domain/auth.ts`); swap the fake in `src/services/auth.ts` only. All fake data lives in `src/fake/data.ts`. Every synced row (events, kitchen tickets) carries `shopId`.
- Orders are identified by number only. No name/phone fields until the CRM + loyalty slice.
- If a request adds clutter, push back and offer a simpler alternative. Lead with the decision or result; be concise.

## Premium feel
Feedback < 100ms, optimistic updates, skeletons not spinners; 150–250ms purposeful motion; one typeface (DM Sans), strict type scale, touch targets >= 48px; neutral base with one accent, true dark mode; readable at arm's length; fully keyboard-operable and touch-first.

## Local context
Currency LKR. Today: cash and bank transfer (no card machine yet); card and QR come later. Counter PC runs Windows 10 Pro. Staff have minimal training time. English, Sinhala and Tamil labels (si/ta are EMPTY until the owner supplies them — never guess translations).

## Engineering rules
- React 19 + TypeScript + Vite. Money is **integer cents** (1 LKR = 100), never floats.
- Pure domain logic in `src/domain` (menu, pricing, order math, parser) with tests; UI in `src/ui`.
- `src/domain/menu.ts` is copied from the printed menus; tests lock the prices. Change it only from the owner's menus.
- Design source of truth: the screens Register (light/dark), Extras sheet, Kitchen, Owner (tokens already in `src/ui/styles.css`). Kitchen colours: ok #30A46C, warn #E8A94B, bad #E5484D; Done button green.
- Commands: `npm run dev` · `npm test` (domain + UI) · `npm run build` (typecheck + build). Run all before finishing.
- Explain tech trade-offs briefly. Accessible, responsive, production-quality code.

## Status and next
See `ARCHITECTURE.md` (decisions, build order, open questions). Done: domain core, Register, Extras sheet, payment v0, Kitchen display (`/#kitchen`; "Send to kitchen" fires a ticket before payment, later rounds are "Added" tickets, Undo recalls; same-device tabs via BroadcastChannel), open orders "Waiting to pay", manager mode on branch `manager-mode` (discounts, Free, line adjustments, voids/edits with kitchen alerts, all audited), order event log. Sync server built (`server/`, MySQL on the counter PC, realtime stream; `docs/server-setup.md`): kitchen tickets are folded from events, so every kitchen change must be an event. Receipt + cash drawer built (`src/domain/receipt.ts`, `server/printer.ts`; the server is the printer helper; preview at `/#receipt`), untested on the real printer. Real PIN logins and roles built (SCRUM-40/41; the server checks every order event against the logins; F4 switches user; 5-minute idle lock; staff via `npm run server:staff`). Windows installer built (`deploy/windows/`, guide `docs/install-windows.md`: one PowerShell line installs everything; `update.ps1` with rollback, `status.ps1`, nightly `backup.ps1`); untested on Windows. The shop is in Thalwila, development in Galle: install and support remotely over AnyDesk. Cloud copy built and live (SCRUM-61, `docs/cloud.md`): Cloudflare Workers + D1 at cheesybeez-cloud.cheesybeez-cloud.workers.dev; the shop server copies its events there when online (`server/replicator.ts`); the shop PC stays the truth for selling. The project is a university software project meant to run in the real shop. **Next:** finish the Windows installer test on a friend's PC, then the shop install; then the Owner view, reading from the cloud.
Kitchen design details: header "Kitchen" + clock; ticket = order number + elapsed time (mm:ss) left, items middle (qty × name + size/mods; leave-outs in the urgency colour), Done button right; true-black ground, cards #1C1C1E, 5px left border in the urgency colour.
