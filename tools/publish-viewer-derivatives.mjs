#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { get, list, put } from "@vercel/blob";
import sharp from "sharp";
import {
  approvedViewerRecords,
  derivativeProfiles,
  inventoryById,
  readViewerBlobInventory,
  writeViewerBlobInventory
} from "./viewer-blob-inventory.mjs";
import { requestedPublishIds, selectApproved } from "./publish-selection.mjs";
import { recordArchiveRoot } from "./tree-config.mjs";

const archiveRoot = process.env.FAMILY_RECORD_ARCHIVE
  || recordArchiveRoot();
const readManifest = () => JSON.parse(fs.readFileSync(new URL("../evidence/records-manifest.json", import.meta.url), "utf8"));
const manifest = readManifest();
const inventory = readViewerBlobInventory();
const currentById = inventoryById(inventory);
const remoteByPath = await listRemoteObjects();
const records = approvedViewerRecords(manifest);
// With PUBLISH_TARGET_IDS (or --record) only those records are read, hashed and given derivatives;
// every other inventory entry is kept as it stands. With no selection every approved record is checked.
const selected = selectApproved(records, requestedPublishIds());
const batchSize = 4;
const processed = new Map(); // rows this run has produced

for (let index = 0; index < selected.length; index += batchSize) {
  const batch = selected.slice(index, index + batchSize);
  const entries = await Promise.all(batch.map((record) => publishRecord(record, currentById.get(record.id))));
  for (const entry of entries) { currentById.set(entry.id, entry); processed.set(entry.id, entry); }
  // Another session may be publishing its own records at the same time. Merge this run's rows into
  // the inventory as it stands on disk now, and prune against the manifest as it stands now, so a
  // long run cannot drop rows, or records, that a concurrent run added after this one started.
  const latest = inventoryById(readViewerBlobInventory());
  for (const [id, entry] of processed) latest.set(id, entry);
  const approvedNow = new Set([...records, ...approvedViewerRecords(readManifest())].map((record) => record.id));
  inventory.records = [...latest.values()].filter((entry) => approvedNow.has(entry.id));
  writeViewerBlobInventory(inventory);
}

const imageCount = selected.filter((record) => record.mediaType.startsWith("image/")).length;
const pdfCount = selected.filter((record) => record.mediaType === "application/pdf").length;
console.log(`viewer derivatives published: ${selected.length} of ${records.length} approved originals; ${imageCount * 2} image derivatives and ${pdfCount} PDF first-page thumbnails`);

async function publishRecord(record, current) {
  const sourcePath = path.join(archiveRoot, path.basename(record.archivePath || ""));
  if (!fs.existsSync(sourcePath)) throw new Error(`${record.id}: encrypted source master is missing`);
  const source = fs.readFileSync(sourcePath);
  const sourceSha256 = sha256(source);
  if (source.length !== record.length || sourceSha256 !== record.sha256) {
    throw new Error(`${record.id}: encrypted source master does not match the records manifest`);
  }

  const originalRemote = remoteByPath.get(record.viewer.blobPath);
  if (!originalRemote) throw new Error(`${record.id}: original is missing from private Blob storage`);
  if (originalRemote.size !== record.length) throw new Error(`${record.id}: remote original byte length does not match the records manifest`);

  const entry = {
    id: record.id,
    sourceSha256,
    original: {
      blobPath: record.viewer.blobPath,
      mediaType: record.mediaType,
      length: record.length,
      sha256: record.sha256,
      etag: originalRemote.etag
    }
  };
  // A PDF gets a gallery thumbnail of its first page only; the record viewer
  // keeps opening the PDF itself, so it has no preview variant.
  if (record.mediaType === "application/pdf") {
    entry.thumbnail = await ensureDerivative(record, renderPdfFirstPage(sourcePath, record.id), "thumbnail", current?.thumbnail);
    return entry;
  }
  if (!record.mediaType.startsWith("image/")) return entry;

  entry.thumbnail = await ensureDerivative(record, source, "thumbnail", current?.thumbnail);
  entry.preview = await ensureDerivative(record, source, "preview", current?.preview);
  return entry;
}

async function ensureDerivative(record, source, variant, current) {
  const profile = derivativeProfiles[variant];
  const blobPath = `records/${record.id}/${profile.pathname}`;
  const rendered = await sharp(source)
    .rotate()
    .resize({ width: profile.width, height: profile.height, fit: "inside", withoutEnlargement: true })
    .webp({ quality: profile.quality, effort: 6, smartSubsample: true })
    .toBuffer({ resolveWithObject: true });
  const descriptor = {
    profile: profile.id,
    blobPath,
    mediaType: "image/webp",
    width: rendered.info.width,
    height: rendered.info.height,
    length: rendered.data.length,
    sha256: sha256(rendered.data)
  };
  const remote = remoteByPath.get(blobPath);
  if (current
    && current.profile === descriptor.profile
    && current.sha256 === descriptor.sha256
    && current.length === descriptor.length
    && remote?.size === descriptor.length
    && remote.etag === current.etag) {
    return { ...descriptor, etag: current.etag };
  }

  const uploaded = await put(blobPath, rendered.data, {
    access: "private",
    allowOverwrite: true,
    contentType: descriptor.mediaType,
    cacheControlMaxAge: 30 * 24 * 60 * 60
  });
  const verified = await verifyUploadedObject(blobPath, descriptor);
  console.log(`published ${record.id} ${variant} (${descriptor.length} bytes)`);
  return { ...descriptor, etag: verified.etag || uploaded.etag };
}

// Renders page 1 with poppler's pdftoppm into a private temporary folder,
// large enough for the thumbnail profile, and removes the pixels at once.
function renderPdfFirstPage(sourcePath, recordId) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "viewer-pdf-thumb-"));
  try {
    const target = path.join(folder, "page");
    execFileSync("pdftoppm", ["-f", "1", "-l", "1", "-scale-to", String(derivativeProfiles.thumbnail.width), "-png", "-singlefile", sourcePath, target], { stdio: ["ignore", "ignore", "pipe"] });
    return fs.readFileSync(`${target}.png`);
  } catch (error) {
    throw new Error(`${recordId}: could not render the PDF's first page (${String(error.stderr || error.message).trim()})`);
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
}

async function verifyUploadedObject(blobPath, expected) {
  const result = await get(blobPath, { access: "private", useCache: false });
  if (!result || result.statusCode !== 200 || !result.stream) throw new Error(`${blobPath}: uploaded derivative could not be fetched`);
  const hash = createHash("sha256");
  let length = 0;
  for await (const chunk of result.stream) {
    hash.update(chunk);
    length += chunk.byteLength;
  }
  if (length !== expected.length || hash.digest("hex") !== expected.sha256) {
    throw new Error(`${blobPath}: uploaded derivative failed byte-for-byte verification`);
  }
  return result.blob;
}

async function listRemoteObjects() {
  const objects = new Map();
  let cursor;
  do {
    const page = await list({ prefix: "records/", cursor, limit: 1_000 });
    for (const blob of page.blobs) objects.set(blob.pathname, blob);
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return objects;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
