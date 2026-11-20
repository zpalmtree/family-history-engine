import assert from "node:assert/strict";
import test from "node:test";
import { exportPackageJson, scanText } from "./engine-export.mjs";

test("the privacy scan finds whole words and phrases, case-insensitively", () => {
  const terms = [{ term: "hilda", reason: "tree term" }, { term: "Ann Example", reason: "person name" }, { term: "ann-example-1820", reason: "person id" }];
  assert.deepEqual(scanText("brunhilda's", terms), [], "a term inside a longer word is not a hit");
  assert.deepEqual(scanText("Hilda's side", terms).map((hit) => hit.term), ["hilda"]);
  assert.deepEqual(scanText("one\nsee ann example here", terms).map((hit) => [hit.term, hit.line]), [["Ann Example", 2]]);
  assert.deepEqual(scanText("id: ann-example-1820", terms).map((hit) => hit.term), ["ann-example-1820"]);
  assert.deepEqual(scanText("Hilda", terms, ["hilda"]), [], "an allowed term is skipped");
});

test("export scripts lose this tree's steps and tests but keep their generic work", () => {
  const raw = JSON.stringify({
    name: "private-tree",
    scripts: {
      check: "npm run places && node tools/check-store.mjs && node --test tools/a.test.mjs tools/tree.test.mjs",
      places: "node tools/migrate-tree-places.mjs",
      all: "npm run check && npm run places",
      treeOnly: "node --test tools/tree.test.mjs",
      lint: "node tools/lint.mjs"
    }
  });
  const { pkg, dropped } = exportPackageJson(raw, ["tools/check-store.mjs", "tools/a.test.mjs", "tools/lint.mjs"]);
  assert.equal(pkg.scripts.check, "node tools/check-store.mjs && node --test tools/a.test.mjs");
  assert.equal(pkg.scripts.all, "npm run check");
  assert.equal(pkg.scripts.lint, "node tools/lint.mjs");
  assert.deepEqual(dropped, ["places", "treeOnly"]);
});
