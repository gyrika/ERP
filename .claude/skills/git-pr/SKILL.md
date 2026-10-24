---
name: git-pr
description: Branch, commit and open a PR for a Jira SCRUM story in gyrika/ERP; never merge.
---
# Git / PR

1. Need a Jira key (SCRUM-nn). None given → ask; don't invent one.
2. Branch from fresh `main`: `SCRUM-nn-short-name` (or the name the user gives). Never commit on `main`.
3. Before staging: `git status --short`. Stage files by name, never `git add -A`. Never commit `excel/`, `*.xlsx`, `.env*`, `server/.env*`, backups, `dist*` (customer data / secrets).
4. `npm test && npm run build` must pass before commit.
5. Commit message: imperative summary with the key, e.g. `Recipes: food cost per item (SCRUM-77)`, short body if needed, then the attribution line.
6. `git push -u origin <branch>`; `gh pr create --base main` with: what changed, why, how tested, Jira link; end with the attribution line.
7. Optionally comment the PR link on the Jira issue.

Rules: never merge, force-push to `main`, or rewrite pushed history unless the user asks. Teammates' branches (e.g. danit-x's) — don't push to them without asking.
Stop: tests fail, or unrelated changes are in the tree → ask what to include.
Report: branch · commit hash · PR link.
