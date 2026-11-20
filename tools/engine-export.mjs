#!/usr/bin/env node
// Export the engine as a standalone, public-safe directory.
//
//   node tools/engine-export.mjs --out <dir> [--ref HEAD] [--report]
//
// The export is built from the engine files committed at --ref (tools/,
// lib/, app/, assets/, the viewer shell, package files, templates), minus
// the files tree.config.json `engineExport.exclude` lists as this tree's own
// (frontier contracts, one-off migrations, tests built on real people). It
// has no Git history.
//
// A privacy gate then scans every exported file and refuses to finish if any
// names a person in this tree's canonical store (person id or full display
// name), one of the tree's engineBoundary terms, or a personal identifier
// from `engineExport.privateTerms` (email, account names, home paths).
// Nothing is pushed anywhere; publishing the directory is a separate step.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { VIEWER_BRANDING_FILE, engineRoot, loadTreeConfig, viewerBrandingSource } from "./tree-config.mjs";
import { ENGINE_COPY_EXCLUDES, ENGINE_COPY_PATHS, engineFiles } from "./tree-init.mjs";

function git(args, options = {}) {
  const result = spawnSync("git", args, { cwd: engineRoot, maxBuffer: 256 * 1024 * 1024, ...options });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

export function exportSettings(config = loadTreeConfig()) {
  const settings = config.engineExport || {};
  return {
    exclude: (settings.exclude || []).map((entry) => new RegExp(entry)),
    privateTerms: (settings.privateTerms || []).filter(Boolean),
    allowTerms: settings.allowTerms || {}
  };
}

// Words that identify this tree: person ids and full names from the store,
// the engine-boundary terms, and the configured private terms.
export function privacyTerms(root = engineRoot, config = loadTreeConfig()) {
  const terms = new Map();
  const add = (term, reason) => {
    const value = String(term || "").trim();
    if (value.length >= 4 && !terms.has(value.toLowerCase())) terms.set(value.toLowerCase(), { term: value, reason });
  };
  const peopleDir = path.join(root, "evidence", "proof", "people");
  for (const name of fs.existsSync(peopleDir) ? fs.readdirSync(peopleDir) : []) {
    if (!name.endsWith(".json")) continue;
    const person = JSON.parse(fs.readFileSync(path.join(peopleDir, name), "utf8"));
    // Short single-word ids are caught by the boundary terms instead.
    if (person.personId.includes("-")) add(person.personId, "person id");
    const display = person.assertions.find((assertion) => assertion.id === person.presentation?.displayNameAssertionId)?.claim?.value;
    if (display && display.trim().split(/\s+/).length >= 2) add(display, "person name");
  }
  for (const term of config.engineBoundary?.terms || []) add(term, "tree term");
  for (const term of exportSettings(config).privateTerms) add(term, "private term");
  return [...terms.values()];
}

export function scanText(text, terms, allowed = []) {
  const lower = text.toLowerCase();
  const found = [];
  for (const { term, reason } of terms) {
    if (allowed.includes(term)) continue;
    const needle = term.toLowerCase();
    let index = lower.indexOf(needle);
    while (index >= 0) {
      // Whole-word match for word-like terms, so a short term does not match inside a longer word.
      const before = lower[index - 1];
      const after = lower[index + needle.length];
      const wordy = /^[a-z0-9]/.test(needle) && /[a-z0-9]$/.test(needle);
      if (!wordy || (!/[a-z0-9]/.test(before || "") && !/[a-z0-9]/.test(after || ""))) {
        found.push({ term, reason, line: text.slice(0, index).split("\n").length });
        break;
      }
      index = lower.indexOf(needle, index + 1);
    }
  }
  return found;
}

// package.json scripts in the export. A step that runs one of this tree's
// excluded files (a check or migration of its own data) is removed from its
// chain; `node --test` lists lose excluded test files; a script left with no
// steps is dropped, and so is any `npm run` step that called it.
export function exportPackageJson(raw, keptFiles, dropSteps = []) {
  const pkg = JSON.parse(raw);
  const kept = new Set(keptFiles);
  const missing = (file) => file.startsWith("tools/") && !kept.has(file);
  const stepsByName = new Map();
  for (const [name, command] of Object.entries(pkg.scripts || {})) {
    const steps = command.split(" && ").map((step) => {
      if (/^node --test /.test(step)) {
        const left = step.split(/\s+/).slice(2).filter((file) => !missing(file));
        return left.length ? `node --test ${left.join(" ")}` : null;
      }
      if (dropSteps.some((pattern) => pattern.test(step))) return null;
      return (step.match(/tools\/[A-Za-z0-9_./-]+\.(?:mjs|ps1|sh|cjs|js)/g) || []).some(missing) ? null : step;
    }).filter(Boolean);
    stepsByName.set(name, steps);
  }
  const dropped = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, steps] of stepsByName) {
      if (dropped.has(name)) continue;
      const left = steps.filter((step) => {
        const call = /^npm run (?:--silent )?([A-Za-z0-9:_-]+)/.exec(step)?.[1];
        return !call || !dropped.has(call);
      });
      if (left.length !== steps.length) { stepsByName.set(name, left); changed = true; }
      if (!left.length) { dropped.add(name); changed = true; }
    }
  }
  const scripts = Object.fromEntries([...stepsByName].filter(([name]) => !dropped.has(name)).map(([name, steps]) => [name, steps.join(" && ")]));
  return { pkg: { ...pkg, scripts }, dropped: [...dropped].sort() };
}

