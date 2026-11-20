#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { del, list } from "@vercel/blob";
import { writeJsonAtomic } from "./atomic-json.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requestedIds = valuesAfter("--target");
const all = process.argv.includes("--all");
if ((!requestedIds.length && !all) || requestedIds.length && all) {
  throw new Error("usage: --target <withheld-record-id>... | --all");
}

const manifest = JSON.parse(fs.readFileSync(path.join(root, "evidence", "records-manifest.json"), "utf8"));
const queueFiles = [
  "evidence/record-recovery-queue.json",
  "evidence/familysearch-recovery-queue.json",
  "evidence/subscription-records-queue.json"
];
const queues = queueFiles.map((relativePath) => ({
  path: path.join(root, relativePath),
  data: JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"))
}));
const targetById = new Map(queues.flatMap((queue) =>
  (queue.data.targets || []).map((target) => [target.id, { target, queue }])));
const selected = all
  ? [...targetById.values()].filter(({ target }) =>
      target.viewerPublishState === "withheld-control" && target.publishEligible === false)
  : requestedIds.map((id) => {
      const entry = targetById.get(id);
      if (!entry) throw new Error(`unknown record target: ${id}`);
      return entry;
    });

for (const { target, queue } of selected) {
  if (target.viewerPublishState !== "withheld-control" || target.publishEligible !== false) {
    throw new Error(`record is not a withheld control: ${target.id}`);
  }
  const record = manifest.records.find((item) => item.id === target.id);
  if (record?.viewer) throw new Error(`withheld record still has a viewer projection: ${target.id}`);
  const prefix = `records/${target.id}/`;
  const paths = await blobPaths(prefix);
  if (paths.length) await del(paths);
  target.viewerUnpublishedAt = new Date().toISOString().slice(0, 10);
  writeJsonAtomic(queue.path, queue.data);
  console.log(`removed ${paths.length} private Blob object(s) for withheld record ${target.id}`);
}

if (!selected.length) console.log("no withheld records require private Blob cleanup");

async function blobPaths(prefix) {
  const paths = [];
  let cursor;
  do {
    const page = await list({ prefix, cursor, limit: 1_000 });
    paths.push(...page.blobs.map((blob) => blob.pathname));
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return paths;
}

function valuesAfter(flag) {
  const values = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === flag && process.argv[index + 1]) values.push(process.argv[index + 1]);
  }
  return [...new Set(values)];
}
