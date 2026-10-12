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

## Setting it up for a shop (once)

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

## Changing the cloud

| What | In `cloud/` |
|---|---|
| Run it locally (simulated D1) | `npm run migrate:local` then `npm run dev` (port 8787) |
| Deploy a new version | `npm run deploy` |
| Apply a new schema file from `cloud/migrations/` | `npm run migrate` |
| Look at the data | `npx wrangler d1 execute cheesybeez-cloud --remote --command "SELECT COUNT(*) FROM events"` |

Tests: `cloud/src/cloud.test.ts` (the Worker on Node's own SQLite with the real schema) and
`cloud/src/replication.test.ts` (shop server + cloud, with the network cut and restored).

## Limits (free plan, far above one shop)

100,000 requests a day, 5 GB in D1. One shop sends a few hundred small requests a day.
