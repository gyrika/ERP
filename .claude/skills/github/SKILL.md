---
name: github
description: GitHub workflow for CheesyBeez ERP (gyrika/ERP). Start a SCRUM branch, commit, keep it in sync with main, resolve merge conflicts, push and open a PR; never merge. Use when the user says new branch, push, open a PR, update my branch, sync with main, merge conflict, or rebase.
---

# GitHub workflow

Repo `gyrika/ERP`, base branch `main`, Jira key `SCRUM`. A merge to `main` releases to the shop, so this skill stops at an open PR. Report each step honestly: a failing step stops the flow, and you say which one and show its output.

## 0. Setup check

```bash
gh auth status
```

If `gh` is missing or not logged in, stop and tell the user to run `sudo apt install gh`, then `! gh auth login`. Git over SSH already works for `origin`.

## 1. Start a branch

- Needs a Jira key (`SCRUM-nn`). None given → ask; never invent one.
- Never commit on `main`. Check `git status --short` first: uncommitted work belongs to someone's slice, so ask before carrying it to a new branch.

```bash
git fetch origin
git switch -c SCRUM-nn-short-name origin/main
```

## 2. Commit

Follow `ship-slice` for the checks, the rules and the message style (`<Area>: <what the user can now do> (SCRUM-nn)`). In short:
- `npm test && npm run build` pass first (plus `npm run build:cloud` when the Owner view or `cloud/` changed).
- Stage files by name, never `git add -A` or `git add .`.
- Never commit `excel/`, `*.xlsx`, `.env*`, `server/data/`, `server/prints/`, `dist*`, backups or `tsconfig.tsbuildinfo` (customer data, secrets, build artefacts).
- One purpose per commit. Two unrelated changes → ask whether to split.

## 3. Sync with main

Once a branch is pushed, **merge** main in; do not rebase it (teammates may have it checked out, and the history already uses merges such as "Merge main into order-ongoing-first: …").

```bash
git fetch origin
git merge origin/main
```

Rebase (`git rebase origin/main`) only for local commits that were never pushed. After either, rerun `npm test && npm run build`.

## 4. Resolve conflicts

```bash
git status --short
git diff --name-only --diff-filter=U
```

- Read both sides of every conflict and keep both intents. Never resolve a whole file with `--ours` / `--theirs` without reading it.
- `src/domain/menu.ts`: prices follow the owner's printed menu; keep the side that matches it and rerun the price tests.
- `CLAUDE.md` / `ARCHITECTURE.md` status lines: combine both slices into the terse status sentence.
- Event shapes: if both sides changed an event, `docs/sync-contract.md` and the server checks must match the result.
- `package-lock.json`: take main's (`git checkout --theirs package-lock.json` during a merge), then `npm install` and stage it.
- Intent unclear → ask the user. `git merge --abort` (or `git rebase --abort`) is the safe way out.
- The merge commit says what was kept, e.g. `Merge main into <branch>: keep both cart drafts and the waste bin`, ending with the Co-Authored-By line.

Then rerun `npm test && npm run build` before going on.

## 5. Push and open a PR

Pushing is outward-facing: confirm with the user first unless they already asked for it.

```bash
git push -u origin <branch>
gh pr create --base main --title "<commit-style title> (SCRUM-nn)" --body-file - <<'EOF'
## What
<what changed, from the shop's point of view>

## Why
<the problem or story>

## How tested
<npm test counts, npm run build, build:cloud if run, manual checks>

## Untested
<real printer, Windows, phone… or "nothing">

Jira: SCRUM-nn

<PR attribution line from the current reminder>
EOF
```

Use `--draft` for work in progress.

## 6. Safety rules

- Never merge a PR or push to `main` unless the user asks (a merge releases to the shop; see the `release` skill when it exists).
- Never force-push `main` or a teammate's branch. On your own branch, `git push --force-with-lease` only when the user asks.
- Never move or delete a tag.
- Never `git reset --hard`, `git clean -f` or `git checkout -- <file>` without looking at what would be lost and asking.

## 7. Report

Branch · commit hash · PR link (or "not pushed") · what the sync merged and how each conflict was resolved.
