#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { withFileLockSync, writeJsonAtomic } from "./atomic-json.mjs";
import { recordArchiveRoot } from "./tree-config.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const queuePath = path.join(projectRoot, "evidence", "familysearch-recovery-queue.json");
const platformArchiveRoot = process.platform === "win32" && process.env.OneDrive
  ? path.join(process.env.OneDrive, "Documents", "FamilyHistorySourceMasters")
  : recordArchiveRoot();
const archiveRoot = process.env.FAMILY_RECORD_ARCHIVE || platformArchiveRoot;
const targetId = valueAfter("--target");
const requestedArchiveFile = valueAfter("--archive-file");
if (!targetId) throw new Error("usage: --target <FamilySearch recovery target id> [--archive-file <filename>]");

const queue = JSON.parse(fs.readFileSync(queuePath, "utf8"));
const baseTarget = queue.targets.find((item) => item.id === targetId);
const canonicalTargetPath = path.join(projectRoot, "evidence", "acquisition", "targets", `${targetId}.json`);
const canonicalTarget = fs.existsSync(canonicalTargetPath)
  ? JSON.parse(fs.readFileSync(canonicalTargetPath, "utf8"))
  : null;
if (!baseTarget && !canonicalTarget) throw new Error(`unknown FamilySearch target: ${targetId}`);
// The queue is a generated compatibility projection. Once a canonical target
// exists, it must remain authoritative even when the projection already has a
// row for the same id; otherwise a re-registration can preserve stale people
// or turn a withheld control into a pending upload.
const target = canonicalTarget || baseTarget;
const archiveFile = requestedArchiveFile || baseTarget?.archiveFile || canonicalTarget?.archiveFile;
if (!archiveFile || path.basename(archiveFile) !== archiveFile) throw new Error(`unsafe or missing archive filename for ${targetId}`);
const sourcePath = path.join(archiveRoot, archiveFile);
if (!fs.existsSync(sourcePath)) throw new Error(`FamilySearch source master was not found for ${targetId}`);
const contents = fs.readFileSync(sourcePath);
if (contents.length < 1_024) throw new Error(`FamilySearch source master is unexpectedly small for ${targetId}`);
const mediaType = mediaTypeFor(archiveFile);
const acquiredAt = new Date().toISOString().slice(0, 10);
const sha256 = createHash("sha256").update(contents).digest("hex");

if (canonicalTarget) {
  registerCanonicalTarget({ target, targetPath: canonicalTargetPath });
  withFileLockSync(queuePath, () => {
    const currentQueue = JSON.parse(fs.readFileSync(queuePath, "utf8"));
    registerCompatibilityTarget({ queue: currentQueue, target, acquiredAt, sha256, mediaType, contents });
    writeJsonAtomic(queuePath, currentQueue);
  });
} else {
  withFileLockSync(queuePath, () => {
    const currentQueue = JSON.parse(fs.readFileSync(queuePath, "utf8"));
    const currentTarget = currentQueue.targets.find((item) => item.id === targetId);
    if (!currentTarget) throw new Error(`FamilySearch queue target disappeared during registration: ${targetId}`);
    currentTarget.archiveFile = archiveFile;
    currentTarget.mediaType = mediaType;
    currentTarget.status = "acquired";
    currentTarget.acquiredAt ||= acquiredAt;
    currentTarget.sha256 = sha256;
    currentTarget.length = contents.length;
    currentTarget.viewerPublishState = currentTarget.viewer
      ? currentTarget.viewerPublishState === "published" ? "published" : "pending-upload"
      : "withheld-control";
    currentTarget.lastAttemptAt = new Date().toISOString();
    currentTarget.lastAttemptResult = "acquired";
    writeJsonAtomic(queuePath, currentQueue);
  });
}
console.log(`registered ${target.id}: ${contents.length} bytes, sha256 ${sha256}`);

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  return index < 0 ? undefined : process.argv[index + 1];
}

function mediaTypeFor(filename) {
  const extension = path.extname(filename).toLowerCase();
  if ([".jpg", ".jpeg"].includes(extension)) return "image/jpeg";
  if (extension === ".png") return "image/png";
  if (extension === ".webp") return "image/webp";
  if (extension === ".pdf") return "application/pdf";
  throw new Error(`unsupported source-master extension: ${extension || "(none)"}`);
}

