#!/usr/bin/env node

import { loadResearchStore } from "./research-store.mjs";
import { isLegacyAssertionEvidence, isLegacySourceReview } from "./review-provenance.mjs";

const json = process.argv.includes("--json");
const store = loadResearchStore();
const assertions = [...store.people, ...store.unions].flatMap((owner) => owner.assertions || []);
const pendingSources = store.sources.filter(isLegacySourceReview).map((source) => ({
  id: source.id,
  provider: source.provider,
  recordClass: source.recordClass,
  viewerPolicy: source.viewerPolicy,
  tier: source.viewerPolicy !== "not-applicable" ? "P0"
    : (source.personLinks || []).some((link) => link.identificationStatus === "confirmed") ? "P1"
      : ["original-image", "original-pdf", "newspaper-page", "index-image"].includes(source.recordClass) ? "P1" : "P2"
}));
const pendingAssertions = assertions.flatMap((assertion) => (assertion.evidence || [])
  .filter(isLegacyAssertionEvidence)
  .map((evidence) => ({
    assertionId: assertion.id,
    sourceId: evidence.sourceId,
    assessment: assertion.assessment,
    claimKind: assertion.claim?.kind,
    tier: ["life-status", "parentage", "union", "person-identity"].includes(assertion.claim?.kind) ? "P0"
      : assertion.assessment === "established" ? "P1" : "P2"
  })));
const result = {
  generatedFrom: "canonical research store",
  sources: {
    pending: pendingSources.length,
    byTier: counts(pendingSources, "tier"),
    items: pendingSources.sort(sortTier)
  },
  assertionEvidence: {
    pending: pendingAssertions.length,
    assertions: new Set(pendingAssertions.map((item) => item.assertionId)).size,
    byTier: counts(pendingAssertions, "tier"),
    items: pendingAssertions.sort(sortTier)
  }
};

if (json) console.log(JSON.stringify(result, null, 2));
else {
  console.log(`Legacy provenance debt: ${result.sources.pending} source-person review(s); ${result.assertionEvidence.pending} assertion-evidence link(s) across ${result.assertionEvidence.assertions} assertion(s).`);
  console.log("This counts records still in the legacy schema. It does not measure whether any genealogical conclusion has been reviewed.");
  console.log(`Sources by tier: ${JSON.stringify(result.sources.byTier)}.`);
  console.log(`Assertion evidence by tier: ${JSON.stringify(result.assertionEvidence.byTier)}.`);
}

function counts(items, field) {
  return Object.fromEntries([...new Set(items.map((item) => item[field]))].sort()
    .map((value) => [value, items.filter((item) => item[field] === value).length]));
}

function sortTier(left, right) {
  return left.tier.localeCompare(right.tier)
    || String(left.id || left.assertionId).localeCompare(String(right.id || right.assertionId));
}
