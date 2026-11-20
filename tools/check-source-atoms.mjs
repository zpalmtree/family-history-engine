#!/usr/bin/env node

import fs from "node:fs";
import { validatePersonNames } from "./person-names.mjs";
import { validatePersonLinks } from "./source-person-links.mjs";
import {
  artifactPolicies,
  artifactPurposes,
  locatorKinds,
  readSourceAtoms,
  recordClasses,
  root,
  viewerPolicies
} from "./source-atoms-lib.mjs";

const inventory = readSourceAtoms();
const manifest = JSON.parse(fs.readFileSync(`${root}/evidence/records-manifest.json`, "utf8"));
const citations = JSON.parse(fs.readFileSync(`${root}/evidence/viewer-sources.json`, "utf8"));
const family = JSON.parse(fs.readFileSync(`${root}/data/family/people.json`, "utf8"));
const issues = [];
const atomIds = new Set();
const atomById = new Map();
const recordIds = new Set(manifest.records.map((record) => record.id));
const citationIds = new Set(citations.records.map((citation) => citation.id));
const personIds = new Set(family.people.map((person) => person.id));

if (inventory.schemaVersion !== 3 || !Array.isArray(inventory.atoms) || !Array.isArray(inventory.citationCoverage)) {
  issues.push("unsupported generated source atom inventory");
}
if (JSON.stringify(inventory).match(/BLOB_READ_WRITE_TOKEN|password\s*[=:]|card(number)?\s*[=:]/i)) {
  issues.push("source atom inventory contains a credential or payment marker");
}

for (const atom of inventory.atoms || []) {
  if (!atom.id || atomIds.has(atom.id)) issues.push(`invalid or duplicate atom id: ${atom.id || "(missing)"}`);
  atomIds.add(atom.id);
  atomById.set(atom.id, atom);
  if (!recordClasses.has(atom.recordClass)) issues.push(`${atom.id} has invalid recordClass: ${atom.recordClass}`);
  if (!artifactPolicies.has(atom.artifactPolicy)) issues.push(`${atom.id} has invalid artifactPolicy: ${atom.artifactPolicy}`);
  if (!viewerPolicies.has(atom.viewerPolicy)) issues.push(`${atom.id} has invalid viewerPolicy: ${atom.viewerPolicy}`);
  if (!artifactPurposes.has(atom.artifactPurpose)) issues.push(`${atom.id} has invalid artifactPurpose: ${atom.artifactPurpose}`);
  if (Object.hasOwn(atom, "evidenceRole")) issues.push(`${atom.id} retains a global evidenceRole`);
  if (!Array.isArray(atom.people) || atom.people.some((id) => !personIds.has(id))) issues.push(`${atom.id} links an unknown person`);
  if (Array.isArray(atom.personLinks)) issues.push(...validatePersonLinks(atom, { personIds }));
  if ((!Array.isArray(atom.locators) || !atom.locators.length) && atom.scope !== "planned-source") {
    issues.push(`${atom.id} has no source locator`);
  }
  for (const locator of atom.locators || []) {
    if (!locatorKinds.has(locator.kind) || !locator.value || typeof locator.value !== "string") issues.push(`${atom.id} has an invalid locator`);
  }
  if (!atom.citationIds?.length && !atom.standaloneReason) issues.push(`${atom.id} is neither cited nor documented as standalone`);
  for (const citationId of atom.citationIds || []) if (!citationIds.has(citationId)) issues.push(`${atom.id} links unknown citation ${citationId}`);
  if (atom.recordId && !recordIds.has(atom.recordId)) issues.push(`${atom.id} links unknown record ${atom.recordId}`);
}
for (const person of family.people) issues.push(...validatePersonNames(person, { personIds, atomIds }));

const coverageIds = new Set();
for (const row of inventory.citationCoverage || []) {
  if (!row.citationId || coverageIds.has(row.citationId)) issues.push(`invalid or duplicate citation coverage: ${row.citationId || "(missing)"}`);
  coverageIds.add(row.citationId);
  if (!citationIds.has(row.citationId)) issues.push(`coverage links unknown citation ${row.citationId}`);
  if (row.disposition === "source-atoms") {
    if (!Array.isArray(row.atomIds) || !row.atomIds.length) issues.push(`${row.citationId} source coverage has no atoms`);
    for (const atomId of row.atomIds || []) if (!atomIds.has(atomId)) issues.push(`${row.citationId} links unknown atom ${atomId}`);
  } else if (row.disposition === "non-documentary") {
    if (!row.reasonCode || row.atomIds?.length) issues.push(`${row.citationId} has invalid non-documentary coverage`);
  } else {
    issues.push(`${row.citationId} has invalid disposition: ${row.disposition}`);
  }
}
for (const citationId of citationIds) if (!coverageIds.has(citationId)) issues.push(`citation is absent from source atom coverage: ${citationId}`);

const manifestAtoms = new Set();
for (const record of manifest.records) {
  if (!record.sourceAtomId || !atomIds.has(record.sourceAtomId)) issues.push(`manifest record ${record.id} has no valid sourceAtomId`);
  if (manifestAtoms.has(record.sourceAtomId)) issues.push(`more than one manifest master maps to atom ${record.sourceAtomId}`);
  manifestAtoms.add(record.sourceAtomId);
  const atom = atomById.get(record.sourceAtomId);
  if (atom?.recordId !== record.id) issues.push(`atom ${record.sourceAtomId} does not point back to manifest record ${record.id}`);
  const allowedPeople = record.viewer?.approved ? (atom?.people || [])
    : [...(atom?.people || []), ...(atom?.intendedPersonIds || [])];
  if ((record.people || []).some((id) => !allowedPeople.includes(id))) {
    issues.push(`manifest record ${record.id} has people absent from atom ${record.sourceAtomId}`);
  }
}

for (const group of inventory.groups || []) {
  if (!group.id || !Array.isArray(group.atomIds) || group.atomIds.length < 2) issues.push(`invalid atom group: ${group.id || "(missing)"}`);
  if (new Set(group.atomIds || []).size !== (group.atomIds || []).length) issues.push(`${group.id} contains duplicate atom members`);
  for (const atomId of group.atomIds || []) if (!atomIds.has(atomId)) issues.push(`${group.id} links unknown atom ${atomId}`);
  if (!new Set(["complete-known-set", "open-ended"]).has(group.completeness)) issues.push(`${group.id} has invalid completeness`);
}

if (issues.length) {
  console.error(`source atom check failed:\n- ${issues.join("\n- ")}`);
  process.exit(1);
}

const preservable = inventory.atoms.filter((atom) => atom.artifactPolicy === "preserve-if-accessible");
const preserved = preservable.filter((atom) => atom.recordId);
console.log(`source atoms ok: ${atomIds.size} atoms; ${coverageIds.size} citations; ${preserved.length}/${preservable.length} preservable atoms have masters`);
