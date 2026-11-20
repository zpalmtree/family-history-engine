#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { writeJsonAtomic } from "./atomic-json.mjs";
import { projectSubscriptionManifestRecord } from "./subscription-record-projection.mjs";
import { writeRegistryAtomic } from "./registry-write.mjs";
import { recordArchiveRoot } from "./tree-config.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const queuePath = path.join(root, "evidence", "subscription-records-queue.json");
const manifestPath = path.join(root, "evidence", "records-manifest.json");
const archiveRoot = process.env.FAMILY_RECORD_ARCHIVE
  || recordArchiveRoot();
const queue = JSON.parse(fs.readFileSync(queuePath, "utf8"));
const queueBase = structuredClone(queue);
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const manifestBase = structuredClone(manifest);
const sourceAtoms = JSON.parse(fs.readFileSync(path.join(root, "evidence", "source-atoms.json"), "utf8"));
const atomsById = new Map(sourceAtoms.atoms.map((atom) => [atom.id, atom]));
const recordsById = new Map(manifest.records.map((record) => [record.id, record]));
const imported = [];

for (const target of queue.targets || []) {
  if (!target.archiveFile) {
    if (["acquired", "published"].includes(target.status)) {
      throw new Error(`${target.status} subscription record has no archiveFile: ${target.id}`);
    }
    continue;
  }

  const archiveFile = path.basename(target.archiveFile);
  if (archiveFile !== target.archiveFile) {
    throw new Error(`subscription archiveFile must be a filename, not a path: ${target.id}`);
  }
  const sourcePath = path.join(archiveRoot, archiveFile);
  if (!fs.existsSync(sourcePath)) {
    if (["acquired", "published"].includes(target.status)) {
      throw new Error(`${target.status} subscription source master is missing: ${target.id}`);
    }
    continue;
  }

  const contents = fs.readFileSync(sourcePath);
  const sha256 = createHash("sha256").update(contents).digest("hex");
  target.status = "acquired";
  target.sha256 = sha256;
  target.length = contents.length;
  target.acquiredAt ||= new Date().toISOString().slice(0, 10);
  target.viewerPublishState ||= "pending-upload";

  // Structured source verification is the durable authority for exact names
  // and identity links. Restore queue/manifest presentation metadata from it
  // if a normalization or merge accidentally drops only the duplicated gate
  // fields; never manufacture verification for an unreviewed atom.
  const atom = atomsById.get(target.atomId || target.id);
  if ((!target.peopleVerifiedAt || !target.peopleVerificationBasis)
      && atom?.peopleVerifiedAt
      && atom?.personLinksVerifiedAt
      && atom?.personLinksVerificationBasis) {
    target.people = atom.people || [];
    target.peopleVerifiedAt = atom.peopleVerifiedAt;
    target.peopleVerificationBasis = atom.personLinksVerificationBasis;
  }

  const record = projectSubscriptionManifestRecord({
    target,
    existing: recordsById.get(target.id),
    atom,
    sha256,
    length: contents.length,
    archiveFile,
    rightsBasis: queue.rightsBasis,
    rightsConfirmedAt: queue.rightsConfirmedAt,
  });

  recordsById.set(target.id, record);
  imported.push(target.id);
}

manifest.records = [...recordsById.values()];
writeRegistryAtomic(queuePath, queueBase, queue);
writeRegistryAtomic(manifestPath, manifestBase, manifest);
console.log(`imported ${imported.length} subscription source masters into the records manifest`);
