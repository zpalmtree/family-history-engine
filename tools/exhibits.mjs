#!/usr/bin/env node

// Exhibit store commands for LIFE-STORIES-GOAL.md.
//
//   npm run exhibits:check                     validate evidence/exhibits against the canonical stores
//   npm run exhibits -- --list                 every exhibit and how many people it reaches
//   npm run exhibits -- --person <id>          what one person's page shows
//   npm run exhibits -- --render <id> --out f  write an exhibit's drawn shield as SVG, to look at it

import fs from "node:fs";
import path from "node:path";
import { loadResearchStore, projectRoot, readJson } from "./research-store.mjs";
import { buildResearchProjections } from "./research-projections.mjs";
import { generationsFromRoots } from "./page-depth-core.mjs";
import { projectExhibits, validateExhibits } from "./exhibit-store.mjs";

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};
const fail = (message) => {
  console.error(message);
  process.exit(1);
};

const store = loadResearchStore();
const manifest = readJson(path.join(projectRoot, "evidence", "records-manifest.json"));
const relationships = buildResearchProjections(store, { manifest }).relationships;
const generations = generationsFromRoots(store.treePresentation.visualTree.directLineRoots || [], relationships.parents);
const context = { store, records: manifest.records, generations };

const issues = validateExhibits(store.exhibits, context);
for (const exhibit of store.exhibits) {
  if (path.basename(exhibit.__file, ".json") !== exhibit.id) issues.push(`exhibit ${exhibit.id}: file name does not match id`);
}
if (issues.length) fail(issues.map((issue) => `- ${issue}`).join("\n"));
const projected = projectExhibits(store.exhibits, context);
const reach = new Map(projected.exhibits.map((exhibit) => [exhibit.id, 0]));
for (const entries of projected.byPerson.values()) for (const entry of entries) reach.set(entry.id, reach.get(entry.id) + 1);
const unreached = [...reach].filter(([, count]) => !count).map(([id]) => id);
if (unreached.length) fail(unreached.map((id) => `- exhibit ${id}: reaches nobody on the tree`).join("\n"));

if (args.includes("--render")) {
  const exhibit = projected.exhibits.find((item) => item.id === option("--render"));
  if (!exhibit?.drawing) fail(`no drawn exhibit: ${option("--render")}`);
  if (!option("--out")) fail("requires --out <file.svg>");
  fs.writeFileSync(option("--out"), exhibit.drawing.svg);
  console.log(`wrote ${option("--out")}`);
} else if (option("--person")) {
  const byId = new Map(projected.exhibits.map((exhibit) => [exhibit.id, exhibit]));
  const entries = projected.byPerson.get(option("--person")) || [];
  console.log(`${option("--person")}: ${entries.length} exhibit(s)`);
  for (const entry of entries) {
    const exhibit = byId.get(entry.id);
    console.log(`- [${exhibit.kind}] ${exhibit.title}${entry.note ? ` · ${entry.note}` : ""}${exhibit.caption ? `\n  ${exhibit.caption}` : ""}\n  ${exhibit.credit} · ${exhibit.licence}`);
  }
} else if (args.includes("--list")) {
  for (const exhibit of projected.exhibits) {
    console.log(`${String(reach.get(exhibit.id)).padStart(4)}  [${exhibit.kind}] ${exhibit.id} · ${exhibit.title}`);
  }
} else {
  console.log(`exhibits are valid: ${projected.exhibits.length} exhibit(s) reaching ${projected.byPerson.size} people`);
}
