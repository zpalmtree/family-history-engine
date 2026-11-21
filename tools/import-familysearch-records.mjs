#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { writeJsonAtomic } from "./atomic-json.mjs";
import { loadResearchStore } from "./research-store.mjs";
import { canonicalViewerPublicationApproved } from "./source-acquisition-authority.mjs";
import { writeRegistryAtomic } from "./registry-write.mjs";
import { recordArchiveRoot } from "./tree-config.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const queuePath = path.join(root, "evidence", "familysearch-recovery-queue.json");
const manifestPath = path.join(root, "evidence", "records-manifest.json");
const canonicalTargetRoot = path.join(root, "evidence", "acquisition", "targets");
const archiveRoot = process.env.FAMILY_RECORD_ARCHIVE
  || recordArchiveRoot();
const queue = JSON.parse(fs.readFileSync(queuePath, "utf8"));
const queueBase = structuredClone(queue);
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const manifestBase = structuredClone(manifest);
const recordsById = new Map(manifest.records.map((record) => [record.id, record]));
const imported = [];
const sourcesById = new Map(loadResearchStore().sources.map((source) => [source.id, source]));

for (const target of queue.targets) {
  let canonicalRouteStatus;
  let canonicalTarget;
  const canonicalTargetPath = path.join(canonicalTargetRoot, `${target.id}.json`);
  if (fs.existsSync(canonicalTargetPath)) {
    canonicalTarget = JSON.parse(fs.readFileSync(canonicalTargetPath, "utf8"));
    const canonicalRoute = (canonicalTarget.routes || []).find((route) =>
      route.id === target.id
      && route.targetId === canonicalTarget.id
      && route.provider === "FamilySearch"
      && typeof route.sourceUrl === "string");
    // The provider queue is only a compatibility projection. A corrected
    // canonical image route must replace its stale URL before the manifest is
    // rebuilt, or the next input sync will append the old image back onto the
    // canonical source as a second, incorrect locator.
    if (canonicalRoute) {
      target.recordUrl = canonicalRoute.sourceUrl;
      canonicalRouteStatus = canonicalRoute.status;
    }
    // Presentation is also canonical. Publication updates custody in both
    // stores, but later title corrections must not be hidden by a stale
    // compatibility-queue copy during the next manifest import.
    if (canonicalTarget.viewer) target.viewer = canonicalTarget.viewer;
  }
  const source = sourcesById.get(target.atomId || target.id);
  if (source) {
    target.source = source.source || source.provider || target.source;
    target.reference = source.reference || target.reference;
    if (Array.isArray(source.personLinks)) target.people = source.personLinks.map((link) => link.personId);
    target.peopleVerifiedAt = source.personLinksVerifiedAt || target.peopleVerifiedAt;
    target.peopleVerificationBasis = source.personLinksVerificationBasis || target.peopleVerificationBasis;
  }
  if (target.viewer?.titleMode) delete target.viewer.title;
  // A canonical approval (approved-private source plus a publish-eligible,
  // pending-upload target) supersedes the queue's earlier withheld-control
  // default. Project that one-way transition so the publisher selects it.
  if (target.viewerPublishState === "withheld-control"
    && canonicalTarget?.viewerPublishState === "pending-upload"
    && canonicalTarget.viewer
    && canonicalViewerPublicationApproved(source, canonicalTarget)) {
    target.viewerPublishState = "pending-upload";
    if ("publishEligible" in target) target.publishEligible = true;
    delete target.withholdReason;
  }
  const sourcePath = path.join(archiveRoot, target.archiveFile);
  if (!fs.existsSync(sourcePath)) {
    if (target.status === "acquired") {
      throw new Error(`acquired FamilySearch source master is missing: ${target.id}`);
    }
    // A queued recovery target may not project a stale manifest/viewer record
    // after its master has been withdrawn, renamed, or found misassigned.
    recordsById.delete(target.id);
    continue;
  }
  const contents = fs.readFileSync(sourcePath);
  const sha256 = createHash("sha256").update(contents).digest("hex");
  // Existing bytes do not resolve an adjudicated incomplete or withheld
  // original, and importing custody must not downgrade a published record.
  target.status = ["published", "needs-alternate-route", "preserved-withheld"].includes(canonicalRouteStatus)
    ? canonicalRouteStatus : "acquired";
  target.sha256 = sha256;
  target.length = contents.length;
  const existing = recordsById.get(target.id) || {};
  target.acquiredAt ||= existing.acquiredAt || new Date().toISOString().slice(0, 10);
  if (target.viewer) target.viewerPublishState ||= existing.viewer ? "published" : "pending-upload";
  if (target.viewerPublishState === "published") target.viewerPublishedAt ||= existing.viewer?.approvedAt || target.acquiredAt;
  const record = {
    ...existing,
    id: target.id,
    sourceAtomId: target.atomId,
    source: target.source,
    reference: target.reference,
    people: target.people,
    catalogueUrl: target.recordUrl,
    acquiredAt: target.acquiredAt,
    mediaType: target.mediaType,
    sha256,
    length: contents.length,
    peopleVerifiedAt: target.peopleVerifiedAt,
    peopleVerificationBasis: target.peopleVerificationBasis,
    rights: canonicalTarget?.rights || "family-viewer-approved",
    rightsBasis: canonicalTarget?.rightsBasis || queue.rightsBasis,
    privacy: "private",
    storage: "encrypted-external",
    archivePath: `FamilyHistorySourceMasters/${target.archiveFile}`,
    encryption: "windows-efs"
  };
  if (record.rights === "family-viewer-approved") record.rightsConfirmedAt ||= "2026-07-12";
  else delete record.rightsConfirmedAt;
  if (target.viewerPublishState === "published") {
    record.viewer = {
      approved: true,
      approvedAt: existing.viewer?.approvedAt || target.viewerPublishedAt,
      ...target.viewer,
      blobPath: `records/${target.id}/original.jpg`
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
console.log(`imported ${imported.length} FamilySearch source masters into the records manifest`);
