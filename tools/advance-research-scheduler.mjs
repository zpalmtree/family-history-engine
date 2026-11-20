#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

import { advanceResearchScheduler } from "./research-scheduler-store.mjs";
import { parseResearchScope } from "./research-scope.mjs";

const args = process.argv.slice(2);
const scope = parseResearchScope(args);
const selectionFile = value("--selection");
const expectedRevision = Number(value("--expected-revision"));
const completionRefs = values("--completion-ref");
const completedAt = value("--completed-at") || new Date().toISOString();
const dryRun = args.includes("--dry-run");

if (!selectionFile || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || !completionRefs.length) {
  usage();
}

const selectionDocument = JSON.parse(fs.readFileSync(path.resolve(selectionFile), "utf8"));
const result = advanceResearchScheduler({
  scope,
  selectionDocument,
  completionRefs,
  completedAt,
  expectedRevision,
  write: !dryRun
});

console.log(JSON.stringify({
  changed: result.changed,
  dryRun,
  scope,
  revision: result.record.revision,
  cursor: result.record.cursor,
  completionId: result.event.id,
  itemId: result.event.itemId,
  kind: result.event.kind
}, null, 2));

function value(flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function values(flag) {
  return args.flatMap((item, index) => item === flag && args[index + 1] ? [args[index + 1]] : []);
}

function usage() {
  console.error(
    "usage: node tools/advance-research-scheduler.mjs [--scope <scope>] "
      + "--selection <saved-research-status.json> --expected-revision <n> "
      + "--completion-ref <canonical-file> [--completion-ref <canonical-file> ...] "
      + "[--completed-at <ISO timestamp>] [--dry-run]"
  );
  process.exit(2);
}
