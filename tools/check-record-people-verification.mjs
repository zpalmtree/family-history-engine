#!/usr/bin/env node

import fs from "node:fs";
import { validatePersonLinks } from "./source-person-links.mjs";

const manifest = JSON.parse(fs.readFileSync(new URL("../evidence/records-manifest.json", import.meta.url), "utf8"));
const atoms = JSON.parse(fs.readFileSync(new URL("../evidence/source-atoms.json", import.meta.url), "utf8"));
const backfill = JSON.parse(fs.readFileSync(new URL("../evidence/source-name-backfill.json", import.meta.url), "utf8"));
const queues = [
  JSON.parse(fs.readFileSync(new URL("../evidence/record-recovery-queue.json", import.meta.url), "utf8")),
  JSON.parse(fs.readFileSync(new URL("../evidence/familysearch-recovery-queue.json", import.meta.url), "utf8")),
  JSON.parse(fs.readFileSync(new URL("../evidence/subscription-records-queue.json", import.meta.url), "utf8"))
];
const records = new Map(manifest.records.map((record) => [record.id, record]));
const atomsById = new Map(atoms.atoms.map((atom) => [atom.id, atom]));
const family = JSON.parse(fs.readFileSync(new URL("../data/family/people.json", import.meta.url), "utf8"));
const personIds = new Set(family.people.map((person) => person.id));
const legacyAtomIds = new Set(backfill.atomIds || []);
const issues = [];
const checkedIds = new Set();
let checked = 0;
let legacy = 0;

for (const queue of queues) {
  for (const target of queue.targets || []) {
    if (target.status !== "acquired" || !target.viewer) continue;
    checked += 1;
    checkedIds.add(target.id);
    const record = records.get(target.id);
    const atom = atomsById.get(target.atomId || target.id);
    if (!record) issues.push(`${target.id} lacks a manifest record`);
    if (!atom) issues.push(`${target.id} lacks a source atom`);
    if (record && JSON.stringify(record.people) !== JSON.stringify(target.people)) issues.push(`${target.id} queue/manifest people differ`);
    if (atom && JSON.stringify(atom.people) !== JSON.stringify(target.people)) issues.push(`${target.id} queue/atom people differ`);
    if (!target.peopleVerifiedAt || !target.peopleVerificationBasis) issues.push(`${target.id} lacks visual person verification`);
    if (record && target.peopleVerifiedAt !== record.peopleVerifiedAt) issues.push(`${target.id} verification date differs in manifest`);
    if (atom && legacyAtomIds.has(atom.id)) {
      legacy += 1;
      continue;
    }
    if (atom) issues.push(...validatePersonLinks(atom, { personIds }).map((issue) => `${target.id}: ${issue}`));
  }
}

for (const record of manifest.records || []) {
  if (!record.viewer?.approved || checkedIds.has(record.id)) continue;
  checked += 1;
  const atom = atomsById.get(record.sourceAtomId || record.id);
  if (!atom) issues.push(`${record.id} lacks a source atom`);
  if (atom && JSON.stringify(atom.people) !== JSON.stringify(record.people)) issues.push(`${record.id} manifest/atom people differ`);
  if (!record.peopleVerifiedAt || !record.peopleVerificationBasis) issues.push(`${record.id} lacks visual person verification`);
  if (atom && legacyAtomIds.has(atom.id)) {
    legacy += 1;
    continue;
  }
  if (atom) issues.push(...validatePersonLinks(atom, { personIds }).map((issue) => `${record.id}: ${issue}`));
}

if (issues.length) {
  console.error(`record person-verification check failed:\n- ${issues.join("\n- ")}`);
  process.exit(1);
}
console.log(
  `record people verification ok: ${checked} acquired viewer/control record(s) visually reconciled; `
    + `${checked - legacy} structured and ${legacy} grandfathered for source-name presentation`
);
