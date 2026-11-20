import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { ENGINE_COPY_EXCLUDES, ENGINE_COPY_PATHS, emptyStore, engineFiles, treeConfigFor } from "./tree-init.mjs";
import { parseTreeConfig } from "./tree-config.mjs";

test("a new tree's config is valid and switches nothing on", () => {
  const config = parseTreeConfig(JSON.stringify(treeConfigFor({ id: "smith-family", title: "Smith Family", rootPersonIds: ["ann-smith"], primaryCheckout: "/srv/smith" })));
  assert.equal(config.tree.id, "smith-family");
  assert.deepEqual(config.scopes.additional, []);
  assert.equal(config.viewer.requireFlags, false);
  assert.equal(config.paths.desktopMirror, null);
});

test("the empty store names the roots and starts every registry empty", () => {
  const store = emptyStore({ title: "Smith Family", rootPersonIds: ["ann-smith"] });
  assert.deepEqual(store["evidence/research/tree-presentation.json"].visualTree.directLineRoots, ["ann-smith"]);
  assert.deepEqual(store["evidence/records-manifest.json"].records, []);
  assert.deepEqual(store["evidence/viewer-blob-inventory.json"].records, []);
  assert.deepEqual(store["evidence/extraction/campaigns/source-reread.json"].records, []);
  assert.ok(Object.keys(store).some((file) => file === "evidence/proof/people/.gitkeep"));
});

// deploy:main validates in an export without .git, where HEAD cannot be read.
const inGitCheckout = spawnSync("git", ["rev-parse", "--verify", "HEAD"], { stdio: "ignore" }).status === 0;

test("only committed engine files travel, never this tree's data or migrations", { skip: !inGitCheckout && "no Git checkout" }, () => {
  const files = engineFiles();
  assert.ok(files.includes("tools/research-store.mjs"));
  assert.ok(files.includes("index.html"));
  for (const file of files) {
    assert.ok(ENGINE_COPY_PATHS.some((prefix) => file === prefix || file.startsWith(`${prefix}/`)), `${file} is an engine path`);
    assert.ok(!ENGINE_COPY_EXCLUDES.some((pattern) => pattern.test(file)), `${file} is excluded`);
    assert.ok(!file.startsWith("evidence/") && !file.startsWith("tree/") && !file.startsWith("data/"));
  }
});
