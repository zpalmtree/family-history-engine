#!/usr/bin/env node
// Upgrade a tree to another engine release.
//
//   npm run tree:upgrade -- [--from <git URL | local engine dir>] [--ref <tag or branch>] [--dry-run] [--force] [--install]
//   node <new engine>/tools/tree-upgrade.mjs --tree <tree dir> --from <new engine>   (a tree without this script)
//
// Replaces only the engine's files (tools/, lib/, app/, assets/, the viewer
// shell, package files, templates) with those of the chosen release. The
// tree's own files are never touched: evidence/, tree/, data/,
// tree.config.json, consents.json, AGENTS.md, GOAL.md, DECISIONS.md. Inside
// the engine paths the tree keeps its viewer branding (regenerated from its
// config) and its package name.
//
// It refuses when the tree has uncommitted changes to engine files (they
// would be lost) unless --force. After copying it records the engine version
// in tree.config.json, runs any store migrations the new engine needs,
// rebuilds and runs the new-tree checks. Nothing is committed: review the
// change with git and commit it yourself.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { TREE_CONFIG_FILE, VIEWER_BRANDING_FILE, engineRoot } from "./tree-config.mjs";
import { ENGINE_COPY_EXCLUDES, ENGINE_COPY_PATHS } from "./tree-init.mjs";

