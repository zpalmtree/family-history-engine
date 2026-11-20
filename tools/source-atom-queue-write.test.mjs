import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { readJson, writeJsonAtomic } from "./atomic-json.mjs";
import { snapshotQueueAtomIds, writeChangedQueueAtomIds } from "./source-atom-queue-write.mjs";

test("an unchanged subscription queue is not rewritten when another provider changes", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "source-atom-queues-"));
  const familysearchPath = path.join(directory, "familysearch.json");
  const subscriptionPath = path.join(directory, "subscription.json");
  const familysearch = { targets: [{ id: "familysearch-target", atomId: "old-atom" }] };
  const subscription = { targets: [{ id: "ancestry-target", atomId: "subscription-atom", normalized: true }] };
  try {
    writeJsonAtomic(familysearchPath, familysearch);
    writeJsonAtomic(subscriptionPath, subscription);
    const preservedTime = new Date("2001-01-01T00:00:00.000Z");
    fs.utimesSync(subscriptionPath, preservedTime, preservedTime);
    const familysearchBefore = snapshotQueueAtomIds(familysearch);
    const subscriptionBefore = snapshotQueueAtomIds(subscription);

    familysearch.targets[0].atomId = "new-atom";
    assert.equal(writeChangedQueueAtomIds(familysearchPath, familysearchBefore, familysearch), true);
    assert.equal(writeChangedQueueAtomIds(subscriptionPath, subscriptionBefore, subscription), false);

    assert.equal(readJson(familysearchPath).targets[0].atomId, "new-atom");
    assert.deepEqual(readJson(subscriptionPath), subscription);
    assert.equal(fs.statSync(subscriptionPath).mtimeMs, preservedTime.getTime());
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("an atomId refresh preserves fields written concurrently", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "source-atom-queue-race-"));
  const queuePath = path.join(directory, "subscription.json");
  const desired = { targets: [{ id: "ancestry-target", atomId: "old-atom", status: "pending" }] };
  try {
    writeJsonAtomic(queuePath, desired);
    const before = snapshotQueueAtomIds(desired);
    desired.targets[0].atomId = "new-atom";
    const concurrent = readJson(queuePath);
    concurrent.targets[0].status = "archived";
    concurrent.targets[0].normalized = true;
    writeJsonAtomic(queuePath, concurrent);

    assert.equal(writeChangedQueueAtomIds(queuePath, before, desired), true);
    assert.deepEqual(readJson(queuePath).targets[0], {
      id: "ancestry-target",
      atomId: "new-atom",
      status: "archived",
      normalized: true
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
