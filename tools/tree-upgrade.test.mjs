import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { applyUpgrade, planUpgrade } from "./tree-upgrade.mjs";

function tree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tree-upgrade-test-"));
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`);
  }
  return root;
}

test("an upgrade replaces engine files and keeps the tree's own", () => {
  const treeRoot = tree({
    "package.json": { name: "smith-family", version: "0.1.0", scripts: { build: "old" } },
    "tools/kept.mjs": "same\n",
    "tools/changed.mjs": "old\n",
    "tools/retired.mjs": "gone soon\n",
    "lib/viewer-branding.js": "export default { title: \"Smith Family\" };\n",
    "tree.config.json": { schemaVersion: 1 },
    "evidence/proof/people/ann.json": { personId: "ann" }
  });
  const engineDir = tree({
    "package.json": { name: "family-history-engine", version: "0.2.0", scripts: { build: "new" } },
    "tools/kept.mjs": "same\n",
    "tools/changed.mjs": "new\n",
    "tools/added.mjs": "added\n",
    "lib/viewer-branding.js": "export default { title: \"Family tree\" };\n"
  });
  const plan = planUpgrade({ treeRoot, engineDir });
  assert.deepEqual(plan, { added: ["tools/added.mjs"], changed: ["package.json", "tools/changed.mjs"], removed: ["tools/retired.mjs"] });
  const { engineVersion } = applyUpgrade({ treeRoot, engineDir, plan });
  assert.equal(engineVersion, "0.2.0");
  const pkg = JSON.parse(fs.readFileSync(path.join(treeRoot, "package.json"), "utf8"));
  assert.deepEqual([pkg.name, pkg.version, pkg.scripts.build], ["smith-family", "0.2.0", "new"]);
  assert.equal(fs.readFileSync(path.join(treeRoot, "tools/changed.mjs"), "utf8"), "new\n");
  assert.ok(fs.existsSync(path.join(treeRoot, "tools/added.mjs")));
  assert.ok(!fs.existsSync(path.join(treeRoot, "tools/retired.mjs")));
  assert.match(fs.readFileSync(path.join(treeRoot, "lib/viewer-branding.js"), "utf8"), /Smith Family/, "the tree keeps its branding");
  assert.ok(fs.existsSync(path.join(treeRoot, "evidence/proof/people/ann.json")), "tree data is never touched");
  assert.deepEqual(planUpgrade({ treeRoot, engineDir }), { added: [], changed: [], removed: [] }, "a second upgrade is a no-op");
});
