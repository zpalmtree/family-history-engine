#!/usr/bin/env node

import { buildExtractionStatus, loadExtractionStore, summarizeExtractionStatus } from "./extraction-store.mjs";
import { parseResearchScope } from "./research-scope.mjs";

const args = process.argv.slice(2);
const scope = parseResearchScope(args);
const asJson = args.includes("--json");
const nextOnly = args.includes("--next");
const recordId = value("--record");
const store = loadExtractionStore();
const status = buildExtractionStatus(store, { scope });

if (recordId && !status.items.some((item) => item.recordId === recordId)) {
  console.error(`record is outside active extraction campaign: ${recordId}`);
  process.exit(2);
}
const result = recordId ? status.items.find((item) => item.recordId === recordId)
  : nextOnly ? status.next
    : status;
if (asJson) {
  console.log(JSON.stringify(result, null, 2));
} else if (recordId) {
  console.log(`${result.recordId}: ${result.state}${result.packetId ? ` (${result.packetId})` : ""}`);
} else if (nextOnly) {
  if (!result) console.log("No extraction work is selectable.");
  else console.log(`${result.kind}: ${result.records.map((item) => item.recordId).join(", ")}`);
} else {
  console.log(summarizeExtractionStatus(status));
  if (status.issues.length) console.log(`Store issues: ${status.issues.length}. Run records-extract-check.mjs for details.`);
  if (status.next) console.log(`Next: ${status.next.kind} — ${status.next.records.map((item) => item.recordId).join(", ")}`);
}

function value(flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}
