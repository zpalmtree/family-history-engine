#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { readJson, writeJsonAtomic } from "./atomic-json.mjs";
import { recordArchiveRoot } from "./tree-config.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(root, "evidence", "records-manifest.json");
const archiveRoot = process.env.FAMILY_RECORD_ARCHIVE
  || recordArchiveRoot();
const checkOnly = process.argv.includes("--check");
const manifest = readJson(manifestPath);
const failures = [];
let changed = 0;

if (!fs.existsSync(archiveRoot)) throw new Error(`encrypted source-master archive is unavailable: ${archiveRoot}`);

for (const record of manifest.records || []) {
  if (record.storage !== "encrypted-external") continue;
  const prefix = "FamilyHistorySourceMasters/";
  if (!record.archivePath?.startsWith(prefix)) {
    failures.push(`${record.id}: invalid external archive path`);
    continue;
  }
  const archiveFile = record.archivePath.slice(prefix.length);
  if (!archiveFile || path.basename(archiveFile) !== archiveFile) {
    failures.push(`${record.id}: archive path is not a single safe filename`);
    continue;
  }
  const sourcePath = path.join(archiveRoot, archiveFile);
  if (!fs.existsSync(sourcePath)) {
    failures.push(`${record.id}: source master is missing`);
    continue;
  }
  const contents = fs.readFileSync(sourcePath);
  const sha256 = createHash("sha256").update(contents).digest("hex");
  if (sha256 !== record.sha256) {
    failures.push(`${record.id}: archive SHA-256 does not match the manifest`);
    continue;
  }
  if (record.length !== contents.length) {
    if (checkOnly) failures.push(`${record.id}: manifest byte length is ${record.length ?? "missing"}; archive is ${contents.length}`);
    else {
      record.length = contents.length;
      changed += 1;
    }
  }
}

if (failures.length) {
  console.error(`source-master archive reconciliation failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
if (!checkOnly && changed) writeJsonAtomic(manifestPath, manifest);
console.log(`source-master archive ok: ${manifest.records.length} records; ${changed} byte lengths updated`);