export function buildEngineExport({ out, ref = "HEAD", root = engineRoot, config = loadTreeConfig() }) {
  const { exclude, allowTerms } = exportSettings(config);
  // ref "WORKTREE" checks the working tree before a commit (dry runs only).
  const worktree = ref === "WORKTREE";
  const all = worktree
    ? git(["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...ENGINE_COPY_PATHS], { encoding: "utf8" }).split("\0").filter(Boolean)
      .filter((file) => !ENGINE_COPY_EXCLUDES.some((pattern) => pattern.test(file)) && fs.existsSync(path.join(root, file)))
    : engineFiles(root, ref);
  const excluded = all.filter((file) => exclude.some((pattern) => pattern.test(file)));
  // A test that reads or imports an excluded file goes with it.
  const excludedNames = excluded.map((file) => path.posix.basename(file));
  for (const file of all.filter((name) => name.endsWith(".test.mjs") && !excluded.includes(name))) {
    const text = (worktree ? fs.readFileSync(path.join(root, file)) : git(["show", `${ref}:${file}`])).toString("utf8");
    if (excludedNames.some((name) => text.includes(`"${name}"`) || text.includes(`/${name}"`) || text.includes(`./${name}`))) excluded.push(file);
  }
  const kept = all.filter((file) => !excluded.includes(file));
  const terms = privacyTerms(root, config);
  const violations = [];
  const files = new Map();
  for (const file of kept) {
    let content = worktree ? fs.readFileSync(path.join(root, file)) : git(["show", `${ref}:${file}`]);
    if (file === "package.json") {
      const { pkg, dropped } = exportPackageJson(content.toString("utf8"), kept, (config.engineExport?.dropSteps || []).map((entry) => new RegExp(entry)));
      pkg.name = "family-history-engine";
      pkg.license = "MIT";
      // The owner's Vercel team never travels; the CLI uses the linked project.
      const scope = config.vercel?.scope;
      if (scope) for (const [name, command] of Object.entries(pkg.scripts)) pkg.scripts[name] = command.replaceAll(` --scope ${scope}`, "");
      content = Buffer.from(`${JSON.stringify(pkg, null, 2)}\n`);
      files.set("_dropped_scripts", dropped);
    }
    if (file === "package-lock.json") {
      const lock = JSON.parse(content.toString("utf8"));
      lock.name = "family-history-engine";
      if (lock.packages?.[""]) lock.packages[""].name = "family-history-engine";
      content = Buffer.from(`${JSON.stringify(lock, null, 2)}\n`);
    }
    // Reviewed text rewrites (tree.config.json engineExport.rewrite): an example
    // this tree must keep verbatim for its own pinned prompts.
    for (const rule of (config.engineExport?.rewrite || []).filter((entry) => entry.file === file)) {
      const before = content.toString("utf8");
      if (!before.includes(rule.find)) throw new Error(`engineExport.rewrite for ${file} no longer matches: ${rule.find}`);
      content = Buffer.from(before.split(rule.find).join(rule.replace));
    }
    if (file === VIEWER_BRANDING_FILE) {
      content = Buffer.from(viewerBrandingSource({ title: "Family tree", issuer: "family-tree" }));
    }
    const text = content.toString("utf8");
    if (!text.includes("\u0000")) {
      for (const hit of scanText(text, terms, allowTerms[file] || [])) violations.push({ file, ...hit });
    }
    files.set(file, content);
  }
  // Kept code must not import a file the export leaves out.
  const keptSet = new Set(kept);
  for (const file of kept.filter((name) => /\.(mjs|js|cjs)$/.test(name))) {
    const text = files.get(file).toString("utf8");
    for (const match of text.matchAll(/(?:from\s+|import\(\s*)["'](\.{1,2}\/[^"']+)["']/g)) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1]));
      if (excluded.includes(target) && !keptSet.has(target)) violations.push({ file, term: target, reason: "imports an excluded file", line: text.slice(0, match.index).split("\n").length });
    }
  }
  const dropped = files.get("_dropped_scripts") || [];
  files.delete("_dropped_scripts");
  // The public repository's own README and licence.
  for (const name of ["README.md", "LICENSE", ".github/workflows/ci.yml"]) {
    const content = fs.readFileSync(path.join(root, "templates", "engine", name));
    for (const hit of scanText(content.toString("utf8"), terms)) violations.push({ file: name, ...hit });
    files.set(name, content);
  }
  if (out) {
    const target = path.resolve(out);
    if (fs.existsSync(target) && fs.readdirSync(target).length) throw new Error(`${target} is not empty`);
    for (const [file, content] of files) {
      const to = path.join(target, file);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.writeFileSync(to, content);
    }
  }
  return { kept: kept.length, excluded, dropped, violations };
}

