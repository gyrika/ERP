---
name: github
description: GitHub workflow for CheesyBeez ERP (gyrika/ERP). Start a SCRUM branch, commit, keep it in sync with main, resolve merge conflicts, push, open a PR, get it reviewed and merged. Use when the user says new branch, commit and push, open a PR, update my branch, sync with main, merge conflict, rebase, review, or merge.
---

# GitHub workflow

Repo `gyrika/ERP`, base branch `main`, Jira key `SCRUM`, team of 4. **A merge to `main` releases to the shop**, so work reaches `main` only through a reviewed PR. Report each step honestly: a failing step stops the flow, and you say which one and show its output.

## 0. Setup (Windows)

```bash
gh auth status
```

- `gh` missing → the user runs `winget install GitHub.cli`, opens a new terminal, then `gh auth login` (GitHub.com, HTTPS or SSH, log in with a browser). You cannot log in for them.
- Installed but not on PATH yet (the shell was open before the install): call it as `"C:/Program Files/GitHub CLI/gh.exe"`.
- Git over SSH already works for `origin`.

Shell traps on the counter PC and dev laptops:
- PowerShell 5.1 has no `&&`, and a multi-line `-m @'…'@` breaks when the message holds quotes. Commit from Git Bash with `git commit -F - <<'EOF'` (below).
- If `npm` is "not recognized" inside Git Bash, run npm from PowerShell.
- Never a bare `git stash`: every worktree shares one stash. Make a WIP commit instead.

## 1. Start a branch

- Needs a Jira key (`SCRUM-nn`). None given → ask; never invent one. The key goes in the branch name, every commit subject and the PR title: that is what links them to the Jira issue.
- Never commit on `main`. Check `git status --short` first: uncommitted work belongs to someone's slice, so ask before carrying it to a new branch.

```bash
git fetch origin
git switch --no-track -c SCRUM-nn-short-name origin/main
```

`--no-track` matters: without it the new branch tracks `origin/main`, and a plain `git push` would go to `main`.

- A tool-made branch (`claude/…`, `codex/…`) gets a proper name before its first push: `git branch -m SCRUM-nn-short-name`.
- One story per branch. Teammates' branches: don't push to them without asking.

## 2. Commit

Follow `ship-slice` for the checks, the rules and the message style (`<Area>: <what the user can now do> (SCRUM-nn)`). In short:
- `npm test && npm run build` pass first (plus `npm run build:cloud` when the Owner view or `cloud/` changed).
- Stage files by name, never `git add -A` or `git add .`.
- Never commit `excel/`, `*.xlsx`, `.env*`, `server/.env*`, `server/data/`, `server/prints/`, `dist*`, backups or `tsconfig.tsbuildinfo` (customer data, secrets, build artefacts).
- One purpose per commit. Two unrelated changes → ask whether to split.

```bash
git add <files>
git commit -F - <<'EOF'
<Area>: <what the user can now do> (SCRUM-nn)

<short body>

<Co-Authored-By line from the current attribution reminder>
EOF
```

## 3. Sync with main

Once a branch is pushed, **merge** main in; do not rebase it (teammates may have it checked out, and the history already uses merges such as "Merge main into order-ongoing-first: …").

```bash
git fetch origin
git merge origin/main
```

Rebase (`git rebase origin/main`) only for local commits that were never pushed. After either, rerun `npm test && npm run build`. Sync before asking for review and again before merging when `main` has moved.

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
gh pr list --head <branch> --state all   # one PR per branch: reuse it if it exists
git push -u origin <branch>
gh pr create --base main --title "<Area>: <what changed> (SCRUM-nn)" --body-file - <<'EOF'
<the sections of .github/pull_request_template.md, filled in>
EOF
```

- Use `--draft` while work is in progress, and `gh pr ready` when it is done.
- Keep a PR small and about one story: easier to review, safer to release.
- Optionally comment the PR link on the Jira issue.

## 6. Review

- Ask one teammate to review: `gh pr edit <n> --add-reviewer <login>`. The author never approves their own PR.
- As a reviewer: run it (`gh pr checkout <n>`, `npm test`, `npm run dev`), read the diff against the rules in `ship-slice` step 3, and answer with `gh pr review <n> --approve` or `--request-changes -b "<what and why>"`. Comment on the line, say what is wrong and what you would do instead.
- The author answers every comment (a fix commit, or a reply saying why not), then asks for review again. Push fixes as new commits; never force-push a branch under review.

## 7. Merge

Only when the user asks, and only when all of these hold:
- one approval from someone other than the author (`gh pr view <n> --json reviewDecision` says `APPROVED`)
- CI is green (`gh pr checks <n>`)
- the branch is up to date with `main` (step 3), and its tests and build passed after the last sync
- the Untested section is something the team accepts for a release

```bash
gh pr merge <n> --merge --delete-branch
```

`--merge` keeps the merge-commit history the repo already uses (no squash, no rebase). Then move the Jira issue to Done and pull `main` locally (`git switch main && git pull`). Merging releases to the shop; tags and deploys follow the `release` skill.

## 8. Safety rules

- Never merge a PR or push to `main` unless the user asks.
- Never force-push `main` or a teammate's branch. On your own branch, `git push --force-with-lease` only when the user asks, and never while it is under review.
- Never move or delete a tag.
- Never `git reset --hard`, `git clean -f` or `git checkout -- <file>` without looking at what would be lost and asking.
- Stop and ask when tests fail or unrelated changes are in the tree.

## 9. Report

Branch · commit hash · PR link (or "not pushed") · review and CI state · what the sync merged and how each conflict was resolved.
