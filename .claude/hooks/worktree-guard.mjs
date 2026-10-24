#!/usr/bin/env node
// Worktree guard (SCRUM-147): several Claude sessions share the ERP folder.
// Each session leaves a heartbeat saying which folders it works in; a git
// command that moves HEAD or rewrites the tree is blocked when another live
// session works in the same folder, and Claude is told to use its own worktree.
// Runs as a Claude Code hook (PreToolUse on every tool, SessionEnd); exit 2 blocks.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** A session counts as working in a folder for this long after its last edit or command. */
export const ACTIVE_MS = 30 * 60 * 1000;

const RISKY = new Set([
  "checkout", "switch", "commit", "reset", "stash", "rebase", "merge",
  "pull", "cherry-pick", "revert", "am", "restore", "clean",
]);
const SAFE_STASH = new Set(["list", "show"]);
const WORKS_IN = new Set(["Bash", "Edit", "Write", "NotebookEdit"]);

/** Splits a shell command into words per segment (&&, ||, ;, |, newline), honouring quotes. */
export function segments(command) {
  const out = [[]];
  let word = null;
  const push = () => { if (word !== null) out[out.length - 1].push(word); word = null; };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === '"' || c === "'") {
      const end = command.indexOf(c, i + 1);
      const stop = end === -1 ? command.length : end;
      word = (word ?? "") + command.slice(i + 1, stop);
      i = stop;
    } else if (c === "\\" && i + 1 < command.length) {
      word = (word ?? "") + command[++i];
    } else if (/\s/.test(c) && c !== "\n") {
      push();
    } else if (c === "\n" || c === ";" || c === "|" || c === "&") {
      push();
      if (out[out.length - 1].length) out.push([]);
      if ((c === "&" || c === "|") && command[i + 1] === c) i++;
    } else {
      word = (word ?? "") + c;
    }
  }
  push();
  return out.filter((s) => s.length);
}

/** The folders a shell command works in (after any cd) and its risky git commands. */
export function scan(command, cwd) {
  let dir = cwd;
  const risky = [];
  const dirs = new Set();
  for (const words of segments(command)) {
    let w = words;
    while (w.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0])) w = w.slice(1);
    if (w[0] === "cd") { dir = path.resolve(dir, w[1] ?? process.env.HOME ?? dir); continue; }
    if (w[0] !== "git") { if (w.length) dirs.add(dir); continue; }
    let at = dir;
    let i = 1;
    for (; i < w.length && w[i].startsWith("-"); i++) {
      if (w[i] === "-C" && w[i + 1]) at = path.resolve(at, w[++i]);
      else if (w[i] === "-c" || w[i] === "--git-dir" || w[i] === "--work-tree") i++;
    }
    const sub = w[i];
    dirs.add(at);
    if (!RISKY.has(sub)) continue;
    if (sub === "stash" && SAFE_STASH.has(w[i + 1])) continue;
    risky.push({ sub, dir: at });
  }
  return { risky, dirs: [...dirs] };
}

/** The working tree a path belongs to and the repo's shared .git folder, or null outside git. */
export function repoOf(start) {
  let dir = path.resolve(start);
  for (;;) {
    const dotGit = path.join(dir, ".git");
    let stat = null;
    try { stat = fs.statSync(dotGit); } catch { /* keep walking up */ }
    if (stat?.isDirectory()) return { top: dir, common: dotGit };
    if (stat?.isFile()) {
      const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, "utf8"));
      if (!m) return null;
      const gitDir = path.resolve(dir, m[1].trim());
      let common = path.resolve(gitDir, "../..");
      try { common = path.resolve(gitDir, fs.readFileSync(path.join(gitDir, "commondir"), "utf8").trim()); } catch { /* old git */ }
      return { top: dir, common };
    }
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/** Other sessions that worked in `top` within ACTIVE_MS, newest first: [{ id, at }]. */
export function othersIn(heartbeats, me, top, now) {
  return Object.entries(heartbeats)
    .filter(([id]) => id !== me)
    .map(([id, beat]) => ({ id, at: beat.tops?.[top] }))
    .filter((s) => typeof s.at === "number" && now - s.at < ACTIVE_MS)
    .sort((a, b) => b.at - a.at);
}

function folderOf(common) { return path.join(common, "claude-sessions"); }

function readBeats(common) {
  const beats = {};
  let names = [];
  try { names = fs.readdirSync(folderOf(common)); } catch { return beats; }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try { beats[name.slice(0, -5)] = JSON.parse(fs.readFileSync(path.join(folderOf(common), name), "utf8")); } catch { /* half-written */ }
  }
  return beats;
}

function beat(common, me, top, now) {
  const file = path.join(folderOf(common), `${me}.json`);
  let mine = { tops: {} };
  try { mine = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* first beat */ }
  mine.tops = Object.fromEntries(Object.entries(mine.tops ?? {}).filter(([, at]) => now - at < ACTIVE_MS));
  mine.tops[top] = now;
  fs.mkdirSync(folderOf(common), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(mine));
  fs.renameSync(`${file}.tmp`, file);
}

function blockMessage({ sub, top }, others, now) {
  const mins = Math.max(1, Math.round((now - others[0].at) / 60000));
  const name = path.basename(top);
  return [
    `Blocked by the worktree guard: ${others.length === 1 ? "another Claude session" : `${others.length} other Claude sessions`} worked in ${top} ${mins} min ago, and \`git ${sub}\` there would move the branch or files under ${others.length === 1 ? "it" : "them"}.`,
    `Do this work in your own worktree instead, for example:`,
    `  git -C "${top}" worktree add "../${name}-<SCRUM-nn>" -b <SCRUM-nn-short-name> origin/main`,
    `then cd into it and continue there. The block lifts by itself ${Math.round(ACTIVE_MS / 60000)} min after the other session last worked here.`,
  ].join("\n");
}

/** Handles one hook call; returns the message to block with, or null. */
export function handle(input, now = Date.now()) {
  const me = input.session_id;
  if (!me) return null;
  const cwd = input.cwd || process.cwd();

  if (input.hook_event_name === "SessionEnd") {
    const repo = repoOf(cwd);
    if (repo) fs.rmSync(path.join(folderOf(repo.common), `${me}.json`), { force: true });
    return null;
  }
  if (input.hook_event_name !== "PreToolUse" || !WORKS_IN.has(input.tool_name)) return null;

  const file = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
  const command = input.tool_name === "Bash" ? String(input.tool_input?.command ?? "") : "";
  const { risky, dirs } = command ? scan(command, cwd) : { risky: [], dirs: [] };

  for (const { sub, dir } of risky) {
    const repo = repoOf(dir);
    if (!repo) continue;
    const others = othersIn(readBeats(repo.common), me, repo.top, now);
    if (others.length) return blockMessage({ sub, top: repo.top }, others, now);
  }

  const places = file ? [path.dirname(path.resolve(cwd, file))] : dirs.length ? dirs : [cwd];
  for (const place of places) {
    const repo = repoOf(place);
    if (repo) beat(repo.common, me, repo.top, now);
  }
  return null;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  let raw = "";
  process.stdin.on("data", (d) => { raw += d; });
  process.stdin.on("end", () => {
    let message = null;
    try { message = handle(JSON.parse(raw || "{}")); } catch { /* never break a session over the guard itself */ }
    if (message) { process.stderr.write(message + "\n"); process.exit(2); }
  });
}
