import assert from "node:assert/strict";
import test from "node:test";

import {
  isLiveResearchQuestion,
  isQuestionExecutable,
  parentSlotGoalKey,
  questionCompatibilityStatus,
  questionGoalKeys,
  researchAttemptsForQuestion,
  routeDependencyPending,
  trailingDryAttemptCount,
  validateQuestionSupersession
} from "./research-question-state.mjs";

test("semantic ownership is exact and v1 person mentions do not own parent slots", () => {
  const mention = {
    id: "rq-jean-origin-place",
    schemaVersion: 1,
    status: "exhausted",
    personIds: ["jean"],
    question: "Where was Jean born?"
  };
  assert.deepEqual(questionGoalKeys(mention), []);
  assert.deepEqual(questionGoalKeys({
    ...mention,
    id: "rq-jean-parentage",
    question: "Who were Jean's parents?"
  }), [parentSlotGoalKey("jean", "father"), parentSlotGoalKey("jean", "mother")]);
  assert.deepEqual(questionGoalKeys({
    schemaVersion: 2,
    lifecycle: "active",
    conclusion: { state: "unresolved" },
    goalKeys: [{ kind: "parent-slot", personId: "jean", role: "mother" }]
  }), ["parent-slot:jean:mother"]);
});

test("dependency-deferred questions neither run nor own their frontier until all assertions establish", () => {
  const question = {
    schemaVersion: 2,
    lifecycle: "active",
    conclusion: { state: "unresolved" },
    goalKeys: ["parent-slot:ancestor:father"],
    deferred: true,
    dependsOnAssertionIds: ["assert-bridge-a", "assert-bridge-b"]
  };
  assert.equal(isLiveResearchQuestion(question), false);
  assert.equal(isQuestionExecutable(question), false);
  assert.deepEqual(questionGoalKeys(question), []);
  const establishedAssertionIds = new Set(["assert-bridge-a", "assert-bridge-b"]);
  assert.equal(isLiveResearchQuestion(question, { establishedAssertionIds }), true);
  assert.equal(isQuestionExecutable(question, { establishedAssertionIds }), true);
  assert.deepEqual(questionGoalKeys(question, { establishedAssertionIds }), ["parent-slot:ancestor:father"]);
});

test("v2 compatibility status orders superseded, answered, deferred, then open", () => {
  const base = {
    schemaVersion: 2,
    lifecycle: "active",
    conclusion: { state: "unresolved" }
  };
  assert.equal(questionCompatibilityStatus({ ...base, lifecycle: "superseded" }), "superseded");
  assert.equal(questionCompatibilityStatus({ ...base, conclusion: { state: "established" } }), "answered");
  const deferred = { ...base, deferred: true, dependsOnAssertionIds: ["assert-parent"] };
  assert.equal(questionCompatibilityStatus(deferred), "deferred");
  assert.equal(questionCompatibilityStatus(deferred, {
    establishedAssertionIds: new Set(["assert-parent"])
  }), "open");
  assert.equal(questionCompatibilityStatus(base), "open");
});

test("split questions inherit legacy attempt context without copying attempts", () => {
  const attempt = {
    id: "attempt-old",
    actionId: "search-old",
    attemptedAt: "2026-07-01T00:00:00.000Z",
    outcome: "not-found-bounded"
  };
  const legacy = { id: "rq-legacy", attempts: [attempt, {
    id: "attempt-unrelated",
    actionId: "search-other",
    attemptedAt: "2026-06-01T00:00:00.000Z",
    outcome: "no-new-information"
  }] };
  const split = {
    id: "rq-split",
    legacyQuestionIds: ["rq-legacy"],
    legacyAttemptIds: ["attempt-old"],
    attempts: [{
      id: "attempt-new",
      actionId: "search-new",
      attemptedAt: "2026-07-02T00:00:00.000Z",
      outcome: "located"
    }]
  };
  assert.deepEqual(researchAttemptsForQuestion(split, [split, legacy]).map((item) => item.id), ["attempt-new"]);
  const context = researchAttemptsForQuestion(split, [split, legacy], { includeInherited: true });
  assert.deepEqual(context.map((item) => item.id), ["attempt-old", "attempt-new"]);
  assert.equal(context[0].inheritedFromQuestionId, "rq-legacy");
  assert.equal(context.some((item) => item.id === "attempt-unrelated"), false);
  assert.equal(Object.hasOwn(split, "attempt-old"), false);
});

