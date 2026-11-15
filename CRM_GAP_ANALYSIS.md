# CRM gap analysis — CheesyBeez ERP

Date: 2026-11-16 · Branch read: `cashier-sent-changes` (CRM code as merged in PR #159 and #161) · No application code changed.

## Checklist

- [x] Domain logic (`src/domain/customers.ts`, `customerInsights.ts`, `campaigns.ts`, `campaignResults.ts`, `customerImport.ts`, `modules.ts`)
- [x] Database tables and migrations (SQLite `server/sqlite/003-crm.sql`, `004-crm-push.sql`; MySQL `server/migrations/004-crm.sql`, `005-crm-push.sql`; cloud D1 `cloud/migrations/0014_push.sql`)
- [x] Stores and encryption (`server/crm/store.ts`, `sqlite.ts`, `mysql.ts`, `crypto.ts`)
- [x] Routes and permissions (`server/crm/routes.ts`, `server/app.ts:339-376`, `src/domain/auth.ts:113`, `server/validate.ts:100-107`)
- [x] Background jobs (`server/crm/jobs.ts`, `server/main.ts:158-175`)
- [x] Notifications / push (`server/crm/push.ts`, `webpush.ts`, `cloud/src/push.ts`, `src/order/Offers.tsx`, `public/order-sw.js` — the service worker was not opened, see "needs verification")
- [x] Screens (`src/ui/customers/*`, `src/ui/PayPanel.tsx`, `src/services/crmClient.ts`)
- [x] Links to the rest of the ERP (sales/payments, receipt, owner To do, online orders, delivery, Uber Eats, test-data clear, backups)
- [x] Tests (ran 60 domain/server tests: 59 pass, 1 skipped — MySQL, no `TEST_DATABASE_URL`; 12 UI tests pass)
- [x] Comparison with a complete CRM
- [x] Automation opportunities
- [x] Solutions, roadmap, questions
- [x] One-page management summary

### Read this first: what kind of CRM this is

The comparison list in the brief is a **B2B sales CRM** (leads, pipeline, quotations, sales reps, support SLAs). CheesyBeez is a **walk-in and online pizza shop**: there are no sales reps, no quotations and no deals. Several items are therefore marked **Not applicable** rather than "missing". The decisions already made by the product owner are respected throughout and are not re-raised as gaps:

- The CRM is a **module the developers switch on** (`#unlock`), not the owner.
- **No SMS or paid channel**: messages are Web Push through the CheesyBeez app (a TWA of cheesybeez.com).
- **The owner's phone sees counts only**; names and numbers stay on the shop PC, encrypted.
- **Campaigns are the owner's alone.**
- Security audit items accepted by design (shared counter sessions, client-set `at`, etc.) are not repeated. SA-09 (anyone can sign up any number) is **on hold** and listed once as a known open item.

---

## 1. Current state

### 1.1 Features that exist

| Area | What exists | Where |
|---|---|---|
| Module switch | CRM on/off per shop as a `shop.module_set` event; off = routes 404, no sidebar part, no Mobile field, jobs idle, data kept | `src/domain/modules.ts`, `server/crm/routes.ts:59-65`, `src/ui/OwnerNav.tsx:36` |
| Customer record | One per mobile number per shop: id `cus-…`, phone, name, source (`pos`/`import`/`manual`/`app`), opted-out flag, created at | `src/domain/customers.ts:24-33` |
| Encryption | Phone, name and push subscription sealed with AES-256-GCM; phone found by keyed HMAC; key in `<data>\crm.key` | `server/crm/crypto.ts` |
| Capture at Charge | Optional Mobile field; typing `0` or `+` jumps to it; lookup shows first name; new number created as the payment goes in; the sale never waits more than 2 s | `src/ui/PayPanel.tsx:48-72`, `crmClient.ts:52-53` |
| Link to sales | `order.paid.customerId` (opaque id only, never the number) | `src/domain/events.ts:30-34`, `src/ui/useRegister.ts:301` |
| Import | .xlsx / .csv / .txt (UTF-8 and UTF-16), auto-detects columns (Sinhala/Tamil headers too), duplicate rows, invalid numbers, preview then save, re-plan on save, 5,000 rows max | `src/domain/customerImport.ts`, `server/crm/importFile.ts`, `src/ui/customers/ImportPanel.tsx` |
| Manual add | Number + optional name, refuses a number already on the list | `routes.ts:130-139`, `CustomerList.tsx` |
| Customer list | Tiles (total, new this month, active, inactive, came-back rate, have the app), top 3 spenders, segment filter, search by name/number, 200 rows shown | `src/ui/customers/CustomerList.tsx` |
| Profile | Orders, spent, first/last visit, segment, source, app yes/no, opt-out toggle, purchase history line by line, owner-only erase with Undo | `src/ui/customers/CustomerProfile.tsx` |
| Segments | New / Regular / VIP / Inactive, computed live from sales (not stored) | `customers.ts:118-182` |
| Push sign-up | Customer gives mobile on cheesybeez.com (or the receipt's QR), allows notifications; cloud keeps it as a letterbox until the shop PC collects it (max 30 days) | `src/order/Offers.tsx`, `cloud/src/push.ts`, `jobs.ts:267-283` |
| Receipt QR | "Get our offers on your phone" QR while CRM is on, not on reprints | `src/domain/receipt.ts:36-44, 130-137` |
| Campaigns | Owner picks audience (Everyone/New/Regular/VIP/Inactive), title ≤ 60, body ≤ 180, sees reach before sending, test to own number | `src/ui/customers/CampaignsPanel.tsx`, `server/crm/push.ts:98-115` |
| Automation | "We miss you": hourly job, 10:00-19:59 Sri Lanka time, to customers who became Inactive in the last 7 days, once per quiet spell; off until the owner turns it on | `push.ts:141-164`, `jobs.ts:285-289` |
| Campaign results | Per campaign: how many reached came in within 7 days and spent what, beside the unreachable part of the same audience | `src/domain/campaignResults.ts`, `push.ts:121-135` |
| Owner To do | "N regulars have gone quiet" card (away > 2× their usual gap, 14-29 days, at least 2 people) with "Send an offer" | `src/domain/customerInsights.ts` |
| Owner phone | "Offers this week" card with counts only | `src/domain/insights.ts:455-475` |
| Privacy | Opt-out respected by every send; erase (PDPA) removes row, phones and send log; past sales keep only the opaque id | `store.ts:27-35`, `sqlite.ts:262-271` |

### 1.2 Tables

| Table | Database | Purpose |
|---|---|---|
| `crm_customers` | shop SQLite / MySQL | The list (sealed phone + name, hash, source, opt-out, who/when) |
| `crm_push_subs` | shop | One row per phone that allowed notifications (sealed), cascades on customer delete |
| `crm_push_log` | shop | Dedupe of sends (`campaign:<id>:<cus>`, `winback:<cus>:<last visit>`) and the comparison group (`compare:<id>:<cus>`) |
| `push_keys` | cloud D1 | The shop's VAPID public key, for the app |
| `push_inbox` | cloud D1 | Sign-ups / stops waiting for the shop PC (phone in plain text, ≤ 30 days) |
| `events` (`crm.campaign_sent`, `crm.auto_set`, `shop.module_set`, `order.paid.customerId`) | everywhere (synced) | Counts and settings only, never a number or name |

### 1.3 Flows

```
Counter:  Charge → Mobile (optional) → /crm/lookup (first name) → Pay → /crm/ensure → order.paid{customerId}
App:      cheesybeez.com#offers → mobile + allow → cloud push_inbox → (every minute) shop PC applyInbox → crm_customers + crm_push_subs
Owner:    Customers › Campaigns → reach → Send → push to each phone → crm.campaign_sent{counts} → owner phone card
Auto:     hourly → Inactive in last 7 days + app + not opted out → "We miss you" → crm.campaign_sent{kind:auto}
Insight:  events → quietRegulars → To do card → #customers/campaigns
```

### 1.4 Integrations with other modules

| Module | Connected? |
|---|---|
| Register sales | Yes, by `order.paid.customerId` |
| Receipt printer | Yes, offers QR |
| Owner To do / phone | Yes, two cards |
| Test-data clear (`freshStart.ts`) | Yes for visits (`customers.ts:60`); **not** for campaigns (see P-13) |
| Online orders / delivery (cheesybeez.com) | **No** — the customer's phone and name stay with the online order only (`src/domain/online.ts:12`) |
| Uber Eats | No (by nature: Uber owns the customer) |
| Inventory, purchasing, money out, Visual Flow | No (no reason to) |
| Staff / roles | Yes: list = managers + owner; campaigns/erase = owner; Charge lookup = any counter role except kitchen |
| Backups | SQLite nightly copy includes CRM tables, on the same disk (see P-6) |
| Cloud copy | Events only; the customer list is never in the cloud by design |

---

## 2. Problems

Severity reflects what goes wrong for the shop. "Confirmed" means read in code; nothing here was reproduced in the running app.

| # | Problem | File:line | What goes wrong for the user | Severity |
|---|---|---|---|---|
| P-1 | **"Send an offer" on the quiet-regulars card opens Campaigns with the wrong audience.** The card links to `#customers/campaigns`; the panel always starts on `inactive`. Quiet regulars are away 14-29 days, so they are *never* Inactive (30+ days); they sit inside Regular/VIP. There is no "quiet" audience at all. | `customerInsights.ts:281`, `CampaignsPanel.tsx:20,24` | Owner taps "Send an offer" for 3 drifting regulars and, if he just writes and taps Send, the message goes to the long-gone Inactive group instead. If he picks Regular, it goes to *every* regular, including the ones who were in yesterday. | High |
| P-2 | **A slow or interrupted campaign can be sent twice, or leave no record.** Sends run one phone after another inside the HTTP request (5-minute client timeout); the `crm.campaign_sent` record is written only after the loop. A network blip, timeout or server restart mid-send means pushes went out but no record exists; the owner sees an error and taps Send again, which gets a new id and so passes the dedupe. | `push.ts:63-80, 105-114`, `crmClient.ts:64`, `CampaignsPanel.tsx:58-64` | Customers get the same offer twice; the Sent list and owner phone show nothing for the first send; results are lost. | High (grows with list size) |
| P-3 | **Segment rules cannot be changed, though half the code for it exists.** `SegmentRules` + `checkSegmentRules` ("the settings screen and the server both ask") exist, but every caller passes `DEFAULT_SEGMENT_RULES`; there is no setting, event or screen. VIP = Rs 15,000 in 90 days or top 10%, Inactive = 30 days, fixed. | `customers.ts:140-151`; callers `push.ts:52,147`, `CustomerList.tsx`, `CustomerProfile.tsx:138`, `customerInsights.ts:255` | The owner cannot match "VIP" or "Inactive" to his shop. Dead code suggests a feature that does not exist. | Medium |
| P-4 | **A customer's name or number cannot be corrected.** No edit route or screen. Name changes only through re-import with "rename"; a changed number means a new customer, splitting history. No merge of two records. | `routes.ts:103-231` (no edit), `CustomerProfile.tsx` | Typos at Add stay forever; a regular who changes SIM loses their history and segment. Contradicts the store's own promise "can be corrected" (`store.ts:7`). | Medium |
| P-5 | **Online and delivery customers never reach the CRM.** Online orders carry name + phone, but the order is paid at the Register with an empty Mobile field, so no `customerId`. | `src/domain/online.ts:12, 188`, `App.tsx:450`, `PayPanel.tsx:38-72` | The shop's most identifiable customers (delivery: name, number, address) are missing from segments, campaigns and results; cashiers would have to re-type the number. | High |
| P-6 | **The customer list has no off-machine copy.** It lives only on the shop PC (by design, not in the cloud). The nightly SQLite backup is written to `<data>\backups` on the same disk, next to `crm.key`. A cloud rebuild restores events but not customers. MySQL shops get no backup from `sqliteBackup.ts` at all. | `server/sqliteBackup.ts:14-20`, `crypto.ts:177-188` | A dead disk or stolen PC loses every customer, phone sign-up and the VAPID key (all app sign-ups must be redone). Past sales keep ids that name nobody. *Needs verification:* whether Station copies backups anywhere else. | High |
| P-7 | **No audit trail for customer-list changes.** Add, import, opt-out, erase and restore only touch `updated_by/updated_at`; erase leaves no trace of who erased whom or when. | `routes.ts:122-193`, `sqlite.ts:262-283` | The owner cannot answer "who removed this customer / turned off their messages?"; conflicts with the project rule "audit trail". A count-only event (no number, no name) would keep privacy. | Medium |
| P-8 | **Erasing a customer silently changes past campaign results** (their `campaign:`/`compare:` log rows are deleted), and Undo cannot bring those rows or the phone sign-ups back. | `sqlite.ts:266`, `mysql.ts:76`, `push.ts:130-131` | "3 of 40 came in" quietly becomes "3 of 39" later; a restored customer has to sign up in the app again without being told. | Low |
| P-9 | **MySQL erase is not one transaction** (three separate DELETEs). | `mysql.ts:73-80` | A failure half-way leaves a customer with no phones, or phones without a customer log. MySQL push/erase paths are also untested (only "the import story" exists, and it is skipped without a DB: `store.test.ts:109`). | Low |
| P-10 | **Restore trusts the whole customer object from the screen** (id, phone, source, createdAt). | `routes.ts:151-162` | Owner-only, so low risk, but a crafted call can attach an old customer id (and so its sales history) to a different number. A server-kept "recently removed" copy would close it. | Low |
| P-11 | **Any cashier can look up first names by number, unlimited.** | `routes.ts:165-169` | A cashier can probe numbers to learn who is a customer. Small shop, trusted team: acceptable, but worth a rate limit. | Low |
| P-12 | **Test send to the owner's own number gives a misleading message** when the number is on the list but has no app sign-up (reachable 0 → "is the app still allowed to notify?"). | `push.ts:44-48`, `CampaignsPanel.tsx:71` | Owner troubleshoots notification settings when the real cause is "not signed up". | Low |
| P-13 | **Campaigns ignore the owner's test-data clear.** Visits use `withoutTestData`; `campaignsFromEvents` and `winbackFromEvents` do not. | `campaigns.ts:365-375` | Test campaigns from before "Start fresh" still show on Sent and the owner's phone card. | Low |
| P-14 | **Whole history held in memory and re-folded on every request/render.** `crmApi.history` caches every event of the shop forever; `visitsFromEvents`/`segmentsOf` re-run over the full log for each list, reach, results and winback; `standingSales` copies arrays per event. | `routes.ts:47-58`, `customers.ts:56-81` | Fine today; after a year or two of events, Customers and Send get slower and the server's memory grows. *Needs measurement* on the shop PC. | Medium (later) |
| P-15 | **No frequency cap.** A customer can get "We miss you" and an owner campaign the same day, and campaigns back to back. | `push.ts:63-80` | Customers turn notifications off; the channel loses value. | Medium |
| P-16 | **"Spent" includes the delivery fee.** Visit total = `order.paid.total`. | `customers.ts:88` | VIP and top-spender lists slightly favour delivery customers. | Low |
| P-17 | **Docs are out of date.** `ARCHITECTURE.md:21` still says "No name or phone field until the CRM + loyalty card slice"; the CLAUDE.md status list does not mention the CRM. | `ARCHITECTURE.md:21`, `CLAUDE.md` | New team members (and Claude) get a wrong picture of what exists. | Low |
| P-18 | **Known, on hold (SA-09): anyone can sign up any number in the app.** No proof the phone belongs to the person. | `cloud/src/push.ts:43-66` | Someone else's offers (segment-based) can be received by a stranger; fake numbers inflate the list. Proposed fix already agreed: a per-receipt claim code. | Medium (on hold) |
| P-19 | **Sign-up numbers sit unencrypted in the cloud** for up to 30 days while the shop PC is offline. | `cloud/src/push.ts:64-65`, `0014_push.sql:12-18` | Small exposure window; everything else about phones is sealed. Could be sealed with the shop's public key. | Low |
| P-20 | **Erased customers stay in nightly backups for 14 days.** | `sqliteBackup.ts:14` (`keep = 14`) | A PDPA erasure is not complete until the backups roll over. Usually acceptable if documented. | Low |

Not problems (checked and fine): devices cannot forge `crm.*` events (`server/app.ts:163-164`); `order.paid.customerId` is validated as an opaque id (`validate.ts:104-107`); import re-plans on save so a double Save adds nobody (`routes.ts:183-193`); failed winback sends are retried next hour (`push.ts:77`); push payloads are end-to-end encrypted (`webpush.ts`).

---

## 3. Gaps against a complete CRM

Legend: **Have** · **Partial** · **Gap** · **N/A** (does not fit a pizza shop; listed so management sees it was considered).

| Area | Item | Status | Notes |
|---|---|---|---|
| Leads | Capture: web form | Have | App/website sign-up + receipt QR |
| | Capture: import | Have | Strong (encodings, Sinhala/Tamil, preview) |
| | Capture: API | Gap | No external API; only needed if a loyalty/partner system appears |
| | Capture: online orders | **Gap** | P-5 |
| | Duplicate detection | Partial | Exact number only; no merge (P-4) |
| | Scoring | Partial | 4 fixed segments; no editable rules (P-3); no lifetime value |
| | Automatic assignment | N/A | No sales reps |
| Contacts | One record shared with ERP | Have | By opaque id on sales |
| | Companies | N/A / question | Only if catering or office orders matter (Q-6) |
| | Full history in one view | Partial | Purchases only; no messages received, no online orders, no opt-out history, no notes |
| | Favourite items / "the usual" | **Gap** | CLAUDE.md principle "repeat customers get the usual in one tap" is not built; the number is typed at Charge, after ordering |
| Pipeline | Stages, probability, forecast, won/lost | N/A | No deals. The equivalent is the customer lifecycle New → Regular → VIP → quiet → Inactive, which exists |
| Activities | Calls, meetings, tasks, reminders, calendar | N/A mostly | A free-text **note** (e.g. "allergic to nuts") is the only one that may matter (Q-4) |
| Quote to cash | Lead → quote → order → invoice → payment | N/A | Walk-in POS. The real chain (order → payment → customer) works at the counter, breaks for online orders (P-5) |
| Communication | Email | N/A by decision | No email captured |
| | SMS/WhatsApp | N/A by decision | Push only (owner decision 2026-11-11) |
| | Templates | Gap | Every campaign typed from scratch; only "We miss you" is saved |
| | Logged against customer | Partial | `crm_push_log` knows, the profile does not show it |
| | Languages | Gap | Messages English only; si/ta labels empty until the owner supplies them |
| After-sales | Tickets, SLA, escalation | N/A | No support desk |
| | Customer feedback | Gap | No rating or complaint capture (Q-5) |
| Marketing | Segments | Partial | 4 fixed; no "quiet regulars" audience (P-1); no custom segment (e.g. "bought pizza, never pasta") |
| | Campaigns | Have | Push, owner-only, reach preview, test send |
| | Scheduled send | Gap | Send now only |
| | Follow-up sequences | Partial | One automation ("We miss you") |
| | Offer redemption | Gap | Results = "came in within 7 days", not "used the offer"; no code or menu link |
| | Loyalty (points / stamps) | Gap | Mentioned in ARCHITECTURE.md as a future slice |
| | Birthday / anniversary | Gap | No date of birth captured (Q-3) |
| | Frequency cap | Gap | P-15 |
| Reporting | Dashboard | Have | Tiles, top spenders, campaign results, owner cards |
| | Conversion / capture rate | Gap | Share of sales with a mobile number, per cashier and per day — the key health number of this CRM |
| | Retention / cohorts | Partial | "Came back" rate only; no month-by-month retention |
| | Customer lifetime value | Gap | Spent is there; no average or forecast |
| | Sales rep performance | N/A | Closest equivalent: cashier capture rate (above) |
| Platform | Roles and permissions | Have | Manager list, owner campaigns/erase, counter lookup |
| | Audit log | **Gap** | P-7 |
| | Import | Have | |
| | Export | Gap | No CSV export (may be deliberate for privacy; Q-7) |
| | API / webhooks | Gap | Not needed today |
| | Mobile use | Have by design | Owner phone sees counts only |
| | Backup / restore | **Gap** | P-6 |
| | Module switch | Have | |

---

## 4. Automation opportunities

Anything that messages a customer or touches money keeps a human approval step, as the brief asks and as the owner's "campaigns are mine" decision requires.

| Manual step today | Automated version | Trigger | Approval |
|---|---|---|---|
| Cashier re-types an online customer's number at Charge (or doesn't) | Online/delivery order carries its phone to the payment; the shop server links (`ensure`, source `online`) | `order.paid` of an online order | None (no message, no money) |
| Owner notices quiet regulars on To do, then picks an audience by hand | To do card opens Campaigns with a ready **"Gone quiet"** audience (exactly those customers) and a suggested message | `regularsGoneQuiet` card | **Owner taps Send** |
| Owner writes each campaign from scratch | Saved templates; draft suggestions for the slow day of the week (from sales-by-hour data) | Weekly scheduled job builds a **draft** | **Owner approves** |
| Owner sends now or forgets | Schedule a campaign for a time (Friday 4 pm) | Shop server timer | Approved at scheduling time |
| "We miss you" is the only automatic message | Owner-approved set of automatic messages: second-visit nudge (New, no return in 14 days), quiet-regular nudge, VIP thank-you after Nth visit | Daily job on segment changes | **Each automation switched on by the owner once, with its words**; frequency cap applies |
| Owner checks campaign results by opening Customers | Owner phone card after 7 days: "Weekend offer: 12 of 80 came in, Rs 18,400" | 7 days after `crm.campaign_sent` | None |
| Nobody watches the capture rate | To do card when the share of sales with a mobile drops (e.g. one cashier at 2% vs others 20%) | Daily fold over `order.paid` | None |
| Segment movements are invisible | Daily counts of New → Regular → VIP and → Inactive on the owner's Today | Daily | None |
| Dead push subscriptions removed only when a send fails | Already automatic (`gone` → `removeSub`) | — | — |
| Customer list backed up only on the same disk | Encrypted nightly copy off the machine (to the cloud as an opaque blob the cloud cannot open, or a USB drive) | Nightly backup job | None |
| Offer redemption checked by "came in within a week" | Offer linked to a menu item / combo; when that item is sold to a reached customer, it counts as redeemed | `order.paid` with `customerId` | Discounts still need manager PIN (unchanged) |
| Erasure requests handled by the owner from memory | Customer asks in app "forget me" → queued for the owner's one tap | App request → To do | **Owner confirms** (no auto-delete) |

---

## 5. Solutions

| # | For | What to build or change | Files / tables | Size | Impact |
|---|---|---|---|---|---|
| S-1 | P-1 | Add audience `quiet` (= `quietRegulars` ids, computed on the shop PC); the To do link becomes `#customers/campaigns?to=quiet`; Campaigns reads it. | `campaigns.ts` (Audience), `customerInsights.ts` (export ids on the server side only), `push.ts:41-60`, `CampaignsPanel.tsx`, `campaigns.test.ts` | S | High |
| S-2 | P-2 | Record the campaign **first** as `crm.campaign_started` (id, audience, words), send in the background on the server, then `crm.campaign_sent` with counts; screen shows "Sending… 40 of 120" and the result; a second Send of the same words to the same audience within 10 minutes is refused. Send in small parallel batches (e.g. 10 at a time). | `push.ts`, `routes.ts:203-209`, `campaigns.ts` (event), `validate.ts`, `CampaignsPanel.tsx`, `crmClient.ts:64` | M | High |
| S-3 | P-3 | Either **delete** `checkSegmentRules`/`SegmentRules` parameters (simplest, matches "almost no UI"), or add one owner-only `crm.rules_set` event read everywhere `DEFAULT_SEGMENT_RULES` is used. Recommend: ask the owner (Q-1) and delete if he is happy with defaults. | `customers.ts`, all callers listed in P-3 | S (delete) / M (setting) | Medium |
| S-4 | P-4 | `POST /crm/customers/edit` (name; number with a check that the new number is free) and **Merge** (move sales by writing a `crm.customer_merged{from,to}` id-only event that `visitsFromEvents` follows). Profile gets "Change" and "Same person as…". | `routes.ts`, `store.ts`/`sqlite.ts`/`mysql.ts` (update), `customers.ts`, `CustomerProfile.tsx` | M | Medium |
| S-5 | P-5 | When an online/delivery order is paid, the counter passes the order's phone to `/crm/ensure` (source `online`), exactly as the Mobile field does; nothing new on screen. Add `online` to the source CHECK/ENUM (migration). | `App.tsx:450`, `PayPanel.tsx`, `customers.ts:22`, new migrations `server/sqlite/005-…`, `server/migrations/006-…` | S-M | High |
| S-6 | P-6, P-20 | Nightly **encrypted** copy of the CRM tables + `crm.key` + `crm-vapid.json` off the machine; documented restore. Options: (a) USB drive path in Settings; (b) the cloud as a sealed blob it cannot read. Document the 14-day erasure tail. | `server/sqliteBackup.ts`, `deploy/station/station-update.ps1`, `docs/install-windows.md` | M | High |
| S-7 | P-7 | One id-only event per list change: `crm.customer_added/opted_out/opted_in/erased/restored/imported{count}` with actor, never number or name. Shows in the owner's audit view. | `routes.ts`, `campaigns.ts` (types), `validate.ts`, `auth.ts:113` | S | Medium |
| S-8 | P-8 | On erase, keep the log rows but replace the customer id with a placeholder (`erased`) so counts stay; tell the owner on Undo that app sign-ups need redoing. | `sqlite.ts:262-271`, `mysql.ts:73-80`, `CustomerProfile.tsx:148-155` | S | Low |
| S-9 | P-9 | Wrap MySQL `remove` in a transaction; add MySQL tests for push subs/log/erase; run them in CI with a MySQL service. | `mysql.ts`, `store.test.ts`, CI workflow | S | Low |
| S-10 | P-10 | Server keeps the removed row (sealed) for 60 s; `restore` takes only the id. | `routes.ts:142-162`, `store.ts` | S | Low |
| S-11 | P-11 | Rate-limit `/crm/lookup` per staff (e.g. 30/min). | `routes.ts:165-169` | S | Low |
| S-12 | P-12 | Distinguish "not on the list" / "on the list, no app" / "app, but delivery failed" in the test result. | `push.ts:44-48`, `CampaignsPanel.tsx:71` | S | Low |
| S-13 | P-13 | Run `withoutTestData` in `campaignsFromEvents` and `winbackFromEvents`. | `campaigns.ts:365-375`, tests | S | Low |
| S-14 | P-14 | Keep a running fold (visits per customer) updated as events arrive instead of re-reading the whole log; replace per-event array copies in `standingSales`. Measure first with a year of seeded events (`scripts/crm-dev-seed.ts`). | `customers.ts`, `routes.ts:47-58` | M | Medium (later) |
| S-15 | P-15 | Frequency cap in `deliver`: at most one message per customer per N days (Q-2), automatic messages yield to the owner's campaigns. | `push.ts:63-80`, `crm_push_log` (query by `customer_id, sent_at` — add index) | S | Medium |
| S-16 | P-16 | Visit total = what was paid minus delivery fee (the ledger already knows the fee). | `customers.ts:84-93` | S | Low |
| S-17 | P-17 | Update `ARCHITECTURE.md:21` and the CLAUDE.md status with the CRM. | docs | S | Low |
| S-18 | P-18 | Already agreed: per-receipt **claim code** in the offers QR instead of a typed number. | `receipt.ts`, `Offers.tsx`, `cloud/src/push.ts`, `push.ts:170-185` | M | Medium |
| S-19 | P-19 | App seals the sign-up to the shop's public key before it reaches the cloud. | `Offers.tsx`, `cloud/src/push.ts`, `push.ts` | M | Low |
| G-1 | Capture rate | Owner card + Customers tile: share of paid orders with a customer, today vs usual, by cashier. | `customerInsights.ts`, `CustomerList.tsx` | S | High |
| G-2 | "The usual" | On the Register, an optional number **before** ordering (same Mobile field logic) shows the customer's last order as one chip: tap = add it. Keep it one chip, no panel. | `customers.ts` (last order fold), `App.tsx`, Register order panel | M | High |
| G-3 | Templates | Last 5 sent messages offered as "Use again". No template manager. | `CampaignsPanel.tsx` | S | Medium |
| G-4 | Scheduled send | `crm.campaign_scheduled{at}` + server timer, cancellable until it fires. | `push.ts`, `jobs.ts`, `CampaignsPanel.tsx` | M | Medium |
| G-5 | More automations | Second-visit nudge, VIP thank-you, each off until the owner turns it on with its words (same shape as "We miss you"). | `push.ts`, `campaigns.ts`, `CampaignsPanel.tsx` | M | Medium |
| G-6 | Profile history | Show messages received (from `crm_push_log`) and online orders. | `CustomerProfile.tsx`, `routes.ts` | S | Low |
| G-7 | Offer redemption | Campaign optionally names a menu item/combo; results count customers who bought it in the week. | `campaigns.ts`, `campaignResults.ts` | M | Medium |
| G-8 | Loyalty | Visit stamps (e.g. 10th pizza free) computed from `order.paid.customerId`; the free item applied by the cashier's existing Free/discount path (manager PIN unchanged). | new `src/domain/loyalty.ts`, Register | L | High (if the owner wants it) |
| G-9 | Feedback | After a delivery is marked Delivered, the customer's order page asks one-tap 👍/👎; counts on the owner's Today. | `src/order/*`, cloud, `insights.ts` | M | Medium |
| G-10 | Languages | Campaign words in si/ta once the owner supplies them (never machine-guessed). | `campaigns.ts`, `CampaignsPanel.tsx` | S | Low |
| G-11 | Export | Owner-only CSV export of the list (if Q-7 says yes), logged as an event. | `routes.ts`, `CustomerList.tsx` | S | Low |

---

## 6. Roadmap

Kept to four phases, each usable on its own (the user asked for few phases).

**Phase 1 — Fixes and quick wins (about 1 sprint)**
S-1 quiet audience · S-2 safe sending · S-5 online customers into the CRM · S-13 test-data clear · S-12 test message · S-16 spent without delivery · S-17 docs · G-1 capture rate card.
*Outcome:* the To do card does what it says, campaigns cannot double-send, and delivery customers start counting.

**Phase 2 — Trust and data safety (about 1 sprint)**
S-6 off-machine encrypted backup · S-7 audit events · S-4 edit + merge · S-8 / S-9 / S-10 / S-11 small hardening · S-3 decide on segment rules · S-18 claim code (if the owner takes SA-09 off hold).
*Outcome:* the list can be corrected, survives a dead PC, and every change has a "who and when".

**Phase 3 — Automation with owner approval (about 1-2 sprints)**
S-15 frequency cap (first, before any new automation) · G-3 reuse past messages · G-4 scheduled send · G-5 second-visit and VIP messages · results card on the owner phone after 7 days · G-6 profile history.
*Outcome:* the shop runs a few always-on, owner-approved messages without the owner writing each one.

**Phase 4 — Advanced (when the owner asks)**
G-2 "the usual" · G-7 offer redemption · G-8 loyalty stamps · G-9 feedback · S-14 performance fold · S-19 sealed sign-ups · G-10 Sinhala/Tamil messages · G-11 export.

---

## 7. Questions for you (business decisions)

1. **Segments:** are VIP = Rs 15,000 in 90 days (or top 10%) and Inactive = 30 days right for CheesyBeez? Should the owner ever change them, or should we delete the unused settings code?
2. **Frequency cap:** at most how many messages per customer per week?
3. **Birthday offers:** do you want to collect date of birth (more data under PDPA) or skip birthdays?
4. **Notes on a customer** ("no onion", allergies): wanted, and who may see them (cashier at Charge, or managers only)?
5. **Feedback:** a one-tap rating after delivery/pickup — wanted? Shown only to the owner?
6. **Catering / office orders:** does the shop take large repeat orders from businesses? If yes, a light "company" record and order history may be worth it; if no, it stays N/A.
7. **Export:** may the owner download the customer list as CSV, or must it never leave the shop PC?
8. **Loyalty:** stamps (10th pizza free), points, or nothing? Who pays for the free item in reports?
9. **Backups off the PC:** USB drive, the cloud (sealed, unreadable there), or both?
10. **Online customers:** may an online/delivery customer be added to the CRM automatically from their order (they gave the number to get the food, not for marketing — they still receive nothing unless they sign up in the app)?
11. **SA-09:** take the claim-code fix off hold now, or after Phase 1?
12. **"The usual":** asking for the number before ordering adds a step for everyone else; is it worth it, or keep the number at Charge only?

---

## One-page summary for management

**What we have.** CheesyBeez has a working, privacy-first customer module, switched on per shop by the developers. Customers are recognised by mobile number at the till (optional, never slows the sale), imported from the owner's spreadsheet, or sign up for offers by scanning the QR on their receipt. Names and numbers are encrypted on the shop PC and never leave it; the owner's phone sees counts only. The owner can see who his regulars and VIPs are, what each bought, and who stopped coming; he can send free push notifications to any segment and see how many came in within a week. One automatic "We miss you" message runs by itself once the owner turns it on. 60 automated tests cover it and pass.

**What is wrong (fix first).**
1. The "regulars have gone quiet → Send an offer" shortcut opens the wrong audience; an offer can go to the wrong customers.
2. A slow or interrupted send can deliver the same offer twice and leave no record of it.
3. Online and delivery customers — the ones we know best — never enter the customer list.
4. The customer list has no copy outside the shop PC; a dead disk would lose it.
5. Changes to the list (who removed a customer, who turned off their messages) are not recorded.

**What is missing.** Correcting or merging customers, a "gone quiet" audience, scheduled sends, reusable messages, a limit on how often one customer is messaged, a measure of how many sales have a customer attached, and (if the owner wants them) loyalty stamps, "the usual" in one tap, and feedback. Sales-CRM features such as pipelines, quotations and sales reps do not apply to a pizza shop and are deliberately not proposed.

**Plan.**

| Phase | Focus | Effort | Result |
|---|---|---|---|
| 1 | Fixes and quick wins | ~1 sprint | Offers reach the right people, never twice; delivery customers counted |
| 2 | Trust and data safety | ~1 sprint | Off-site encrypted backup, audit trail, edit/merge |
| 3 | Owner-approved automation | 1-2 sprints | A few always-on messages, scheduled sends, results on the owner's phone |
| 4 | Growth features | on request | Loyalty, "the usual", feedback |

**Guardrails kept.** No SMS or paid channel; nothing is sent to a customer without the owner's approval; no money moves without the existing manager PIN; customer numbers stay on the shop PC.

**Decisions needed from the business:** segment thresholds, message frequency limit, loyalty yes/no, backup location, and whether online customers join the list automatically (full list in section 7).
