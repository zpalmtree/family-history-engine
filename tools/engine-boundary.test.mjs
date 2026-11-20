import assert from "node:assert/strict";
import test from "node:test";
import { boundaryConfig, compareToBaseline, countTerms } from "./engine-boundary.mjs";

test("counts terms case-insensitively and escapes regex characters", () => {
  assert.equal(countTerms("Fixture fixture FIXTURE-line", ["fixture"]), 3);
  assert.equal(countTerms("a.b axb", ["a.b"]), 1);
  assert.equal(countTerms("anything", []), 0);
});

test("a file that gains mentions or a new file fails; falls are reported for ratcheting", () => {
  const { grown, shrunk } = compareToBaseline({ "tools/a.mjs": 3, "tools/new.mjs": 1, "tools/c.mjs": 1 }, { "tools/a.mjs": 2, "tools/b.mjs": 4, "tools/c.mjs": 1 });
  assert.deepEqual(grown, [{ file: "tools/a.mjs", count: 3, allowed: 2 }, { file: "tools/new.mjs", count: 1, allowed: 0 }]);
  assert.deepEqual(shrunk, [{ file: "tools/b.mjs", count: 0, allowed: 4 }]);
});

test("boundary settings default to no terms and the tree/ baseline", () => {
  assert.deepEqual(boundaryConfig({}), { terms: [], baselineFile: "tree/engine-boundary-baseline.json" });
  assert.deepEqual(boundaryConfig({ engineBoundary: { terms: ["Fixture"] } }).terms, ["fixture"]);
});
