#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { writeJsonAtomic } from "./atomic-json.mjs";
import { loadResearchStore, projectRoot } from "./research-store.mjs";

const root = projectRoot;
const queueName = valueAfter("--queue");
const targetId = valueAfter("--target");
const note = valueAfter("--note");
const queueFiles = {
  public: "evidence/record-recovery-queue.json",
  familysearch: "evidence/familysearch-recovery-queue.json",
  subscription: "evidence/subscription-records-queue.json"
};

if (!(queueName in queueFiles) || !targetId || !note) {
  throw new Error("usage: --queue public|familysearch|subscription --target <id> --note <visual mismatch basis>");
}
if (note.length > 500 || /password|token|secret|credit card|contact details/i.test(note)) {
  throw new Error("withhold note is too long or contains a sensitive-data marker");
}

const queuePath = path.join(root, queueFiles[queueName]);
const manifestPath = path.join(root, "evidence", "records-manifest.json");
const inventoryPath = path.join(root, "evidence", "viewer-blob-inventory.json");
const queue = JSON.parse(fs.readFileSync(queuePath, "utf8"));
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const inventory = JSON.parse(fs.readFileSync(inventoryPath, "utf8"));
const store = loadResearchStore();
const target = queue.targets?.find((item) => item.id === targetId);
if (!target) throw new Error(`unknown ${queueName} target: ${targetId}`);
if (target.status !== "acquired") throw new Error(`target must be acquired before it can be withheld: ${targetId}`);
const record = manifest.records.find((item) => item.id === targetId);
if (!record) throw new Error(`manifest record is missing for acquired target: ${targetId}`);
const atomId = target.atomId || record.sourceAtomId || target.id;
const atom = store.sources.find((item) => item.id === atomId);
const acquisitionTarget = store.acquisitionTargets.find((item) => item.sourceId === atomId);
if (!atom) throw new Error(`source atom is missing for target: ${atomId}`);
if (!acquisitionTarget) throw new Error(`acquisition target is missing for source: ${atomId}`);

const verifiedAt = new Date().toISOString().slice(0, 10);
target.people = [];
target.peopleVerifiedAt = verifiedAt;
target.peopleVerificationBasis = note;
target.evidenceRole = "candidate-control";
target.publishEligible = false;
target.viewerPublishState = "withheld-control";
target.withholdReason = note;
delete target.viewerApproved;
delete target.viewerApprovalBasis;
delete target.viewerPublishedAt;

record.people = [];
record.peopleVerifiedAt = verifiedAt;
record.peopleVerificationBasis = note;
delete record.viewer;

atom.peopleVerifiedAt = verifiedAt;
atom.personLinks = [];
atom.personLinksVerifiedAt = verifiedAt;
atom.personLinksVerificationBasis = note;
atom.viewerPolicy = "withheld-control";
atom.artifactPurpose = "control";
delete atom.unlinkedNames;
delete atom.intendedPersonIds;
acquisitionTarget.desiredArtifact = { publishEligible: false };
inventory.records = (inventory.records || []).filter((item) => item.id !== targetId);

writeJsonAtomic(queuePath, queue);
writeJsonAtomic(manifestPath, manifest);
writeJsonAtomic(atom.__file, atom);
writeJsonAtomic(acquisitionTarget.__file, acquisitionTarget);
writeJsonAtomic(inventoryPath, inventory);
console.log(`withheld misidentified record ${targetId}; preserved its source master as a control`);

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  return index < 0 ? undefined : process.argv[index + 1];
}
