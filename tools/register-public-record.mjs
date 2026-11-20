#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { writeJsonAtomic } from "./atomic-json.mjs";
import { writeRegistryAtomic } from "./registry-write.mjs";
import { recordArchiveRoot } from "./tree-config.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const archiveRoot = process.env.FAMILY_RECORD_ARCHIVE
  || recordArchiveRoot();
const manifestPath = path.join(projectRoot, "evidence", "records-manifest.json");
const queuePath = path.join(projectRoot, "evidence", "record-recovery-queue.json");
const targetId = valueAfter("--target");
if (!targetId || !/^[a-z0-9][a-z0-9._-]+$/.test(targetId)) {
  throw new Error("usage: --target <canonical public-record target id>");
}

const targetPath = path.join(projectRoot, "evidence", "acquisition", "targets", `${targetId}.json`);
if (!fs.existsSync(targetPath)) throw new Error(`canonical public-record target is missing: ${targetId}`);
const target = JSON.parse(fs.readFileSync(targetPath, "utf8"));
const route = (target.routes || []).find((candidate) =>
  candidate.id === targetId
  && candidate.sourceQueue === "public-record-recovery"
  && ["ready-download", "acquired", "published"].includes(candidate.status));
if (!route?.sourceUrl || !isSafePublicUrl(route.sourceUrl)) {
  throw new Error(`canonical public-record target has no safe ready route: ${targetId}`);
}
if (!target.archiveFile || path.basename(target.archiveFile) !== target.archiveFile) {
  throw new Error(`canonical public-record target has no safe archive filename: ${targetId}`);
}

const sourcePath = findSourcePath(target.sourceId);
if (!sourcePath) throw new Error(`canonical source is missing for public-record target: ${targetId}`);
const source = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
const archivePath = path.join(archiveRoot, target.archiveFile);
if (!fs.existsSync(archivePath)) throw new Error(`public source master was not found for ${targetId}`);
const contents = fs.readFileSync(archivePath);
if (contents.length < 1_024) throw new Error(`public source master is unexpectedly small for ${targetId}`);
const mediaType = mediaTypeFor(target.archiveFile);
if (target.mediaType && target.mediaType !== mediaType) {
  throw new Error(`public source-master media type conflicts with the canonical target: ${targetId}`);
}
const acquiredAt = new Date().toISOString().slice(0, 10);
const sha256 = createHash("sha256").update(contents).digest("hex");

const alreadyPublished = route.status === "published" && target.viewerPublishState === "published";
route.status = alreadyPublished ? "published" : "acquired";
target.mediaType = mediaType;
target.acquiredAt ||= acquiredAt;
target.sha256 = sha256;
target.length = contents.length;
target.viewerPublishState = alreadyPublished
  ? "published"
  : target.desiredArtifact?.publishEligible === true
    ? "pending-upload"
    : "withheld-control";
source.scope = "preserved-record";
source.recordId = targetId;

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const manifestBase = structuredClone(manifest);
const people = (source.personLinks || [])
  .map((link) => typeof link === "string" ? link : link?.personId)
  .filter(Boolean);
const record = {
  id: targetId,
  sourceAtomId: source.id,
  source: source.source || source.provider,
  reference: source.reference || target.reference,
  people,
  catalogueUrl: route.sourceUrl,
  acquiredAt: target.acquiredAt,
  mediaType,
  sha256,
  length: contents.length,
  rights: target.rights || "archive-only-pending-provider-approval",
  rightsBasis: target.rightsBasis
    || "Publicly accessible official historical record preserved in the encrypted archive; family-viewer publication remains withheld pending a separate approval decision.",
  privacy: "private",
  storage: "encrypted-external",
  archivePath: `FamilyHistorySourceMasters/${target.archiveFile}`,
  encryption: "windows-efs",
  ...(source.peopleVerifiedAt ? { peopleVerifiedAt: source.peopleVerifiedAt } : {}),
  ...(source.personLinksVerificationBasis
    ? { peopleVerificationBasis: source.personLinksVerificationBasis } : {})
};
const index = manifest.records.findIndex((candidate) => candidate.id === targetId);
if (index >= 0) manifest.records[index] = { ...manifest.records[index], ...record };
else manifest.records.push(record);

// The public publisher still consumes the compatibility queue. Keep its entry
// synchronized when the Windows archive wrapper registers a canonical target,
// so a newly created canonical record cannot disappear from publication.
const queue = JSON.parse(fs.readFileSync(queuePath, "utf8"));
const queueBase = structuredClone(queue);
const compatibilityTarget = {
  id: targetId,
  status: "acquired",
  source: source.source || source.provider,
  reference: source.reference || target.reference,
  catalogueUrl: route.sourceUrl,
  url: route.sourceUrl,
  archiveFile: target.archiveFile,
  mediaType,
  priority: target.priority,
  rights: target.rights || record.rights,
  rightsBasis: target.rightsBasis || record.rightsBasis,
  viewer: target.viewer,
  atomId: source.id,
  people,
  sha256,
  length: contents.length,
  acquiredAt: target.acquiredAt,
  viewerPublishState: target.viewerPublishState,
  publishEligible: target.desiredArtifact?.publishEligible === true,
  ...(source.peopleVerifiedAt ? { peopleVerifiedAt: source.peopleVerifiedAt } : {}),
  ...(source.personLinksVerificationBasis
    ? { peopleVerificationBasis: source.personLinksVerificationBasis } : {})
};
const queueIndex = queue.targets.findIndex((candidate) => candidate.id === targetId);
if (queueIndex >= 0) queue.targets[queueIndex] = { ...queue.targets[queueIndex], ...compatibilityTarget };
else queue.targets.push(compatibilityTarget);

writeJsonAtomic(targetPath, target);
writeJsonAtomic(sourcePath, source);
writeRegistryAtomic(manifestPath, manifestBase, manifest);
writeRegistryAtomic(queuePath, queueBase, queue);
console.log(`registered ${targetId}: ${contents.length} bytes, sha256 ${sha256}`);

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  return index < 0 ? undefined : process.argv[index + 1];
}

function isSafePublicUrl(value) {
  try {
    const url = new URL(value);
    if (url.username || url.password) return false;
    if (url.protocol === "https:") return true;
    // TLCPL's legacy obituary server exposes provider-generated public PDFs
    // only over HTTP. Keep the exception host- and path-exact; never extend it
    // to account, cart, search, or arbitrary plaintext URLs.
    return url.protocol === "http:"
      && url.hostname === "obits.toledolibrary.org"
      && /^\/obitfiles\/\d+\/[^/]+\.pdf$/i.test(url.pathname);
  } catch {
    return false;
  }
}

function mediaTypeFor(filename) {
  const extension = path.extname(filename).toLowerCase();
  if ([".jpg", ".jpeg"].includes(extension)) return "image/jpeg";
  if ([".tif", ".tiff"].includes(extension)) return "image/tiff";
  if (extension === ".jp2") return "image/jp2";
  if (extension === ".png") return "image/png";
  if (extension === ".webp") return "image/webp";
  if (extension === ".pdf") return "application/pdf";
  throw new Error(`unsupported public source-master extension: ${extension || "(none)"}`);
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
