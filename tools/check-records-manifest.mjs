#!/usr/bin/env node

import fs from "node:fs";
import { validateTitlePresentation } from "./source-person-links.mjs";

const manifestPath = new URL("../evidence/records-manifest.json", import.meta.url);
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const recoveryQueue = JSON.parse(fs.readFileSync(new URL("../evidence/record-recovery-queue.json", import.meta.url), "utf8"));
const familySearchRecoveryQueue = JSON.parse(fs.readFileSync(new URL("../evidence/familysearch-recovery-queue.json", import.meta.url), "utf8"));
const subscriptionQueue = JSON.parse(fs.readFileSync(new URL("../evidence/subscription-records-queue.json", import.meta.url), "utf8"));
const family = JSON.parse(fs.readFileSync(new URL("../data/family/people.json", import.meta.url), "utf8"));
const sourceAtoms = JSON.parse(fs.readFileSync(new URL("../evidence/source-atoms.json", import.meta.url), "utf8"));
const personIds = new Set(family.people.map((person) => person.id));
const atomsById = new Map(sourceAtoms.atoms.map((atom) => [atom.id, atom]));
const issues = [];
const storageKinds = new Set(["git-lfs", "local-pending-encrypted-archive", "encrypted-external"]);
const privacyLevels = new Set(["restricted", "public", "private"]);
// A TIFF master is shown only through its generated web previews (browsers cannot draw TIFF).
const viewerMediaTypes = new Set(["image/jpeg", "image/png", "image/webp", "image/tiff", "application/pdf"]);

if (manifest.schemaVersion !== 1) {
  issues.push(`unsupported schemaVersion: ${manifest.schemaVersion}`);
}
if (!Array.isArray(manifest.records)) {
  issues.push("records must be an array");
}

const ids = new Set();
for (const record of manifest.records || []) {
  if (!record.id || typeof record.id !== "string") {
    issues.push("record is missing an id");
  } else if (ids.has(record.id)) {
    issues.push(`duplicate record id: ${record.id}`);
  } else {
    ids.add(record.id);
  }
  for (const field of ["source", "reference", "acquiredAt", "mediaType", "rights"]) {
    if (!record[field] || typeof record[field] !== "string") {
      issues.push(`record ${record.id || "(missing id)"} is missing ${field}`);
    }
  }
  if (!/^[a-f0-9]{64}$/.test(record.sha256 || "")) {
    issues.push(`record ${record.id || "(missing id)"} has an invalid sha256`);
  }
  if (!Number.isInteger(record.length) || record.length < 1) {
    issues.push(`record ${record.id || "(missing id)"} has an invalid byte length`);
  }
  if (!privacyLevels.has(record.privacy)) {
    issues.push(`record ${record.id || "(missing id)"} has invalid privacy: ${record.privacy}`);
  }
  if (!storageKinds.has(record.storage)) {
    issues.push(`record ${record.id || "(missing id)"} has invalid storage: ${record.storage}`);
  }
  if (record.storage === "git-lfs" && record.privacy !== "public") {
    issues.push(`record ${record.id} may use git-lfs only after public/rights clearance`);
  }
  if (record.people !== undefined && (!Array.isArray(record.people)
    || record.people.some((personId) => typeof personId !== "string" || !personId))) {
    issues.push(`record ${record.id} has invalid people links`);
  } else if (record.people?.some((personId) => !personIds.has(personId))) {
    issues.push(`record ${record.id} links an unknown person`);
  }
  if (record.viewer !== undefined) {
    const viewer = record.viewer;
    const sourceAtom = atomsById.get(record.sourceAtomId);
    if (!viewer || typeof viewer !== "object" || Array.isArray(viewer)) {
      issues.push(`record ${record.id} has invalid viewer configuration`);
      continue;
    }
    for (const field of ["category", "blobPath", "approvedAt"]) {
      if (!viewer[field] || typeof viewer[field] !== "string") {
        issues.push(`record ${record.id} viewer configuration is missing ${field}`);
      }
    }
    if (Array.isArray(sourceAtom?.personLinks) && !viewer.titleMode) {
      issues.push(`record ${record.id} has structured source names but still uses a manual viewer title`);
    }
    if (viewer.titleMode && !Array.isArray(sourceAtom?.personLinks)) {
      issues.push(`record ${record.id} structured viewer title requires structured source person links`);
    }
    if (viewer.titleMode) {
      if (viewer.title !== undefined) issues.push(`record ${record.id} structured viewer title cannot retain a manual title`);
      const titleIssues = validateTitlePresentation(viewer, atomsById, new Set(record.people || []));
      for (const issue of titleIssues) issues.push(`record ${record.id} ${issue}`);
      for (const principal of viewer.titlePrincipals || []) {
        if (principal.sourceAtomId !== record.sourceAtomId) {
          issues.push(`record ${record.id} title principal must use its own source atom`);
        }
      }
    } else if (!viewer.title || typeof viewer.title !== "string") {
      issues.push(`record ${record.id} legacy viewer configuration is missing title`);
    }
    if (viewer.approved !== true || record.rights !== "family-viewer-approved" || record.privacy === "restricted") {
      issues.push(`record ${record.id} is not approved for the family viewer`);
    }
    if (!Array.isArray(record.people)) {
      issues.push(`record ${record.id} viewer configuration requires a people array (empty means all-files only)`);
    }
    if (!viewerMediaTypes.has(record.mediaType)) {
      issues.push(`record ${record.id} has unsupported viewer media type: ${record.mediaType}`);
    }
    const requiredPrefix = `records/${record.id}/`;
    if (typeof viewer.blobPath === "string" && !validBlobPath(viewer.blobPath, requiredPrefix)) {
      issues.push(`record ${record.id} blobPath must begin with ${requiredPrefix}`);
    }
    if (viewer.thumbnailBlobPath !== undefined
      && (typeof viewer.thumbnailBlobPath !== "string" || !validBlobPath(viewer.thumbnailBlobPath, requiredPrefix))) {
      issues.push(`record ${record.id} has invalid thumbnailBlobPath`);
    }

  }
}

