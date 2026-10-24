// What a Setup.exe would install, as one SHA-256 (SCRUM-149): the staged app, Node.js and the Station's own
// files. A merge whose hash matches the last release changes nothing at the shop, so nothing is released.
// Usage (repo root, after stage.ps1): node deploy/station/content-hash.mjs [stageDir]
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const sha = (data) => createHash("sha256").update(data).digest("hex");

function filesIn(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(base, full).split(path.sep).join("/");
    // npm ci from the same lock gives the same packages: the installed list stands for node_modules.
    if (rel === "node_modules") { if (fs.existsSync(path.join(full, ".package-lock.json"))) out.push("node_modules/.package-lock.json"); }
    else if (entry.isDirectory()) out.push(...filesIn(full, base));
    else out.push(rel);
  }
  return out;
}

/** [name, sha256] for everything that ends up in Setup.exe, sorted by name. */
export function parts(stage, root) {
  const app = path.join(stage, "app");
  const list = [];
  for (const rel of filesIn(app)) {
    // package.json also holds scripts and dev tools that never reach the shop.
    if (rel === "package.json" || rel === "package-lock.json") continue;
    list.push([`app/${rel}`, sha(fs.readFileSync(path.join(app, rel)))]);
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(app, "package.json"), "utf8"));
  list.push(["app/package.json (runtime)", sha(JSON.stringify({ type: pkg.type, dependencies: pkg.dependencies }))]);
  if (!fs.existsSync(path.join(app, "node_modules/.package-lock.json"))) {
    list.push(["app/package-lock.json", sha(fs.readFileSync(path.join(app, "package-lock.json")))]);
  }
  list.push(["node/node.exe", sha(fs.readFileSync(path.join(stage, "node/node.exe")))]);

  // The installer, the update scripts and the counter app's sources (built output differs each build).
  const tracked = execFileSync("git", ["-C", root, "ls-files", "-z", "deploy/station"], { encoding: "utf8" })
    .split("\0").filter((rel) => rel && !rel.endsWith(".test.mjs") && !rel.endsWith("/content-hash.mjs"));
  for (const rel of tracked) list.push([rel, sha(fs.readFileSync(path.join(root, rel)))]);

  return list.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

export function contentHash(stage, root) {
  return sha(parts(stage, root).map(([name, h]) => `${name}\0${h}\n`).join(""));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  process.stdout.write(contentHash(path.resolve(process.argv[2] ?? path.join(root, "deploy/station/stage")), root) + "\n");
}
