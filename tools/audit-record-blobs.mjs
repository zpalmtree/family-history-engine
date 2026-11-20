#!/usr/bin/env node

import { createHash } from "node:crypto";
import { get, list } from "@vercel/blob";
import { expectedBlobObjects, readViewerBlobInventory } from "./viewer-blob-inventory.mjs";

const inventory = readViewerBlobInventory();
const requestedRecord = valueAfter("--record");
if (requestedRecord && !(inventory.records || []).some((record) => record.id === requestedRecord)) {
  throw new Error(`unknown viewer record: ${requestedRecord}`);
}
const allExpected = expectedBlobObjects(inventory);
const allObjectByteAudit = process.argv.includes("--full");
if (allObjectByteAudit && requestedRecord) {
  throw new Error("choose either --record for a targeted byte audit or --full for every object, not both");
}
if (allObjectByteAudit && !process.argv.includes("--acknowledge-fast-origin-transfer")) {
  const bytes = allExpected.reduce((total, object) => total + object.length, 0);
  const mebibytes = (bytes / 1024 / 1024).toFixed(1);
  throw new Error(`refusing an unacknowledged all-object byte audit (${allExpected.length} objects, approximately ${mebibytes} MiB of Fast Origin Transfer). Use the metadata-only audit by default or --record <id> for changed records. A deliberately authorized baseline additionally requires --acknowledge-fast-origin-transfer`);
}
const fullAudit = allObjectByteAudit || Boolean(requestedRecord);
const expected = allExpected
  .filter((object) => !requestedRecord || object.recordId === requestedRecord);
const expectedByPath = new Map(expected.map((object) => [object.blobPath, object]));
const remoteByPath = new Map();
let cursor;

do {
  const page = await list({ prefix: "records/", cursor, limit: 1_000 });
  for (const blob of page.blobs) remoteByPath.set(blob.pathname, blob);
  cursor = page.hasMore ? page.cursor : undefined;
} while (cursor);

const failures = [];
for (const object of expected) {
  const listed = remoteByPath.get(object.blobPath);
  if (!listed) {
    failures.push(`${object.recordId} ${object.variant}: missing remote object ${object.blobPath}`);
    continue;
  }
  if (listed.size !== object.length) failures.push(`${object.recordId} ${object.variant}: remote byte length mismatch`);
  if (listed.etag !== object.etag) failures.push(`${object.recordId} ${object.variant}: remote ETag mismatch`);
  if (fullAudit) await verifyBytes(object);
}

if (!requestedRecord) {
  for (const pathname of remoteByPath.keys()) {
    if (!expectedByPath.has(pathname)) failures.push(`unexpected remote object: ${pathname}`);
  }
}

console.log(`Blob ${fullAudit ? "byte" : "inventory"} audit: ${expected.length} expected objects; ${remoteByPath.size} remote record objects.`);
if (failures.length) {
  for (const failure of failures) console.error(`ERROR ${failure}`);
  process.exitCode = 1;
} else {
  console.log(fullAudit
    ? "Every selected private Blob object matches its recorded byte length, SHA-256, and ETag."
    : "Every private Blob object matches its recorded path, byte length, and ETag.");
}

async function verifyBytes(object) {
  const result = await get(object.blobPath, { access: "private", useCache: false });
  if (!result || result.statusCode !== 200 || !result.stream) {
    failures.push(`${object.recordId} ${object.variant}: private object could not be fetched`);
    return;
  }
  const hash = createHash("sha256");
  let length = 0;
  for await (const chunk of result.stream) {
    hash.update(chunk);
    length += chunk.byteLength;
  }
  if (length !== object.length) failures.push(`${object.recordId} ${object.variant}: fetched byte length mismatch`);
  if (hash.digest("hex") !== object.sha256) failures.push(`${object.recordId} ${object.variant}: SHA-256 mismatch`);
}

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
