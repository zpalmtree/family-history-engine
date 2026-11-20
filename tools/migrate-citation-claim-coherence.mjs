#!/usr/bin/env node

import { writeJsonAtomic } from "./atomic-json.mjs";
import {
  legacyCitationContextNote,
  partitionCitationAssertions
} from "./citation-coherence.mjs";
import { assertionMap, loadResearchStore, serializeJson } from "./research-store.mjs";

const write = process.argv.includes("--write");
const store = loadResearchStore();
const assertions = assertionMap(store);
const changes = [];
let proofLinkCount = 0;
let contextLinkCount = 0;
let contextOnlyCount = 0;

for (const citation of store.citations) {
  const { proofAssertionIds, contextAssertionIds } = partitionCitationAssertions(citation, assertions);
  proofLinkCount += proofAssertionIds.length;
  contextLinkCount += contextAssertionIds.length;
  if (!proofAssertionIds.length && contextAssertionIds.length) contextOnlyCount += 1;
  const {
    schemaVersion,
    id,
    assertionIds: ignoredAssertionIds,
    contextAssertionIds: ignoredContextAssertionIds,
    contextNote: ignoredContextNote,
    sourceIds,
    ...rest
  } = citation;
  const migrated = {
    schemaVersion,
    id,
    assertionIds: proofAssertionIds,
    ...(contextAssertionIds.length ? {
      contextAssertionIds,
      contextNote: citation.contextNote?.trim() || legacyCitationContextNote
    } : {}),
    sourceIds,
    ...rest
  };
  if (serializeJson(migrated) !== serializeJson(citation)) changes.push({ citation, migrated });
}

if (write) for (const { citation, migrated } of changes) writeJsonAtomic(citation.__file, migrated);
console.log(
  `citation claim coherence ${write ? "migrated" : "check"}: ${changes.length} file(s) ${write ? "changed" : "would change"}; `
    + `${proofLinkCount} proof link(s), ${contextLinkCount} context link(s), ${contextOnlyCount} context-only citation(s)`
);
if (!write && changes.length) process.exit(1);
