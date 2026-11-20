import assert from "node:assert/strict";
import test from "node:test";

import { buildStateV2MigrationProjection } from "./project-research-state-v2.mjs";
import { projectQuestionStateV2, projectTargetStateV2 } from "./research-state-v2.mjs";

test("migration helpers project v1 state without mutating source documents", () => {
  const question = {
    schemaVersion: 1,
    id: "rq-parentage",
    status: "exhausted",
    question: "Who were Person's parents?",
    personIds: ["person"],
    actions: [{ id: "search", kind: "search", status: "blocked", note: "Access changes" }]
  };
  const before = structuredClone(question);
  const projected = projectQuestionStateV2(question);
  assert.equal(projected.schemaVersion, 2);
  assert.equal(projected.conclusion.state, "unresolved");
  assert.equal(projected.routeAssessment.state, "unassessed");
  assert.equal(projected.actions[0].status, "gated");
  assert.deepEqual(projected.goalKeys, [
    "parent-slot:person:father", "parent-slot:person:mother"
  ]);
  assert.deepEqual(question, before);
});

test("target migration assigns research role and route discovery separately from gates", () => {
  const target = {
    schemaVersion: 4,
    id: "alternate",
    questionIds: ["rq-live"],
    reconciliation: { state: "blocked", reasonCode: "needs-alternate-route" }
  };
  const projection = projectTargetStateV2(target, [{ id: "rq-live", status: "blocked" }]);
  assert.equal(projection.schemaVersion, 4);
  assert.equal(projection.researchRole, "proof-blocking");
  assert.equal(projection.workState, "route-discovery");
  assert.equal(Object.hasOwn(projection, "gate"), false);
});

test("atomic frontier migration pins one person and selected legacy attempts without copying them", () => {
  const legacy = {
    id: "rq-combined",
    attempts: [
      { id: "attempt-z", attemptedAt: "2026-07-01T00:00:00.000Z" },
      { id: "attempt-a", attemptedAt: "2026-07-02T00:00:00.000Z" }
    ]
  };
  const split = {
    schemaVersion: 2,
    id: "rq-person-father",
    lifecycle: "active",
    conclusion: { state: "unresolved" },
    routeAssessment: { state: "unassessed" },
    goalKeys: ["parent-slot:person:father"],
    personIds: ["person"],
    legacyQuestionIds: ["rq-combined"],
    actions: []
  };
  const projection = projectQuestionStateV2(split, { questions: [legacy, split] });
  assert.equal(projection.frontierPersonId, "person");
  assert.deepEqual(projection.legacyAttemptIds, ["attempt-a", "attempt-z"]);
  assert.equal(Object.hasOwn(projection, "attempts"), false);
  assert.equal(projection.migration.requiresFrontierPersonReview, false);
});

test("migration never materializes derived target gates or bumps canonical target authority", () => {
  const target = {
    schemaVersion: 4,
    id: "fee-quoted",
    status: "access-gated",
    questionIds: ["rq-live"],
    reconciliation: {
      state: "blocked",
      reasonCode: "request-conflict-hold",
      routeId: "fee-route"
    },
    routes: [{
      id: "fee-route",
      requestProjection: { operationalState: "fee-quote-hold" }
    }]
  };
  const projection = projectTargetStateV2(target, [{ id: "rq-live", status: "blocked" }]);
  assert.equal(projection.schemaVersion, 4);
  assert.equal(Object.hasOwn(projection, "gate"), false);
  assert.equal(projection.migration.gateBasis, "schema-v1-derived");
});

test("read-only migration command API supports bounded question selection", () => {
  const result = buildStateV2MigrationProjection({
    questions: [{ id: "rq-one", schemaVersion: 1, status: "blocked", question: "Where?", actions: [] }],
    targets: [],
    questionId: "rq-one"
  });
  assert.equal(result.writesCanonicalState, false);
  assert.deepEqual(result.questions.map((item) => item.id), ["rq-one"]);
});
