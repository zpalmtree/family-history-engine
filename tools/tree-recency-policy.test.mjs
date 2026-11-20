import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  createTreeRecencyStamp,
  validateTreeRecencyPolicy
} from "./tree-recency-policy.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const baseline = JSON.parse(fs.readFileSync(
  path.join(root, "evidence", "research", "tree-recency-baseline.json"),
  "utf8"
));

// A tree that adopted the ledger from the start has no legacy people.
test("legacy visible people may predate tree recency metadata", { skip: !baseline.legacyVisiblePersonIds.length && "no legacy snapshot in this tree" }, () => {
  const personId = baseline.legacyVisiblePersonIds[0];
  assert.deepEqual(validateTreeRecencyPolicy({
    people: [{ personId }],
    visualPersonIds: [personId],
    baseline: { ...baseline, firstVisibleEntries: [] }
  }), []);
});

test("a newly visible person fails with the exact atomic-stamp remedy", () => {
  assert.deepEqual(validateTreeRecencyPolicy({
    people: [{ personId: "new-person" }],
    visualPersonIds: ["new-person"],
    baseline: { ...baseline, firstVisibleEntries: [] }
  }), ["new-person is newly visible; run npm run tree:recency:stamp -- --person new-person"]);
});

test("the stamp operation updates canonical metadata and the ledger together", () => {
  const emptyLedger = { ...baseline, firstVisibleEntries: [] };
  const stamped = createTreeRecencyStamp({
    person: { schemaVersion: 2, personId: "new-person", branchIds: ["example"] },
    baseline: emptyLedger,
    visualPersonIds: ["new-person"],
    timestamp: "2026-08-11T04:30:00-04:00"
  });
  assert.equal(stamped.person.treeAddedAt, "2026-08-11T04:30:00-04:00");
  assert.deepEqual(stamped.baseline.firstVisibleEntries, [{
    personId: "new-person",
    firstVisibleAt: "2026-08-11T04:30:00-04:00"
  }]);
  assert.deepEqual(validateTreeRecencyPolicy({
    people: [stamped.person],
    visualPersonIds: ["new-person"],
    baseline: stamped.baseline,
    now: "2026-08-11T05:00:00-04:00"
  }), []);
});

test("hidden drafts pass, but pre-stamping without a ledger entry fails", () => {
  const emptyLedger = { ...baseline, firstVisibleEntries: [] };
  assert.deepEqual(validateTreeRecencyPolicy({
    people: [{ personId: "hidden-person" }],
    visualPersonIds: [],
    baseline: emptyLedger
  }), []);
  assert.deepEqual(validateTreeRecencyPolicy({
    people: [{ personId: "hidden-person", treeAddedAt: "2026-08-11T04:30:00-04:00" }],
    visualPersonIds: [],
    baseline: emptyLedger,
    now: "2026-08-11T05:00:00-04:00"
  }), ["hidden-person has treeAddedAt but no first-visible ledger entry"]);
});

test("removal and re-addition preserve the original first-visible time", () => {
  const ledger = {
    ...baseline,
    firstVisibleEntries: [{ personId: "returning-person", firstVisibleAt: "2026-08-10T04:30:00-04:00" }]
  };
  const people = [{ personId: "returning-person", treeAddedAt: "2026-08-10T04:30:00-04:00" }];
  assert.deepEqual(validateTreeRecencyPolicy({ people, visualPersonIds: [], baseline: ledger, now: "2026-08-11T05:00:00-04:00" }), []);
  assert.deepEqual(validateTreeRecencyPolicy({ people, visualPersonIds: ["returning-person"], baseline: ledger, now: "2026-08-11T05:00:00-04:00" }), []);
});

test("timestamps are strict, immutable, and cannot be future-dated", () => {
  const ledger = {
    ...baseline,
    firstVisibleEntries: [
      { personId: "date-only", firstVisibleAt: "2026-08-11" },
      { personId: "mismatch", firstVisibleAt: "2026-08-11T04:29:00-04:00" },
      { personId: "future-person", firstVisibleAt: "2026-08-11T05:00:01-04:00" }
    ]
  };
  const issues = validateTreeRecencyPolicy({
    people: [
      { personId: "date-only", treeAddedAt: "2026-08-11" },
      { personId: "mismatch", treeAddedAt: "2026-08-11T04:30:00-04:00" },
      { personId: "future-person", treeAddedAt: "2026-08-11T05:00:01-04:00" }
    ],
    visualPersonIds: ["date-only", "mismatch", "future-person"],
    baseline: ledger,
    now: "2026-08-11T05:00:00-04:00"
  });
  assert.ok(issues.includes("date-only has invalid firstVisibleAt; use an RFC 3339 timestamp with an explicit offset"));
  assert.ok(issues.includes("date-only has invalid treeAddedAt; use an RFC 3339 timestamp with an explicit offset"));
  assert.ok(issues.includes("mismatch treeAddedAt does not match immutable firstVisibleAt"));
  assert.ok(issues.includes("future-person has future treeAddedAt"));
  assert.ok(issues.includes("future-person has future firstVisibleAt"));
});

test("the frozen legacy digest prevents quietly grandfathering a new person", () => {
  assert.deepEqual(validateTreeRecencyPolicy({
    people: [],
    visualPersonIds: [],
    baseline: { ...baseline, legacyVisiblePersonIds: [...baseline.legacyVisiblePersonIds, "new-person"], firstVisibleEntries: [] }
  }), ["tree recency legacy snapshot changed; it is frozen and cannot grandfather new people"]);
});

test("invalid ledgers and missing canonical people are reported", () => {
  assert.deepEqual(validateTreeRecencyPolicy({ people: [], visualPersonIds: [], baseline: {} }), [
    "tree recency ledger has unsupported schema"
  ]);
  assert.deepEqual(validateTreeRecencyPolicy({
    people: [],
    visualPersonIds: ["missing-person"],
    baseline: { ...baseline, firstVisibleEntries: [] }
  }), ["visible tree node missing-person has no canonical person bundle"]);
});
