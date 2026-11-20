#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { del } from "@vercel/blob";
import { writeJsonAtomic } from "./atomic-json.mjs";
import { recordArchiveRoot } from "./tree-config.mjs";

const queueName = valueAfter("--queue") || "subscription";
const queueConfig = {
  subscription: {
    path: new URL("../evidence/subscription-records-queue.json", import.meta.url),
    pendingStatus: "pending-subscription",
  },
  familysearch: {
    path: new URL("../evidence/familysearch-recovery-queue.json", import.meta.url),
    pendingStatus: "ready",
  },
  public: {
    path: new URL("../evidence/record-recovery-queue.json", import.meta.url),
    pendingStatus: "needs-alternate-route",
  },
};
if (!queueConfig[queueName]) throw new Error("--queue must be subscription, familysearch, or public");
const queuePath = queueConfig[queueName].path;
const manifestPath = new URL("../evidence/records-manifest.json", import.meta.url);
const viewerInventoryPath = new URL("../evidence/viewer-blob-inventory.json", import.meta.url);
const archiveRoot = process.env.FAMILY_RECORD_ARCHIVE
  || recordArchiveRoot();
const targetId = valueAfter("--target");
const suppliedNote = valueAfter("--note");
const requestedStatus = valueAfter("--status");
if (!targetId) throw new Error("usage: node tools/reject-misidentified-subscription-record.mjs [--queue subscription|familysearch|public] --target <id>");
if (suppliedNote && (suppliedNote.length > 500 || /password|token|secret|card number|contact details/i.test(suppliedNote))) {
  throw new Error("unsafe rejection note");
}
if (requestedStatus && (!new Set(["familysearch", "public"]).has(queueName)
  || !new Set(["ready", "needs-alternate-route", "index-only-no-image"]).has(requestedStatus))) {
  throw new Error("--status is supported for FamilySearch and public queues and must be ready, needs-alternate-route, or index-only-no-image");
}

const queue = JSON.parse(fs.readFileSync(queuePath, "utf8"));
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const viewerInventory = fs.existsSync(viewerInventoryPath)
  ? JSON.parse(fs.readFileSync(viewerInventoryPath, "utf8"))
  : { schemaVersion: 1, records: [] };
const base = queue.targets.find((target) => target.id === targetId);
if (!base) throw new Error(`unknown ${queueName} target: ${targetId}`);
const rejected = queue.targets.filter((target) => target.id === targetId || target.derivedFrom === targetId);
if (!rejected.some((target) => target.archiveFile)) throw new Error(`target has no acquired files to reject: ${targetId}`);

for (const target of rejected) {
  if (!target.archiveFile) continue;
  const archivePath = path.join(archiveRoot, path.basename(target.archiveFile));
  if (!fs.existsSync(archivePath)) throw new Error(`archive file is missing: ${target.archiveFile}`);
  const contents = fs.readFileSync(archivePath);
  const sha256 = createHash("sha256").update(contents).digest("hex");
  if (sha256 !== target.sha256 || contents.length !== target.length) {
    throw new Error(`refusing to remove unverified archive bytes for ${target.id}`);
  }
}

for (const target of rejected) {
  if (target.viewerPublishState === "published") {
    const inventoryRecord = viewerInventory.records?.find((record) => record.id === target.id);
    const paths = [...new Set([
      blobPath(target),
      inventoryRecord?.original?.blobPath,
      inventoryRecord?.thumbnail?.blobPath,
      inventoryRecord?.preview?.blobPath,
    ].filter(Boolean))];
    await del(paths);
    console.log(`removed ${paths.length} misidentified Blob object(s) for ${target.id}`);
  }
}
for (const target of rejected) {
  if (target.archiveFile) fs.unlinkSync(path.join(archiveRoot, path.basename(target.archiveFile)));
}

queue.targets = queue.targets.filter((target) => target.id === targetId || target.derivedFrom !== targetId);
base.status = requestedStatus || queueConfig[queueName].pendingStatus;
base.attempts ||= [];
base.attempts.push({
  attemptedAt: new Date().toISOString(),
  outcome: "rejected-misassigned-image",
  note: suppliedNote || "The acquired image did not contain the indexed target household; verified misassigned bytes and all live Blob variants were removed.",
});
base.lastAttemptAt = base.attempts.at(-1).attemptedAt;
base.lastAttemptResult = "rejected-misassigned-image";
const clearedArtifactFields = [
  "acquiredAt",
  "sha256",
  "length",
  "viewerPublishState",
  "viewerPublishedAt",
  "peopleVerifiedAt",
  "peopleVerificationBasis",
];
if (queueName === "subscription") clearedArtifactFields.unshift("archiveFile", "mediaType");
for (const field of clearedArtifactFields) delete base[field];

const rejectedIds = new Set(rejected.map((target) => target.id));
manifest.records = manifest.records.filter((record) => !rejectedIds.has(record.id));
viewerInventory.records = (viewerInventory.records || []).filter((record) => !rejectedIds.has(record.id));
writeJsonAtomic(queuePath, queue);
writeJsonAtomic(manifestPath, manifest);
writeJsonAtomic(viewerInventoryPath, viewerInventory);
console.log(`restored ${targetId} to pending after rejecting ${rejected.length} misidentified artifact(s)`);

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

function blobPath(target) {
  return `records/${target.id}/original${extensionFor(target.mediaType)}`;
}

function extensionFor(mediaType) {
  if (mediaType === "application/pdf") return ".pdf";
  if (mediaType === "image/png") return ".png";
  if (mediaType === "image/webp") return ".webp";
  return ".jpg";
}
