# CheesyBeez Android app (TWA)

The app is **cheesybeez.com in Chrome, full screen** (a Trusted Web Activity): every change to the
site is in the app at once, and offers arrive as normal Android notifications (Web Push through
Chrome's notification delegation: no Firebase, no cost). Nothing to build in the app itself.

## Build it once (a developer PC with Node 20+)
1. `npm i -g @bubblewrap/cli`, then in an empty folder **outside this repo**:
   `bubblewrap init --manifest https://cheesybeez.com/order.webmanifest` and answer with the values in
   `twa/twa-manifest.json` (package `com.cheesybeez.app`, notifications **on**). Bubblewrap offers to
   install the JDK and Android SDK it needs.
2. It makes the **signing key** (`cheesybeez-app-signing.keystore`). Keep it, and its passwords, in the
   team's password manager, never in the repo: an app can only be updated with the key it was signed with.
3. `bubblewrap build` gives `app-release-signed.apk` (and an `.aab` for Google Play).
4. `bubblewrap fingerprint list` (or `keytool -list -v -keystore …`) shows the key's **SHA-256** fingerprint.

## Tell the site the app is ours
In `cloud/wrangler.toml` `[vars]` (not secrets: both are public):
```
TWA_PACKAGE = "com.cheesybeez.app"
TWA_SHA256 = "AA:BB:…"   # the fingerprint; with Google Play App Signing, add Play's too, comma-separated
```
Deploy the cloud; `https://cheesybeez.com/.well-known/assetlinks.json` then vouches for the app, and
the app opens without a browser bar. Until then it still works, with a bar.

## Give it to customers
- Google Play: upload the `.aab` (a one-time USD 25 developer account).
- Or the `.apk` from cheesybeez.com (customers allow "install unknown apps" once).

## Offers in the app
"Get offers" on the page asks for the mobile number and notification permission; the shop PC then
sends campaigns from Customers › Campaigns (server/crm/). iPhones: Safari, Share › Add to Home Screen.
