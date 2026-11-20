#!/usr/bin/env node
// The checks that hold for any tree on this engine.
//
//   node tools/check-new-tree.mjs
//
// `data:check` and `tree:check` also run tests that read one particular tree's
// store and frontier history, so a new tree runs this instead: configuration,
// consents, canonical store, generated projections, the family data, the
// visual tree and the engine's own tree-independent tests.

import { spawnSync } from "node:child_process";
import path from "node:path";
import { engineRoot } from "./tree-config.mjs";

export const NEW_TREE_STEPS = [
  ["tree config", ["node", "tools/tree-config.mjs", "--check"]],
  ["consents", ["node", "tools/consents.mjs", "--check"]],
  ["research projections", ["node", "tools/build-research-system.mjs", "--check"]],
  ["branch summaries", ["node", "tools/build-research-current-state.mjs", "--check"]],
  ["family data", ["node", "tools/build-family-data.mjs", "--check"]],
  ["research store", ["node", "tools/check-research-store.mjs"]],
  ["tree people", ["node", "tools/check-family-data.mjs"]],
  ["layout", ["node", "tools/layout-visual-tree.mjs", "--check"]],
  ["visual tree", ["node", "tools/check-visual-tree.mjs"]],
  ["engine tests", ["node", "--test", "tools/tree-config.test.mjs", "tools/consents.test.mjs", "tools/gedcom.test.mjs", "tools/gedcom-export.test.mjs", "tools/gedcom-import.test.mjs", "tools/tree-init.test.mjs", "tools/engine-boundary.test.mjs"]]
];

function main() {
  const failures = [];
  for (const [label, command] of NEW_TREE_STEPS) {
    const result = spawnSync(command[0], command.slice(1), { cwd: engineRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    const output = `${result.stdout || ""}${result.stderr || ""}`.trim();
    if (result.status === 0) {
      console.log(`ok   ${label}: ${output.split("\n").filter((line) => line && !line.startsWith("#") && !/^\s/.test(line) && !/^(ok|TAP|1\.\.)/.test(line)).at(-1) || "passed"}`);
    } else {
      failures.push(label);
      console.log(`FAIL ${label} (${command.join(" ")})\n${output.split("\n").slice(-20).join("\n")}`);
    }
  }
  if (failures.length) {
    console.error(`${failures.length} check(s) failed in ${path.basename(engineRoot)}: ${failures.join(", ")}`);
    process.exit(1);
  }
  console.log(`new-tree checks passed (${NEW_TREE_STEPS.length})`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
