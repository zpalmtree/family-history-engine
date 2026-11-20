#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { put } from "@vercel/blob";
import { writeJsonAtomic } from "./atomic-json.mjs";
import { recordArchiveRoot } from "./tree-config.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const archiveRoot = path.resolve(process.env.FAMILY_RECORD_ARCHIVE
  || recordArchiveRoot());

const recordIndex = process.argv.indexOf("--record");
const recordId = recordIndex >= 0 ? process.argv[recordIndex + 1] : undefined;
if (!recordId || !/^[a-z0-9][a-z0-9-]*$/.test(recordId)) {
  throw new Error("usage: publish-approved-record.mjs --record <record-id>");
}

const targetPath = path.join(root, "evidence", "acquisition", "targets", `${recordId}.json`);
if (!fs.existsSync(targetPath)) throw new Error(`missing canonical acquisition target ${recordId}`);
const target = JSON.parse(fs.readFileSync(targetPath, "utf8"));
if (target.id !== recordId) throw new Error(`target id mismatch for ${recordId}`);
if (target.rights !== "family-viewer-approved" || target.desiredArtifact?.publishEligible !== true) {
  throw new Error(`refusing to publish ${recordId}: canonical target lacks private-viewer approval`);
}
if (target.viewerPublishState === "published") {
  console.log(`${recordId} is already published`);
  process.exit(0);
}
if (target.viewerPublishState !== "pending-upload") {
  throw new Error(`refusing to publish ${recordId}: viewer state is ${target.viewerPublishState || "unset"}`);
}
if (!target.archiveFile || path.basename(target.archiveFile) !== target.archiveFile) {
  throw new Error(`refusing to publish ${recordId}: invalid archive filename`);
}
if (!target.peopleVerifiedAt || !target.peopleVerificationBasis) {
  throw new Error(`refusing to publish ${recordId}: canonical target lacks completed visual person-link verification`);
}

const manifest = JSON.parse(fs.readFileSync(path.join(root, "evidence", "records-manifest.json"), "utf8"));
const record = manifest.records.find((candidate) => candidate.id === recordId);
if (!record) throw new Error(`missing records-manifest entry for ${recordId}`);
if (record.rights !== "family-viewer-approved" || record.viewer?.approved !== true) {
  throw new Error(`refusing to publish ${recordId}: manifest lacks private-viewer approval`);
}
for (const field of ["sha256", "length", "mediaType"]) {
  if (record[field] !== target[field]) throw new Error(`${field} mismatch between target and manifest for ${recordId}`);
}
if (path.basename(record.archivePath || "") !== target.archiveFile) {
  throw new Error(`archive filename mismatch between target and manifest for ${recordId}`);
}
const extension = path.extname(target.archiveFile).toLowerCase();
const expectedBlobPath = `records/${recordId}/original${extension}`;
if (record.viewer?.blobPath !== expectedBlobPath) {
  throw new Error(`refusing to publish ${recordId}: blob path is not the deterministic record path`);
}

const sourceAtoms = JSON.parse(fs.readFileSync(path.join(root, "evidence", "source-atoms.json"), "utf8"));
const atom = sourceAtoms.atoms.find((candidate) => candidate.id === (record.sourceAtomId || record.id));
if (!Array.isArray(atom?.personLinks) || !atom.personLinks.length
  || !atom.personLinksVerifiedAt || !atom.personLinksVerificationBasis) {
  throw new Error(`refusing to publish ${recordId}: structured source person links are not verified`);
}
const atomPeople = [...new Set(atom.personLinks.map((link) => link.personId).filter(Boolean))].sort();
const manifestPeople = [...new Set(record.people || [])].sort();
if (JSON.stringify(atomPeople) !== JSON.stringify(manifestPeople)) {
  throw new Error(`refusing to publish ${recordId}: source and manifest person sets disagree`);
}

const sourcePath = path.resolve(archiveRoot, target.archiveFile);
if (!sourcePath.startsWith(`${archiveRoot}${path.sep}`)) throw new Error(`archive path escapes the configured root for ${recordId}`);
const contents = fs.readFileSync(sourcePath);
const sha256 = createHash("sha256").update(contents).digest("hex");
if (sha256 !== target.sha256) throw new Error(`hash mismatch for ${recordId}`);
if (contents.length !== target.length) throw new Error(`byte-length mismatch for ${recordId}`);

await put(expectedBlobPath, contents, {
  access: "private",
  allowOverwrite: true,
  contentType: target.mediaType
});

const publishedAt = new Date().toISOString().slice(0, 10);
target.viewerPublishState = "published";
target.viewerPublishedAt = publishedAt;
const route = (target.routes || []).find((candidate) => candidate.id === recordId);
if (route) route.status = "published";
writeJsonAtomic(targetPath, target);
console.log(`uploaded ${recordId} (${contents.length} bytes)`);
