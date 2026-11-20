#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { writeJsonAtomic } from "./atomic-json.mjs";
import { writeRegistryAtomic } from "./registry-write.mjs";
import { recordArchiveRoot } from "./tree-config.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const queuePath = path.join(root, "evidence", "record-recovery-queue.json");
const manifestPath = path.join(root, "evidence", "records-manifest.json");
const archiveRoot = process.env.FAMILY_RECORD_ARCHIVE
  || recordArchiveRoot();
const queue = JSON.parse(fs.readFileSync(queuePath, "utf8"));
const queueBase = structuredClone(queue);
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const manifestBase = structuredClone(manifest);
const recordsById = new Map(manifest.records.map((record) => [record.id, record]));
const imported = [];

for (const target of queue.targets || []) {
  const sourcePath = path.join(archiveRoot, target.archiveFile || "");
  if (!fs.existsSync(sourcePath)) {
    if (target.status === "acquired") {
      throw new Error(`acquired public source master is missing: ${target.id}`);
    }
    recordsById.delete(target.id);
    continue;
  }

  const contents = fs.readFileSync(sourcePath);
  const sha256 = createHash("sha256").update(contents).digest("hex");
  target.status = "acquired";
  target.sha256 = sha256;
  target.length = contents.length;
  target.acquiredAt ||= new Date().toISOString().slice(0, 10);

  const existing = recordsById.get(target.id) || {};
  target.viewerPublishState ||= existing.viewer ? "published" : "pending-upload";
  const record = {
    ...existing,
    id: target.id,
    sourceAtomId: target.atomId,
    source: target.source,
    reference: target.reference,
    people: target.people,
    catalogueUrl: target.catalogueUrl || target.url,
    acquiredAt: target.acquiredAt,
    mediaType: target.mediaType,
    sha256,
    length: contents.length,
    rights: target.rights || "family-viewer-approved",
    rightsBasis: target.rightsBasis || queue.rightsBasis || "Publicly available original; private family-viewer preservation approved by the user.",
    peopleVerifiedAt: target.peopleVerifiedAt,
    peopleVerificationBasis: target.peopleVerificationBasis,
    privacy: "private",
    storage: "encrypted-external",
    archivePath: `FamilyHistorySourceMasters/${target.archiveFile}`,
    encryption: "windows-efs"
  };
  if (target.viewerPublishState === "published") {
    record.viewer = {
      approved: true,
      approvedAt: target.viewerPublishedAt || target.acquiredAt,
      ...target.viewer,
      blobPath: `records/${target.id}/original${extensionFor(target.mediaType)}`
    };
  } else {
    delete record.viewer;
  }
  recordsById.set(target.id, record);
  imported.push(target.id);
}

manifest.records = [...recordsById.values()];
writeRegistryAtomic(queuePath, queueBase, queue);
writeRegistryAtomic(manifestPath, manifestBase, manifest);
console.log(`imported ${imported.length} public source masters into the records manifest`);

function extensionFor(mediaType) {
  if (mediaType === "application/pdf") return ".pdf";
  if (mediaType === "image/tiff") return ".tif";
  if (mediaType === "image/jp2") return ".jp2";
  if (mediaType === "image/png") return ".png";
  if (mediaType === "image/webp") return ".webp";
  return ".jpg";
}
