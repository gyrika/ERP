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

## Changing the cloud

| What | In `cloud/` |
|---|---|
| Run it locally (simulated D1) | `npm run migrate:local` then `npm run dev` (port 8787) |
| Deploy a new version (builds the owner's page too) | `npm run deploy` |
| Apply a new schema file from `cloud/migrations/` | `npm run migrate` |
| Look at the data | `npx wrangler d1 execute cheesybeez-cloud --remote --command "SELECT COUNT(*) FROM events"` |

Tests: `cloud/src/cloud.test.ts` (the Worker on Node's own SQLite with the real schema) and
`cloud/src/replication.test.ts` (shop server + cloud, with the network cut and restored).

## Limits (free plan, far above one shop)

100,000 requests a day, 5 GB in D1. One shop sends a few hundred small requests a day.
