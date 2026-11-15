# Security audit: CheesyBeez ERP (POS module)

Date: 2026-11-15 · Branch `claude/erp-security-audit-5cdf4f` (from `main` at 02269a9) · Read-only review: no application code was changed.

Every finding below was confirmed by reading the code at the file and line given. Anything that depends on how the shop is actually set up, or that I could not prove from the code alone, is marked **needs verification**.

### Status (2026-11-16, owner's decision)
| Status | Findings |
|---|---|
| **Fixed** | SA-03: a broken %-escape answers 400; the request handler can no longer stop the server (`server/app.ts`, test in `server/app.test.ts`) |
| **On hold, solution proposed** | SA-09: see "Proposed solution" under SA-09 |
| **Accepted by design** (the owner's requirements) | SA-01, SA-02, SA-04 to SA-08, SA-10 to SA-21 |

The accepted findings stay listed so a later reviewer can see the risk was known and chosen.

---

## 1. System map

### Stack
| Part | Technology | Where it runs |
|---|---|---|
| Counter app (Register, Kitchen, Owner, Menu, Visual Flow …) | React 19 + TypeScript + Vite (`src/`) | Browser on the counter PC; kitchen tablets on the shop Wi-Fi |
| Shop server | Node (strip-types), `node:http` + `ws` (`server/`) | Counter PC, port 8080, bound to `0.0.0.0`, runs as **SYSTEM** (scheduled task) |
| Shop database | SQLite (`node:sqlite`) by default, MySQL via `DATABASE_URL` | `C:\ProgramData\CheesyBeez` (ACL: SYSTEM + Administrators) |
| Cloud copy | Cloudflare Worker + D1 (`cloud/src/`) | `cheesybeez-cloud…workers.dev`, `cheesybeez.com` |
| Installer / updater | Inno Setup + PowerShell (`deploy/station/`) | Counter PC, as SYSTEM, every 5 min |

### Modules
Event sync (`server/app.ts`, `validate.ts`, `store.ts`, `sqliteStore.ts`), staff/PIN logins, setup wizard (`setup.ts`), modules unlock (`modules.ts`), receipt printer + cash drawer (`printer.ts`), photos and menu photos, CRM (`server/crm/`), computer vision (`cvPack.ts`, `cvSecrets.ts`, `cvCameras.ts`, `cvLive.ts`, `onvif.ts`, `cv/`), purchasing/stock rules (`stockRules.ts`, `numbering.ts`, `scheduler.ts`), cloud link (`replicator.ts`, `online.ts`, `managerInbox.ts`, `ownerDigest.ts`, `fleet.ts`), updates (`updates.ts`, station scripts). Cloud: enrol / replica / devices / events (`cloud.ts`), online ordering + delivery (`online.ts`, `road.ts`), offers push (`push.ts`), manager and owner phones (`manager.ts`), language model (`ai.ts`), owner's ChatGPT plugin (`mcp.ts`, OAuth), developer admin (`admin.ts`), owner questions (`questions.ts`), download page.

### Roles and identities
- **Staff roles** (`src/domain/auth.ts:8-15`): `cashier`, `manager`, `owner`, `kitchen`; plus `vision`, stamped by the server only for the camera worker.
- **Device kinds** (shop server, `server/store.ts:17`): `counter`, `kitchen`, `owner`, `manager`. Each has a random bearer token (stored as SHA-256).
- **Cloud device kinds** (`cloud/src/cloud.ts:36`): `shop_server`, `owner` (phone), `manager` (phone, bound to one person).
- **Other credentials:** developer module password (`server/modules.ts:9`), cloud `ENROL_CODE`, `ADMIN_KEY`, `ANSWER_KEY`, MCP OAuth tokens, per-online-order tokens.

### Where authentication and permission checks happen
| Check | Location |
|---|---|
| Device token to device + shop (`tenant_id` always from the token) | `server/app.ts:190-195`, `cloud/src/cloud.ts:106-116` |
| PIN login creates a session for (device, person, role, expiry) | `server/app.ts:260-281` |
| Each pushed event: device kind, then the actor must have a session on this device covering `event.at`, then `mayRecord(role, type)` | `server/app.ts:154-179`, `src/domain/auth.ts:76-119` |
| Event shape and shop | `server/validate.ts:84-336` (shape only, see SA-01) |
| Setup endpoints: localhost only, then the owner's PIN once setup is done | `server/app.ts:223-226`, `server/setup.ts:105-140` |
| CRM: module on, counter device, `X-Staff-Id` header must match a live session on the device | `server/crm/routes.ts:64-77` |
| Cloud: device kind allow-lists per route; manager phones limited to `stock.*` for their own person | `cloud/src/manager.ts:21-27` |
| Admin: HMAC-signed cookie or bearer key | `cloud/src/admin.ts:40-52, 216-223` |
| MCP: OAuth with PKCE S256, ChatGPT callback allow-list | `cloud/src/mcp.ts:54-200` |

---

## 2. Module checklist

- [x] Shop server HTTP router and static file serving (`server/app.ts`, `server/main.ts`)
- [x] Authentication: PIN hashing, logins, sessions, rate limiting (`server/pins.ts`, `server/store.ts`, `server/sqliteStore.ts`, `src/domain/auth.ts`)
- [x] Event validation and role rules (`server/validate.ts`, `src/domain/auth.ts`, `src/domain/events.ts`)
- [x] Stock rules, document numbering, batch scheduler (how they are invoked and trusted; `stockRules.ts`, `numbering.ts`, `scheduler.ts`)
- [x] Setup wizard, staff management, device pairing, modules unlock (`server/setup.ts`, `server/modules.ts`, `server/settings.ts`)
- [x] CRM: routes, storage, encryption, import, push campaigns (`server/crm/*`)
- [x] File uploads: shelf photos, menu photos, CV test videos, CRM import (`server/photos.ts`, `server/menuPhotos.ts`, `server/setup.ts`, `server/crm/importFile.ts`)
- [x] Receipt printer and cash drawer (`server/printer.ts`, `server/rawprint.ps1`, `src/domain/receipt.ts`)
- [x] Computer vision: pack download, camera secrets, ffmpeg, ONVIF, worker (`server/cv*.ts`, `server/onvif.ts`, `server/cv/`)
- [x] Cloud link from the shop: replicator, online orders, manager inbox, owner digest, fleet (`server/replicator.ts`, `server/online.ts`, `server/managerInbox.ts`, `server/ownerDigest.ts`, `server/fleet.ts`)
- [x] Updates, installer, backups (`server/updates.ts`, `deploy/station/*`, `deploy/windows/*`)
- [x] Cloud: enrol, replica, devices, events (`cloud/src/cloud.ts`, `cloud/src/http.ts`, `cloud/src/worker.ts`)
- [x] Cloud: online ordering and delivery quotes (`cloud/src/online.ts`, `src/domain/online.ts`)
- [x] Cloud: offers push sign-up (`cloud/src/push.ts`)
- [x] Cloud: manager and owner phones, photos (`cloud/src/manager.ts`)
- [x] Cloud: language model endpoints (`cloud/src/ai.ts`)
- [x] Cloud: owner's ChatGPT plugin, OAuth (`cloud/src/mcp.ts`)
- [x] Cloud: developer admin, owner questions page, download page (`cloud/src/admin.ts`, `questions.ts`, `download.ts`)
- [x] Front end: token storage, XSS sinks (`src/services/pairing.ts`, `src/**`)
- [x] SQL injection in reports and search (all SQL in `server/`, `cloud/src/`)
- [x] CSV/Excel export injection (searched the whole repo for exports)
- [x] Hardcoded secrets and configuration (`.env.cloud`, `server/dev.env`, `cloud/wrangler.toml`, `.gitignore`, tracked files)
- [x] Audit logging of financial actions
- [x] Debug settings left on
- [x] Dependencies (`npm audit` on the root and `cloud/`)

---

## 3. Findings

Severity is for this shop: one PC, a few staff, customer data, cash. OWASP categories are the 2021 Top 10.

### SA-01 · Cashier can set prices and payment totals through the sync API
- **Severity:** High
- **OWASP:** A04 Insecure Design (also A01 Broken Access Control)
- **Where:** `server/validate.ts:84-118` (no checks on order money); `src/domain/events.ts:30, 43, 47`; `server/app.ts:154-179`; `src/domain/auth.ts:41-46`
- **What can happen:** The rule "what the customer pays is a manager's" is only enforced by *event type* (`order.discount_set`, `order.line_adjusted` and `order.comped` need a manager). The money itself is not checked by the server. A cashier-role session may record `order.sent` with any `lines[].unit` price, `order.item_changed` with any `after` line (including a lower `unit`), and `order.paid` with any `total`. The server stores these unchanged ("checks the shape only"). The counter's device token is in the browser's `localStorage` (`src/services/pairing.ts:9`), so anyone at the counter PC with devtools can send their own push. Sales reports, the cash expected in the drawer and the owner's Today screen all read these totals. That means a cashier can under-ring sales and keep the difference, with no manager PIN and no discount event to show for it.
- **Fix:** Re-price on the shop server. For `order.sent`, check every line's `unit` against the effective menu (`effectiveMenu` + menu events) and reject a mismatch unless the event comes from a manager session. For `order.item_changed`, require `after.unit === before.unit` (or the menu price) for non-managers. For `order.paid`, recompute the order's total from its stored events and reject a `total` that differs. Add tests that lock these rules.

### SA-02 · Sessions belong to the PC, not the person: impersonation and backdating
- **Severity:** High
- **OWASP:** A01 Broken Access Control / A07 Identification and Authentication Failures
- **Where:** `server/app.ts:76-77` (14 h shift, 15 min manager session), `server/app.ts:171-176` (session match by `actor.id` + role + `event.at`), `server/validate.ts:92` (`at` has no bound), `server/crm/routes.ts:64-77` (`X-Staff-Id` header), no logout endpoint anywhere in `server/app.ts`
- **What can happen:**
  1. **Acting as someone else.** A login creates a session for *(device, person)*. Any later request from that device may claim to be that person. Staff ids are in every event (`actor.id`), which the counter pulls. So after the owner or a manager signs in on the shared counter PC, any cashier on that PC can, for the next 14 hours (or 15 minutes after manager mode): record manager-only events as the manager (discounts, comps, line removals, stock counts, supplier prices); and call the CRM with `X-Staff-Id: <owner id>` to download every customer's name and mobile number (`/api/v1/crm/customers`), erase customers or send campaigns. Locking the screen does not end the server session.
  2. **Backdating.** `event.at` is chosen by the client and only has to fall inside *any* past session of that person on this device (±2 min). A cashier can therefore record a manager's discount today with yesterday's timestamp from the manager's earlier 15-minute session. It also lets anyone write events into closed past days.
  This defeats the manager-PIN approval flow.
- **Fix:** Return a per-login random session token from `/api/v1/login` and require it on every push and CRM call (header), instead of trusting `actor.id` or `X-Staff-Id`. Mark the session ended when the screen locks or manager mode exits (add `/api/v1/logout`). Reject events whose `at` is more than a few minutes away from the server clock (`receivedAt`), except for an explicit, bounded offline-replay window that is recorded as such.

### SA-03 · One malformed URL crashes the shop server
- **Severity:** Medium
- **OWASP:** A04 Insecure Design (unhandled exception, denial of service)
- **Where:** `server/app.ts:464` (`decodeURIComponent(url.pathname)` inside the synchronous request handler, `server/app.ts:477-479`); no `uncaughtException` handler in `server/`
- **What can happen:** `GET /%zz` (no login) makes `decodeURIComponent` throw a `URIError` that nothing catches, and Node exits. I confirmed that `new URL('/%zz')` keeps the `%` and that decoding throws. Anyone on the shop Wi-Fi can do this, and so can any web page opened on the counter PC (for example `<img src="http://localhost:8080/%zz">`). `station.cmd` restarts the server after 5 s, so a repeated request keeps the kitchen screen, printing, sync and online orders down for as long as it is sent.
- **Fix:** Wrap the decode in `try { … } catch { res.writeHead(400).end(); return; }`. Also wrap the whole request callback so that any synchronous throw answers 500 instead of killing the process.
- **Status: fixed (2026-11-16).** Both parts are done. The test `a malformed address answers 400 and the server keeps running (SA-03)` sends `/%zz` and a truncated escape, then checks that health and the app still answer.

### SA-04 · Cash drawer opens, and staff/setup changes happen, with no audit record
- **Severity:** Medium
- **OWASP:** A09 Security Logging and Monitoring Failures (also A01)
- **Where:** `server/app.ts:283-297` (print only checks `device.kind === 'counter'`, no session, no event); `src/domain/receipt.ts:229` (drawer kick bytes); `server/setup.ts:300-327, 287-293, 379-402, 419-424` (add/remove staff, printer, cloud connect and install update write no event)
- **What can happen:** `POST /api/v1/print` sends raw ESC/POS from the browser. With the counter token, anyone at the PC can send the drawer-kick command (`ESC p`) whenever they want, with nobody signed in. This leaves no trace in the event log, so a "no sale" drawer opening cannot be found later. In the same way, adding a staff member with a new PIN, removing one, connecting the cloud or changing the printer is not recorded anywhere the owner can see.
- **Fix:** Make the server write an event (`drawer.opened` with who, when and the order number or "no sale") for each print that contains a drawer kick, and require a live session for printing. Better: let the client send a receipt *description* and have the server build the ESC/POS, deciding itself whether to open the drawer (cash payments only). Record `staff.added`, `staff.removed`, `setup.*` events with the owner as actor.

### SA-05 · Removing a staff member or losing a phone does not revoke access
- **Severity:** Medium
- **OWASP:** A07 Identification and Authentication Failures / A01
- **Where:** `server/setup.ts:316-327` (`removeStaff` only deactivates the PIN locally); `cloud/src/cloud.ts:241-247` (DELETE exists, but nothing in `server/` or `src/` calls it: confirmed by searching for `api/v1/devices`); `server/store.ts:43-66` (no way to remove a local device token); `cloud/src/cloud.ts:251-253` (manager phones may read every event)
- **What can happen:** A manager who leaves keeps their paired phone. It still reads the shop's whole history from the cloud (sales, money out, staff) and still records stock events as them, which the shop server takes in (`server/managerInbox.ts`). A lost owner phone or kitchen tablet keeps working too. The owner has no button to stop any of them.
- **Fix:** When a person is removed, also delete their manager phones in the cloud (`DELETE /api/v1/devices/:id` for devices whose `actor.id` matches). Add a Devices list in Shop setup (the cloud already has `GET /api/v1/devices`) with Remove for phones and local kitchen/counter tokens (`DELETE FROM devices`). Have the shop server refuse inbox events from a person who is no longer active.

### SA-06 · Four-digit PINs can be brute-forced
- **Severity:** Medium
- **OWASP:** A07 Identification and Authentication Failures
- **Where:** `server/app.ts:79-82, 260-274`; `server/setup.ts:115, 128-140`; `src/domain/auth.ts:127`
- **What can happen:** A wrong PIN costs nothing until 5 in a row, then 30 s. That is about 600 guesses an hour per device, so all 10,000 PINs take about 17 hours (half that on average). Any staff PIN is a hit, so with several staff a valid login comes sooner. The counter in memory resets when the server restarts (SA-03 makes that easy). Login with `purpose: 'manager'` finds the manager's or owner's PIN the same way. The owner's PIN on the setup endpoints uses the same scheme.
- **Fix:** Lock out progressively (30 s, then 5 min, then 1 h), keep the counter in the database so restarts don't reset it, and alert the owner (an event, shown on Today) after repeated failures. Consider 6-digit PINs for managers and the owner.

### SA-07 · Updates and the CV pack are installed as SYSTEM without a signature check
- **Severity:** Medium
- **OWASP:** A08 Software and Data Integrity Failures
- **Where:** `deploy/station/station-update.ps1:106-126` (latest GitHub release, only the size is checked), `:95` (runs the installer); `deploy/station/station-install.ps1:11-27` (tasks run as SYSTEM every 5 min); `server/cvPack.ts:166-181` (the sha256 list comes from `manifest.json` *inside the same zip*, so it catches corruption, not tampering)
- **What can happen:** Whoever can publish a release on `gyrika/ERP` (any of the 4 team members, a leaked token, or a compromised CI job) can make every shop PC run their program as SYSTEM within 5 minutes. The CV pack's `ffmpeg.exe` and model have the same exposure.
- **Fix:** Sign the installer (Authenticode) and have the updater check `Get-AuthenticodeSignature` against your certificate's thumbprint before running it. Alternatively, publish a detached signature or SHA-256 signed with a key whose public half ships in the app. For the CV pack, pin the expected `manifest.json` SHA-256 in the server source per `CV_PACK_VERSION`. Protect releases on GitHub (required reviewers, tag protection).

### SA-08 · The shop network carries tokens, PINs and customer numbers in clear text
- **Severity:** Medium (**needs verification:** whether customers can join the shop Wi-Fi)
- **OWASP:** A02 Cryptographic Failures
- **Where:** `server/app.ts:477` (plain `http`), `server/app.ts:118-123` (token also accepted in `?token=` for the WebSocket), `server/setup.ts:366` (kitchen pairing link is `http://…?pair=<token>`), `deploy/station/station-install.ps1:40` (port 8080 open on Private networks)
- **What can happen:** Anyone on the same Wi-Fi can capture a kitchen or counter device token, staff PINs (`/api/v1/login` body) and customers' mobile numbers. With a captured counter token plus a PIN they can record sales and stock events from their own laptop. If the shop's Wi-Fi is also the customers' Wi-Fi, this is easy to do.
- **Fix:** Put the POS on its own Wi-Fi (or VLAN) that customers never join. That is the cheap fix, and it should be in the install guide. Longer term, serve HTTPS with a certificate the setup wizard creates and pins on paired devices.

### SA-09 · Anyone can add any phone number to the customer list and receive its offers
- **Severity:** Medium
- **OWASP:** A04 Insecure Design / A07
- **Where:** `cloud/src/push.ts:43-67` (unauthenticated `/api/v1/push/subscribe`, any mobile + any push endpoint); `server/crm/push.ts:168-178` (shop server makes that customer, source `app`, and links the subscription)
- **What can happen:** Without proving they own the number, a stranger can sign up someone else's mobile for offers. That puts a person on the marketing list without their consent, which is a PDPA problem. It also routes that customer's personal offers (for example "we miss you") to the stranger's phone, and the list fills with junk (10 per IP an hour, 2,000 queued).
- **Fix:** Verify ownership before linking: an SMS or WhatsApp one-time code, or link only when the number already bought at the counter **and** the customer confirms on the receipt QR flow. Until then, keep app sign-ups apart from the counter's customer list.
- **Status: on hold.**
- **Proposed solution: the receipt proves the number (no SMS, which the owner ruled out).**
  1. **Per-receipt claim code.** When a customer is on an order (their mobile was given at the counter), the shop server makes a one-time random code for that `customerId`. The receipt's offers QR carries it: `cheesybeez.com/offers?c=<code>`. The shop sends the cloud only the code's hash and an expiry (for example 7 days), never the number.
  2. **Signing up from the receipt.** The customer scans the QR and allows notifications. The cloud stores the subscription with the code. The phone number is not typed, so there is nothing to fake.
  3. **Linking.** The shop server picks the sign-up up as it does now (`server/crm/push.ts`). It links the subscription to the `customerId` whose code matches, then spends the code. An unknown, used or expired code links nobody.
  4. **Typed-number sign-ups** (no receipt) stay "app only". They get the shop's general offers, but they are never added to the customer list and never get anyone's personal offers ("we miss you", birthday). Each later visit at the counter with a receipt QR upgrades them.
  5. **Unsubscribe** needs the subscription's own endpoint, as today. Only the phone that subscribed knows it.
- **Why this fits:** It uses what the shop already does (mobile at the counter, offers QR on the receipt). It needs no SMS cost, and the customer types nothing. The number stays on the shop PC. Code changes: `src/domain/receipt.ts` (QR with code), `server/crm/push.ts` (match code), `cloud/src/push.ts` (accept `code` instead of `phone`, keep its IP limits), a cloud migration for code hashes, and the offers page in `src/order/`.

### SA-10 · Setup endpoints trust "localhost": cross-site requests and an open install window
- **Severity:** Low
- **OWASP:** A01 Broken Access Control
- **Where:** `server/setup.ts:105-106` (`isLocal`), `server/setup.ts:128-129` (no PIN before `setupDone`), `server/app.ts:112-116` (body parsed as JSON whatever the `Content-Type`), no `Origin`/`Host` check
- **What can happen:** Any web page opened in a browser on the counter PC is "local". It can send a `text/plain` POST, which needs no CORS preflight, to `http://localhost:8080/api/v1/setup/…`. Until setup is finished there is no PIN, so a page visited during install could add itself an owner (`/staff`) or pair a counter. After setup it would still need the owner's PIN. DNS rebinding would also let it read the answers.
- **Fix:** Require `Content-Type: application/json` (this forces a preflight, which the server never approves). Reject requests whose `Origin` or `Host` is not `localhost:<port>` / `127.0.0.1:<port>`.

### SA-11 · The developers' module password hash ships in the source
- **Severity:** Low (**needs verification:** the password's strength)
- **OWASP:** A07 / A02
- **Where:** `server/modules.ts:9`
- **What can happen:** The salt and scrypt hash are in every install and in the repo. scrypt runs with Node's default cost. Someone with the files can try passwords offline, without the 5-tries brake. The same password unlocks modules (for example CRM) in every shop.
- **Fix:** Use a long random passphrase (20+ random characters), raise the scrypt cost (`N=2^17` or more), or replace the password with a signed unlock code per shop (signed by a key only the developers hold, verified by a public key in the app).

### SA-12 · The cloud shop code can be guessed without limit
- **Severity:** Low (**needs verification:** length of the `ENROL_CODE` secret)
- **OWASP:** A07
- **Where:** `cloud/src/cloud.ts:186-191`
- **What can happen:** There is no rate limit on `/api/v1/enrol`. With the code, anyone can create new shops in the cloud. They cannot take over an existing shop (the per-shop secret protects that). Each new shop gets its own daily AI allowance, which can run up cost.
- **Fix:** Use a long random code, and rate-limit by IP (as `online.ts` already does).

### SA-13 · Phone tokens never expire and travel in URLs
- **Severity:** Low
- **OWASP:** A07
- **Where:** `server/setup.ts:346, 360` (`?owner=` / `?manager=` links), `cloud/src/worker.ts:50-75` (the token is put into the web manifest's `start_url`), `cloud/migrations/*` (no expiry column on `devices`)
- **What can happen:** The owner's full credential sits in browser history, home-screen shortcuts, screenshots of the QR, and anywhere the link is shared (WhatsApp). It works forever unless removed, and SA-05 means there is no way to remove it today.
- **Fix:** Use the link token once, exchanging it for a session token kept in storage, and give device tokens an expiry with silent renewal. Fixing SA-05 provides the kill switch.

### SA-14 · Every device, including the kitchen tablet, can read the whole shop history
- **Severity:** Low
- **OWASP:** A01
- **Where:** `server/app.ts:447-457, 502-526` (pull and stream answer any device kind)
- **What can happen:** A kitchen token (in its plain-HTTP pairing link, SA-08) reads all sales, money out, supplier prices and staff names. The kitchen needs only tickets.
- **Fix:** Filter what is sent by device kind (kitchen: `order.*` and `kitchen.*` for today, without money fields), or accept this deliberately and note it in `ARCHITECTURE.md`.

### SA-15 · Secrets at rest sit beside the data they protect
- **Severity:** Low (**needs verification:** whether backups copy `crm.key` together with the database)
- **OWASP:** A02 Cryptographic Failures
- **Where:** `server/settings.ts:19-21` (cloud token and secret in plain `settings.json`); `server/crm/crypto.ts` (`crm.key` in the same data folder as `pos.sqlite`); `server/cvSecrets.ts` (key file beside `cv-secrets.json`); `mode: 0o600` has no effect on Windows
- **What can happen:** Anyone who copies the data folder (an admin account, AnyDesk support, a stolen disk, a backup copy) gets the customers' numbers and camera passwords in clear. The folder ACL (`deploy/station/station-install.ps1:9`) is the real protection.
- **Fix:** Protect the keys with Windows DPAPI (machine scope), so a copied folder is useless on another PC. Keep backups encrypted, or store the CRM key separately from them.

### SA-16 · The OAuth callback allow-list accepts any ChatGPT custom connector
- **Severity:** Low (**needs verification:** whether `chatgpt.com/connector/oauth/<id>` ids can be created by any ChatGPT user)
- **OWASP:** A01 / A07
- **Where:** `cloud/src/mcp.ts:54-55`
- **What can happen:** An attacker could send the owner an `/authorize` link built with the attacker's own connector callback. If the owner pastes their owner link there, the attacker's ChatGPT gets read access to the shop's sales.
- **Fix:** Pin the exact callback(s) of your own registered connector. At least, show on the approval page which ChatGPT app is asking.

### SA-17 · No browser security headers
- **Severity:** Low
- **OWASP:** A05 Security Misconfiguration
- **Where:** `server/app.ts:469-473` (static files), `server/app.ts:94-97`; cloud assets served as-is (`cloud/src/worker.ts:160`)
- **What can happen:** No `Content-Security-Policy`, no `frame-ancestors` / `X-Frame-Options`, no `X-Content-Type-Options: nosniff`. Another site could frame the Register or the owner's view (clickjacking), and any future XSS would have nothing to contain it. I found no XSS sinks today: no `dangerouslySetInnerHTML`, `innerHTML` or `eval` in `src/`, and the HTML pages in `cloud/src` escape their values.
- **Fix:** Add `Content-Security-Policy: default-src 'self'; frame-ancestors 'none'` (with any needed exceptions), `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer` on both servers.

### SA-18 · Uploads that can fill the disk or memory
- **Severity:** Low (xlsx part: **needs verification**)
- **OWASP:** A04
- **Where:** `server/app.ts:309-320` (menu photos: counter token only, no session, no limit on how many, never deleted); `server/crm/importFile.ts:70-73` (a 1 MB `.xlsx` is inflated by exceljs with no size limit)
- **What can happen:** A script with the counter token can store unlimited 1 MB-ish WebP files until the disk is full, which stops the database writing. A crafted `.xlsx` (zip bomb) uploaded by a manager could exhaust the server's memory.
- **Fix:** Require a manager or owner session for menu photo uploads (matching `menu.photo_set`). Cap the folder size or delete photos no event refers to. For imports, check the zip's declared uncompressed sizes before loading (or cap rows and cells).

### SA-19 · Vulnerable development dependency
- **Severity:** Low
- **OWASP:** A06 Vulnerable and Outdated Components
- **Where:** `package-lock.json:4739` (`undici` 7.30.0, `dev: true`, through jsdom), `cloud/package-lock.json` (`wrangler` → `miniflare` → `undici`)
- **What can happen:** `npm audit` reports 1 high advisory in the root project and 1 high + 2 moderate in `cloud/` (undici < 7.30.1: TLS validation bypass, several DoS issues). All of them are development tools, not shipped to the shop or the Worker. Production dependencies (`exceljs`, `mysql2`, `ws`, `react`, `@xyflow/react`) show no advisories.
- **Fix:** Run `npm update undici` (or bump jsdom/vitest and wrangler). Add `npm audit --omit=dev` to CI.

### SA-20 · Unauthenticated endpoints give away information and can use up a paid quota
- **Severity:** Low
- **OWASP:** A05 / A04
- **Where:** `server/app.ts:198-203` (`/api/v1/health`: version, cloud link state, update state); `cloud/src/online.ts:108-113` (`/api/v1/delivery-quote`: no rate limit, each call may query openrouteservice)
- **What can happen:** Anyone on the Wi-Fi learns the exact version, which helps them pick known bugs. A script on the internet can exhaust the `ORS_API_KEY` daily quota, after which delivery fees fall back to the straight-line guess.
- **Fix:** Trim the health answer for requests that are not local or have no token. Rate-limit delivery quotes per IP like orders, and cache by rounded location.

### SA-21 · Temporary test-video upload is still shipped
- **Severity:** Low
- **OWASP:** A05 Security Misconfiguration (debug feature left on)
- **Where:** `server/setup.ts:529-570`, `server/app.ts:232-236`, `server/main.ts:154`
- **What can happen:** A code path marked TEMPORARY accepts 200 MB uploads and makes ffmpeg read them. It needs the owner's PIN and is local only, but it is extra attack surface on an internet-connected PC, running as SYSTEM, that the shop does not need.
- **Fix:** Remove it (or put it behind the developers' module password) before the shop install.

---

## 4. Checked and found sound

- **SQL injection:** every query in `server/` and `cloud/src/` uses bound parameters. The only interpolated fragments are constants (`COLUMNS`, `IN_PLAY_SQL`, `STILL_LINKED`, placeholder lists). There are no free-text search or report queries built from user input.
- **Shop isolation (changing an id):** `tenant_id` always comes from the device token, never from the request, on both servers. Cross-shop event pushes are rejected (`validate.ts:93`). Cloud photo, inbox, online-order and device queries all filter by the caller's tenant. Online-order status needs the order's own token (`cloud/src/online.ts:151-158`).
- **Online order pricing:** totals and delivery fees are computed on the server from the menu (`checkOnlineOrder`, `quote`). Per-phone, per-IP and per-shop limits are in place.
- **Mass assignment:** server-built events (setup, CRM) set `id`, `shopId`, `at` and `actor` themselves. Menu, combo and section payloads have key allow-lists. The remaining gap is money in order events (SA-01).
- **Path traversal:** static files (`app.ts:463-465`), shelf photos (id and tenant regex), menu photos (64-hex id) and CV pack zip entries (`cvPack.ts:105`) are all contained.
- **Receipt / ESC/POS injection:** customer text is reduced to printable ASCII before printing (`receipt.ts:259-261`).
- **Passwords and PINs at rest:** salted scrypt, constant-time compare. Device tokens are stored as SHA-256. Admin session is HMAC-signed, `HttpOnly; Secure; SameSite=Strict`.
- **OAuth (MCP):** PKCE S256 required, single-use 5-minute codes, refresh rotation, revocation tied to the owner device.
- **CSV/Excel export injection:** the app has no CSV or Excel export. The only spreadsheet code is the CRM import (parsing only) and dev scripts.
- **Hardcoded secrets:** none live in tracked files. `cloud/wrangler.toml` holds only non-secret vars and D1 ids. `ENROL_CODE`, `ADMIN_KEY`, `ANSWER_KEY` and `ORS_API_KEY` are Worker secrets. `server/.env` and `cloud/.dev.vars` are git-ignored. `.env.cloud` and `server/dev.env` contain only a build mode and a port. (The module password hash is SA-11.)
- **Debug settings:** `MEMORY=1`, `CV_DEV_CAMERAS` and `server/dev.env` are dev-only, read from the environment, and off in the station install. The exception is SA-21.
- **Audit trail:** order, stock, menu and money events are append-only, with actor, time and `receivedAt`. Manager changes carry before/after. The gaps are the drawer and setup (SA-04) and who the actor really is (SA-02).

---

## 5. Summary

| Severity | Count | Findings |
|---|---:|---|
| Critical | 0 | none |
| High | 2 | SA-01, SA-02 |
| Medium | 7 | SA-03, SA-04, SA-05, SA-06, SA-07, SA-08, SA-09 |
| Low | 12 | SA-10 to SA-21 |
| **Total** | **21** | 6 of them partly *needs verification* (SA-08, SA-11, SA-12, SA-15, SA-16, SA-18) |

**Outcome (2026-11-16):** SA-03 fixed. SA-09 on hold with a proposed solution. Every other finding was accepted by design, per the owner's requirements.
