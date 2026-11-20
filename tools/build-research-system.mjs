#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { writeJsonAtomic } from "./atomic-json.mjs";
import {
  loadResearchStore,
  projectRoot,
  readJson,
  serializeJson
} from "./research-store.mjs";
import { buildResearchProjections } from "./research-projections.mjs";

const args = new Set(process.argv.slice(2));
const mode = args.has("--write") ? "write" : args.has("--check") ? "check" : "summary";
const store = loadResearchStore();
const manifest = readJson(path.join(projectRoot, "evidence", "records-manifest.json"));
const projections = buildResearchProjections(store, { manifest });
const outputs = new Map([
  [path.join(projectRoot, "data", "family", "people.json"), projections.people],
  [path.join(projectRoot, "data", "family", "relationships.json"), projections.relationships],
  [path.join(projectRoot, "data", "family", "tree.json"), projections.tree],
  [path.join(projectRoot, "evidence", "source-atoms.json"), projections.sourceAtoms],
  [path.join(projectRoot, "evidence", "viewer-sources.json"), projections.viewerSources],
  [path.join(projectRoot, "evidence", "acquisition-session-queue.json"), projections.acquisitionSession]
]);

if (mode === "write") {
  for (const [file, value] of outputs) writeJsonAtomic(file, value);
  console.log(`wrote ${outputs.size} research-system projections`);
} else if (mode === "check") {
  const stale = [];
  for (const [file, value] of outputs) {
    const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    if (current !== serializeJson(value)) stale.push(path.relative(projectRoot, file));
  }
  if (stale.length) {
    console.error(`research projections are stale:\n- ${stale.join("\n- ")}\nRun npm run research:build.`);
    process.exit(1);
  }
  console.log(`research projections are current: ${outputs.size} files`);
} else {
  const views = Object.fromEntries(Object.entries(projections.tree.visualTree.views).map(([id, view]) => [
    id,
    view.nodes?.length || projections.tree.visualTree.nodes.length
  ]));
  console.log(JSON.stringify({
    people: projections.people.people.length,
    assertions: store.people.reduce((count, person) => count + person.assertions.length, 0)
      + store.unions.reduce((count, union) => count + union.assertions.length, 0),
    sources: store.sources.length,
    citations: projections.viewerSources.records.length,
    acquisitionTargets: projections.acquisitionSession.targets.length,
    acquisitionStatuses: projections.acquisitionSession.summary.byStatus,
    visualNodes: projections.tree.visualTree.nodes.length,
    views
  }, null, 2));
}