for (const target of recoveryQueue.targets || []) {
  if (target.status === "acquired" && !ids.has(target.id)) {
    issues.push(`recovery target ${target.id} is acquired but missing from the records manifest`);
  }
}
for (const target of familySearchRecoveryQueue.targets || []) {
  if (target.status === "acquired" && !ids.has(target.id)) {
    issues.push(`FamilySearch recovery target ${target.id} is acquired but missing from the records manifest`);
  }
  const record = manifest.records.find((item) => item.id === target.id);
  if (target.status === "acquired" && record) {
    if (target.sha256 !== record.sha256 || target.length !== record.length) {
      issues.push(`FamilySearch recovery target ${target.id} disagrees with the records manifest`);
    }
    if (target.viewerPublishState === "published" && !record.viewer) {
      issues.push(`published FamilySearch target ${target.id} is missing its viewer projection`);
    }
    if (record.viewer && target.viewer && target.viewerPublishState !== "published") {
      issues.push(`FamilySearch target ${target.id} has a viewer projection but is not marked published`);
    }
  }
}
for (const target of subscriptionQueue.targets || []) {
  if (["acquired", "published"].includes(target.status) && !ids.has(target.id)) {
    issues.push(`subscription target ${target.id} is ${target.status} but missing from the records manifest`);
  }
  if (target.viewerPublishState === "published" && !manifest.records.find((record) => record.id === target.id)?.viewer) {
    issues.push(`published subscription target ${target.id} is missing its viewer projection`);
  }
}

if (issues.length) {
  console.error(`records manifest check failed:\n- ${issues.join("\n- ")}`);
  process.exit(1);
}

console.log(`records manifest ok: ${ids.size} record entries`);

function validBlobPath(value, requiredPrefix) {
  return value.startsWith(requiredPrefix)
    && !value.includes("..")
    && !/[\\?#]/.test(value);
}
