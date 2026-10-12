# Installing the POS on the shop PC (and looking after it from far away)

The shop is in Thalwila; development happens in Galle. So the shop PC is set up **once**, by
one script, and after that everything (updates, checks, fixes) is done remotely.

## Before you start (with whoever is at the shop, on the phone)

1. The counter PC: Windows 10 or 11, on mains power, connected to the internet.
2. **AnyDesk** installed (anydesk.com, free). They read you the 9-digit AnyDesk address; you
   connect from Galle and do the rest yourself. Ask them to set an **unattended access**
   password (AnyDesk > Settings > Security), so you can connect later without them clicking Accept.
3. The receipt printer (Xprinter XP-80T) plugged in by USB, its **Windows driver installed**
   (from the CD or xprintertech.com), and the cash drawer's cable in the printer's RJ11 port.
   Windows' own test page should print.

## The one step

On the shop PC: Start > type **PowerShell** > right-click > **Run as administrator**, then paste:

```powershell
irm https://raw.githubusercontent.com/gyrika/ERP/main/deploy/windows/get.ps1 | iex
```

It downloads the POS to `C:\CheesyBeez\ERP` and runs `deploy\windows\install.ps1`, which:

- installs **Node.js**, and its **own MySQL** (a Windows service that starts with the PC), with
  random passwords it saves for the server (administrators only). If the PC already has a MySQL,
  it asks: a separate one just for the POS on port 3307 (recommended: needs no password, never
  touches the other one) or the existing one (needs its admin password; it is started and set to
  start with Windows);
  the MySQL admin password ends up in `C:\CheesyBeez\mysql-root-password.txt` (give the owner a copy);
- creates the database and its two users, builds the app, applies the database changes;
- asks **which printer** prints receipts (a numbered list);
- asks for the **staff**: name, role (cashier, manager, owner, kitchen), 4-digit PIN each;
- makes the server start with Windows (it restarts itself if it ever stops), and the POS open
  **full screen** whenever someone logs in to Windows;
- schedules a **backup every night at 3 am** (14 days kept, in `C:\CheesyBeez\backups`);
- asks whether to **install updates by themselves at 4 am** (say no until you trust it);
- stops the PC from sleeping, and opens port 8080 to the shop's private Wi-Fi only (for a
  kitchen tablet later).

Questions it asks: the MySQL admin password (only if MySQL was already installed), the printer,
the staff. Everything else is automatic. If it stops halfway (no internet, a typo), just run it
again: it skips what is done.

## Then, at the counter

1. The POS opens on the PIN screen. Log in with a PIN.
2. **Printer:** open `http://localhost:8080/#receipt` and press **Print a test receipt** (it never
   opens the drawer). Ask for a photo of the paper on WhatsApp.
3. **Drawer:** one real cash sale. The drawer should pop as the receipt starts printing.
4. Unplug the printer and make a sale: note what the screen says (the printer-status gap in
   SCRUM-71), then plug it back.

## The cloud copy

After the install, connect the shop to the cloud copy so its sales are also kept off-site:
[cloud.md](cloud.md) ("Setting it up for a shop"). `status.ps1` then shows when the cloud last
confirmed it has every sale.

## From Galle, afterwards

Connect with AnyDesk, open PowerShell **as administrator**, then:

| What | Command |
|---|---|
| Is everything all right? | `C:\CheesyBeez\ERP\deploy\windows\status.ps1` |
| Install the newest version | `C:\CheesyBeez\ERP\deploy\windows\update.ps1` |
| …even while orders come in | `C:\CheesyBeez\ERP\deploy\windows\update.ps1 -Force` |
| Add or remove staff | `cd C:\CheesyBeez\ERP` then `npm run server:staff -- add --shop cheesybeez-thalwila --name … --role … --pin …` |
| Back up right now | `C:\CheesyBeez\ERP\deploy\windows\backup.ps1` |
| Change the printer | run `install.ps1` again (it keeps everything else) |
| Remove the POS from a PC (a test PC, an old counter) | `C:\CheesyBeez\ERP\deploy\windows\uninstall.ps1` (asks before deleting any data) |

`status.ps1` shows, in one screen: server, start-up task, MySQL, version, printer (and jobs
stuck in its queue), last backup, free disk, and the end of the server log.

`update.ps1` refuses while orders are coming in (any activity in the last 15 minutes) unless
you add `-Force`. It builds the new version while the old one keeps running, applies database
changes, then switches over; if anything fails, it **puts the old version back** by itself.
Logs of every install and update are in `C:\CheesyBeez\logs`.

## Good to know

- The internet at the shop only matters for AnyDesk and updates. The POS itself runs entirely
  on the PC: no internet needed to sell.
- Keep a USB stick with a folder named `CheesyBeezBackup` plugged in: the nightly backup is
  copied there too. Until the cloud copy (SCRUM-61) exists, that is the copy that survives if
  the PC dies.
- These scripts were written and syntax-checked on Linux; their first real run is on a Windows
  PC. Try them first in **Windows Sandbox** (Windows 10/11 Pro: Turn Windows features on or off >
  Windows Sandbox), which throws everything away when closed, or on a spare PC and then run
  `uninstall.ps1`. Not in Docker: that tests Linux, not the Windows installer.
