#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeJsonAtomic } from "./atomic-json.mjs";
import { validatePersonLinks } from "./source-person-links.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const checkOnly = process.argv.includes("--check");
const dryRun = process.argv.includes("--dry-run");
const atomsPath = path.join(root, "evidence", "source-atoms.json");
const curationPath = path.join(root, "evidence", "source-atom-curation.json");
const backfillPath = path.join(root, "evidence", "source-name-backfill.json");
const familyPath = path.join(root, "data", "family", "people.json");
const inventory = JSON.parse(fs.readFileSync(atomsPath, "utf8"));
const curation = JSON.parse(fs.readFileSync(curationPath, "utf8"));
const backfill = JSON.parse(fs.readFileSync(backfillPath, "utf8"));
const family = JSON.parse(fs.readFileSync(familyPath, "utf8"));
const peopleById = new Map(family.people.map((person) => [person.id, person]));
const personIds = new Set(peopleById.keys());
const pendingIds = new Set(backfill.atomIds || []);

if (checkOnly) {
  if (pendingIds.size) {
    throw new Error(`legacy source-name migration remains for ${pendingIds.size} atom(s)`);
  }
  console.log("legacy source-name migration is complete");
  process.exit(0);
}

const verifiedAt = new Date().toISOString().slice(0, 10);
const verificationBasis = "Legacy corpus metadata reconciled; name readings match preserved source-reference text, while unmatched pre-existing links make no recorded-name claim.";
let named = 0;
let directlyEvidenced = 0;

for (const atom of inventory.atoms) {
  if (!pendingIds.has(atom.id)) continue;
  const referenceText = sourceReferenceText(atom);
  const identificationStatus = atom.evidenceRole === "candidate-control"
    || atom.viewerPolicy === "withheld-control"
    || atom.artifactPolicy === "preserve-if-accessible" && !atom.recordId
    ? "candidate"
    : "confirmed";
  const readings = (atom.people || []).map((personId) => {
    const person = peopleById.get(personId);
    if (!person) throw new Error(`legacy source ${atom.id} links unknown person ${personId}`);
    return { personId, reading: exactReferenceReading(person, atom.id, referenceText) };
  });
  const readingCounts = new Map();
  for (const { reading } of readings) {
    if (!reading) continue;
    const key = reading.toLocaleLowerCase();
    readingCounts.set(key, (readingCounts.get(key) || 0) + 1);
  }
  const personLinks = readings.map(({ personId, reading }) => {
    const ambiguous = reading && readingCounts.get(reading.toLocaleLowerCase()) > 1;
    if (!reading || ambiguous) {
      directlyEvidenced += 1;
      return { personId, identificationStatus: "candidate", evidenceBasis: "directly-evidenced" };
    }
    named += 1;
    return {
      personId,
      identificationStatus,
      evidenceBasis: "named",
      names: [{
        asRecorded: reading,
        origin: readingOrigin(atom),
        preferred: true
      }]
    };
  });
  const virtualAtom = {
    ...atom,
    personLinks,
    personLinksVerifiedAt: verifiedAt,
    personLinksVerificationBasis: verificationBasis
  };
  const issues = validatePersonLinks(virtualAtom, { personIds });
  if (issues.length) throw new Error(`invalid migrated source ${atom.id}:\n- ${issues.join("\n- ")}`);
  atom.personLinks = personLinks;
  atom.personLinksVerifiedAt = verifiedAt;
  atom.personLinksVerificationBasis = verificationBasis;
  curation.updates ||= {};
  curation.updates[atom.id] = {
    ...(curation.updates[atom.id] || {}),
    people: atom.people || [],
    personLinks,
    personLinksVerifiedAt: verifiedAt,
    personLinksVerificationBasis: verificationBasis
  };
}

const migrated = pendingIds.size;
if (!dryRun) {
  backfill.atomIds = [];
  writeJsonAtomic(atomsPath, inventory);
  writeJsonAtomic(curationPath, curation);
  writeJsonAtomic(backfillPath, backfill);
}
console.log(`${dryRun ? "would migrate" : "migrated"} ${migrated} legacy source atom(s): ${named} exact reference name reading(s), ${directlyEvidenced} link(s) without a recorded-name claim`);

function sourceReferenceText(atom) {
  return [
    atom.reference,
    ...(atom.locators || []).filter((locator) => locator.kind === "bibliographic").map((locator) => locator.value)
  ].filter(Boolean).join(" ");
}

function exactReferenceReading(person, atomId, referenceText) {
  const variants = (person.names || [])
    .filter((name) => typeof name.value === "string" && name.value.trim())
    .sort((left, right) => {
      const leftSpecific = left.sourceAtomIds?.includes(atomId) ? 1 : 0;
      const rightSpecific = right.sourceAtomIds?.includes(atomId) ? 1 : 0;
      return rightSpecific - leftSpecific || right.value.length - left.value.length;
    });
  for (const variant of variants) {
    const pattern = new RegExp(`(?:^|[^\\p{L}\\p{N}])(${escapeRegExp(variant.value)})(?![\\p{L}\\p{N}])`, "iu");
    const match = referenceText.match(pattern);
    if (match) return match[1];
  }
  return undefined;
}

function readingOrigin(atom) {
  if (atom.recordId && new Set(["original-image", "index-image", "newspaper-page", "original-pdf"]).has(atom.recordClass)) {
    return "original";
  }
  if (atom.recordClass === "transcript") return "transcript";
  if (new Set(["index-entry", "index-image"]).has(atom.recordClass)) return "index";
  if (atom.recordClass === "family-statement") return "family-statement";
  if (atom.recordClass === "research-webpage" || atom.recordClass === "newspaper-page") return "webpage";
  return "catalogue";
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
