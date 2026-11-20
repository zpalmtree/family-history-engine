#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { put } from "@vercel/blob";
import { recordArchiveRoot } from "./tree-config.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const archiveRoot = process.env.FAMILY_RECORD_ARCHIVE
  || recordArchiveRoot();
const manifest = JSON.parse(fs.readFileSync(path.join(root, "evidence", "records-manifest.json"), "utf8"));
const prefix = process.argv.includes("--familysearch") ? "familysearch-" : "";
const records = manifest.records.filter((record) => record.viewer?.approved === true
  && record.rights === "family-viewer-approved"
  && (!prefix || record.id.startsWith(prefix)));

for (const record of records) {
  const sourcePath = path.join(archiveRoot, path.basename(record.archivePath));
  const contents = fs.readFileSync(sourcePath);
  const sha256 = createHash("sha256").update(contents).digest("hex");
  if (sha256 !== record.sha256) throw new Error(`hash mismatch for ${record.id}`);
  await put(record.viewer.blobPath, contents, {
    access: "private",
    allowOverwrite: true,
    contentType: record.mediaType
  });
  console.log(`uploaded ${record.id} (${contents.length} bytes)`);
}
