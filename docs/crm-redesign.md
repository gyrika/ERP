# Customers redesign: implementation plan

**Status (2026-11-21):** phases 1 to 4 built on branch `customers-redesign`; tests and build pass. Not yet looked at in the running app (needs the shop's PIN and Customers on). The cloud must be deployed before the owner sends to Gone quiet (it checks a campaign's audience). "We miss you" shows how many times it was sent, not a came-in rate: automatic sends keep no comparison group yet.

Accepted design (2026-11-21): https://claude.ai/artifact/1Xr6PB1uBQNzSBUPxx96zU (three screens: Customers, One customer, Campaigns; light and dark).

**Mind served:** the owner (and managers) on the shop PC. What they know: their regulars by face. The one next thing: who to bring back, who owes, who to message, and whether it worked.

**Not changing:** the sidebar (`OwnerNav`), stored data, event types, the module switch, who may do what (sending and credit are the owner's; managers read). The owner's phone still shows counts only.

## Ground rules

- Every number on these screens is folded from data that exists today (`customers.ts`, `credit.ts`, `campaignResults.ts`, the event log). Nothing is typed in by staff, and nothing new is stored.
- Pure logic in `src/domain/crmPage.ts` with tests; UI in `src/ui/customers/`. Money stays integer cents.
- Copy never assumes gender: use the customer's first name or "this customer" (the mock's "him/his" is not shipped).
- Touch targets at least 48px: the mock's 36px pills get a 48px hit area.
- Charts are plain divs/inline SVG (no chart library); `role="img"` with an `aria-label` that says the number.
- Dark mode reads the existing tokens. New tokens in `styles.css`: `--seg-new` (= `--reserved`), `--seg-vip` (= `--gold`), `--seg-idle` (light `#CFCBC5`, dark `#48484A`).

## Before starting

1. Land the open `customer-credit` work (6 modified files) and merge it to main.
2. One Jira story in SCRUM, "Customers redesign", with one sub-task per phase below. Branch `SCRUM-<n>-customers-redesign` from main.

## Phase 1 · Domain: `src/domain/crmPage.ts` (+ `crmPage.test.ts`)

| Function | Feeds | Built from |
|---|---|---|
| `rhythmOf(visits, now)` → `{ usualDays, lastAt, nextAt, quietFrom } \| null` | "Comes about every 6 days, next likely Thursday" | median gap between visits; null under `REGULAR_VISITS` (3) |
| `isGoneQuiet(visits, now)` | Gone quiet filter, card, audience | the rule already in `customerInsights.ts` (away > 2× usual gap, ≥ 14 days, not yet Inactive). Refactor `quietRegulars` to call it so To do and Customers always agree |
| `weekStrip(visits, now, weeks)` → per week `{ visits, size: 's'\|'m'\|'b', credit }` | 12-week dots on list rows; 26-week timeline on a customer | visits + `credit.ts` bills; size buckets from that customer's own bills (thirds) |
| `comingBack(events, now, 12)` → per week `{ returning, first }` + this week's share | "Coming back" chart | `visitsFromEvents`: a visit is "first" when it is that customer's first ever |
| `favourites(orders, 4)` → `{ itemId, size, n }[]` | "What they buy" bars | `customerOrders` lines, combo dishes included |
| `usualLeaveOut(orders)` → `{ optionId, itemId, n, of } \| null` | "Leaves out onion on 14 of 18" | `OrderLine.outs`; shown only at ≥ 3 times and ≥ 50% of that dish |
| `usualTime(visits)` → `{ weekday, from, to } \| null` | "Usually Fri, 7–9 pm" | Sri Lanka time; shown only when ≥ 40% of visits fall in one weekday + 2-hour window |
| `averageBill(visits)`, `shopAverageBill(events, now, 90)` | Average bill tile | standing sales |
| `needsYou(...)` → up to 3 cards | top of Customers | gone-quiet count; credit owed / overdue / near limit (`creditInsights.ts`); new this month + how many signed up in the app (`source: 'app'`) |
| `reachFunnel(customers, withApp)` → `{ total, signedUp, reachable, optedOut }` | Campaigns, top | `CrmData` |
| `signupsByMonth(customers, now)` → `{ thisMonth, lastMonth }` | "Grow it" note | `source: 'app'` + `createdAt` |

**Dropped from the mock:** "take away, 31 of 41". `order.paid` does not carry dine-in/take-away, and adding it is not worth a new event field for one line.

## Phase 2 · Customers list (`CustomerList.tsx`, `CustomersView.tsx`)

