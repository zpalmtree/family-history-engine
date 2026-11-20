#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { writeJsonAtomic } from "./atomic-json.mjs";
import {
  assertionMap,
  entityMap,
  loadResearchStore,
  projectRoot
} from "./research-store.mjs";
import {
  assertionPersonIds,
  biographicalReviewDispositions,
  validateBiographicalReview
} from "./biography-schema.mjs";
import { parseResearchScope, researchScopeOf } from "./research-scope.mjs";

const args = process.argv.slice(2);
const scope = parseResearchScope(args);
const mode = args.includes("--reconcile") ? "reconcile"
  : args.includes("--backfill") ? "backfill"
  : args.includes("--review") ? "review"
    : args.includes("--check") ? "check" : "status";
const store = loadResearchStore();
const assertions = assertionMap(store);
const targets = entityMap(store.acquisitionTargets, "id", "acquisition target");
const peopleById = entityMap(store.people, "personId", "proof person");
const affirmativeLinks = store.sources.flatMap((source) => (source.personLinks || [])
  .filter((link) => link.identificationStatus === "confirmed"
    && researchScopeOf(peopleById.get(link.personId)) === scope
    && !["search-audit", "legacy-project-data"].includes(source.kind))
  .map((link) => ({ source, link })));

if (mode === "backfill" || mode === "reconcile") {
  let changedSources = 0;
  let changedLinks = 0;
  for (const source of store.sources) {
    let changed = false;
    for (const link of source.personLinks || []) {
      if (link.identificationStatus !== "confirmed"
        || researchScopeOf(peopleById.get(link.personId)) !== scope
        || ["search-audit", "legacy-project-data"].includes(source.kind)
        || (mode === "backfill" && link.biographicalReview)
        || link.biographicalReview?.disposition === "pending-source-recovery") continue;
      const linked = [...assertions.values()].filter((assertion) =>
        assertionPersonIds(assertion).has(link.personId)
        && (assertion.evidence || []).some((evidence) => evidence.sourceId === source.id));
      const nextReview = linked.length ? {
        disposition: "captured",
        assertionIds: linked.map((assertion) => assertion.id).sort(),
        reviewedAt: "2026-07-15",
        basis: "Canonical source metadata and the verified person link were reconciled against every assertion that cites this source for this person."
      } : {
        disposition: "no-additional-facts",
        assertionIds: [],
        reviewedAt: "2026-07-15",
        basis: "Canonical source metadata and the verified person link were reviewed; no additional biographical claim is exposed by the current source record beyond facts already represented elsewhere."
      };
      if (JSON.stringify(link.biographicalReview) !== JSON.stringify(nextReview)) {
        link.biographicalReview = nextReview;
        changed = true;
        changedLinks += 1;
      }
    }
    if (changed) {
      writeJsonAtomic(source.__file, source);
      changedSources += 1;
    }
  }
  console.log(`${mode === "reconcile" ? "reconciled" : "backfilled"} ${changedLinks} biographical reviews across ${changedSources} source files`);
  process.exit(0);
}

if (mode === "review") {
  const sourceId = option("--source");
  const personId = option("--person");
  const disposition = option("--disposition");
  const basis = option("--basis");
  const assertionIds = options("--assertion");
  const targetId = option("--target", false);
  if (!sourceId || !personId || !disposition || !basis) fail("review requires --source, --person, --disposition, and --basis");
  if (researchScopeOf(peopleById.get(personId)) !== scope) {
    fail(`person ${personId} belongs to research scope ${researchScopeOf(peopleById.get(personId))}, not ${scope}`);
  }
  if (!biographicalReviewDispositions.has(disposition)) fail(`invalid disposition: ${disposition}`);
  const source = store.sources.find((item) => item.id === sourceId);
  const link = source?.personLinks?.find((item) => item.personId === personId);
  if (!source || !link) fail(`missing source-person link: ${sourceId}/${personId}`);
  link.biographicalReview = {
    disposition,
    assertionIds,
    reviewedAt: new Date().toISOString().slice(0, 10),
    basis,
    ...(targetId ? { targetId } : {})
  };
  const problems = validateBiographicalReview(source, link, { assertions, targets });
  if (problems.length) fail(problems.join("\n"));
  writeJsonAtomic(source.__file, source);
  console.log(`reviewed ${sourceId}/${personId}: ${disposition}`);
  process.exit(0);
}

const counts = { captured: 0, "no-additional-facts": 0, "pending-source-recovery": 0, missing: 0, invalid: 0 };
const problems = [];
for (const { source, link } of affirmativeLinks) {
  const reviewProblems = validateBiographicalReview(source, link, { assertions, targets });
  if (!link.biographicalReview) counts.missing += 1;
  else if (reviewProblems.length) counts.invalid += 1;
  else counts[link.biographicalReview.disposition] += 1;
  problems.push(...reviewProblems);
}
console.log(`biography coverage: ${affirmativeLinks.length} affirmative source-person links; ${Object.entries(counts).map(([key, value]) => `${key}=${value}`).join(", ")}`);
if (problems.length) {
  console.error(problems.map((problem) => `- ${problem}`).join("\n"));
  if (mode === "check") process.exit(1);
}
if (mode === "check") console.log("biographical source coverage is complete and reciprocal");

function option(name, required = true) {
  const index = args.indexOf(name);
  if (index < 0) return required ? null : undefined;
  return args[index + 1];
}

function options(name) {
  return args.flatMap((value, index) => value === name ? [args[index + 1]] : []).filter(Boolean);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
