#!/usr/bin/env node

// Finds documents that state a family relationship whose named people are
// recorded nowhere as a claim.
//
// Person-link discipline says: do not assert an identity you cannot bridge. It
// does not say: do not record what the document states. Applied carelessly the
// first collapses into the second, and a positive statement evaporates into a
// bare name plus a sentence of prose. Hannah Duhamel's 1924 obituary named two
// surviving sisters; before this check existed, no assertion in the store
// mentioned either of them, so the Cuyahoga marriage control already waiting on
// a provider reply had nothing explaining why that woman mattered.
//
// A hit is not automatically a defect. Wills name witnesses, censuses name
// neighbours, and bonds name sureties, all of whom are correctly left as
// context. A hit means: this document states kinship, it touches a canonical
// person, and these named people appear in no assertion citing it. Someone
// should re-read the original and decide.

import fs from "node:fs";
import path from "node:path";
import { loadResearchStore, projectRoot } from "./research-store.mjs";

const KINSHIP = /\b(sister|brother|son|daughter|father|mother|wife|husband|widow|widower|nephew|niece|grandson|granddaughter|grandchild|brother-in-law|sister-in-law|son-in-law|daughter-in-law|stepson|stepdaughter|heir)\b/i;
const baselinePath = path.join(projectRoot, "evidence", "research", "unrecorded-kinship-baseline.json");
const checkOnly = process.argv.includes("--check");
const asJson = process.argv.includes("--json");

const store = loadResearchStore();
const citingAssertions = new Map();
for (const bundle of [...store.people, ...store.unions]) {
  for (const assertion of bundle.assertions || []) {
    for (const evidence of assertion.evidence || []) {
      if (!citingAssertions.has(evidence.sourceId)) citingAssertions.set(evidence.sourceId, []);
      citingAssertions.get(evidence.sourceId).push(assertion);
    }
  }
}

const findings = [];
for (const source of store.sources) {
  const unlinked = source.unlinkedNames || [];
  if (!unlinked.length || !(source.personLinks || []).length) continue;
  const prose = [source.personLinksVerificationBasis, source.reference].filter(Boolean).join(" ");
  if (!KINSHIP.test(prose)) continue;
  const cited = JSON.stringify(citingAssertions.get(source.id) || []);
  const uncaptured = unlinked
    .map((entry) => String(entry.asRecorded || ""))
    .filter((name) => {
      const surname = name.replace(/^(?:Mrs|Mr|Miss|Dr)\.?\s+/i, "").trim().split(/\s+/).pop();
      return surname && surname.length > 3 && !cited.includes(surname);
    });
  if (!uncaptured.length) continue;
  findings.push({
    sourceId: source.id,
    linkedPeople: (source.personLinks || []).map((link) => link.personId),
    uncapturedNames: uncaptured
  });
}
findings.sort((first, second) => first.sourceId.localeCompare(second.sourceId));

const baseline = fs.existsSync(baselinePath)
  ? JSON.parse(fs.readFileSync(baselinePath, "utf8"))
  : { schemaVersion: 1, note: "", sourceIds: [] };
const known = new Set(baseline.sourceIds || []);
const fresh = findings.filter((finding) => !known.has(finding.sourceId));

if (asJson) {
  console.log(JSON.stringify({ total: findings.length, baselined: known.size, fresh }, null, 2));
} else {
  console.log(`documents stating kinship with unrecorded named people: ${findings.length} (${known.size} baselined, ${fresh.length} new)`);
  for (const finding of fresh.length ? fresh : findings.slice(0, 25)) {
    console.log(`- ${finding.sourceId}`);
    console.log(`    links: ${finding.linkedPeople.join(", ") || "(none)"}`);
    console.log(`    unrecorded: ${finding.uncapturedNames.join("; ")}`);
  }
}

if (checkOnly && fresh.length) {
  console.error(`\n${fresh.length} newly acquired document(s) state kinship that no assertion records.`);
  console.error("Re-read the original and record what it states, or add the id to the baseline with a reason.");
  process.exitCode = 1;
}
