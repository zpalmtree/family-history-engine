#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { writeJsonAtomic } from "./atomic-json.mjs";
import { subscriptionRegistrationRouteId, verifiedFindmypastBrowseRoute } from "./subscription-registration-route.mjs";
import { writeRegistryAtomic } from "./registry-write.mjs";
import { recordArchiveRoot } from "./tree-config.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const queuePath = path.join(projectRoot, "evidence", "subscription-records-queue.json");
const manifestPath = path.join(projectRoot, "evidence", "records-manifest.json");
const archiveRoot = process.env.FAMILY_RECORD_ARCHIVE
  || recordArchiveRoot();
const targetId = valueAfter("--target");
const requestedRouteId = valueAfter("--route");
const archiveFile = valueAfter("--archive-file");
const part = Number(valueAfter("--part") || 1);

if (!targetId || !archiveFile) {
  throw new Error("usage: node tools/register-subscription-record.mjs --target <id> --archive-file <filename> [--part <number>]");
}
if (!Number.isInteger(part) || part < 1) throw new Error("--part must be a positive integer");
if (path.basename(archiveFile) !== archiveFile) {
  throw new Error("--archive-file must be a filename, not a path");
}

const queue = JSON.parse(fs.readFileSync(queuePath, "utf8"));
const queueBase = structuredClone(queue);
const baseTarget = queue.targets?.find((item) => item.id === targetId);
const canonicalTargetPath = path.join(projectRoot, "evidence", "acquisition", "targets", `${targetId}.json`);
const canonicalTarget = fs.existsSync(canonicalTargetPath)
  ? JSON.parse(fs.readFileSync(canonicalTargetPath, "utf8"))
  : null;
const routeId = canonicalTarget
  ? subscriptionRegistrationRouteId(canonicalTarget, requestedRouteId)
  : requestedRouteId || targetId;
if (!baseTarget && !canonicalTarget) throw new Error(`unknown subscription target: ${targetId}`);
if (canonicalTarget && part !== 1) {
  throw new Error("canonical subscription targets require a distinct target id for each source image");
}
const target = canonicalTarget
  ? {
      ...(baseTarget || {}),
      ...canonicalTarget,
      captureFields: canonicalTarget.captureFields || baseTarget?.captureFields,
      resultMatch: canonicalTarget.resultMatch || baseTarget?.resultMatch,
      viewer: canonicalTarget.viewer || baseTarget?.viewer,
    }
  : (part === 1 ? baseTarget : targetForPart(queue, baseTarget, part));
const sourcePath = path.join(archiveRoot, archiveFile);
if (!fs.existsSync(sourcePath)) throw new Error(`archive file not found: ${archiveFile}`);

const mediaType = mediaTypeFor(archiveFile);
const contents = fs.readFileSync(sourcePath);
const acquiredAt = new Date().toISOString().slice(0, 10);
const sha256 = createHash("sha256").update(contents).digest("hex");
if (!canonicalTarget) {
  target.archiveFile = archiveFile;
  target.mediaType = mediaType;
  target.status = "acquired";
  target.acquiredAt = acquiredAt;
  target.sha256 = sha256;
  target.length = contents.length;
  target.viewerPublishState = target.publishEligible === true
    ? target.viewerPublishState === "published" ? "published" : "pending-upload"
    : "withheld-control";
  delete target.viewerPublishedAt;
  writeRegistryAtomic(queuePath, queueBase, queue);
} else {
  registerCanonicalTarget({ target, targetPath: canonicalTargetPath, acquiredAt, sha256, mediaType, contents });
  registerCompatibilityTarget({ queue, target, acquiredAt, sha256, mediaType, contents });
  writeRegistryAtomic(queuePath, queueBase, queue);
}
console.log(`registered ${target.id}: ${archiveFile} (${contents.length} bytes, sha256 ${target.sha256})`);

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

function targetForPart(queue, base, partNumber) {
  const id = `${base.id}-part-${partNumber}`;
  let target = queue.targets.find((item) => item.id === id);
  if (target) return target;
  const {
    title: _legacyTitle,
    titleMode: _titleMode,
    titlePrincipals: _titlePrincipals,
    titleQualifier: _titleQualifier,
    ...baseViewer
  } = base.viewer;
  target = {
    ...base,
    id,
    status: "pending-subscription",
    reference: `${base.reference}, part ${partNumber}`,
    derivedFrom: base.id,
    viewer: {
      ...baseViewer,
      titleMode: "category-only",
      titleQualifier: `part ${partNumber}`,
      description: `${base.viewer.description} Part ${partNumber}.`
    }
  };
  for (const field of ["archiveFile", "mediaType", "acquiredAt", "sha256", "length", "viewerPublishState", "viewerPublishedAt"]) {
    delete target[field];
  }
  const baseIndex = queue.targets.findLastIndex((item) => item.id === base.id || item.derivedFrom === base.id);
  queue.targets.splice(baseIndex + 1, 0, target);
  return target;
}

function mediaTypeFor(filename) {
  const extension = path.extname(filename).toLowerCase();
  if ([".jpg", ".jpeg"].includes(extension)) return "image/jpeg";
  if (extension === ".png") return "image/png";
  if (extension === ".webp") return "image/webp";
  if (extension === ".pdf") return "application/pdf";
  throw new Error(`unsupported source-master extension: ${extension || "(none)"}`);
}

