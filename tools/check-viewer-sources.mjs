#!/usr/bin/env node

import fs from "node:fs";
import { projectViewerSources } from "./viewer-records.mjs";

const registry = JSON.parse(fs.readFileSync(new URL("../evidence/viewer-sources.json", import.meta.url), "utf8"));
const family = JSON.parse(fs.readFileSync(new URL("../data/family/people.json", import.meta.url), "utf8"));
const sourceInventory = JSON.parse(fs.readFileSync(new URL("../evidence/source-atoms.json", import.meta.url), "utf8"));
const manifest = JSON.parse(fs.readFileSync(new URL("../evidence/records-manifest.json", import.meta.url), "utf8"));

try {
  const projected = projectViewerSources(registry, family, { sourceInventory });
  if (projected.length !== registry.records.length) throw new Error("not every source was projected");
  const documentIds = new Set((manifest.records || [])
    .filter((record) => record.viewer?.approved === true
      && record.rights === "family-viewer-approved"
      && record.privacy !== "restricted")
    .map((record) => record.id));
  const duplicate = projected.find((source) => documentIds.has(source.id));
  if (duplicate) throw new Error(`citation id collides with an approved document id: ${duplicate.id}`);
  const internal = JSON.stringify(projected).match(/(?:evidence\/|data\/archive|archivePath|blobPath)/i)?.[0];
  if (internal) throw new Error(`projected sources expose an internal field or path: ${internal}`);
  console.log(`viewer sources ok: ${projected.length} person-linked citations`);
} catch (error) {
  console.error(`viewer source check failed: ${error.message}`);
  process.exit(1);
}
