---
name: ci-debug
description: Debug a failing GitHub Actions run (CheesyBeez Station workflow on windows-latest) and make the smallest fix.
---
# CI debug

The only workflow is `.github/workflows/station.yml` (Windows): `npm ci` → `npm test` → `npm run build` → `stage.ps1` → backup check → dotnet counter app → Inno Setup → Release on `v*` tags.

1. `gh run list --limit 5`, then `gh run view <id> --log-failed | tail -80`. Don't download full logs.
2. Take the FIRST real error and the step that failed.
3. Classify:
   - test/build → reproduce locally with the single failing test file.
   - Windows-only (paths `\` vs `/`, CRLF, PowerShell, `node:sqlite`, timeouts) → fix the code to be portable; can't reproduce on Linux, say so.
   - stage/installer step → read only the failing part of `deploy/station/*.ps1` or `CheesyBeez.iss`.
4. Smallest fix; run the targeted test, then `npm test && npm run build`.
5. Push to the branch and watch: `gh run watch <id> --exit-status`.

Rules: never skip/delete tests or steps to go green; don't change the Node version, permissions or tag trigger unless that IS the bug; never re-tag a published version.
Stop: after 3 failed attempts, or if the fix needs secrets/settings on GitHub → report and ask.
Report: failing step · root cause · fix · files · run result.
