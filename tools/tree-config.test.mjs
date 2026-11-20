import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  STORE_SCHEMA_VERSION,
  defaultTreeConfig,
  desktopMirror,
  engineRoot,
  loadTreeConfig,
  parseTreeConfig,
  primaryCheckout,
  researchScopes,
  validateTreeConfig,
  viewerTitle
} from "./tree-config.mjs";

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tree-config-test-"));
}

test("a missing config falls back to neutral defaults", () => {
  const root = tempRoot();
  const config = loadTreeConfig({ root, env: {}, fresh: true });
  assert.deepEqual(researchScopes(config), ["main"]);
  assert.equal(primaryCheckout(config), null);
  assert.equal(desktopMirror(config), null);
  assert.equal(viewerTitle(config), "Family history");
  assert.deepEqual(validateTreeConfig(defaultTreeConfig()), []);
});

test("a partial config merges over the defaults", () => {
  const config = parseTreeConfig(JSON.stringify({
    schemaVersion: 1,
    tree: { id: "smith-family", title: "The Smith family", rootPersonIds: ["ann-smith"] },
    scopes: { additional: ["collateral"] },
    paths: { primaryCheckout: "/srv/smith" }
  }));
  assert.equal(config.tree.id, "smith-family");
  assert.deepEqual(researchScopes(config), ["main", "collateral"]);
  assert.equal(primaryCheckout(config), "/srv/smith");
  assert.equal(config.store.schemaVersion, STORE_SCHEMA_VERSION);
  assert.equal(config.consentsFile, "consents.json");
});

test("invalid configs are refused with every problem listed", () => {
  assert.throws(() => parseTreeConfig("{not json"), /not valid JSON/);
  assert.throws(() => parseTreeConfig("[]"), /JSON object/);
  assert.throws(
    () => parseTreeConfig(JSON.stringify({ schemaVersion: 1, tree: { id: "Bad Id", rootPersonIds: ["ok", 3] }, paths: { primaryCheckout: "relative/path" }, consentsFile: "../outside.json" })),
    (error) => /tree\.id/.test(error.message) && /rootPersonIds/.test(error.message) && /primaryCheckout/.test(error.message) && /consentsFile/.test(error.message)
  );
  assert.throws(() => parseTreeConfig(JSON.stringify({ schemaVersion: 1, scopes: { additional: ["main"] } })), /must not repeat scopes\.default/);
  assert.throws(() => parseTreeConfig(JSON.stringify({ schemaVersion: 1, store: { schemaVersion: 99 } })), /not supported by this engine/);
});

test("TREE_CONFIG_PATH overrides the repository file", () => {
  const root = tempRoot();
  const file = path.join(root, "other.json");
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, tree: { id: "other", title: "Other", rootPersonIds: [] } }));
  const config = loadTreeConfig({ root: engineRoot, env: { TREE_CONFIG_PATH: file }, fresh: true });
  assert.equal(config.tree.id, "other");
});

// The engine repository itself has no tree.config.json; a tree always does.
test("this repository's own tree.config.json is valid", { skip: !fs.existsSync(path.join(engineRoot, "tree.config.json")) && "engine without a tree" }, () => {
  const config = loadTreeConfig({ env: {}, fresh: true });
  assert.ok(config.tree.rootPersonIds.length > 0, "the checked-in tree names its root people");
});
