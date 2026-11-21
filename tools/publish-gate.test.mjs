import test from "node:test";
import assert from "node:assert/strict";
import { scopedIssues } from "./publish-gate.mjs";

const fixture = (overrides = {}) => {
  const files = {
    "evidence/records-manifest.json": { records: [{ id: "mine", sha256: "abc" }] },
    "evidence/acquisition/targets/mine.json": { id: "mine", sha256: "abc", peopleVerifiedAt: "2026-11-19", sourceId: "mine" },
    "evidence/sources/findmypast/mine.json": { id: "mine" },
    ...overrides,
  };
  return { readJson: (file) => files[file], exists: (file) => file in files && files[file] !== undefined, sourceDirs: ["ancestry", "findmypast"] };
};

test("a scoped publish gate passes a complete record and ignores everyone else's files", () => {
  assert.deepEqual(scopedIssues(["mine"], fixture()), []);
});

test("a scoped publish gate names each missing or inconsistent piece", () => {
  assert.deepEqual(scopedIssues(["absent"], fixture()), ["absent: no canonical target"]);
  const io = fixture({ "evidence/acquisition/targets/mine.json": { id: "mine", sha256: "zzz", sourceId: "mine" }, "evidence/sources/findmypast/mine.json": undefined });
  assert.deepEqual(scopedIssues(["mine"], io), [
    "mine: manifest sha256 disagrees with the target",
    "mine: people not verified on the target",
    "mine: no canonical source mine",
  ]);
});

test("a FamilySearch target without its own hash passes on the manifest row's hash", () => {
  const io = fixture({ "evidence/acquisition/targets/mine.json": { id: "mine", peopleVerifiedAt: "2026-11-19", sourceId: "mine" } });
  assert.deepEqual(scopedIssues(["mine"], io), []);
  const none = fixture({
    "evidence/records-manifest.json": { records: [{ id: "mine" }] },
    "evidence/acquisition/targets/mine.json": { id: "mine", peopleVerifiedAt: "2026-11-19", sourceId: "mine" },
  });
  assert.deepEqual(scopedIssues(["mine"], none), ["mine: target has no archived sha256"]);
});

test("every records:publish chain validates through the scoped gate, not a whole-tree data:check", async () => {
  const fs = await import("node:fs");
  const scripts = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).scripts;
  for (const name of ["records:publish:public", "records:publish:subscriptions", "records:publish:familysearch"]) {
    assert.ok(scripts[name].includes("node tools/publish-gate.mjs"), `${name} must run the scoped publish gate`);
    assert.ok(!scripts[name].includes("npm run data:check"), `${name} must not run the whole-tree data:check directly`);
  }
});
