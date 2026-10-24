---
name: ship-slice
description: Finish a slice of CheesyBeez POS work. Runs every check, updates CLAUDE.md status and ARCHITECTURE.md, then commits in the project's style. Use when a change is done, or when the user says ship, finish, wrap up, commit this, or "done".
---

# Ship a slice

A slice is done only when every step below passes. Report each result honestly: a failing step stops the ship, and you say which step failed and show its output.

## 1. See what changed

```bash
git status --short
git diff --stat
```

- Leave out anything that is not part of this slice. `tsconfig.tsbuildinfo` is a build artefact: never commit it.
- Never commit the owner's spreadsheets (`excel/`, `*.xlsx` with customer data), `.env*`, `server/data/` or `server/prints/`.
- If the diff mixes two unrelated changes, ask whether to split them into two commits.

## 2. Run the checks (all of them, every time)

```bash
npm test            # domain (node --test) + UI (vitest)
npm run build       # tsc --noEmit + vite build
```

Run this one as well when anything under `src/ui/Owner*`, `src/domain/insights.ts`, `cloud/` or code the Owner view imports has changed:

```bash
npm run build:cloud # the Owner view the cloud Worker serves to the phone
```

When a check fails, fix the cause, not the test. Tests that lock prices from `src/domain/menu.ts` follow the owner's printed menu, so change them only from the owner's menu.

## 3. Check the change against the rules

Read the diff once more and confirm:
- Money is integer cents everywhere. No floats, and a discount rounds once.
- Every new kitchen change, stock change or manager change is an **event** carrying `shopId`, and the server re-checks it (`server/`). If the event shape changed, `docs/sync-contract.md` matches it.
- Manager changes go through `applyManagerChange()` / `manage()`: they are audited, record before/after in cents, and return an Undo.
- There are no confirmation dialogs (the one exception is GRN undo, which needs a manager's PIN and a reason).
- New labels leave si/ta empty, never guessed. Touch targets are at least 48px, the change is keyboard-operable, and colours come from the tokens in `styles.css`.

Fix anything that breaks a rule, then rerun step 2.

## 4. Update the docs

- **CLAUDE.md → "Status and next"**: add the slice in one short sentence in the same terse style (what was built, the key file, anything untested on real hardware), and update **Next:** if it changed. Small polish to an existing screen does not go here.
- **ARCHITECTURE.md**: update it only for a new decision, a change to the build order, or an open question answered or raised. Date decisions (e.g. "(2026-10-23)").
- Update a `docs/*.md` guide when its behaviour changed (`inventory-purchasing.md`, `cloud.md`, `server-setup.md`, `install-windows.md`, `sync-contract.md`).

## 5. Commit

Match the existing history:
- Subject: `<Screen or area>: <what the user can now do> (SCRUM-nn)` in plain words, from the shop's point of view, not the code's. The Jira key links the commit to its story. Examples: `Purchase order bill: the price of one pack can be changed on its line`, `Order page: the open orders come first, above the suppliers to order from`.
- Body (when it helps): a short paragraph or `- ` bullets saying how it behaves (keys, Undo, what is audited). Wrap at about 100 characters.
- End with the Co-Authored-By line from the current attribution reminder.

```bash
git add <the slice's files>
git commit -F - <<'EOF'
<subject>

<body>

Co-Authored-By: ...
EOF
```

Do not push, merge, tag or deploy unless the user asks; pushing, PRs, review and merging follow the `github` skill. A `v*` tag publishes a release, and the shop PCs install it at 4 am.

## 6. Report

Give a few lines:
- what shipped (the commit subject)
- the check results (test counts, build ok, cloud build if it ran)
- which docs were updated
- anything left untested (for example the real printer, Windows, or the phone)
