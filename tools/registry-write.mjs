// Concurrency-safe writes for the shared registry files.
//
// Writers read a registry (records manifest, subscription and recovery queues, ...) early and
// wrote the whole file back later, so a concurrent session's rows written in between were lost.
// writeRegistryAtomic(file, base, next) takes the copy the process read (base) and its edited
// copy (next) and, under the file lock, re-reads the file on disk and applies only what this
// process changed: every top-level array of id-keyed rows is merged row by row (changed or new
// rows replaced or inserted, rows this process removed deleted), and other top-level keys are
// written only when this process changed them. Everyone else's rows are kept as on disk.
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { withFileLockSync, writeJsonAtomic } from "./atomic-json.mjs";

const pathOf = (file) => (file instanceof URL ? fileURLToPath(file) : file);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const keyed = (list) => Array.isArray(list) && list.length > 0 && list.every((row) => row && typeof row === "object" && typeof row.id === "string");

export function mergeRegistry(disk, base, next) {
  const out = { ...disk };
  for (const key of new Set([...Object.keys(next), ...Object.keys(base || {})])) {
    const isList = keyed(next[key]) || keyed(base?.[key]) || keyed(disk?.[key]);
    if (!isList) {
      if (!same(next[key], base?.[key])) { if (key in next) out[key] = next[key]; else delete out[key]; }
      continue;
    }
    const baseRows = new Map((base?.[key] || []).map((row) => [row.id, row]));
    const nextRows = next[key] || [];
    const nextIds = new Set(nextRows.map((row) => row.id));
    const changed = new Set(nextRows.filter((row) => !same(row, baseRows.get(row.id))).map((row) => row.id));
    const removed = new Set([...baseRows.keys()].filter((id) => !nextIds.has(id)));
    if (!changed.size && !removed.size) continue;
    const merged = (disk?.[key] || []).filter((row) => !removed.has(row.id)).map((row) => (changed.has(row.id) ? nextRows.find((r) => r.id === row.id) : row));
    const present = new Set(merged.map((row) => row.id));
    nextRows.forEach((row, index) => {
      if (!changed.has(row.id) || present.has(row.id)) return;
      let at = merged.length;
      for (let back = index - 1; back >= 0; back -= 1) {
        const position = merged.findIndex((candidate) => candidate.id === nextRows[back].id);
        if (position >= 0) { at = position + 1; break; }
      }
      merged.splice(at, 0, row); present.add(row.id);
    });
    out[key] = merged;
  }
  return out;
}

export function writeRegistryAtomic(file, base, next) {
  const target = pathOf(file);
  return withFileLockSync(target, () => {
    const disk = fs.existsSync(target) ? JSON.parse(fs.readFileSync(target, "utf8")) : {};
    const merged = mergeRegistry(disk, base, next);
    writeJsonAtomic(target, merged);
    return merged;
  });
}
