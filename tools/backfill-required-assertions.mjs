#!/usr/bin/env node

import { writeJsonAtomic } from "./atomic-json.mjs";
import { loadResearchStore } from "./research-store.mjs";

const write = process.argv.includes("--write");
const store = loadResearchStore();
const changed = [];

for (const person of store.people) {
  if (person.assertions.some((assertion) => assertion.claim?.kind === "life-status")) continue;
  const id = `assert-${person.personId}-life-status`;
  person.assertions.push({
    id,
    assessment: "unresolved",
    claim: {
      kind: "life-status",
      personId: person.personId,
      value: "unknown"
    },
    conclusion: "No life status was recorded in the pre-migration family data.",
    limitations: "This explicit unknown preserves the display contract without inferring whether the person is living or deceased.",
    evidence: [{
      sourceId: `legacy-project-data-${person.personId}`,
      role: "context",
      rationale: "The pre-migration person record omitted life status; this provenance supports only the absence of a recorded conclusion."
    }],
    questionIds: [],
    reviewedAt: "2026-07-14"
  });
  person.presentation.detailAssertionIds.push(id);
  changed.push(person);
}

if (!write && changed.length) {
  console.error(`${changed.length} people are missing explicit life-status assertions; run node tools/backfill-required-assertions.mjs --write`);
  process.exit(1);
}
if (write) for (const person of changed) writeJsonAtomic(person.__file, person);
console.log(`${write ? "backfilled" : "checked"} required assertions: ${changed.length} person file(s) ${write ? "changed" : "missing"}`);
