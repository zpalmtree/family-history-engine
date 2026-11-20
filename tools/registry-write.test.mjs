import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mergeRegistry, writeRegistryAtomic } from "./registry-write.mjs";

test("a stale writer keeps a concurrent writer's new and changed rows", () => {
  const base = { schemaVersion: 1, records: [{ id: "a", v: 1 }, { id: "b", v: 1 }] };
  const disk = { schemaVersion: 1, records: [{ id: "a", v: 1 }, { id: "b", v: 1, viewer: "peer" }, { id: "peer", v: 1 }] };
  const next = { schemaVersion: 1, records: [{ id: "a", v: 2 }, { id: "b", v: 1 }, { id: "mine", v: 1 }] };
  assert.deepEqual(mergeRegistry(disk, base, next).records, [{ id: "a", v: 2 }, { id: "b", v: 1, viewer: "peer" }, { id: "mine", v: 1 }, { id: "peer", v: 1 }]);
});

test("rows the writer removed are deleted; unchanged keys stay as on disk", () => {
  const base = { note: "x", targets: [{ id: "a" }, { id: "gone" }] };
  const disk = { note: "peer", targets: [{ id: "a" }, { id: "gone" }, { id: "p" }] };
  const next = { note: "x", targets: [{ id: "a" }] };
  assert.deepEqual(mergeRegistry(disk, base, next), { note: "peer", targets: [{ id: "a" }, { id: "p" }] });
});

test("writeRegistryAtomic merges against the file on disk", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "registry-write-"));
  const file = path.join(dir, "m.json");
  try {
    fs.writeFileSync(file, `${JSON.stringify({ records: [{ id: "a" }, { id: "peer" }] }, null, 2)}\n`);
    writeRegistryAtomic(file, { records: [{ id: "a" }] }, { records: [{ id: "a", done: true }] });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).records, [{ id: "a", done: true }, { id: "peer" }]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
