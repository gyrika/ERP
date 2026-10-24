---
name: release
description: Release CheesyBeez: merging a PR to main runs tests, deploys the cloud (staging, then live), builds Setup.exe with the next version and publishes it; shop PCs install it within minutes when the counter is quiet.
---

# Release

A merge to `main` IS the release (`.github/workflows/station.yml`). Order is fixed and automatic:
**tests → cloud staging (migrate + deploy + health) → cloud live → Setup.exe vX.Y.(Z+1) → GitHub Release.**
An older cloud refuses unknown event types and stops the shop's copy, so the cloud always goes first.

1. Before merging: CI green on the PR; `npm test && npm run build && npm run build:cloud` locally.
2. Merging is outward-facing (it reaches Nisal's counter within minutes) → confirm with the user first.
3. Watch it: `gh run watch --exit-status` on the push run. Cloud job red → nothing was released; fix forward.
4. Confirm the Release has `CheesyBeez-Setup-*.exe`, then `/admin` in the cloud shows each shop moving to it.

Needs repository secrets CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID (without them the cloud job fails and nothing ships).
Shop PCs check every 5 min (`CheesyBeez Station update` task), install only after 15 quiet minutes, back up first and roll back by themselves; 4 am is the nightly backup. "Update now" in Shop setup → Updates forces it.
Rules: never move or delete a published tag; fix forward with a new merge. Docs-only changes do not release.
Report: version · cloud deployed (y/n) · run link · Release link.
