#!/usr/bin/env node

import { loadExtractionStore, summarizeExtractionStatus, validateExtractionStore, buildExtractionStatus } from "./extraction-store.mjs";

const requireComplete = process.argv.includes("--require-complete");
const asJson = process.argv.includes("--json");
let store;
try {
  store = loadExtractionStore();
} catch (error) {
  console.error(`extraction store check failed:\n- ${error.message}`);
  process.exit(1);
}
const issues = validateExtractionStore(store, { requireComplete });
const status = buildExtractionStatus(store, { skipValidation: true });
if (asJson) console.log(JSON.stringify({ ok: !issues.length, issues, status }, null, 2));
else {
  console.log(summarizeExtractionStatus(status));
  if (issues.length) console.error(`extraction store check failed:\n- ${issues.join("\n- ")}`);
  else console.log(`extraction store ok: ${store.reviews.length} hash-bound review file(s); biography metadata contributes zero.`);
}
if (issues.length) process.exit(1);
