#!/usr/bin/env node
// Check or promote preserved originals that established conclusions cite but
// the protected viewer still withholds. See cited-record-viewer.mjs.
//
//   node tools/promote-cited-records.mjs --check
//   node tools/promote-cited-records.mjs --write [--viewers <file.json>] [--record <id>...]
//
// --write sets the canonical source to approved-private and the canonical
// target to publish-eligible/pending-upload. The normal provider publisher
// then uploads the master and its derivatives. A record whose target has no
// structured viewer presentation needs one in the --viewers file.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeJsonAtomic } from "./atomic-json.mjs";
import { citedRecordViewerGaps, loadCitedRecordContext, promoteTarget } from "./cited-record-viewer.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const write = args.includes("--write");
const check = args.includes("--check");
if (write === check) throw new Error("usage: --check | --write [--viewers <file.json>] [--record <id>...]");
const viewersFile = valueAfter("--viewers");
const requested = new Set(valuesAfter("--record"));

const context = loadCitedRecordContext(root);
const { gaps, awaitingRights } = citedRecordViewerGaps(context);

if (check) {
  if (awaitingRights.length) {
    console.log(`${awaitingRights.length} cited original(s) await provider viewer approval before they can be published (not a failure).`);
  }
  if (gaps.length) {
    console.error(`${gaps.length} proof-cited, viewer-approved original(s) are withheld from the family viewer:`);
    for (const gap of gaps) console.error(`  ${gap.id}`);
    console.error("Promote them with: npm run records:promote:cited -- --write [--viewers <file>]");
    process.exit(1);
  }
  console.log("Every proof-cited, viewer-approved original is published or pending upload.");
  process.exit(0);
}

const viewers = viewersFile ? JSON.parse(fs.readFileSync(viewersFile, "utf8")) : {};
const selected = requested.size ? gaps.filter((gap) => requested.has(gap.id)) : gaps;
const missing = [...requested].filter((id) => !gaps.some((gap) => gap.id === id));
if (missing.length) throw new Error(`not promotable cited-record gaps: ${missing.join(", ")}`);

const promoted = [];
const skipped = [];
for (const gap of selected) {
  const target = gap.targetId && context.targetsById.get(gap.targetId);
  if (!target) {
    skipped.push(`${gap.id}: no canonical acquisition target`);
    continue;
  }
  let next;
  try {
    next = promoteTarget(target, viewers[gap.id], gap.sourceId);
  } catch (error) {
    skipped.push(`${gap.id}: ${error.message}`);
    continue;
  }
  const sourcePath = context.sourcePaths.get(gap.sourceId);
  const source = context.sourcesById.get(gap.sourceId);
  source.viewerPolicy = "approved-private";
  writeJsonAtomic(sourcePath, source);
  writeJsonAtomic(path.join(context.targetRoot, `${target.id}.json`), next);
  promoted.push(gap.id);
}

console.log(`promoted ${promoted.length} cited original(s) to pending-upload`);
for (const line of skipped) console.log(`skipped ${line}`);
if (skipped.length) process.exitCode = 1;

function valueAfter(flag) {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

function valuesAfter(flag) {
  const values = [];
  args.forEach((arg, index) => { if (arg === flag && args[index + 1]) values.push(args[index + 1]); });
  return values;
}
