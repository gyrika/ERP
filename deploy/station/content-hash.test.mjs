import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { contentHash } from "./content-hash.mjs";

/** A repo with the Station's own files and a staged app, like stage.ps1 leaves it. */
function staged() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stage-"));
  const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
  put("deploy/station/CheesyBeez.iss", "[Setup]");
  put("deploy/station/pos-app/Program.cs", "class P {}");
  execFileSync("git", ["-C", root, "init", "-q"]);
  execFileSync("git", ["-C", root, "add", "."]);
  const s = "deploy/station/stage";
  put(`${s}/node/node.exe`, "node 22.23.3");
  put(`${s}/app/dist/index.html`, "<div id=root>");
  put(`${s}/app/server/index.ts`, "serve()");
  put(`${s}/app/package.json`, JSON.stringify({ type: "module", scripts: { test: "a" }, dependencies: { ws: "^8" }, devDependencies: { vite: "8" } }));
  put(`${s}/app/package-lock.json`, "{\"dev\":1}");
  put(`${s}/app/node_modules/.package-lock.json`, "{\"ws\":\"8.22.0\"}");
  put(`${s}/app/node_modules/ws/index.js`, "module.exports = 1");
  return { root, stage: path.join(root, s), put: (rel, text) => put(path.join(s, rel), text), putRepo: put };
}

test("the same content gives the same hash", () => {
  const a = staged();
  assert.match(contentHash(a.stage, a.root), /^[0-9a-f]{64}$/);
  assert.equal(contentHash(a.stage, a.root), contentHash(a.stage, a.root));
});

test("scripts, dev tools and the full lock don't count; what reaches the shop does", () => {
  const a = staged();
  const before = contentHash(a.stage, a.root);
  a.put("app/package.json", JSON.stringify({ type: "module", scripts: { test: "b" }, dependencies: { ws: "^8" }, devDependencies: { vite: "9" } }));
  a.put("app/package-lock.json", "{\"dev\":2}");
  assert.equal(contentHash(a.stage, a.root), before);

  for (const [rel, text] of [
    ["app/dist/index.html", "<div id=app>"],
    ["app/node_modules/.package-lock.json", "{\"ws\":\"8.23.0\"}"],
    ["node/node.exe", "node 22.24.0"],
  ]) {
    const b = staged();
    const was = contentHash(b.stage, b.root);
    b.put(rel, text);
    assert.notEqual(contentHash(b.stage, b.root), was, rel);
  }
});

test("a change to the installer or the counter app's sources counts", () => {
  const a = staged();
  const before = contentHash(a.stage, a.root);
  a.putRepo("deploy/station/pos-app/Program.cs", "class Q {}");
  assert.notEqual(contentHash(a.stage, a.root), before);
});
