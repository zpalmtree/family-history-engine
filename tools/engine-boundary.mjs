// Engine boundary ratchet.
//
// The engine (tools/, lib/, app/ and the viewer shell) must not grow new
// knowledge of one particular family. Tree-specific code belongs under tree/,
// and tree-specific words (surnames, places, person ids) belong in the
// canonical store or tree.config.json.
//
// This check counts the tree's distinctive terms (tree.config.json
// `engineBoundary.terms`) in every tracked engine file and compares the counts
// with the recorded baseline (`engineBoundary.baselineFile`). A file that gains
// a term, or a new file that contains one, fails the check. Counts that fall
// are fine; `--update` lowers the baseline to match, so the ratchet only
// tightens. A fresh tree with no terms passes trivially.
//
// Only tracked files are scanned. By default a growth is reported as a warning
// so a concurrent session's commit is never blocked by it; `--strict` (used by
// the engine's own release check) turns it into a failure.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { engineRoot, loadTreeConfig } from "./tree-config.mjs";

export const ENGINE_PATHS = ["tools", "lib", "app", "index.html", "middleware.js", "next.config.mjs"];
const SKIP = [/^tools\/data\//, /\.(png|jpe?g|gif|webp|woff2?|ttf|pdf)$/i];

export function boundaryConfig(config) {
  const settings = config.engineBoundary || {};
  return {
    terms: Array.isArray(settings.terms) ? settings.terms.map((term) => String(term).toLowerCase()).filter(Boolean) : [],
    baselineFile: settings.baselineFile || "tree/engine-boundary-baseline.json"
  };
}

export function listEngineFiles(root) {
  const result = spawnSync("git", ["ls-files", "-z", "--cached", "--", ...ENGINE_PATHS], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ls-files failed: ${result.stderr}`);
  return result.stdout.split("\0").filter(Boolean).filter((file) => !SKIP.some((pattern) => pattern.test(file))).sort();
}

export function countTerms(text, terms) {
  if (!terms.length) return 0;
  const pattern = new RegExp(terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "gi");
  return (String(text).match(pattern) || []).length;
}

export function scanEngine(root, terms, files = listEngineFiles(root)) {
  const counts = {};
  for (const file of files) {
    const full = path.join(root, file);
    if (!fs.existsSync(full)) continue;
    const count = countTerms(fs.readFileSync(full, "utf8"), terms);
    if (count) counts[file] = count;
  }
  return counts;
}

export function compareToBaseline(counts, baseline) {
  const grown = [];
  for (const [file, count] of Object.entries(counts)) {
    const allowed = baseline[file] || 0;
    if (count > allowed) grown.push({ file, count, allowed });
  }
  const shrunk = Object.entries(baseline).filter(([file, allowed]) => (counts[file] || 0) < allowed).map(([file, allowed]) => ({ file, count: counts[file] || 0, allowed }));
  return { grown, shrunk };
}

export function readBaseline(file) {
  if (!fs.existsSync(file)) return {};
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  return parsed.files || {};
}

export function writeBaseline(file, counts, terms) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const sorted = Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
  const total = Object.values(sorted).reduce((sum, count) => sum + count, 0);
  fs.writeFileSync(file, `${JSON.stringify({ note: "Engine files that still name this tree's families. Counts may only fall; run `npm run engine:boundary -- --update` after moving tree-specific code under tree/.", terms, totalFiles: Object.keys(sorted).length, totalMentions: total, files: sorted }, null, 2)}\n`);
}

function main() {
  const args = new Set(process.argv.slice(2));
  const root = engineRoot;
  const config = loadTreeConfig({ root });
  const { terms, baselineFile } = boundaryConfig(config);
  const baselinePath = path.join(root, baselineFile);
  if (!terms.length) {
    console.log("engine boundary: no tree terms configured; nothing to check");
    return;
  }
  const counts = scanEngine(root, terms);
  const baseline = readBaseline(baselinePath);
  const { grown, shrunk } = compareToBaseline(counts, baseline);
  if (args.has("--update") || args.has("--init")) {
    if (grown.length && !args.has("--init")) {
      for (const entry of grown) console.error(`  ${entry.file}: ${entry.count} mentions (baseline ${entry.allowed})`);
      console.error("engine boundary: --update only lowers the baseline; move the new family-specific code under tree/ instead (or --init to re-baseline deliberately)");
      process.exit(1);
    }
    writeBaseline(baselinePath, counts, terms);
    console.log(`engine boundary baseline written: ${Object.keys(counts).length} files, ${Object.values(counts).reduce((a, b) => a + b, 0)} mentions`);
    return;
  }
  if (grown.length) {
    const strict = args.has("--strict");
    const print = strict ? console.error : console.log;
    print(`engine boundary ${strict ? "FAILED" : "WARNING"}: these engine files gained tree-specific terms:`);
    for (const entry of grown) print(`  ${entry.file}: ${entry.count} mentions (baseline ${entry.allowed})`);
    print("Move tree-specific code under tree/ or read the value from tree.config.json / the canonical store.");
    if (strict) process.exit(1);
    return;
  }
  const files = Object.keys(counts).length;
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  console.log(`engine boundary ok: ${files} engine files still name the tree (${total} mentions)${shrunk.length ? `; ${shrunk.length} fell below baseline, run with --update to ratchet` : ""}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
