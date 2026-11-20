import fs from "node:fs";
import vm from "node:vm";

export const treeLayoutsPath = new URL("../data/tree-layouts.js", import.meta.url);

export function loadTreeLayouts({ optional = false } = {}) {
  if (optional && !fs.existsSync(treeLayoutsPath)) {
    return null;
  }

  const source = fs.readFileSync(treeLayoutsPath, "utf8");
  const sandbox = { globalThis: {} };
  vm.runInNewContext(source, sandbox, { filename: treeLayoutsPath.pathname });
  const layouts = sandbox.globalThis.familyTreeLayouts;
  if (!layouts || typeof layouts !== "object" || Array.isArray(layouts)) {
    throw new Error("data/tree-layouts.js did not assign a familyTreeLayouts object");
  }
  return layouts;
}

export function serializeTreeLayouts(layouts) {
  return "/* Generated visual-tree geometry. Run `npm run tree:layout` after changing tree data or layout settings. */\n"
    + `globalThis.familyTreeLayouts = ${JSON.stringify(layouts, null, 2)};\n`;
}

export function writeTreeLayouts(layouts) {
  fs.writeFileSync(treeLayoutsPath, serializeTreeLayouts(layouts));
}