test("v2 supersession requires exact unique same-scope replacements", () => {
  const replacement = { id: "rq-new", schemaVersion: 2, lifecycle: "active", researchScope: "main" };
  const old = {
    id: "rq-old",
    schemaVersion: 2,
    lifecycle: "superseded",
    researchScope: "main",
    supersededBy: ["rq-new"]
  };
  assert.deepEqual(validateQuestionSupersession(old, [old, replacement]), []);
  assert.match(validateQuestionSupersession({ ...old, supersededBy: [] }, [old, replacement])[0], /nonempty/);
  assert.match(validateQuestionSupersession({ ...old, supersededBy: ["rq-new", "rq-new"] }, [old, replacement])[0], /repeats/);
  assert.match(validateQuestionSupersession({ ...old, supersededBy: ["rq-missing"] }, [old, replacement])[0], /missing/);
  assert.match(validateQuestionSupersession({ ...replacement, supersededBy: ["rq-old"] }, [old, replacement])[0], /active lifecycle/);
});

test("a recorded route dependency defers only while its target or owner action is still pending", () => {
  const waiting = (dependency) => ({ id: "rq-child", routeAssessment: { state: "in-progress", dependency } });
  const targetById = new Map([
    ["gated", { id: "gated", reconciliation: { state: "blocked" } }],
    ["moved", { id: "moved", reconciliation: { state: "actionable" } }]
  ]);
  const owner = {
    id: "rq-owner",
    actions: [
      { id: "pending", status: "ready" },
      { id: "held", status: "gated" },
      { id: "done", status: "completed" }
    ]
  };
  const questionById = new Map([["rq-owner", owner]]);
  const options = { targetById, questionById };
  assert.equal(routeDependencyPending(waiting({ targetId: "gated" }), options), true);
  assert.equal(routeDependencyPending(waiting({ targetId: "moved" }), options), false);
  assert.equal(routeDependencyPending(waiting({ targetId: "missing" }), options), false);
  assert.equal(routeDependencyPending(waiting({ questionId: "rq-owner", actionId: "pending" }), options), true);
  assert.equal(routeDependencyPending(waiting({ questionId: "rq-owner", actionId: "held" }), options), true);
  assert.equal(routeDependencyPending(waiting({ questionId: "rq-owner", actionId: "done" }), options), false);
  assert.equal(routeDependencyPending(waiting({ questionId: "rq-owner", actionId: "missing" }), options), false);
  assert.equal(routeDependencyPending(waiting({ questionId: "rq-owner", actionId: "pending" }), {
    ...options,
    isLive: () => false
  }), false, "a superseded owner never parks its dependent");
  assert.equal(routeDependencyPending({ id: "rq-owner", routeAssessment: {
    dependency: { questionId: "rq-owner", actionId: "pending" }
  } }, options), false, "a self-dependency never parks a question");
  assert.equal(routeDependencyPending({ id: "rq-plain" }, options), false);
});

test("the dry attempt streak counts back to the last candidate and ignores adapter errors", () => {
  const attempts = (...outcomes) => outcomes.map((outcome) => ({ outcome }));
  assert.equal(trailingDryAttemptCount([]), 0);
  assert.equal(trailingDryAttemptCount(attempts("not-found-bounded", "located", "no-new-information")), 3);
  assert.equal(trailingDryAttemptCount(attempts("located", "candidate-found", "blocked", "error", "located")), 2);
  assert.equal(trailingDryAttemptCount(attempts("located", "candidate-found")), 0);
});
