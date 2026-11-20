import assert from "node:assert/strict";
import test from "node:test";

import { evaluateReopenTriggers } from "./reopen-triggers.mjs";

const question = (overrides = {}) => ({
  id: "rq-example",
  status: "blocked",
  reopenTriggers: [{ id: "t1", kind: "record-delivered", requestId: "req-1" }],
  ...overrides
});
const target = (overrides = {}) => ({
  id: "tgt-1", questionIds: ["rq-example"], reconciliation: { state: "published" }, ...overrides
});
const request = (overrides = {}) => ({
  id: "req-1", items: [{ targetId: "tgt-1" }], events: [{ type: "delivery-complete" }], ...overrides
});

const run = (overrides = {}) => evaluateReopenTriggers({
  questions: [question()], requests: [request()], targets: [target()], ...overrides
});

test("a delivered record bound to the question fires", () => {
  const { fired } = run();
  assert.equal(fired.length, 1);
  assert.equal(fired[0].questionId, "rq-example");
  assert.match(fired[0].resume, /research:question:reopen/);
});

test("firing never mutates the question", () => {
  const q = question();
  run({ questions: [q] });
  assert.equal(q.status, "blocked", "the trigger surfaces work; the reopen command performs the transition");
});

test("a request not bound to the question through a target does not fire", () => {
  const { fired, skipped } = run({ targets: [target({ questionIds: ["rq-other"] })] });
  assert.equal(fired.length, 0);
  assert.match(skipped[0].reason, /not bound to this question/);
});

test("an undelivered request does not fire", () => {
  const { fired, skipped } = run({ requests: [request({ events: [{ type: "submission-confirmed" }] })] });
  assert.equal(fired.length, 0);
  assert.match(skipped[0].reason, /no delivery event/);
});

test("a delivery reconciled as terminal does not fire", () => {
  const { fired, skipped } = run({ targets: [target({ reconciliation: { state: "superseded" } })] });
  assert.equal(fired.length, 0);
  assert.match(skipped[0].reason, /irrelevant or terminal/);
});

test("a trigger already consumed by a reopen event does not fire again", () => {
  const consumed = question({
    reopenEvents: [{ type: "reopened", fromStatus: "blocked", reason: "r", actionId: "a", triggerId: "t1" }]
  });
  const { fired, skipped } = run({ questions: [consumed] });
  assert.equal(fired.length, 0, "one delivery justifies one re-entry");
  assert.match(skipped[0].reason, /already consumed/);
});

test("repeated evaluation is stable", () => {
  assert.deepEqual(run().fired, run().fired);
});

test("open and answered questions are never surfaced as reopenable", () => {
  for (const status of ["open", "answered"]) {
    assert.equal(run({ questions: [question({ status })] }).fired.length, 0);
  }
});

test("unsupported trigger kinds are skipped explicitly rather than silently", () => {
  const { fired, skipped } = run({
    questions: [question({ reopenTriggers: [{ id: "t9", kind: "route-class-available", class: "probate" }] })]
  });
  assert.equal(fired.length, 0);
  assert.match(skipped[0].reason, /unsupported trigger kind route-class-available/);
});

test("an imported delivery item counts as delivered", () => {
  const { fired } = run({ requests: [request({ events: [{ type: "delivery-item-imported" }] })] });
  assert.equal(fired.length, 1);
});

test("v2 current-no-known-route questions can fire the same versioned trigger", () => {
  const v2 = question({
    status: undefined,
    lifecycle: "active",
    conclusion: { state: "unresolved" },
    routeAssessment: { state: "current-no-known-route" }
  });
  const { fired } = run({ questions: [v2] });
  assert.equal(fired.length, 1);
  assert.equal(fired[0].questionStatus, "current-no-known-route");
});

test("a missing request is reported, not thrown", () => {
  const { fired, skipped } = run({ requests: [] });
  assert.equal(fired.length, 0);
  assert.match(skipped[0].reason, /does not exist/);
});
