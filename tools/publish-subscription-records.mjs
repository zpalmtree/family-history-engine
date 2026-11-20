#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { put } from "@vercel/blob";
import { writeJsonAtomic } from "./atomic-json.mjs";
import { explicitSubscriptionProjectionRoute } from "./subscription-registration-route.mjs";
import { blobPathFor, manifestViewerFor, queueFieldsFromManifest } from "./public-record-publication.mjs";
import { requestedPublishIds, selectRequested } from "./publish-selection.mjs";
import { writeRegistryAtomic } from "./registry-write.mjs";
import { recordArchiveRoot } from "./tree-config.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const queuePath = path.join(root, "evidence", "subscription-records-queue.json");
const archiveRoot = process.env.FAMILY_RECORD_ARCHIVE
  || recordArchiveRoot();
const manifestPath = path.join(root, "evidence", "records-manifest.json");
const queue = JSON.parse(fs.readFileSync(queuePath, "utf8"));
const queueBase = structuredClone(queue);
// The manifest record carries custody and verified people; this publisher
// writes its viewer block directly so publication never needs the
// subscription import, which rebuilds every manifest record from stale
// queue copies.
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const manifestBase = structuredClone(manifest);
const manifestRecords = new Map((manifest.records || []).map((record) => [record.id, record]));
const sourceAtoms = JSON.parse(fs.readFileSync(path.join(root, "evidence", "source-atoms.json"), "utf8"));
const atomsById = new Map(sourceAtoms.atoms.map((atom) => [atom.id, atom]));
const requestedIds = requestedPublishIds();
const eligiblePending = (queue.targets || []).filter((target) => target.status === "acquired"
  && target.viewer
  && target.publishEligible === true
  && target.viewerPublishState === "pending-upload");
const { selected: pending, skipped } = selectRequested(eligiblePending, requestedIds);
if (skipped.length) console.log(`left for their owners (not requested): ${skipped.join(", ")}`);

for (const target of pending) {
  if (target.routeId) {
    const canonicalPath = path.join(root, "evidence", "acquisition", "targets", `${target.id}.json`);
    explicitSubscriptionProjectionRoute(JSON.parse(fs.readFileSync(canonicalPath, "utf8")), target);
  }
  if (!target.peopleVerifiedAt || !target.peopleVerificationBasis) {
    throw new Error(`refusing to publish ${target.id}: visually verify the original and record its exact named family people first`);
  }
  const atom = atomsById.get(target.atomId || target.id);
  if (!Array.isArray(atom?.personLinks) || !atom.personLinksVerifiedAt || !atom.personLinksVerificationBasis) {
    throw new Error(`refusing to publish ${target.id}: verify its structured source names and identity links first`);
  }
  if (!manifestRecords.has(target.id)) {
    throw new Error(`refusing to publish ${target.id}: register its source master in the records manifest first`);
  }
}

for (const target of pending) {
  const sourcePath = path.join(archiveRoot, path.basename(target.archiveFile));
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
  const record = manifestRecords.get(target.id);
  const canonicalPath = path.join(root, "evidence", "acquisition", "targets", `${target.id}.json`);
  const canonical = fs.existsSync(canonicalPath) ? JSON.parse(fs.readFileSync(canonicalPath, "utf8")) : null;
  const viewer = manifestViewerFor({ canonical, item: target, record }, publishedAt);
  Object.assign(target, queueFieldsFromManifest(record), { viewerPublishState: "published", viewerPublishedAt: publishedAt, viewer });
  writeRegistryAtomic(queuePath, queueBase, queue);
  record.viewer = viewer;
  writeRegistryAtomic(manifestPath, manifestBase, manifest);
  if (canonical) {
    canonical.viewerPublishState = "published";
    canonical.viewerPublishedAt = publishedAt;
    const route = (canonical.routes || []).find((candidate) => candidate.id === (target.routeId || target.id));
    if (route) route.status = "published";
    writeJsonAtomic(canonicalPath, canonical);
  }
  console.log(`uploaded ${target.id} (${contents.length} bytes)`);
}

if (!pending.length) console.log("no pending subscription source masters to publish");