function registerCanonicalTarget({ target, targetPath, acquiredAt, sha256, mediaType, contents }) {
  const route = (target.routes || []).find((candidate) =>
    candidate.id === routeId
    && ((candidate.sourceQueue === "subscription-records"
      && ["Ancestry", "Findmypast"].includes(candidate.provider))
      || (candidate.sourceQueue === "archion-access" && candidate.provider === "Archion"))
    && ["pending-subscription", "ready-subscription-capture", "acquired", "published"].includes(candidate.status));
  const exactRoute = route?.provider === "Ancestry"
    ? /^https:\/\/www\.ancestry\.(?:com|co\.uk)\/(?:search\/collections\/\d+\/records\/\d+|imageviewer\/)/.test(route.sourceUrl)
    : route?.provider === "Findmypast"
      ? /^https:\/\/www\.findmypast\.(?:com|co\.uk)\/search\/results\?/.test(route.sourceUrl)
        || verifiedFindmypastBrowseRoute(target, route)
      : route?.provider === "Archion"
        ? /^https:\/\/www\.archion\.de\/de\/alle-archive\//.test(route.sourceUrl)
        : false;
  if (!route?.sourceUrl || !exactRoute) {
    throw new Error(`canonical subscription target has no exact ready provider route: ${target.id}/${routeId}`);
  }
  const sourcePath = findSourcePath(target.sourceId);
  if (!sourcePath) throw new Error(`canonical source is missing for subscription target: ${target.id}`);
  const source = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
  if (route.status !== "published") route.status = "acquired";
  target.mediaType = mediaType;
  target.acquiredAt ||= acquiredAt;
  target.sha256 = sha256;
  target.length = contents.length;
  target.viewerPublishState = route.status === "published"
    ? "published"
    : target.desiredArtifact?.publishEligible === true ? "pending-upload" : "withheld-control";
  if (source.peopleVerifiedAt && source.personLinksVerificationBasis) {
    target.peopleVerifiedAt = source.peopleVerifiedAt;
    target.peopleVerificationBasis = source.personLinksVerificationBasis;
  }
  source.scope = "preserved-record";
  source.recordId = target.id;
  writeJsonAtomic(targetPath, target);
  writeJsonAtomic(sourcePath, source);

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const manifestBase = structuredClone(manifest);
  const index = manifest.records.findIndex((record) => record.id === target.id);
  const existing = index >= 0 ? manifest.records[index] : {};
  const record = {
    ...existing,
    id: target.id,
    sourceAtomId: source.id,
    source: source.source || source.provider,
    reference: source.reference || target.reference,
    people: (source.personLinks || []).map((link) => link.personId),
    catalogueUrl: route.sourceUrl,
    acquiredAt: target.acquiredAt || acquiredAt,
    mediaType,
    sha256,
    length: contents.length,
    rights: "family-viewer-approved",
    rightsBasis: queue.rightsBasis,
    rightsConfirmedAt: queue.rightsConfirmedAt,
    privacy: "private",
    storage: "encrypted-external",
    archivePath: `FamilyHistorySourceMasters/${archiveFile}`,
    encryption: "windows-efs",
    ...(source.peopleVerifiedAt ? { peopleVerifiedAt: source.peopleVerifiedAt } : {}),
    ...(source.personLinksVerificationBasis
      ? { peopleVerificationBasis: source.personLinksVerificationBasis } : {})
  };
  delete record.viewer;
  if (index >= 0) manifest.records[index] = record;
  else manifest.records.push(record);
  writeRegistryAtomic(manifestPath, manifestBase, manifest);
}

function registerCompatibilityTarget({ queue, target, acquiredAt, sha256, mediaType, contents }) {
  const route = (target.routes || []).find((candidate) =>
    candidate.id === routeId
    && ((candidate.sourceQueue === "subscription-records"
      && ["Ancestry", "Findmypast"].includes(candidate.provider))
      || (candidate.sourceQueue === "archion-access" && candidate.provider === "Archion"))
    && ["acquired", "published"].includes(candidate.status));
  const sourcePath = findSourcePath(target.sourceId);
  const source = sourcePath ? JSON.parse(fs.readFileSync(sourcePath, "utf8")) : null;
  const publishEligible = target.desiredArtifact?.publishEligible === true;
  if (!route?.sourceUrl || !source) {
    throw new Error(`cannot project canonical subscription custody for ${target.id}`);
  }
  if (!Array.isArray(target.captureFields) || !target.captureFields.length || !target.viewer?.category
      || (!target.viewer.title && !target.viewer.titleMode)) {
    throw new Error(`canonical subscription target requires captureFields and viewer presentation: ${target.id}`);
  }

  const exactPeople = (source.personLinks || []).map((link) => link.personId);
  const compatibility = {
    id: target.id,
    routeId: route.id,
    atomId: source.id,
    provider: route.provider,
    status: route.status,
    priority: target.priority,
    source: source.source || source.provider,
    reference: source.reference || target.reference,
    catalogueUrl: route.sourceUrl,
    searchUrl: route.sourceUrl,
    people: exactPeople,
    captureFields: target.captureFields,
    captureKind: "record-image",
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
    acquiredAt: target.acquiredAt || acquiredAt,
    sha256,
    length: contents.length,
    viewerPublishState: route.status === "published"
      ? "published"
      : publishEligible ? "pending-upload" : "withheld-control",
    ...(source.peopleVerifiedAt ? { peopleVerifiedAt: source.peopleVerifiedAt } : {}),
    ...(source.personLinksVerificationBasis
      ? { peopleVerificationBasis: source.personLinksVerificationBasis } : {})
  };
  const index = queue.targets.findIndex((candidate) => candidate.id === target.id);
  if (index >= 0) queue.targets[index] = { ...queue.targets[index], ...compatibility };
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