function main() {
  const args = process.argv.slice(2);
  const value = (flag) => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : undefined; };
  const out = value("--out");
  const report = args.includes("--report");
  if (!out && !report) throw new Error("usage: node tools/engine-export.mjs --out <dir> [--ref HEAD] | --report");
  const result = buildEngineExport({ out: report ? null : out, ref: value("--ref") || "HEAD" });
  const byFile = new Map();
  for (const violation of result.violations) {
    if (!byFile.has(violation.file)) byFile.set(violation.file, []);
    byFile.get(violation.file).push(violation);
  }
  console.log(`engine export: ${result.kept} files kept, ${result.excluded.length} excluded as tree-specific, ${result.dropped.length} package scripts dropped`);
  if (byFile.size) {
    console.log(`PRIVACY GATE FAILED: ${byFile.size} file(s) name this tree or its owner`);
    for (const [file, hits] of [...byFile].sort((a, b) => b[1].length - a[1].length)) {
      console.log(`  ${file}: ${hits.length} term(s), e.g. ${hits.slice(0, 4).map((hit) => `${hit.term} (${hit.reason}, line ${hit.line})`).join("; ")}`);
    }
    if (out && !report) {
      fs.rmSync(path.resolve(out), { recursive: true, force: true });
      console.log("The export directory was removed.");
    }
    process.exit(1);
  }
  console.log(`privacy gate passed${out ? `; export written to ${path.resolve(out)}` : ""}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
