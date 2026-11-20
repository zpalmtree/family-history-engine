// Import this first in a test file that needs a known tree configuration: it
// points the engine at a fixture config (a "collateral" side-branch scope
// that is dormant, roots "root-a" and "root-b"), so the test behaves the same
// in every tree. It must come before any import that reads the config.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "test-tree-config-")), "tree.config.json");
fs.writeFileSync(file, JSON.stringify({
  schemaVersion: 1,
  tree: { id: "fixture-tree", title: "Fixture Tree", rootPersonIds: ["root-a", "root-b"] },
  scopes: { default: "main", additional: ["collateral"], dormant: ["collateral"] },
  owner: { name: "Test Owner" }
}));
process.env.TREE_CONFIG_PATH = file;
