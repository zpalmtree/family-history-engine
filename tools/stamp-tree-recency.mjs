#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { buildResearchProjections } from "./research-projections.mjs";
import { loadResearchStore, projectRoot, readJson, serializeJson } from "./research-store.mjs";
import {
  createTreeRecencyStamp,
  strictTreeTimestamp,
  validateTreeRecencyPolicy
} from "./tree-recency-policy.mjs";

const personIds = [...new Set(process.argv.flatMap((arg, index) => arg === "--person" ? [process.argv[index + 1]] : []))];
const timestamp = option("--at") || new Date().toISOString();
if (!personIds.length || personIds.some((id) => !/^[a-z0-9][a-z0-9-]*$/.test(id || ""))) fail("usage: npm run tree:recency:stamp -- --person <person-id> [--person <another-id>] [--at <RFC3339>]");
const timestampMs = strictTreeTimestamp(timestamp);
if (timestampMs === null || timestampMs > Date.now()) fail("--at must be a non-future RFC 3339 timestamp with an explicit offset");

const store = loadResearchStore();
const manifest = readJson(path.join(projectRoot, "evidence", "records-manifest.json"));
const baselineFile = path.join(projectRoot, "evidence", "research", "tree-recency-baseline.json");
const baseline = readJson(baselineFile);
const visualPersonIds = buildResearchProjections(store, { manifest }).tree.visualTree.nodes.map((node) => node.id);
let nextBaseline = baseline;
const stampedPeople = new Map();
try {
  for (const personId of personIds) {
    const person = store.people.find((item) => item.personId === personId);
    if (!person) throw new Error(`unknown canonical person ${personId}`);
    const stamped = createTreeRecencyStamp({ person, baseline: nextBaseline, visualPersonIds, timestamp });
    nextBaseline = stamped.baseline;
    stampedPeople.set(personId, { file: person.__file, person: stamped.person });
  }
} catch (error) { fail(error.message); }
const issues = validateTreeRecencyPolicy({
  people: store.people.map((item) => stampedPeople.get(item.personId)?.person || item),
  visualPersonIds, baseline: nextBaseline, now: Date.now()
});
if (issues.length) fail(`refusing invalid tree recency stamp:\n- ${issues.join("\n- ")}`);
writeBatchAtomically([
  ...[...stampedPeople.values()].map(({ file, person }) => [file, serializeJson(person)]),
  [baselineFile, serializeJson(nextBaseline)]
]);
for (const personId of personIds) console.log(`stamped first tree visibility for ${personId} at ${timestamp}`);

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function writeBatchAtomically(entries) {
  const nonce = `${process.pid}-${Date.now()}`;
  const files = entries.map(([file, contents]) => ({ file, contents,
    temporary: `${file}.${nonce}.tmp`, original: fs.readFileSync(file) }));
  const written = [];
  try {
    for (const item of files) fs.writeFileSync(item.temporary, item.contents, { flag: "wx" });
    for (const item of files) {
      fs.renameSync(item.temporary, item.file);
      written.push(item);
    }
  } catch (error) {
    for (const item of written.reverse()) fs.writeFileSync(item.file, item.original);
    throw error;
  } finally {
    for (const item of files) fs.rmSync(item.temporary, { force: true });
  }
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
