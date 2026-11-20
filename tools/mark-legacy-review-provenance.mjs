#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { writeJsonAtomic } from "./atomic-json.mjs";
import { loadResearchStore, projectRoot, serializeJson } from "./research-store.mjs";
import {
  evidenceReviewKey,
  isLegacyAssertionEvidence,
  isLegacySourceReview
} from "./review-provenance.mjs";

const write = process.argv.includes("--write");
const baselinePath = path.join(projectRoot, "evidence", "research", "review-baseline.json");
const store = loadResearchStore();
const changed = new Map();
const sourceIds = [];
const assertionEvidenceKeys = [];

for (const source of store.sources) {
  if (!isLegacySourceReview(source)) continue;
  sourceIds.push(source.id);
  const expected = {
    status: "migration-inferred",
    method: "legacy-reference-text",
    migratedAt: source.personLinksVerifiedAt || "2026-07-14"
  };
  if (JSON.stringify(source.personLinkReview) !== JSON.stringify(expected)) {
    source.personLinkReview = expected;
    changed.set(source.__file, source);
  }
}

for (const owner of [...store.people, ...store.unions]) {
  let ownerChanged = false;
  for (const assertion of owner.assertions || []) {
    for (const evidence of assertion.evidence || []) {
      if (!isLegacyAssertionEvidence(evidence)) continue;
      assertionEvidenceKeys.push(evidenceReviewKey(assertion.id, evidence.sourceId));
      const expected = {
        status: "migration-inferred",
        method: "bootstrap-keyword-scoring",
        migratedAt: assertion.reviewedAt || "2026-07-14"
      };
      if (JSON.stringify(evidence.review) !== JSON.stringify(expected)) {
        evidence.review = expected;
        ownerChanged = true;
      }
    }
  }
  if (ownerChanged) changed.set(owner.__file, owner);
}

sourceIds.sort();
assertionEvidenceKeys.sort();
const baseline = {
  schemaVersion: 1,
  createdAt: "2026-07-15",
  policy: "Frozen allowlist for mechanically migrated source-person and assertion-evidence review debt. Entries may be reviewed away but new IDs must not be added.",
  sourcePersonLinkIds: sourceIds,
  assertionEvidenceKeys
};
const currentBaseline = fs.existsSync(baselinePath) ? fs.readFileSync(baselinePath, "utf8") : "";
const expectedBaseline = serializeJson(baseline);
if (currentBaseline && currentBaseline !== expectedBaseline) {
  const existing = JSON.parse(currentBaseline);
  const newSources = sourceIds.filter((id) => !(existing.sourcePersonLinkIds || []).includes(id));
  const newEvidence = assertionEvidenceKeys.filter((id) => !(existing.assertionEvidenceKeys || []).includes(id));
  if (newSources.length || newEvidence.length) {
    throw new Error(`legacy review debt expanded unexpectedly: ${newSources.length} source(s), ${newEvidence.length} assertion link(s)`);
  }
}

if (!write) {
  if (!currentBaseline) throw new Error("legacy review baseline is missing; run with --write once");
  if (changed.size) throw new Error(`${changed.size} canonical file(s) lack legacy review provenance`);
  console.log(`legacy review provenance ok: ${sourceIds.length} source(s), ${assertionEvidenceKeys.length} assertion link(s) pending`);
  process.exit(0);
}

for (const [file, value] of changed) writeJsonAtomic(file, value);
if (!currentBaseline) writeJsonAtomic(baselinePath, baseline);
console.log(`marked legacy review provenance: ${sourceIds.length} source(s), ${assertionEvidenceKeys.length} assertion link(s); ${changed.size} canonical file(s) changed`);
