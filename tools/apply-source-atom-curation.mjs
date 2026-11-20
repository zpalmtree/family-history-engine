#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { readJson, writeJsonAtomic } from "./atomic-json.mjs";
import { root, sourceAtomsPath } from "./source-atoms-lib.mjs";
import { snapshotQueueAtomIds, writeChangedQueueAtomIds } from "./source-atom-queue-write.mjs";

const checkOnly = process.argv.includes("--check");
const curationPath = path.join(root, "evidence", "source-atom-curation.json");
const inventory = readJson(sourceAtomsPath);
const curation = readJson(curationPath);
const before = JSON.stringify(inventory);
const atoms = new Map(inventory.atoms.map((atom) => [atom.id, atom]));

for (const [fromId, toId] of Object.entries(curation.renames || {})) {
  if (!atoms.has(fromId)) continue;
  const atom = atoms.get(fromId);
  atoms.delete(fromId);
  if (atoms.has(toId)) {
    const target = atoms.get(toId);
    target.citationIds = [...new Set([...(target.citationIds || []), ...(atom.citationIds || [])])];
    target.locators = uniqueLocators([...(target.locators || []), ...(atom.locators || [])]);
  } else {
    atom.id = toId;
    atoms.set(toId, atom);
  }
  for (const row of inventory.citationCoverage) {
    if (row.atomIds) row.atomIds = row.atomIds.map((id) => id === fromId ? toId : id);
  }
  for (const group of inventory.groups || []) {
    if (group.atomIds) group.atomIds = group.atomIds.map((id) => id === fromId ? toId : id);
  }
}

for (const atom of curation.addAtoms || []) {
  if (!atoms.has(atom.id)) atoms.set(atom.id, structuredClone(atom));
}
for (const [fromId, toId] of Object.entries(curation.renames || {})) {
  if (!atoms.has(toId)) throw new Error(`curation rename references unknown atom: ${fromId}`);
}

for (const [atomId, update] of Object.entries(curation.updates || {})) {
  const atom = atoms.get(atomId);
  if (!atom) throw new Error(`curation update references unknown atom: ${atomId}`);
  Object.assign(atom, update);
}

for (const [fromId, toIds] of Object.entries(curation.aliases || {})) {
  const source = atoms.get(fromId);
  if (!source) continue;
  for (const toId of toIds) {
    const target = atoms.get(toId);
    if (!target) throw new Error(`curation alias ${fromId} references unknown atom: ${toId}`);
    target.citationIds ||= [];
    for (const citationId of source.citationIds || []) if (!target.citationIds.includes(citationId)) target.citationIds.push(citationId);
  }
  for (const row of inventory.citationCoverage) {
    if (!row.atomIds?.includes(fromId)) continue;
    row.atomIds = [...new Set(row.atomIds.flatMap((id) => id === fromId ? toIds : [id]))];
  }
  for (const group of inventory.groups || []) {
    if (!group.atomIds?.includes(fromId)) continue;
    group.atomIds = [...new Set(group.atomIds.flatMap((id) => id === fromId ? toIds : [id]))];
  }
  atoms.delete(fromId);
}

for (const [citationId, atomIds] of Object.entries(curation.coverageAdds || {})) {
  const row = inventory.citationCoverage.find((item) => item.citationId === citationId);
  if (!row || row.disposition !== "documentary") throw new Error(`coverage add references invalid citation: ${citationId}`);
  for (const atomId of atomIds) {
    const atom = atoms.get(atomId);
    if (!atom) throw new Error(`coverage add references unknown atom: ${atomId}`);
    if (!row.atomIds.includes(atomId)) row.atomIds.push(atomId);
    atom.citationIds ||= [];
    if (!atom.citationIds.includes(citationId)) atom.citationIds.push(citationId);
  }
}

inventory.atoms = [...atoms.values()].sort((a, b) => a.id.localeCompare(b.id));
inventory.citationCoverage.sort((a, b) => a.citationId.localeCompare(b.citationId));

const queuePaths = [
  "evidence/familysearch-recovery-queue.json",
  "evidence/record-recovery-queue.json",
  "evidence/subscription-records-queue.json"
];
const queues = queuePaths.map((relative) => {
  const queuePath = path.join(root, relative);
  const queue = readJson(queuePath);
  return [queuePath, queue, snapshotQueueAtomIds(queue)];
});
for (const [, queue] of queues) {
  for (const target of queue.targets || []) {
    if (curation.renames?.[target.atomId]) target.atomId = curation.renames[target.atomId];
    const replacements = curation.aliases?.[target.atomId];
    if (!replacements) continue;
    if (replacements.length !== 1) throw new Error(`provider route ${target.id} cannot map to multiple alias atoms`);
    target.atomId = replacements[0];
  }
}

if (checkOnly) {
  if (before !== JSON.stringify(inventory)) throw new Error("source atom curation is stale; run node tools/apply-source-atom-curation.mjs");
  console.log(`source atom curation is current: ${inventory.atoms.length} atoms`);
} else {
  writeJsonAtomic(sourceAtomsPath, inventory);
  for (const [queuePath, queue, beforeAtomIds] of queues) {
    writeChangedQueueAtomIds(queuePath, beforeAtomIds, queue);
  }
  console.log(`applied source atom curation: ${inventory.atoms.length} atoms remain`);
}

function uniqueLocators(locators) {
  const seen = new Set();
  return locators.filter((locator) => {
    const key = `${locator.kind}:${locator.value}`.toLocaleLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
