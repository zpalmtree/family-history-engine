// Row-level commits for the shared registry files.
//
// Several sessions append rows to the same registry files (the records manifest, the
// subscription and recovery queues, the Blob inventory, the extraction campaign and the
// unrecorded-kinship baseline). Committing a whole working-tree copy would carry another
// session's half-finished rows, which used to force sessions to take turns. Instead,
// `deploy:main -- --records <id ...>` commits HEAD's copy of each registry plus exactly the
// named rows taken from the working tree, so concurrent sessions never block each other.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { manifestRecordDigest } from "./extraction-store.mjs";

// Each registry: its path, the array (or map) holding rows, and the row key.
export const REGISTRY_FILES = Object.freeze([
  { path: "evidence/records-manifest.json", lists: [["records", "id"]] },
  { path: "evidence/subscription-records-queue.json", lists: [["targets", "id"]] },
  { path: "evidence/record-recovery-queue.json", lists: [["targets", "id"]] },
  { path: "evidence/viewer-blob-inventory.json", lists: [["records", "id"]] },
  { path: "evidence/extraction/campaigns/master-reread-2026-07-28.json", lists: [["records", "recordId"]], campaign: true },
  { path: "evidence/research/unrecorded-kinship-baseline.json", kinship: true },
]);

export const REGISTRY_PATHS = Object.freeze(REGISTRY_FILES.map((registry) => registry.path));

const serialize = (value) => `${JSON.stringify(value, null, 2)}\n`;

// Merge the named rows of one list: rows present in both are replaced in place, rows only in
// the working tree are inserted after their nearest working-tree predecessor that is already
// present (or at the start), and named rows absent from the working tree are removed.
export function mergeRows(headRows, workRows, key, ids) {
  const wanted = new Set(ids);
  const workById = new Map(workRows.map((row) => [row[key], row]));
  const merged = [];
  for (const row of headRows) {
    if (!wanted.has(row[key])) { merged.push(row); continue; }
    if (workById.has(row[key])) merged.push(workById.get(row[key]));
  }
  const present = new Set(merged.map((row) => row[key]));
  workRows.forEach((row, index) => {
    if (!wanted.has(row[key]) || present.has(row[key])) return;
    let at = 0;
    for (let back = index - 1; back >= 0; back -= 1) {
      const position = merged.findIndex((candidate) => candidate[key] === workRows[back][key]);
      if (position >= 0) { at = position + 1; break; }
    }
    merged.splice(at, 0, row);
    present.add(row[key]);
  });
  return merged;
}

function mergeKinship(head, work, ids) {
  const wanted = new Set(ids);
  const result = { ...head, reasons: { ...head.reasons } };
  for (const id of wanted) {
    if (work.reasons && Object.hasOwn(work.reasons, id)) result.reasons[id] = work.reasons[id];
    else delete result.reasons[id];
  }
  const workIds = new Set(work.sourceIds || []);
  result.sourceIds = (head.sourceIds || []).filter((id) => !wanted.has(id) || workIds.has(id));
  for (const id of work.sourceIds || []) if (wanted.has(id) && !result.sourceIds.includes(id)) result.sourceIds.push(id);
  return result;
}

// Returns the merged JSON text for one registry, or null when the named rows change nothing.
export function mergeRegistryText(registry, headText, workText, ids, { mergedManifest } = {}) {
  const head = JSON.parse(headText);
  const work = JSON.parse(workText);
  let result;
  if (registry.kinship) {
    result = mergeKinship(head, work, ids);
  } else {
    result = { ...head };
    for (const [list, key] of registry.lists) result[list] = mergeRows(head[list] || [], work[list] || [], key, ids);
    if (registry.campaign) {
      if (!mergedManifest) throw new Error("The campaign merge needs the merged manifest.");
      result.currentSnapshot = {
        ...head.currentSnapshot,
        capturedAt: work.currentSnapshot?.capturedAt || head.currentSnapshot?.capturedAt,
        recordCount: mergedManifest.records.length,
        manifestDigest: manifestRecordDigest(mergedManifest.records),
      };
    }
  }
  const text = serialize(result);
  return text === headText ? null : text;
}

// Builds --content overrides (HEAD plus the named rows) for every registry the rows touch.
// readHead(path) returns HEAD's text (or null when the file is new); readWork(path) the
// working-tree text. Throws when a named id appears in no registry, so a typo cannot pass.
export function registryOverrides(ids, { readHead, readWork, outDir }) {
  const wanted = [...new Set(ids)];
  if (!wanted.length) return [];
  const seen = new Set();
  const overrides = [];
  let mergedManifest = null;
  for (const registry of REGISTRY_FILES) {
    const headText = readHead(registry.path);
    const workText = readWork(registry.path);
    if (headText == null || workText == null) continue;
    const head = JSON.parse(headText);
    const work = JSON.parse(workText);
    for (const id of wanted) {
      if (registry.kinship) {
        if ((work.sourceIds || []).includes(id) || (head.sourceIds || []).includes(id)) seen.add(id);
        continue;
      }
      for (const [list, key] of registry.lists) {
        if ((work[list] || []).some((row) => row[key] === id) || (head[list] || []).some((row) => row[key] === id)) seen.add(id);
      }
    }
    const text = mergeRegistryText(registry, headText, workText, wanted, { mergedManifest });
    if (registry.path === "evidence/records-manifest.json") mergedManifest = JSON.parse(text ?? headText);
    if (text == null) continue;
    const digest = crypto.createHash("sha256").update(registry.path).digest("hex").slice(0, 12);
    const source = path.join(outDir, `${digest}-${path.basename(registry.path)}`);
    fs.writeFileSync(source, text);
    overrides.push({ path: registry.path, source });
  }
  const unknown = wanted.filter((id) => !seen.has(id));
  if (unknown.length) throw new Error(`--records names id(s) found in no registry file: ${unknown.join(", ")}`);
  return overrides;
}

export function scratchDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "deploy-main-registry-rows-"));
}
