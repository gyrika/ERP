# Running the sync server on the counter PC

The server keeps every order event in MySQL on the counter PC and sends it live to every
paired device (the kitchen, later the owner's phone). It also serves the app itself, so the
counter just opens `http://localhost:8080`. Design: [sync-contract.md](sync-contract.md).

## The quick way: built-in database + setup wizard (default)

```sh
npm ci && npm run build
npm run server
```

With no `DATABASE_URL`, the server keeps everything in a built-in database (one SQLite file in
`server/data/`, created and updated by itself; same tables and append-only rules as MySQL). Open
`http://localhost:8080` **on that PC**: the setup wizard asks for the shop's name, the receipt
printer (with a test print), the staff and their PINs (the owner first), and shows QR codes to
connect a kitchen tablet and the owner's phone. That PC becomes the counter by itself.

- Setup only answers the PC itself: a tablet or phone on the Wi-Fi can never set up or change the shop.
- Later changes (staff, printer, devices): Manager mode → Ctrl+K → **Shop setup**, with the owner's PIN.
- Another screen on the same PC: it asks for the owner's PIN once, then it is a counter too.
- A tablet that has not scanned its code sees "This device is not connected yet", never a register.
- `MEMORY=1 npm run server` keeps nothing (a quick look); `DATA_DIR=…` moves the data folder.
- Developing: `npm run dev` + `npm run dev:server` (port 8090, data in `server/data/`), so an installed POS on 8080 is never touched. Check with `http://localhost:5173/api/v1/health`: `"version"` should say `development`.
- Developing with cameras, sync or real logins: put `VITE_SETUP_CHECK=1` in `.env.development.local` (git-ignored) and restart `npm run dev`. Without it the dev app has fake staff and its own browser log, so what the camera worker sees never reaches its screen.

The MySQL steps below remain for anyone who sets `DATABASE_URL`.

## Install on the counter PC (Windows 10)

**Use the installer:** [install-windows.md](install-windows.md) does every step below by itself
(one PowerShell line). The manual steps stay here to explain what it does.

1. **Node.js 22 LTS** from nodejs.org, and **MySQL 8 Community Server** (MySQL Installer,
   "Server only", run as a Windows service that starts automatically).
2. **Once, as the MySQL admin** (the only step that needs the admin password): put two long
   random passwords into a copy of `server/bootstrap.sql` and run it. It creates the database,
   the app's user `pos_app`, and `pos_migrate`, which only changes the database structure.
   ```sh
   mysql -u root -p < server/bootstrap.sql
   ```
3. Create `server/.env.migrate` (git-ignored) with the `pos_migrate` password, then create the
   tables. This is also how **every later database change** arrives: a new file in
   `server/migrations/`, applied once by this command, safe to run any time:
   ```
   MIGRATE_DATABASE_URL=mysql://pos_migrate:<migrate password>@localhost:3306/cheesybeez
   ```
   ```sh
   npm run server:migrate
   ```
   The migrations also give `pos_app` its rights: it may add and read events but **never change
   or delete them** (the audit trail, SCRUM-43). `UPDATE` on `shops` exists only because MySQL
   requires it for the `SELECT … FOR UPDATE` lock that keeps `seq` in order; on `staff` it is for
   switching someone off. There is no `UPDATE` or `DELETE` on `events` or `sessions`.
   `pos_migrate` *can* change anything in this database, so keep `server/.env.migrate` with the
   owner, not on a shared drive.
4. Create `server/.env` (it is git-ignored; it holds the password):
   ```
   DATABASE_URL=mysql://pos_app:<password>@localhost:3306/cheesybeez
   PORT=8080
   PRINTER=XP-80T
   ```
   `PRINTER` is the printer's name exactly as Windows shows it (Settings → Printers & scanners).
   Leave it out until the printer is there: receipts are then saved to `server/prints/` (dry run).
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
   means pairing again. A kitchen device shows the Kitchen only and needs no login.
7. Add the staff, each with their own 4-digit PIN (SCRUM-40). Roles: `cashier`, `manager`,
   `owner`, `kitchen`. Two people can never share a PIN.
   ```sh
   npm run server:staff -- add --shop shop-demo-cheesybeez --name Nimal --role cashier --pin <4 digits>
   npm run server:staff -- list --shop shop-demo-cheesybeez
   npm run server:staff -- remove --shop shop-demo-cheesybeez --id <id from list>
   ```
   Someone who leaves is removed (their PIN stops at once); to bring them back, add them again
   with a new PIN.
8. Start on boot: Task Scheduler → "At log on" → `npm run server` in the project folder (or wrap
   it with NSSM as a Windows service). Then Chrome opens `http://localhost:8080` full screen.

## Logins and roles (SCRUM-40/41)

- The counter opens on the PIN screen. Four digits, typed or tapped; the PIN alone says who it is.
  **F4** (or the name in the corner) switches user; the screen locks itself after 5 quiet minutes.
  If the Kitchen view is showing when it locks, it stays visible; the Register needs a PIN.
- After 5 wrong PINs in a row the counter waits 30 seconds before trying again.
- Roles: a cashier takes orders and payment and does not see the day's takings; a manager
  also changes, cancels and discounts (manager mode, Ctrl+M, their own PIN); the owner can do
  everything; a kitchen login sees the Kitchen only.
- **The server checks it, not just the screen:** each login is recorded (who, which device, until
  when), and an order event is stored only if its person was logged in on that device at that
  moment with a role that allows it. Anything else is refused and never stored.
- Development and `/?demo` keep the fake staff from `src/fake/data.ts`, with no PIN screen.

## Receipt printer and cash drawer (SCRUM-71)

The server prints: the app builds the receipt (`src/domain/receipt.ts`) and the server sends its
bytes to the Windows printer queue unchanged (`server/rawprint.ps1`, RAW datatype). The normal
Xprinter driver stays installed, so nothing else on the PC breaks. No separate helper program.

- Paying prints the receipt by itself. **Cash** also opens the drawer, before the paper, so change
  can be counted at once. Bank transfer and Free print without opening it.
- **Print again** on the paid screen prints a copy marked COPY and never opens the drawer.
- Only a device paired as `counter` may print: a kitchen tablet can never open the drawer.
- Setting it up at the shop: install the Xprinter driver, set `PRINTER` in `server/.env`, restart
  the server, open `http://localhost:8080/#receipt` and press **Print a test receipt** (it never
  opens the drawer). Then one real cash sale tests the drawer.
- If the receipt prints but characters look wrong, the printer's code page differs: everything is
  plain ASCII already, so check the driver's "raw"/"generic text" setting first.

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