- Header: "Customers", "N people · N get offers", the Customers / Campaigns / Import tabs as one segmented control (same hrefs), **Add customer** (the existing `AddCustomer` form opens under it).
- `NeedsYou.tsx`: up to three cards, each one sentence + one link: Gone quiet → `#customers/campaigns?to=quiet`, Owed → `#customers/owes`, New → the New filter. No card when there is nothing to say.
- `SegmentBar.tsx`: one bar split New / Regular / VIP / Inactive; each part is a button that sets the filter; counts under it.
- `ComingBack.tsx`: 12 columns, returning vs first visit, one sentence above ("89% of named orders this week were from people who had been before").
- List card: search (name or last digits, unchanged logic), pills All · New · Regular · VIP · Inactive · **Gone quiet** · Owes, rows: initials, name + mobile, segment dot (+ "Gone quiet" tag), `WeekStrip.tsx`, orders, last came (relative: "2 days ago"), spent, owes. A row is a link to the customer. The Owes table view stays as it is, restyled.
- Keep the 200-row cap and the skeleton.

## Phase 3 · One customer (`CustomerProfile.tsx`, `CreditPanel.tsx`)

- Header: initials, name, segment, "Gets offers" (or "No messages"), mobile · source · since; **Change** (existing `EditForm`) and **Start an order**.
- **Start an order:** opens the Register with the customer on the bill through the same path the Customer bar uses (`order.customer`). If the bill already has lines, it is held and a new bill starts (Decided, 1).
- Rhythm card (`rhythmOf` + 26-week `weekStrip`); for fewer than 3 visits it says "Too early to tell: N visits so far".
- Tiles: Orders, Spent (+ this month), Average bill (vs the shop), Usually (or hidden).
- "What they buy" (`favourites`, `usualLeaveOut`, and the Register's usual from `usualOrder.ts`, so both show the same thing).
- Credit: restyle `CreditPanel` only. Same events, same owner-only rule, same Undo. Off / With a limit / No limit as one segmented control, owes vs limit bar with the 80% mark, oldest open bill (days + ORDER badge), last paid, Take payment, Statement.
- Messages line: signed up / not / opted out, with the one-tap opt-out as now. **New server route** `/customers/messages {id}` → the last campaign that reached them (from the `campaign:<id>:<customerId>` keys `server/crm/store.ts` already logs) and the first visit after it. Names never leave the shop PC.
- Bills: date, ORDER badge, items + leave-outs, paid by (Cash / Bank transfer / Credit · open in amber, from `SaleRow.tender` + `credit.ts`), total. 10 shown, then "All N bills".
- Remove customer: unchanged behaviour, quiet at the bottom.

## Phase 4 · Campaigns (`CampaignsPanel.tsx` + server)

- Reach card: `reachFunnel` bars + "Grow it" (`signupsByMonth`) pointing at the receipt words.
- Compose: audience pills **with reach counts**, title/message with counters (60/180, unchanged), the live **phone preview** (`PushPreview.tsx`), Send to N, Test to my number. The "can't be called back" line stays.
- **"Gone quiet" audience:** add `'quiet'` to `Audience` and `AUDIENCE_LABEL` (`campaigns.ts`); `server/crm/push.ts` `audience()` picks it with `isGoneQuiet`; its results and comparisons work as for any audience. **New route** `/campaigns/reach-all` returns every audience's `{ customers, reachable }` in one call (one call instead of six).
- We miss you: On/Off switch, words edited in place, and its result over all sends (sum of each auto send's `campaignResult`: came in within 7 days vs others like them).
- On the receipt: the two fields + a small receipt preview drawn from the same lines `receipt.ts` prints.
- What they brought: date, message + audience, reached, came-in bar with the comparison mark ("others like them"), Rs brought + orders. Managers see this table only, as today.

## Phase 5 · Finish

- UI tests: update `customers.ui.test.tsx`, `creditPanel.ui.test.tsx`; new tests for filters (segment bar, Gone quiet), Start an order, the audience counts, the phone preview. Domain tests for every Phase 1 function (edge cases: no visits, one visit, test-data cut, payment undone).
- Check in the app: light/dark, 1366×768 counter PC, phone width, keyboard only.
- `npm test`, `npm run build`, then the ship-slice skill (CLAUDE.md status + ARCHITECTURE.md).

Phases 2, 3 and 4 each ship on their own once Phase 1 is in. One PR per phase keeps reviews small.

## Decided (user, 2026-11-21)

1. **Start an order while the bill has items:** starts a new bill. The bill on screen is held (as HOLD F7 does, with its Undo) and the customer goes on the new, empty bill. An empty bill on screen is simply used.
2. **"Gone quiet" is a campaign audience**, as well as the automatic "We miss you" at 30 days.
