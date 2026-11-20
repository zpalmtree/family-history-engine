import test from "node:test";
import assert from "node:assert/strict";
import { requestedPublishIds, selectApproved, selectRequested } from "./publish-selection.mjs";

test("publish ids come from --record, --target and PUBLISH_TARGET_IDS", () => {
  const ids = requestedPublishIds(["node", "p.mjs", "--record", "a", "--target", "b"], { PUBLISH_TARGET_IDS: "c, d e" });
  assert.deepEqual([...ids].sort(), ["a", "b", "c", "d", "e"]);
  assert.equal(requestedPublishIds(["node"], {}).size, 0);
});

test("a selection publishes only the requested pending records and names the others", () => {
  const pending = [{ id: "mine" }, { id: "peer" }];
  assert.deepEqual(selectRequested(pending, new Set(["mine"])), { selected: [{ id: "mine" }], skipped: ["peer"] });
  assert.deepEqual(selectRequested(pending, new Set()), { selected: pending, skipped: [] });
  assert.throws(() => selectRequested(pending, new Set(["absent"])), /not eligible pending uploads: absent/);
});

test("a derivative run reads only the requested approved records, or all of them with no selection", () => {
  const approved = [{ id: "mine" }, { id: "peer" }, { id: "old" }];
  assert.deepEqual(selectApproved(approved, new Set(["mine"])), [{ id: "mine" }]);
  assert.equal(selectApproved(approved, new Set()), approved);
  assert.throws(() => selectApproved(approved, new Set(["absent"])), /not approved viewer records: absent/);
});
