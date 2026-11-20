#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { put } from "@vercel/blob";
import { writeJsonAtomic } from "./atomic-json.mjs";
import { recordArchiveRoot } from "./tree-config.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const queuePath = path.join(root, "evidence", "familysearch-recovery-queue.json");
const archiveRoot = process.env.FAMILY_RECORD_ARCHIVE
  || recordArchiveRoot();
const queue = JSON.parse(fs.readFileSync(queuePath, "utf8"));
const sourceAtoms = JSON.parse(fs.readFileSync(path.join(root, "evidence", "source-atoms.json"), "utf8"));
const atomsById = new Map(sourceAtoms.atoms.map((atom) => [atom.id, atom]));
const pending = queue.targets.filter((target) => target.status === "acquired"
  && target.viewer
  && target.viewerPublishState === "pending-upload");

for (const target of pending) {
  if (!target.peopleVerifiedAt || !target.peopleVerificationBasis) {
    throw new Error(`refusing to publish ${target.id}: visually verify the original and record its exact named family people first`);
  }
  const atom = atomsById.get(target.atomId || target.id);
  if (!Array.isArray(atom?.personLinks) || !atom.personLinksVerifiedAt || !atom.personLinksVerificationBasis) {
    throw new Error(`refusing to publish ${target.id}: verify its structured source names and identity links first`);
  }
}

for (const target of pending) {
  const sourcePath = path.join(archiveRoot, target.archiveFile);
  const contents = fs.readFileSync(sourcePath);
  const sha256 = createHash("sha256").update(contents).digest("hex");
  if (sha256 !== target.sha256) throw new Error(`hash mismatch for ${target.id}`);
  if (contents.length !== target.length) throw new Error(`byte-length mismatch for ${target.id}`);
  await put(`records/${target.id}/original.jpg`, contents, {
    access: "private",
    allowOverwrite: true,
    contentType: target.mediaType
  });
  target.viewerPublishState = "published";
  target.viewerPublishedAt = new Date().toISOString().slice(0, 10);
  writeJsonAtomic(queuePath, queue);
  const canonicalPath = path.join(root, "evidence", "acquisition", "targets", `${target.id}.json`);
  if (fs.existsSync(canonicalPath)) {
    const canonical = JSON.parse(fs.readFileSync(canonicalPath, "utf8"));
    canonical.viewerPublishState = "published";
    canonical.viewerPublishedAt = target.viewerPublishedAt;
    const route = (canonical.routes || []).find((candidate) => candidate.id === target.id);
    if (route) route.status = "published";
    writeJsonAtomic(canonicalPath, canonical);
  }
  console.log(`uploaded ${target.id} (${contents.length} bytes)`);
}

if (!pending.length) console.log("no pending FamilySearch source masters to publish");
