# Running the sync server on the counter PC

The server keeps every order event in MySQL on the counter PC and sends it live to every
paired device (the kitchen, later the owner's phone). It also serves the app itself, so the
counter just opens `http://localhost:8080`. Design: [sync-contract.md](sync-contract.md).

## Try it without MySQL (any laptop)

```sh
npm run build
npm run server
```

With no `DATABASE_URL`, events live in memory and are **lost when it stops**. It prints two
pairing links (counter and kitchen). Open them in two different browsers or laptops: an order
sent on one shows on the other within a second.

## Install on the counter PC (Windows 10)

1. **Node.js 22 LTS** from nodejs.org, and **MySQL 8 Community Server** (MySQL Installer,
   "Server only", run as a Windows service that starts automatically).
2. Create the tables, as the MySQL admin:
   ```sh
   mysql -u root -p < server/schema.sql
   ```
3. Create the app's own MySQL user. It may add and read events but **never change or delete
   them** (the audit trail, SCRUM-43):
   ```sql
   CREATE USER 'pos_app'@'localhost' IDENTIFIED BY '<a long random password>';
   GRANT SELECT ON cheesybeez.* TO 'pos_app'@'localhost';
   GRANT INSERT ON cheesybeez.events TO 'pos_app'@'localhost';
   GRANT INSERT ON cheesybeez.devices TO 'pos_app'@'localhost';
   GRANT INSERT, UPDATE ON cheesybeez.shops TO 'pos_app'@'localhost';
   ```
   `UPDATE` on `shops` exists only because MySQL requires it for the `SELECT … FOR UPDATE` lock
   that keeps `seq` in order. There is no `UPDATE` or `DELETE` on `events`.
4. Create `server/.env` (it is git-ignored; it holds the password):
   ```
   DATABASE_URL=mysql://pos_app:<password>@localhost:3306/cheesybeez
   PORT=8080
   ```
5. Build and start:
   ```sh
   npm ci
   npm run build
   npm run server
   ```
6. Pair each device **once**. The shop id must be the one the app stamps on its events
   (today `shop-demo-cheesybeez`, from `src/fake/data.ts`, until real logins: SCRUM-40/41):
   ```sh
   npm run server:device -- --kind counter --shop shop-demo-cheesybeez --name "CheesyBeez Thalwila"
   npm run server:device -- --kind kitchen --shop shop-demo-cheesybeez --host <PC address>:8080
   ```
   Each prints a link with `?pair=<token>`. Open it on that device; the app keeps the token and
   removes it from the address bar. The server stores only a hash of the token, so a lost link
   means pairing again.
7. Start on boot: Task Scheduler → "At log on" → `npm run server` in the project folder (or wrap
   it with NSSM as a Windows service). Then Chrome opens `http://localhost:8080` full screen.

## Good to know

- **Power cut:** every action is saved on the device first (the outbox) and pushed when the
  server is back. MySQL then holds the full history. Put the PC (and later the Wi-Fi router) on
  the UPS (SCRUM-73).
- **Offline sign:** the Register and the Kitchen show "Offline · 2 orders waiting" while they cannot
  reach the server, and nothing at all when synced (SCRUM-32).
- **Firewall:** a kitchen tablet needs Windows Firewall to allow Node on port 8080 for
  *private* networks only.
- **Backups:** the cloud copy is SCRUM-61. Until then, a nightly `mysqldump cheesybeez` to a USB
  drive is the backup.
- **Tests against MySQL:** `TEST_DATABASE_URL=… npm run test:domain` runs `server/mysql.test.ts`
  (each run adds a `test-…` shop; the app user cannot delete it, which is the point).
