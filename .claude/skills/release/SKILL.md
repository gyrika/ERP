---
name: release
description: Release CheesyBeez: merging a PR to main runs tests, deploys the cloud (staging, then live), builds Setup.exe with the next version and publishes it when what the shop installs changed; shop PCs install it at the next PC start or late at night.
---

# Release

A merge to `main` IS the release (`.github/workflows/station.yml`). Three jobs run side by side, then one waits for all:
**cloud** (Linux tests → staging migrate + deploy + health → live) · **test-windows** · **build** (Setup.exe vX.Y.(Z+1))
→ **release** (GitHub Release), only when all three are green **and** Setup.exe content changed.
An older cloud refuses unknown event types and stops the shop's copy, so no Setup.exe is published before the cloud is live.

"Content changed" = `deploy/station/content-hash.mjs` (staged app, runtime deps, node.exe, `deploy/station` files) differs from the
`<!-- content: … -->` hash in the last release's notes. Tooling, tests, docs, dev deps and cloud-only changes: cloud deploys, no release
(the build job's summary says which). To force a release anyway, change something in `deploy/station` (e.g. raise `release-line.txt`).

1. Before merging: CI green on the PR (the build summary says whether a merge would release); `npm test && npm run build && npm run build:cloud` locally.
2. Merging is outward-facing (the cloud at once, the counter at its next start or night) → confirm with the user first.
3. Watch it: `gh run watch --exit-status` on the push run. Cloud or test-windows red → nothing was released; fix forward.
4. If released: the Release has `CheesyBeez-Setup-*.exe` and lists the merged PRs; `/admin` in the cloud shows each shop moving to it.

Needs repository secrets CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID (without them the cloud job fails and nothing ships).
Shop PCs check every 5 min (`CheesyBeez Station update` task), download ahead, install in the first minutes after Windows starts or 23:00–06:00 once quiet for an hour, back up first and roll back by themselves. "Update now" in Shop setup → Updates forces it.
Rules: never move or delete a published tag; fix forward with a new merge. Docs-only changes do not run the workflow.
Report: version (or "no release: content unchanged") · cloud deployed (y/n) · run link · Release link.