// Engine-path files the tree keeps as its own across an upgrade.
export const TREE_OWNED_ENGINE_FILES = Object.freeze([VIEWER_BRANDING_FILE]);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, ...options });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed:\n${(result.stderr || result.stdout || "").slice(-4000)}`);
  return result.stdout;
}

const inEnginePaths = (file) => ENGINE_COPY_PATHS.some((prefix) => file === prefix || file.startsWith(`${prefix}/`))
  && !ENGINE_COPY_EXCLUDES.some((pattern) => pattern.test(file));

export function engineFilesIn(dir) {
  const isGit = fs.existsSync(path.join(dir, ".git"));
  const files = isGit
    ? run("git", ["ls-files", "-z"], { cwd: dir }).split("\0").filter(Boolean)
    : listAll(dir);
  return files.filter(inEnginePaths).filter((file) => fs.existsSync(path.join(dir, file))).sort();
}

function listAll(dir, prefix = "") {
  const out = [];
  for (const entry of fs.readdirSync(path.join(dir, prefix), { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listAll(dir, relative));
    else out.push(relative);
  }
  return out;
}

// What the upgrade will add, change and remove, before anything is written.
export function planUpgrade({ treeRoot, engineDir }) {
  const incoming = new Set(engineFilesIn(engineDir));
  const current = new Set(engineFilesIn(treeRoot));
  const owned = new Set(TREE_OWNED_ENGINE_FILES);
  // Package files differ only by the tree's own name, which it keeps.
  const unnamed = (dir, file) => {
    const raw = fs.readFileSync(path.join(dir, file), "utf8");
    if (!["package.json", "package-lock.json"].includes(file)) return raw;
    const json = JSON.parse(raw);
    delete json.name;
    if (json.packages?.[""]) delete json.packages[""].name;
    return JSON.stringify(json);
  };
  const same = (file) => unnamed(treeRoot, file) === unnamed(engineDir, file);
  const added = [...incoming].filter((file) => !current.has(file) && !owned.has(file));
  const changed = [...incoming].filter((file) => current.has(file) && !owned.has(file) && !same(file));
  const removed = [...current].filter((file) => !incoming.has(file) && !owned.has(file));
  return { added, changed, removed };
}

export function applyUpgrade({ treeRoot, engineDir, plan }) {
  const treePackage = JSON.parse(fs.readFileSync(path.join(treeRoot, "package.json"), "utf8"));
  for (const file of plan.removed) fs.rmSync(path.join(treeRoot, file), { force: true });
  for (const file of [...plan.added, ...plan.changed]) {
    const to = path.join(treeRoot, file);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(engineDir, file), to);
  }
  // The tree keeps its own package name; everything else comes from the engine.
  for (const file of ["package.json", "package-lock.json"]) {
    const full = path.join(treeRoot, file);
    if (!fs.existsSync(full)) continue;
    const json = JSON.parse(fs.readFileSync(full, "utf8"));
    json.name = treePackage.name;
    if (json.packages?.[""]) json.packages[""].name = treePackage.name;
    fs.writeFileSync(full, `${JSON.stringify(json, null, 2)}\n`);
  }
  const engineVersion = JSON.parse(fs.readFileSync(path.join(engineDir, "package.json"), "utf8")).version || null;
  return { engineVersion, previousVersion: treePackage.version || null };
}

function fetchEngine(from, ref, work) {
  if (fs.existsSync(from) && fs.statSync(from).isDirectory()) return path.resolve(from);
  const target = path.join(work, "engine");
  run("git", ["clone", "--quiet", "--depth", "1", ...(ref ? ["--branch", ref] : []), from, target]);
  return target;
}

function main() {
  const args = process.argv.slice(2);
  const value = (flag) => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : undefined; };
  // --tree lets a newer engine's copy of this script upgrade a tree that does
  // not have it yet (trees started on 0.1.0).
  const treeRoot = path.resolve(value("--tree") || engineRoot);
  const configFile = path.join(treeRoot, TREE_CONFIG_FILE);
  const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
  const from = value("--from") || config.engine?.source;
  if (!from) throw new Error("Pass --from <engine git URL or local directory> (or set engine.source in tree.config.json).");
  const ref = value("--ref") || null;

  const dirty = run("git", ["status", "--porcelain", "--", ...ENGINE_COPY_PATHS], { cwd: treeRoot }).trim();
  if (dirty && !args.includes("--force")) {
    throw new Error(`Uncommitted changes to engine files would be lost:\n${dirty}\nCommit or discard them, or pass --force.`);
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), "tree-upgrade-"));
  try {
    const engineDir = fetchEngine(from, ref, work);
    const plan = planUpgrade({ treeRoot, engineDir });
    const incomingVersion = JSON.parse(fs.readFileSync(path.join(engineDir, "package.json"), "utf8")).version;
    console.log(`Engine ${config.engine?.version || "(unrecorded)"} -> ${incomingVersion}: ${plan.added.length} added, ${plan.changed.length} changed, ${plan.removed.length} removed`);
    for (const [label, files] of [["+", plan.added], ["~", plan.changed], ["-", plan.removed]]) {
      for (const file of files.slice(0, 40)) console.log(`  ${label} ${file}`);
      if (files.length > 40) console.log(`  ${label} ... ${files.length - 40} more`);
    }
    if (args.includes("--dry-run")) {
      console.log("Dry run: nothing was changed.");
      return;
    }
    const dependencies = () => {
      const file = path.join(treeRoot, "package-lock.json");
      if (!fs.existsSync(file)) return "";
      const { name: ignoredName, packages = {}, ...rest } = JSON.parse(fs.readFileSync(file, "utf8"));
      const { "": root = {}, ...installed } = packages;
      return JSON.stringify({ ...rest, root: { ...root, name: undefined }, installed });
    };
    const lockBefore = dependencies();
    const { engineVersion } = applyUpgrade({ treeRoot, engineDir, plan });
    const updated = JSON.parse(fs.readFileSync(configFile, "utf8"));
    updated.engine = { ...(updated.engine || {}), version: engineVersion, source: from, ...(ref ? { ref } : {}) };
    fs.writeFileSync(configFile, `${JSON.stringify(updated, null, 2)}\n`);

    // The new engine's own tools take it from here.
    const node = (script, extra = []) => run(process.execPath, [script, ...extra], { cwd: treeRoot });
    node("tools/tree-config.mjs", ["--write-branding"]);
    process.stdout.write(node("tools/store-migrations.mjs"));
    const lockAfter = dependencies();
    if (lockAfter !== lockBefore) {
      if (args.includes("--install")) run("npm", ["install"], { cwd: treeRoot });
      else console.log("The engine's dependencies changed: run npm install before building.");
    }
    if (lockAfter === lockBefore || args.includes("--install")) {
      run("npm", ["run", "--silent", "build"], { cwd: treeRoot });
      process.stdout.write(run(process.execPath, ["tools/check-new-tree.mjs"], { cwd: treeRoot }).split("\n").slice(-2).join("\n"));
    }
    console.log(`\nUpgraded to engine ${engineVersion}. Review with git status and git diff, then commit.`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
