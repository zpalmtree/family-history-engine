import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { REGISTRY_FILES, mergeRows, mergeRegistryText, registryOverrides } from "./registry-rows.mjs";
import { manifestRecordDigest } from "./extraction-store.mjs";

const text = (value) => `${JSON.stringify(value, null, 2)}\n`;
const registry = (file) => REGISTRY_FILES.find((entry) => entry.path === file);

test("named rows replace in place, insert after their working-tree predecessor, and other rows stay HEAD's", () => {
  const head = [{ id: "a", v: 1 }, { id: "b", v: 1 }, { id: "c", v: 1 }];
  const work = [{ id: "a", v: 2 }, { id: "b", v: 9 }, { id: "new", v: 1 }, { id: "c", v: 1 }, { id: "peer", v: 1 }];
  assert.deepEqual(mergeRows(head, work, "id", ["b", "new"]), [{ id: "a", v: 1 }, { id: "b", v: 9 }, { id: "new", v: 1 }, { id: "c", v: 1 }]);
});

test("a named row missing from the working tree is removed; an unnamed one never is", () => {
  const head = [{ id: "a" }, { id: "gone" }, { id: "kept" }];
  const work = [{ id: "a" }];
  assert.deepEqual(mergeRows(head, work, "id", ["gone"]), [{ id: "a" }, { id: "kept" }]);
});

test("a new row with no present predecessor goes first", () => {
  assert.deepEqual(mergeRows([{ id: "b" }], [{ id: "a" }, { id: "b" }], "id", ["a"]), [{ id: "a" }, { id: "b" }]);
});

test("unchanged rows produce no override, and formatting matches the writers", () => {
  const manifest = { schemaVersion: 1, records: [{ id: "a", sha256: "x" }] };
  assert.equal(mergeRegistryText(registry("evidence/records-manifest.json"), text(manifest), text(manifest), ["a"]), null);
  const work = { schemaVersion: 1, records: [{ id: "a", sha256: "x" }, { id: "é", sha256: "y" }] };
  assert.equal(mergeRegistryText(registry("evidence/records-manifest.json"), text(manifest), text(work), ["é"]), text(work));
});

test("the campaign snapshot is recomputed from the merged manifest, not the working tree", () => {
  const headManifest = { schemaVersion: 1, records: [{ id: "a", sha256: "1" }] };
  const mergedManifest = { schemaVersion: 1, records: [{ id: "a", sha256: "1" }, { id: "mine", sha256: "2" }] };
  const head = { schemaVersion: 1, currentSnapshot: { capturedAt: "2026-11-18", recordCount: 1, manifestDigest: manifestRecordDigest(headManifest.records) }, records: [{ recordId: "a" }] };
  const work = { schemaVersion: 1, currentSnapshot: { capturedAt: "2026-11-19", recordCount: 3, manifestDigest: "peer" }, records: [{ recordId: "a" }, { recordId: "mine" }, { recordId: "peer" }] };
  const merged = JSON.parse(mergeRegistryText(registry("evidence/extraction/campaigns/master-reread-2026-07-28.json"), text(head), text(work), ["mine"], { mergedManifest }));
  assert.deepEqual(merged.records.map((row) => row.recordId), ["a", "mine"]);
  assert.equal(merged.currentSnapshot.recordCount, 2);
  assert.equal(merged.currentSnapshot.manifestDigest, manifestRecordDigest(mergedManifest.records));
  assert.equal(merged.currentSnapshot.capturedAt, "2026-11-19");
});

test("kinship baseline merges only the named reasons and source ids", () => {
  const head = { schemaVersion: 1, reasons: { a: "old" }, sourceIds: ["a"] };
  const work = { schemaVersion: 1, reasons: { a: "old", mine: "why", peer: "theirs" }, sourceIds: ["a", "mine", "peer"] };
  const merged = JSON.parse(mergeRegistryText(registry("evidence/research/unrecorded-kinship-baseline.json"), text(head), text(work), ["mine"]));
  assert.deepEqual(merged, { schemaVersion: 1, reasons: { a: "old", mine: "why" }, sourceIds: ["a", "mine"] });
});

test("registryOverrides writes merged files for touched registries and rejects unknown ids", () => {
  const files = {
    "evidence/records-manifest.json": [{ schemaVersion: 1, records: [{ id: "a", sha256: "1" }] }, { schemaVersion: 1, records: [{ id: "a", sha256: "1" }, { id: "mine", sha256: "2" }, { id: "peer", sha256: "3" }] }],
    "evidence/subscription-records-queue.json": [{ schemaVersion: 1, targets: [] }, { schemaVersion: 1, targets: [{ id: "peer" }] }],
    "evidence/extraction/campaigns/master-reread-2026-07-28.json": [{ schemaVersion: 1, currentSnapshot: {}, records: [{ recordId: "a" }] }, { schemaVersion: 1, currentSnapshot: { capturedAt: "d" }, records: [{ recordId: "a" }, { recordId: "mine" }, { recordId: "peer" }] }],
  };
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "registry-rows-test-"));
  try {
    const io = { readHead: (file) => (files[file] ? text(files[file][0]) : null), readWork: (file) => (files[file] ? text(files[file][1]) : null), outDir };
    const overrides = registryOverrides(["mine"], io);
    assert.deepEqual(overrides.map((override) => override.path), ["evidence/records-manifest.json", "evidence/extraction/campaigns/master-reread-2026-07-28.json"]);
    const manifest = JSON.parse(fs.readFileSync(overrides[0].source, "utf8"));
    assert.deepEqual(manifest.records.map((row) => row.id), ["a", "mine"]);
    const campaign = JSON.parse(fs.readFileSync(overrides[1].source, "utf8"));
    assert.equal(campaign.currentSnapshot.recordCount, 2);
    assert.throws(() => registryOverrides(["typo"], io), /found in no registry file: typo/);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});
