import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sandbox = { globalThis: {} };
vm.runInNewContext(
  fs.readFileSync(path.join(root, "assets", "tree-recency.js"), "utf8"),
  sandbox,
  { filename: "assets/tree-recency.js" }
);
const { isNewTreeNode, NEW_NODE_WINDOW_MS } = sandbox.globalThis.familyTreeRecency;
const now = Date.parse("2026-07-30T12:00:00-04:00");

test("tree nodes remain new through the rolling five-day boundary", () => {
  assert.equal(NEW_NODE_WINDOW_MS, 5 * 24 * 60 * 60 * 1000);
  assert.equal(isNewTreeNode("2026-07-30T11:59:59-04:00", now), true);
  assert.equal(isNewTreeNode(new Date(now - NEW_NODE_WINDOW_MS).toISOString(), now), true);
  assert.equal(isNewTreeNode(new Date(now - NEW_NODE_WINDOW_MS - 1).toISOString(), now), false);
});

test("tree node recency rejects missing, invalid, and future timestamps", () => {
  assert.equal(isNewTreeNode(undefined, now), false);
  assert.equal(isNewTreeNode("not-a-date", now), false);
  assert.equal(isNewTreeNode("2026-07-30T12:00:01-04:00", now), false);
  assert.equal(isNewTreeNode("2026-07-30T12:00:00-04:00", new Date(now)), true);
});