function registerCanonicalTarget({ target, targetPath }) {
  const route = (target.routes || []).find((candidate) =>
    candidate.id === target.id
    && candidate.sourceQueue === "familysearch-recovery"
    && candidate.provider === "FamilySearch"
    && ["ready-download", "acquired", "published"].includes(candidate.status));
  if (!route?.sourceUrl || !isExactFamilySearchDownloadRoute(route.sourceUrl)) {
    throw new Error(`canonical FamilySearch target has no exact ready image route: ${target.id}`);
  }
  const sourceFile = findSourcePath(target.sourceId);
  if (!sourceFile) throw new Error(`canonical source is missing for FamilySearch target: ${target.id}`);
  const source = JSON.parse(fs.readFileSync(sourceFile, "utf8"));
  if (route.status !== "published") route.status = "acquired";
  source.scope = "preserved-record";
  source.recordId = target.id;
  writeJsonAtomic(targetPath, target);
  writeJsonAtomic(sourceFile, source);
}

function isExactFamilySearchDownloadRoute(value) {
  return /^https:\/\/www\.familysearch\.org\/ark:\/61903\/3:[12]:/.test(value)
    || /^https:\/\/www\.familysearch\.org\/en\/memories\/memory\/\d+(?:[?#].*)?$/.test(value);
}

function registerCompatibilityTarget({ queue, target, acquiredAt, sha256, mediaType, contents }) {
  const route = (target.routes || []).find((candidate) =>
    candidate.id === target.id
    && candidate.sourceQueue === "familysearch-recovery"
    && candidate.provider === "FamilySearch"
    && ["acquired", "published"].includes(candidate.status));
  const sourceFile = findSourcePath(target.sourceId);
  const source = sourceFile ? JSON.parse(fs.readFileSync(sourceFile, "utf8")) : null;
  const publishEligible = target.desiredArtifact?.publishEligible === true;
  if (!route?.sourceUrl || !source) throw new Error(`cannot project canonical FamilySearch custody for ${target.id}`);
  if (!Array.isArray(target.captureFields) || !target.captureFields.length || !target.viewer?.category
      || (!target.viewer.title && !target.viewer.titleMode)) {
    throw new Error(`canonical FamilySearch target requires captureFields and viewer presentation: ${target.id}`);
  }

  const exactPeople = (source.personLinks || []).map((link) => link.personId);
  const previous = queue.targets.find((candidate) => candidate.id === target.id);
  const compatibilityAcquiredAt = previous?.acquiredAt || target.acquiredAt || acquiredAt;
  const published = publishEligible
    && (route.status === "published" || previous?.viewerPublishState === "published");
  const compatibility = {
    id: target.id,
    atomId: source.id,
    provider: target.provider,
    status: published ? "published" : "acquired",
    priority: target.priority,
    recordUrl: route.sourceUrl,
    source: source.source || source.provider,
    reference: source.reference || target.reference,
    people: exactPeople,
    captureFields: target.captureFields,
    resultMatch: target.resultMatch || exactPeople,
    viewer: target.viewer,
    evidenceRole: publishEligible ? "direct-or-supporting" : "candidate-control",
    publishEligible,
    ...(publishEligible ? {} : {
      withholdReason: target.withholdReason
        || "Preserve for identity or comparison; do not expose as ordinary family evidence until the comparison is resolved and viewer approval is recorded."
    }),
    archiveFile,
    mediaType,
    acquiredAt: compatibilityAcquiredAt,
    sha256,
    length: contents.length,
    viewerPublishState: publishEligible ? (published ? "published" : "pending-upload") : "withheld-control",
    ...(source.personLinksVerifiedAt ? { peopleVerifiedAt: source.personLinksVerifiedAt } : {}),
    ...(source.personLinksVerificationBasis
      ? { peopleVerificationBasis: source.personLinksVerificationBasis } : {})
  };
  const index = queue.targets.findIndex((candidate) => candidate.id === target.id);
  if (index >= 0) {
    queue.targets[index] = { ...queue.targets[index], ...compatibility };
    if (publishEligible) delete queue.targets[index].withholdReason;
  }
  else queue.targets.push(compatibility);
}

function findSourcePath(sourceId) {
  const root = path.join(projectRoot, "evidence", "sources");
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(candidate);
      else if (entry.isFile() && entry.name === `${sourceId}.json`) return candidate;
    }
  }
  return null;
}
