#!/usr/bin/env node

// Uploads public source masters awaiting private viewer publication.
//
// The canonical acquisition target decides whether a record awaits upload and
// the manifest record supplies its custody and verified people; the legacy
// record-recovery-queue.json only scopes which records belong here (see
// public-record-publication.mjs). After upload this writes the canonical
// target, the queue entry and the manifest viewer block itself, so the
// stale-copy import step is not needed to finish publication.

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { put } from "@vercel/blob";
import { writeJsonAtomic } from "./atomic-json.mjs";
import { blobPathFor, manifestViewerFor, publicationFacts, queueFieldsFromManifest, selectPendingPublicRecords } from "./public-record-publication.mjs";
import { requestedPublishIds, selectRequested } from "./publish-selection.mjs";
import { writeRegistryAtomic } from "./registry-write.mjs";
import { recordArchiveRoot } from "./tree-config.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const queuePath = path.join(root, "evidence", "record-recovery-queue.json");
const manifestPath = path.join(root, "evidence", "records-manifest.json");
const targetsDir = path.join(root, "evidence", "acquisition", "targets");
const archiveRoot = process.env.FAMILY_RECORD_ARCHIVE
  || recordArchiveRoot();
const queue = JSON.parse(fs.readFileSync(queuePath, "utf8"));
const queueBase = structuredClone(queue);
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const manifestBase = structuredClone(manifest);
const sourceAtoms = JSON.parse(fs.readFileSync(path.join(root, "evidence", "source-atoms.json"), "utf8"));
const atomsById = new Map(sourceAtoms.atoms.map((atom) => [atom.id, atom]));
const canonicalTargets = new Map();
for (const item of queue.targets || []) {
  const file = path.join(targetsDir, `${item.id}.json`);
  if (fs.existsSync(file)) canonicalTargets.set(item.id, JSON.parse(fs.readFileSync(file, "utf8")));
}
const manifestRecords = new Map((manifest.records || []).map((record) => [record.id, record]));
const { selected: pending, skipped } = selectRequested(
  selectPendingPublicRecords({ queueTargets: queue.targets || [], canonicalTargets, manifestRecords }),
  requestedPublishIds());
if (skipped.length) console.log(`left for their owners (not requested): ${skipped.join(", ")}`);

for (const entry of pending) {
  const target = { id: entry.id, atomId: entry.item.atomId, ...publicationFacts(entry) };
  if (target.rights !== "family-viewer-approved") {
    throw new Error(`refusing to publish ${target.id}: normalize documented public-domain or provider permission to family-viewer-approved before upload`);
  }
  if (!target.peopleVerifiedAt || !target.peopleVerificationBasis) {
    throw new Error(`refusing to publish ${target.id}: visually verify the original and record its exact named family people first`);
  }
  const atom = atomsById.get(target.atomId || target.id);
  if (!Array.isArray(atom?.personLinks) || !atom.personLinksVerifiedAt || !atom.personLinksVerificationBasis) {
    throw new Error(`refusing to publish ${target.id}: verify its structured source names and identity links first`);
  }
  entry.facts = target;
}

for (const entry of pending) {
  const target = entry.facts;
  const sourcePath = path.join(archiveRoot, target.archiveFile);
  const contents = fs.readFileSync(sourcePath);
  const sha256 = createHash("sha256").update(contents).digest("hex");
  if (sha256 !== target.sha256) throw new Error(`hash mismatch for ${target.id}`);
  if (contents.length !== target.length) throw new Error(`byte-length mismatch for ${target.id}`);
  await put(blobPathFor(target.id, target.mediaType), contents, {
    access: "private",
    allowOverwrite: true,
    contentType: target.mediaType
  });
  const publishedAt = new Date().toISOString().slice(0, 10);
  const viewer = manifestViewerFor(entry, publishedAt);
  Object.assign(entry.item, queueFieldsFromManifest(entry.record), { viewerPublishState: "published", viewerPublishedAt: publishedAt, viewer });
  writeRegistryAtomic(queuePath, queueBase, queue);
  entry.record.viewer = viewer;
  writeRegistryAtomic(manifestPath, manifestBase, manifest);
  const canonicalPath = path.join(targetsDir, `${target.id}.json`);
  if (fs.existsSync(canonicalPath)) {
    const canonical = JSON.parse(fs.readFileSync(canonicalPath, "utf8"));
    canonical.viewerPublishState = "published";
    canonical.viewerPublishedAt = publishedAt;
    const route = (canonical.routes || []).find((candidate) => candidate.id === target.id);
    if (route) route.status = "published";
    writeJsonAtomic(canonicalPath, canonical);
  }
  console.log(`uploaded ${target.id} (${contents.length} bytes)`);
}

if (!pending.length) console.log("no pending public source masters to publish");
