#!/usr/bin/env node

import fs from "node:fs";
import { approvedViewerRecords, derivativeProfiles, inventoryById, readViewerBlobInventory } from "./viewer-blob-inventory.mjs";

const manifest = JSON.parse(fs.readFileSync(new URL("../evidence/records-manifest.json", import.meta.url), "utf8"));
const inventory = readViewerBlobInventory();
const approved = approvedViewerRecords(manifest);
const approvedById = new Map(approved.map((record) => [record.id, record]));
const deliveryById = inventoryById(inventory);
const pendingPublicationIds = readPendingPublicationIds();
const issues = [];
const paths = new Set();

if (inventory.schemaVersion !== 1 || !Array.isArray(inventory.records)) {
  issues.push("viewer Blob inventory must use schemaVersion 1 with a records array");
}

for (const record of approved) {
  const delivery = deliveryById.get(record.id);
  if (!delivery) {
    // A newly approved record has to exist in the manifest before its guarded
    // publisher can upload it. Treat that explicit canonical transition state
    // as valid during pre-publication checks; once the publisher marks it
    // published, a missing inventory entry remains a hard failure.
    if (pendingPublicationIds.has(record.id)) continue;
    issues.push(`${record.id}: missing viewer Blob inventory entry`);
    continue;
  }
  if (delivery.sourceSha256 !== record.sha256) issues.push(`${record.id}: inventory is stale for its source master`);
  checkObject(record, delivery.original, "original", {
    blobPath: record.viewer.blobPath,
    mediaType: record.mediaType,
    length: record.length,
    sha256: record.sha256
  });

  if (record.mediaType.startsWith("image/")) {
    checkDerivative(record, delivery.thumbnail, "thumbnail", derivativeProfiles.thumbnail);
    checkDerivative(record, delivery.preview, "preview", derivativeProfiles.preview);
  } else if (record.mediaType === "application/pdf") {
    // PDFs carry a first-page gallery thumbnail and no preview.
    checkDerivative(record, delivery.thumbnail, "thumbnail", derivativeProfiles.thumbnail);
    if (delivery.preview) issues.push(`${record.id}: PDF originals may publish only a first-page thumbnail`);
  } else if (delivery.thumbnail || delivery.preview) {
    issues.push(`${record.id}: originals other than images and PDFs may not publish image derivatives`);
  }
}

for (const delivery of inventory.records || []) {
  if (!approvedById.has(delivery.id)) issues.push(`${delivery.id}: inventory entry is not an approved viewer record`);
}

if (issues.length) {
  console.error(`viewer Blob inventory check failed:\n- ${issues.join("\n- ")}`);
  process.exit(1);
}

const derivativeCount = inventory.records.reduce((count, record) => count + Number(Boolean(record.thumbnail)) + Number(Boolean(record.preview)), 0);
const pendingCount = approved.filter((record) => !deliveryById.has(record.id) && pendingPublicationIds.has(record.id)).length;
console.log(`viewer Blob inventory ok: ${inventory.records.length} originals, ${derivativeCount} derivatives, ${pendingCount} pending upload(s)`);

function readPendingPublicationIds() {
  const targetRoot = new URL("../evidence/acquisition/targets/", import.meta.url);
  return new Set(fs.readdirSync(targetRoot)
    .filter((filename) => filename.endsWith(".json"))
    .map((filename) => JSON.parse(fs.readFileSync(new URL(filename, targetRoot), "utf8")))
    .filter((target) => target.viewerPublishState === "pending-upload")
    .map((target) => target.id));
}

function checkDerivative(record, descriptor, variant, profile) {
  checkObject(record, descriptor, variant, {
    blobPath: `records/${record.id}/${profile.pathname}`,
    mediaType: "image/webp",
    profile: profile.id
  });
  if (!descriptor) return;
  if (!Number.isInteger(descriptor.width) || descriptor.width < 1 || descriptor.width > profile.width) {
    issues.push(`${record.id}: ${variant} has invalid width`);
  }
  if (!Number.isInteger(descriptor.height) || descriptor.height < 1 || descriptor.height > profile.height) {
    issues.push(`${record.id}: ${variant} has invalid height`);
  }
}

function checkObject(record, descriptor, variant, expected) {
  if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)) {
    issues.push(`${record.id}: missing ${variant} object metadata`);
    return;
  }
  for (const [field, value] of Object.entries(expected)) {
    if (descriptor[field] !== value) issues.push(`${record.id}: ${variant} ${field} does not match its source record`);
  }
  if (!Number.isInteger(descriptor.length) || descriptor.length < 1) issues.push(`${record.id}: ${variant} has invalid byte length`);
  if (!/^[a-f0-9]{64}$/.test(descriptor.sha256 || "")) issues.push(`${record.id}: ${variant} has invalid SHA-256`);
  if (typeof descriptor.etag !== "string" || !descriptor.etag) issues.push(`${record.id}: ${variant} has no Blob ETag`);
  if (typeof descriptor.blobPath === "string") {
    if (!descriptor.blobPath.startsWith(`records/${record.id}/`) || descriptor.blobPath.includes("..") || /[\\?#]/.test(descriptor.blobPath)) {
      issues.push(`${record.id}: ${variant} has an unsafe Blob path`);
    }
    if (paths.has(descriptor.blobPath)) issues.push(`${record.id}: duplicate Blob path ${descriptor.blobPath}`);
    paths.add(descriptor.blobPath);
  }
}
