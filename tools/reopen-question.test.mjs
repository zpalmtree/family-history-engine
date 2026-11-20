import assert from "node:assert/strict";
import test from "node:test";

import { buildReopenedQuestion } from "./reopen-question.mjs";

const closed = (overrides = {}) => ({
  id: "rq-example",
  status: "exhausted",
  conclusion: { summary: "Bounded FreeREG audit found no candidate." },
  reopenWhen: ["A settlement or probate record bridges a candidate to the adult."],
  actions: [{ id: "old-search", kind: "search", status: "completed", note: "FreeREG pass" }],
  ...overrides
});

const action = { id: "search-lichfield-probate", kind: "search", note: "Lichfield probate for the candidate father" };
const at = "2026-07-26T00:00:00.000Z";

test("reopening adds the action and flips status in one result", () => {
  const result = buildReopenedQuestion(closed(), { reason: "Marriage recorded by licence", action, at });
  assert.equal(result.status, "open");
  const added = result.actions.find((item) => item.id === action.id);
  assert.equal(added.status, "ready");
  assert.equal(result.actions.length, 2);
});

test("a reason with no action is refused", () => {
  assert.throws(() => buildReopenedQuestion(closed(), { reason: "New index appeared", at }),
    /requires a concrete next action/);
});

test("an action with no note is refused", () => {
  assert.throws(
    () => buildReopenedQuestion(closed(), { reason: "New index appeared", action: { id: "x", kind: "search" }, at }),
    /requires a note/);
});

test("a perfunctory reason is refused", () => {
  assert.throws(() => buildReopenedQuestion(closed(), { reason: "why", action, at }), /requires a reason/);
});

test("blocked questions are reopenable too", () => {
  const result = buildReopenedQuestion(closed({ status: "blocked" }), { reason: "Access restored", action, at });
  assert.equal(result.status, "open");
  assert.equal(result.reopenEvents[0].fromStatus, "blocked");
});

test("answered questions are not reopenable through this path", () => {
  assert.throws(() => buildReopenedQuestion(closed({ status: "answered" }), { reason: "Contradiction found", action, at }),
    /only exhausted or blocked/);
});

test("prior attempts, conclusion, and reopenWhen prose survive untouched", () => {
  const before = closed();
  const result = buildReopenedQuestion(before, { reason: "Marriage recorded by licence", action, at });
  assert.deepEqual(result.actions[0], before.actions[0], "the completed action is the audit trail");
  assert.deepEqual(result.conclusion, before.conclusion);
  assert.deepEqual(result.reopenWhen, before.reopenWhen);
});

test("the prior status and reason are recorded as an event", () => {
  const result = buildReopenedQuestion(closed(), { reason: "Marriage recorded by licence", action, at });
  assert.deepEqual(result.reopenEvents, [{
    type: "reopened",
    fromStatus: "exhausted",
    reason: "Marriage recorded by licence",
    actionId: action.id,
    at
  }]);
});

test("a firing trigger can be bound to the reopen event", () => {
  const result = buildReopenedQuestion(closed(), { reason: "Certificate arrived", action, at, triggerId: "t-1" });
  assert.equal(result.reopenEvents[0].triggerId, "t-1");
});

test("v2 re-entry advances route assessment without reviving an overloaded status", () => {
  const question = {
    schemaVersion: 2,
    id: "rq-v2",
    lifecycle: "active",
    conclusion: { state: "unresolved", summary: "No bridge yet." },
    routeAssessment: { state: "current-no-known-route", reviewedAt: "2026-07-20" },
    actions: []
  };
  const result = buildReopenedQuestion(question, { reason: "New register delivery arrived", action, at, triggerId: "t-v2" });
  assert.equal(result.routeAssessment.state, "in-progress");
  assert.equal(Object.hasOwn(result, "status"), false);
  assert.equal(result.actions[0].status, "ready");
  assert.equal(result.reopenEvents[0].fromRouteAssessment, "current-no-known-route");
});

test("a duplicate action id is refused", () => {
  const dup = { id: "old-search", kind: "search", note: "again" };
  assert.throws(() => buildReopenedQuestion(closed(), { reason: "Something changed", action: dup, at }),
    /already exists/);
});

test("reopening twice accumulates events rather than overwriting", () => {
  const once = buildReopenedQuestion(closed(), { reason: "Marriage recorded by licence", action, at });
  const twice = buildReopenedQuestion({ ...once, status: "exhausted" }, {
    reason: "Apprenticeship series identified",
    action: { id: "search-apprenticeship", kind: "search", note: "IR 1 for the stated trade" },
    at
  });
  assert.equal(twice.reopenEvents.length, 2);
});
