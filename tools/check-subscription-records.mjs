#!/usr/bin/env node

import fs from "node:fs";

const queue = JSON.parse(fs.readFileSync(new URL("../evidence/subscription-records-queue.json", import.meta.url), "utf8"));
const family = JSON.parse(fs.readFileSync(new URL("../data/family/people.json", import.meta.url), "utf8"));
const personIds = new Set(family.people.map((person) => person.id));
const allowedStatuses = new Set(["pending-subscription", "provider-alternate", "index-only-no-image", "acquired", "published", "not-found", "duplicate"]);
const mediaTypes = new Set(["image/jpeg", "image/png", "image/webp", "application/pdf"]);
const evidenceRoles = new Set(["direct-or-supporting", "candidate-control"]);
const ids = new Set();
const issues = [];

if (queue.schemaVersion !== 1 || !Array.isArray(queue.targets)) issues.push("unsupported subscription queue");
// A tree documents viewer approval once it queues subscription records, and
// documents each subscription it holds (or queues records from).
const queuedProviders = new Set(queue.targets.map((target) => String(target.provider || "").toLowerCase()).filter(Boolean));
if (queue.targets.length && (!queue.rightsBasis || !queue.rightsConfirmedAt)) issues.push("subscription queue is missing documented viewer approval");
for (const provider of ["findmypast", "ancestry"].filter((name) => queue.subscriptionAccess?.[name] || queuedProviders.has(name))) {
  const access = queue.subscriptionAccess?.[provider];
  if (!access?.plan || access.status !== "active-renewal-disabled" || !access.verifiedAt || !access.expiresAt) {
    issues.push(`${provider} subscription access is not fully documented`);
  }
}

for (const target of queue.targets || []) {
  if (!target.id || ids.has(target.id)) issues.push(`invalid or duplicate target id: ${target.id || "(missing)"}`);
  ids.add(target.id);
  for (const field of ["provider", "source", "reference", "catalogueUrl", "priority"]) {
    if (!target[field] || typeof target[field] !== "string") issues.push(`${target.id} is missing ${field}`);
  }
  if (!allowedStatuses.has(target.status)) issues.push(`${target.id} has invalid status: ${target.status}`);
  // Acquired controls may intentionally be all-files-only with an empty array;
  // non-empty arrays still have to reference known canonical people.
  if (!Array.isArray(target.people) || target.people.some((id) => !personIds.has(id))) {
    issues.push(`${target.id} has invalid person links`);
  }
  if (!evidenceRoles.has(target.evidenceRole)) issues.push(`${target.id} has invalid evidenceRole`);
  if (typeof target.publishEligible !== "boolean") issues.push(`${target.id} is missing publishEligible`);
  if (target.publishEligible === false && !target.withholdReason) issues.push(`${target.id} is withheld without a reason`);
  if ((!target.viewer?.title && !target.viewer?.titleMode) || !target.viewer?.category) {
    issues.push(`${target.id} is missing viewer metadata`);
  }
  if (!Array.isArray(target.captureFields) || !target.captureFields.length) issues.push(`${target.id} is missing capture fields`);
  try {
    const url = new URL(target.catalogueUrl);
    if (url.protocol !== "https:") issues.push(`${target.id} catalogueUrl must use HTTPS`);
  } catch {
    issues.push(`${target.id} has an invalid catalogueUrl`);
  }
  if (["acquired", "published"].includes(target.status)) {
    if (!target.archiveFile || !target.sha256 || !Number.isInteger(target.length)) issues.push(`${target.id} is missing acquired-file metadata`);
    if (!mediaTypes.has(target.mediaType)) issues.push(`${target.id} has an unsupported media type`);
  }
  if (target.viewerPublishState === "published" && target.status !== "acquired") {
    issues.push(`${target.id} has a published viewer state without an acquired source master`);
  }
  if (target.viewerPublishState === "published" && target.publishEligible !== true) {
    issues.push(`${target.id} is published but is not eligible for viewer publication`);
  }
}

if (issues.length) {
  console.error(`subscription record queue check failed:\n- ${issues.join("\n- ")}`);
  process.exit(1);
}
console.log(`subscription record queue ok: ${ids.size} targets`);
