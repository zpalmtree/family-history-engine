#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { del } from "@vercel/blob";
import { writeJsonAtomic } from "./atomic-json.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const queuePath = path.join(root, "evidence", "subscription-records-queue.json");
const queue = JSON.parse(fs.readFileSync(queuePath, "utf8"));
const publishedControls = (queue.targets || []).filter((target) =>
  target.status === "acquired"
  && target.publishEligible === false
  && target.viewerPublishState === "published");

for (const target of publishedControls) {
  await del(blobPath(target));
  target.viewerPublishState = "withheld-control";
  target.viewerUnpublishedAt = new Date().toISOString().slice(0, 10);
  writeJsonAtomic(queuePath, queue);
  console.log(`removed candidate/control Blob object for ${target.id}`);
}

if (!publishedControls.length) console.log("no published subscription controls require removal");

function blobPath(target) {
  return `records/${target.id}/original${extensionFor(target.mediaType)}`;
}

function extensionFor(mediaType) {
  if (mediaType === "application/pdf") return ".pdf";
  if (mediaType === "image/png") return ".png";
  if (mediaType === "image/webp") return ".webp";
  return ".jpg";
}
