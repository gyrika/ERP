import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ACTIVE_MS, handle, repoOf, scan, segments } from "./worktree-guard.mjs";

const HOOK = fileURLToPath(new URL("./worktree-guard.mjs", import.meta.url));

/** A throwaway repo with one commit and a linked worktree next to it. */
function repo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "guard-"));
  const main = path.join(root, "ERP");
  const git = (...args) => execFileSync("git", ["-C", main, ...args], { stdio: "ignore" });
  fs.mkdirSync(main);
  git("init", "-q", "-b", "main");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "start");
  git("worktree", "add", "-q", path.join(root, "ERP-x"), "-b", "x");
  return { main, wt: path.join(root, "ERP-x") };
}

const bash = (session, cwd, command) => ({ hook_event_name: "PreToolUse", session_id: session, cwd, tool_name: "Bash", tool_input: { command } });

test("segments: splits on && ; | and keeps quoted words whole", () => {
  assert.deepEqual(segments(`cd "/a b" && git commit -m 'x; y' | tee o; ls`), [
    ["cd", "/a b"], ["git", "commit", "-m", "x; y"], ["tee", "o"], ["ls"],
  ]);
});

test("scan: follows cd and git -C, ignores safe git commands", () => {
  const r = scan(`cd ../ERP-x && git status && git -C /r checkout -b y && git stash list && git stash`, "/w/ERP");
  assert.deepEqual(r.risky, [{ sub: "checkout", dir: "/r" }, { sub: "stash", dir: "/w/ERP-x" }]);
  assert.deepEqual(r.dirs, ["/w/ERP-x", "/r"]);
});

test("repoOf: a linked worktree shares the main repo's .git", () => {
  const { main, wt } = repo();
  assert.equal(repoOf(path.join(main)).top, main);
  assert.equal(repoOf(wt).top, wt);
  assert.equal(repoOf(wt).common, repoOf(main).common);
});

test("a lone session is never blocked", () => {
  const { main } = repo();
  assert.equal(handle(bash("a", main, "git status"), 1000), null);
  assert.equal(handle(bash("a", main, "git checkout -b y"), 2000), null);
});

test("blocks a branch switch where another session is working, and says how to move", () => {
  const { main } = repo();
  handle(bash("a", main, "npm test"), 1000);
  const msg = handle(bash("b", main, "git checkout -b SCRUM-148-x"), 2000);
  assert.match(msg, /another Claude session worked in/);
  assert.match(msg, /git worktree add|worktree add/);
});

test("sessions in different worktrees of the same repo don't block each other", () => {
  const { main, wt } = repo();
  handle(bash("a", main, "npm test"), 1000);
  assert.equal(handle(bash("b", wt, "git commit -m x"), 2000), null);
  assert.equal(handle(bash("b", main, `cd "${wt}" && git commit -m x`), 3000), null);
});

test("an edit counts as working in that folder", () => {
  const { main } = repo();
  handle({ hook_event_name: "PreToolUse", session_id: "a", cwd: "/", tool_name: "Edit", tool_input: { file_path: path.join(main, "x.ts") } }, 1000);
  assert.ok(handle(bash("b", main, "git stash"), 2000));
});

test("the block lifts after ACTIVE_MS or when the other session ends", () => {
  const { main } = repo();
  handle(bash("a", main, "ls"), 1000);
  assert.equal(handle(bash("b", main, "git pull"), 1000 + ACTIVE_MS), null);
  handle(bash("a", main, "ls"), 2 * ACTIVE_MS);
  assert.ok(handle(bash("b", main, "git pull"), 2 * ACTIVE_MS + 1));
  handle({ hook_event_name: "SessionEnd", session_id: "a", cwd: main }, 2 * ACTIVE_MS + 2);
  assert.equal(handle(bash("b", main, "git pull"), 2 * ACTIVE_MS + 3), null);
});

test("as a hook: exit 2 with the reason on stderr; bad input never blocks", () => {
  const { main } = repo();
  const run = (input) => spawnSync(process.execPath, [HOOK], { input, encoding: "utf8" });
  assert.equal(run(JSON.stringify(bash("a", main, "ls"))).status, 0);
  const blocked = run(JSON.stringify(bash("b", main, "git switch main")));
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /worktree guard/);
  assert.equal(run("not json").status, 0);
});
