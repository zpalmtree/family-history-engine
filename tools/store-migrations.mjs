// Canonical store migrations between engine versions.
//
// A tree records its store layout version in tree.config.json
// (store.schemaVersion). When an engine release changes the layout, it bumps
// STORE_SCHEMA_VERSION in tools/tree-config.mjs and adds a step here that
// upgrades a tree from the previous version. `npm run tree:upgrade` runs the
// steps a tree needs, in order, then records the new version.

import fs from "node:fs";
import path from "node:path";
import { STORE_SCHEMA_VERSION, TREE_CONFIG_FILE } from "./tree-config.mjs";

// { from, to, describe, run(root) }; none yet: version 1 is the first layout.
export const storeMigrations = Object.freeze([]);

export function pendingMigrations(fromVersion, toVersion = STORE_SCHEMA_VERSION, migrations = storeMigrations) {
  if (fromVersion > toVersion) throw new Error(`This tree's store is version ${fromVersion}, newer than this engine supports (${toVersion}).`);
  const steps = [];
  for (let version = fromVersion; version < toVersion; version += 1) {
    const step = migrations.find((migration) => migration.from === version && migration.to === version + 1);
    if (!step) throw new Error(`No store migration from version ${version} to ${version + 1}.`);
    steps.push(step);
  }
  return steps;
}

export function migrateStore(root, { migrations = storeMigrations, log = console.log } = {}) {
  const configFile = path.join(root, TREE_CONFIG_FILE);
  const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
  const from = config.store?.schemaVersion ?? 1;
  const steps = pendingMigrations(from, STORE_SCHEMA_VERSION, migrations);
  for (const step of steps) {
    log(`store migration ${step.from} -> ${step.to}: ${step.describe}`);
    step.run(root);
  }
  if (steps.length) {
    config.store = { ...(config.store || {}), schemaVersion: STORE_SCHEMA_VERSION };
    fs.writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);
  }
  return steps.length;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const { engineRoot } = await import("./tree-config.mjs");
    const count = migrateStore(engineRoot);
    console.log(count ? `store migrated (${count} step${count === 1 ? "" : "s"})` : `store is current (schema v${STORE_SCHEMA_VERSION})`);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
