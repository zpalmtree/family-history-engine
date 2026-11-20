import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeJsonAtomic } from "./atomic-json.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const viewerBlobInventoryPath = path.join(root, "evidence", "viewer-blob-inventory.json");

export const derivativeProfiles = Object.freeze({
  thumbnail: Object.freeze({
    id: "thumbnail-webp-v2",
    pathname: "thumbnail-v1.webp",
    width: 1_200,
    height: 600,
    quality: 82
  }),
  preview: Object.freeze({
    id: "preview-webp-v1",
    pathname: "preview-v1.webp",
    width: 2_000,
    height: 2_000,
    quality: 80
  })
});

export function readViewerBlobInventory() {
  if (!fs.existsSync(viewerBlobInventoryPath)) return { schemaVersion: 1, records: [] };
  return JSON.parse(fs.readFileSync(viewerBlobInventoryPath, "utf8"));
}

export function writeViewerBlobInventory(inventory) {
  inventory.schemaVersion = 1;
  inventory.records = [...(inventory.records || [])].sort((first, second) => first.id.localeCompare(second.id));
  writeJsonAtomic(viewerBlobInventoryPath, inventory);
}

export function inventoryById(inventory) {
  return new Map((inventory?.records || []).map((record) => [record.id, record]));
}

export function approvedViewerRecords(manifest) {
  return (manifest.records || []).filter((record) => record.viewer?.approved === true
    && record.rights === "family-viewer-approved"
    && record.privacy !== "restricted");
}

export function expectedBlobObjects(inventory) {
  return (inventory.records || []).flatMap((record) => [
    { recordId: record.id, variant: "original", ...record.original },
    ...(record.thumbnail ? [{ recordId: record.id, variant: "thumbnail", ...record.thumbnail }] : []),
    ...(record.preview ? [{ recordId: record.id, variant: "preview", ...record.preview }] : [])
  ]);
}
