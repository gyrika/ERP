# The cloud copy (SCRUM-61)

**Live:** https://cheesybeez-cloud.cheesybeez-cloud.workers.dev (Cloudflare Workers + D1, free plan).

```
 Shop PC: server + MySQL            the truth for selling; works with no internet
      │  whenever the internet is up, copies its new events (server/replicator.ts)
      ▼
 Cloudflare: Worker + D1            a full copy of every event, off-site
      ├─ survives the shop PC (disk dead, stolen, flooded)
      ├─ support from Galle without AnyDesk
      └─ later: the Owner view on the owner's phone, and the examiners' link
```

## How the copying works

- The shop server asks the cloud *"which of my events do you have last?"* (by the shop's own
  `seq`) and sends everything newer, 100 at a time. It keeps no bookmark of its own, so a
  restart, power cut or lost reply can never skip or double an event.
- It runs a couple of seconds after each new sale, and every 30 s. With no internet it retries
  quietly (up to every 5 minutes); the shop never notices. Selling never waits for the cloud.
- The cloud checks the same things the shop server did (shape, right shop) and stores each event
  once. **The database itself refuses to change or delete an event** (SQLite triggers), the same
  rule MySQL enforces at the shop.
- Each shop server signs in with its own token (stored in the cloud only as a hash). A shop sees
  only its own events.

## Connecting a shop: the shop code (normal way)

The setup wizard's step 4, **Connect to the cloud**, asks for the **shop code**. Typed in, the shop
server registers itself with the cloud (`POST /api/v1/enrol`), keeps its key in its settings, and
starts copying at once; the owner's phone QR code works from then on. Later: Shop setup → Cloud.

- The code is a Worker secret, never in the code or the repo. Give it only to whoever installs a shop.
  Change it any time (old shops keep working; only new shops need the new code):
  `npx wrangler secret put ENROL_CODE` (in `cloud/`), then type the new code.
- Each shop's id ends in 4 random characters (`cheesybeez-thalwila-7b39`), so two shops with the same
  name, or a test install, never mix in the cloud.
- On Windows the key is kept in `C:\ProgramData\CheesyBeez`, readable by administrators and Windows only.

## Setting it up for a shop by hand (only for special cases)

From your laptop, in `cloud/` (logged in with `npx wrangler login`):

```sh
npm run device -- --shop cheesybeez-thalwila --name "CheesyBeez Thalwila" \
  --url https://cheesybeez-cloud.cheesybeez-cloud.workers.dev
```

It prints three lines. Put them in the shop PC's `server\.env` (over AnyDesk) and restart the
server (or run `deploy\windows\update.ps1 -Force`):

```
CLOUD_URL=https://cheesybeez-cloud.cheesybeez-cloud.workers.dev
CLOUD_TOKEN=…
CLOUD_SHOP=cheesybeez-thalwila
```

Check: `http://localhost:8080/api/v1/health` shows `"cloud": { "upToDateAt": …, "lastError": null }`,
and `status.ps1` shows **Cloud copy: up to date N min ago**.

## The owner's phone

The same address also serves the **owner's page**: a separate build of the app (`npm run build:cloud`)
that holds only the Owner view, so nobody on the internet reaches a register there.

- Give the owner their link, once (from your laptop, in `cloud/`):
  ```sh
  npm run device -- --shop cheesybeez-thalwila --kind owner --url https://cheesybeez-cloud.cheesybeez-cloud.workers.dev
  ```
  It prints `…/?owner=<secret>#owner`. Send it privately; opening it on the phone keeps the secret
  there and removes it from the address bar. "Add to Home Screen" makes it an app icon.
- The phone reads the cloud copy: the first visit loads the shop's history, then every minute only
  what is new. The secret can read that shop's events and nothing else; it can never write.
- **For the examiners:** `https://cheesybeez-cloud.cheesybeez-cloud.workers.dev/?demo#owner` shows the
  demo feed (made-up sales), no secret needed. The bare address shows a short welcome page.
- A lost phone: there is no screen yet to withdraw a link; until there is, delete that device's row
  in D1 (`npx wrangler d1 execute cheesybeez-cloud --remote --command "DELETE FROM devices WHERE id = '…'"`).
  The phone then shows "This link is no longer valid".

## The manager's phone (SCRUM-94)

The same address serves the **Manager app**: today's counts and the stock, nothing else. It is
made for one person, at the shop PC: Shop setup → Devices → **Manager's phone** → pick the manager
→ QR code. Scanning it opens `…/?manager=<secret>#manager`; **Install app** (Android) or Share →
Add to Home Screen (iPhone) makes it an app (`/manager.webmanifest`).

- It reads the shop like the owner's phone does. What it records (counts, deliveries: `stock.*`
  only, signed with its person) goes to the cloud's **inbox** (`POST /api/v1/inbox`); the shop
  server takes it into its own log every 15 seconds (`server/managerInbox.ts`), filed under one
  local device of kind `manager`, and copies it back up as usual. No internet at the shop: the
  counts wait in the cloud and arrive when it is back.
- **Shelf photos** for a big gap go to the cloud (`POST /api/v1/photos`, table `photos`, ~150 KB
  each, about 50 MB a year for one shop). The counter fetches one the first time it is shown
  and keeps a copy in `C:\ProgramData\CheesyBeez\photos`.
