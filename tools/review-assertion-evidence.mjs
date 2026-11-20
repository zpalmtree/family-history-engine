#!/usr/bin/env node

import { writeJsonAtomic } from "./atomic-json.mjs";
import { loadResearchStore } from "./research-store.mjs";
import { legacyAssertionRationalePrefix } from "./review-provenance.mjs";

const assertionId = valueAfter("--assertion");
const sourceId = valueAfter("--source");
const remove = process.argv.includes("--remove");
const assessment = valueAfter("--assessment");
const limitations = valueAfter("--limitations");
if (!assertionId || !sourceId) throw new Error("Pass --assertion and --source.");
if (assessment && !["established", "candidate", "unresolved", "rejected"].includes(assessment)) {
  throw new Error("--assessment must be established, candidate, unresolved, or rejected.");
}

const store = loadResearchStore();
const owner = [...store.people, ...store.unions].find((candidate) =>
  candidate.assertions?.some((assertion) => assertion.id === assertionId));
if (!owner) throw new Error(`Unknown assertion ${assertionId}.`);
const assertion = owner.assertions.find((candidate) => candidate.id === assertionId);
const index = (assertion.evidence || []).findIndex((evidence) => evidence.sourceId === sourceId);
if (index < 0) throw new Error(`${assertionId} has no evidence link to ${sourceId}.`);

if (remove) {
  const note = valueAfter("--note");
  if (!note || note.length < 20) throw new Error("Removing evidence requires a specific --note of at least 20 characters.");
  assertion.evidence.splice(index, 1);
  assertion.reviewNotes = [...(assertion.reviewNotes || []), {
    reviewedAt: today(),
    action: "evidence-link-removed",
    sourceId,
    note
  }];
} else {
  const role = valueAfter("--role");
  const rationale = valueAfter("--rationale");
  const method = valueAfter("--method");
  if (!new Set(["direct", "indirect", "negative", "contradicts", "context"]).has(role)) {
    throw new Error("Pass an exact --role.");
  }
  if (!new Set(["original", "provider-index-transcript", "family-statement", "legacy-provenance"]).has(method)) {
    throw new Error("Pass a supported --method.");
  }
  if (!rationale || rationale.length < 20 || rationale.startsWith(legacyAssertionRationalePrefix)) {
    throw new Error("Pass a specific non-boilerplate --rationale of at least 20 characters.");
  }
  assertion.evidence[index] = {
    sourceId,
    role,
    rationale,
    review: { status: "claim-reviewed", method, reviewedAt: today() }
  };
}

if (assessment) assertion.assessment = assessment;
if (limitations) assertion.limitations = limitations;
if (["candidate", "unresolved"].includes(assertion.assessment) && !assertion.limitations) {
  throw new Error(`${assertion.id} requires --limitations while ${assertion.assessment}.`);
}
assertion.reviewedAt = today();
writeJsonAtomic(owner.__file, owner);
console.log(`${assertionId}/${sourceId}: ${remove ? "removed" : "claim-reviewed"}`);

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  return index < 0 ? "" : process.argv[index + 1] || "";
}

function today() {
  return new Date().toISOString().slice(0, 10);
}
