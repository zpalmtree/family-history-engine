// Tree hooks: tree-specific checks and rules that the engine runs by
// convention. A hook is a module at tree/hooks/<name>.mjs exporting a default
// function. A tree without that file simply has no extra rule, so the engine
// never needs to know one family's views, people or scopes.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { engineRoot } from "./tree-config.mjs";

export const TREE_HOOKS_DIR = path.join("tree", "hooks");

export function treeHookPath(name, root = engineRoot) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error(`Invalid tree hook name ${name}`);
  return path.join(root, TREE_HOOKS_DIR, `${name}.mjs`);
}

// Runs tree/hooks/<name>.mjs with the given context and returns its result,
// or undefined when the tree defines no such hook.
export async function runTreeHook(name, context, { root = engineRoot } = {}) {
  const file = treeHookPath(name, root);
  if (!fs.existsSync(file)) return undefined;
  const hook = await import(pathToFileURL(file).href);
  if (typeof hook.default !== "function") throw new Error(`${path.relative(root, file)} must export a default function`);
  return hook.default(context);
}