- No PIN on the phone: it is that person's phone. A lost phone: delete its row in `devices`
  (as for the owner's phone).

## The owner's questions page

`/questions?k=<key>` is a plain page (no account, no app) where the owner answers what the POS still
needs: missing recipe amounts, menu items, receipt details. The key is a Worker secret (`ANSWER_KEY`);
a wrong key shows "This link is not right". Every save is kept (`owner_answers`); the newest is the
answer. Read it with `npm run answers` (in `cloud/`). New key: `npx wrangler secret put ANSWER_KEY`.

## Online orders (cheesybeez.com)

Customers order ahead on **cheesybeez.com** (or `/order` on any cloud address), collect at the
shop and pay there. Rules in `src/domain/online.ts`; the cloud side in `cloud/src/online.ts`;
the shop side in `server/online.ts`; the counter's **Online** key in `src/ui/Online.tsx`; the
customer page in `src/order/` (built as `order.html` by `npm run build:cloud`).

On **cheesybeez.com**, customers can install the ordering page from their browser as a lightweight,
full-screen app: use **Install app** when offered, or on iPhone/iPad use **Share → Add to Home
Screen**. The app caches its page and static assets so it can open with a weak connection. Shop
availability and order status are always fetched live; the cached menu may be stale offline.
Customers must be online to place an order or refresh its status, and the cloud recalculates the
price when an order is submitted. On a cloud address, `/order` serves the same customer page and
can be installed separately with a `/order` scope, so it does not conflict with the owner app at
the cloud address root.

- **Which shop:** `ORDER_SHOP` in `cloud/wrangler.toml` `[vars]` (the shop id from the setup
  wizard). Change it to the real shop after the install, then `npm run deploy`.
- **Open or closed:** the counter switches *Taking orders* on (Register → Online). The site takes
  orders only while it is on **and** the shop server was heard from in the last 2 minutes (power
  cut or no internet = closed). It switches itself off between 2 and 6 am.
- **The flow:** the order chimes at the counter → *Ready in 15/20/30/45 min* accepts it (it goes
  straight to the kitchen with the next number, which the customer sees) or *Decline* with a
  reason → the kitchen's **Done** makes it *Ready* on the customer's phone → the payment makes it
  *Collected*. Unanswered for 10 minutes: the customer is told it expired.
- **Prices** are always worked out by the cloud from the menu, never taken from the phone.
- **Floods:** at most 2 orders in play per phone number, 6 an hour per connection, 20 waiting.
- **Privacy:** the customer's name and phone are kept only with the online order (the Register
  knows the order by its number), and are blanked after 30 days.

## Changing the cloud

| What | In `cloud/` |
|---|---|
| Run it locally (simulated D1) | `npm run migrate:local` then `npm run dev` (port 8787) |
| Deploy a new version (builds the owner's page too) | `npm run deploy` |
| Apply a new schema file from `cloud/migrations/` | `npm run migrate` |
| What the shorthand parser could not read (SCRUM-143), commonest first | `npm run misses` |
| Look at the data | `npx wrangler d1 execute cheesybeez-cloud --remote --command "SELECT COUNT(*) FROM events"` |

**Release order: cloud first, then the shop PCs.** The cloud checks every event with the same
rules as the shop server (`server/validate.ts`). An older cloud refuses event types it does not
know yet, and a refused batch stops the whole copy (and the owner's phone stops updating). So when
a release adds or changes event types: `npm run deploy:staging`, check it, `npm run deploy`, and
only then tag `v*` (shop PCs update within minutes, when the counter is quiet). The cloud must also keep accepting what the
installed version sends.

Tests: `cloud/src/cloud.test.ts` (the Worker on Node's own SQLite with the real schema) and
`cloud/src/replication.test.ts` (shop server + cloud, with the network cut and restored).

## Limits (free plan, far above one shop)

100,000 requests a day, 5 GB in D1. One shop sends a few hundred small requests a day.

## Admin view (`/admin`)

The developer's view of every shop: online or not (each shop server checks in every 30 s), the
version it runs against the latest release, how its last update went, its last sale, and one tap
into that shop's Owner view (read-only). Shops report through the copy they already make
(`x-station-version` / `x-station-update` headers on `/api/v1/replica`, stored on `devices`,
migration `0005`).

Closed unless set up: one long random password, made and stored by

    cd cloud && npm run admin-key        (add -- --staging for the test cloud)

It stores the password in the cloud and saves it on this laptop (`server/.env`, `CLOUD_ADMIN_KEY`),
so nothing needs copying; for the website, copy it from that file. Typed once at `/admin`, it becomes a signed session
cookie for 30 days (HttpOnly, Secure, SameSite=Strict, only for `/admin`). Running it again makes a
new password and signs every browser out. Without `ADMIN_KEY`, `/admin` answers 404.

### The Shops screen on the developer's laptop

The same data inside the local app: add the admin password to this laptop's `server/.env`
(`CLOUD_ADMIN_KEY=<password>`, optionally `CLOUD_ADMIN_URL` for the test cloud), restart
`npm run server`, then Ctrl+K → **Shops**. The local server reads the cloud with the password
(`server/fleet.ts`) and answers only this computer itself; a shop PC has no key, so no Shops screen.
