import assert from "node:assert/strict";
import test from "node:test";

import { buildDepthReport, gradeAttempt, MIN_BRANCH_SAMPLE } from "./research-depth.mjs";
import { buildGoalState } from "./research-actions.mjs";

const q = (id, status, branchId = "english") => ({ id, status, branchId, priority: "P1" });

test("grades an acquired original above the index that framed the search", () => {
  assert.equal(gradeAttempt({
    source: "Findmypast Staffordshire Marriages",
    note: "Original register page 14 entry 41 records both parties of the parish"
  }), "original");
});

test("grades a bounded negative distinctly from an index hit", () => {
  assert.equal(gradeAttempt({ source: "FreeREG Staffordshire", outcome: "not-found-bounded" }), "bounded-negative");
  assert.equal(gradeAttempt({ source: "FreeREG Staffordshire", outcome: "candidate-found" }), "index");
});

test("flags thin exhaustions and leaves thin answered questions alone", () => {
  const questions = [q("a", "exhausted"), q("b", "answered"), q("c", "open")];
  const attempts = new Map([["a", [{}]], ["b", [{}]], ["c", [{}]]]);
  const report = buildDepthReport(questions, attempts);
  assert.deepEqual(report.flagged.map((entry) => entry.id), ["a"],
    "a one-attempt answered question is efficient, not defective");
});

test("a deep exhaustion is not flagged", () => {
  const report = buildDepthReport([q("deep", "exhausted")], new Map([["deep", Array.from({ length: 9 }, () => ({}))]]));
  assert.equal(report.flagged.length, 0);
});

test("v2 current-no-known-route and migrated exhaustion remain closure-review candidates", () => {
  const questions = [
    { id: "v2", branchId: "b", priority: "P1", routeAssessment: { state: "current-no-known-route" } },
    { id: "migrated", branchId: "b", priority: "P1", routeAssessment: { state: "unassessed", legacyStatus: "exhausted" } }
  ];
  const report = buildDepthReport(questions, new Map([["v2", [{}]], ["migrated", [{}]]]));
  assert.deepEqual(report.flagged.map((item) => item.id), ["migrated", "v2"]);
});

test("reports a distribution rather than a median", () => {
  const questions = ["a", "b", "c", "d"].map((id) => q(id, "open"));
  const attempts = new Map([["a", []], ["b", [{}]], ["c", [{}, {}, {}]], ["d", Array.from({ length: 12 }, () => ({}))]]);
  const report = buildDepthReport(questions, attempts);
  const branch = report.branches[0];
  assert.equal(branch.distribution["0"], 1);
  assert.equal(branch.distribution["1"], 1);
  assert.equal(branch.distribution["3-5"], 1);
  assert.equal(branch.distribution["11+"], 1);
  assert.ok(!("median" in branch), "a median would hide exactly the spread this exists to show");
});

test("small branches are guarded against a misleading branch-level rate", () => {
  const questions = [q("a", "exhausted", "tiny"), q("b", "exhausted", "tiny")];
  const report = buildDepthReport(questions, new Map([["a", [{}]], ["b", [{}]]]));
  assert.equal(report.warnings.length, 0, "two of two must not raise a branch-level alarm");
  assert.equal(report.branches[0].sampleTooSmallForRate, true);
  assert.equal(report.flagged.length, 2, "but each question is still individually visible");
});

test("a branch above the sample floor does raise a warning", () => {
  const questions = Array.from({ length: MIN_BRANCH_SAMPLE + 1 }, (_, i) => q(`q${i}`, "exhausted"));
  const attempts = new Map(questions.map((question) => [question.id, [{}]]));
  const report = buildDepthReport(questions, attempts);
  assert.equal(report.warnings.length, 1);
  assert.match(report.warnings[0], /closure review/);
});

test("thin questions carried by original evidence are tracked separately", () => {
  const questions = [q("orig", "exhausted"), q("idx", "exhausted")];
  const attempts = new Map([
    ["orig", [{ note: "acquired original register image" }]],
    ["idx", [{ source: "FreeREG", outcome: "candidate-found" }]]
  ]);
  const report = buildDepthReport(questions, attempts);
  assert.equal(report.questions.find((e) => e.id === "orig").hasOriginalEvidence, true);
  assert.equal(report.branches[0].thinWithoutOriginal, 1);
});

test("goal state is RUNNABLE whenever any canonical item can be taken", () => {
  const state = buildGoalState({ readyQuestionCount: 0, closureReviewCount: 3, needsUserCount: 62 });
  assert.equal(state.operationalState, "RUNNABLE");
  assert.equal(state.blocked, false);
});

test("gates make a goal blocked rather than unreportable", () => {
  // The original rule said BLOCKED required every category to be empty, which
  // inverted it: with no gates there is nothing to be blocked on.
  const state = buildGoalState({ needsUserCount: 62, waitingExternalCount: 24 });
  assert.equal(state.operationalState, "NEEDS USER");
  assert.equal(state.blocked, true);
});

test("waiting external leads when it dominates", () => {
  assert.equal(buildGoalState({ needsUserCount: 1, waitingExternalCount: 9 }).operationalState, "WAITING EXTERNAL");
});

test("an empty queue with no gates is reported without an epistemic claim", () => {
  const state = buildGoalState({});
  assert.equal(state.operationalState, "NO CANONICAL WORK KNOWN");
  assert.match(state.neverClaim, /does not mean no leads exist/);
});

test("full origin-gap coverage is labelled a coverage result, not a depth result", () => {
  const state = buildGoalState({ originGapCount: 101, uncoveredOriginGapCount: 0, needsUserCount: 1 });
  assert.match(state.coverageNote, /coverage result, not a depth result/);
});

test("an uncovered origin gap counts as runnable work", () => {
  assert.equal(buildGoalState({ uncoveredOriginGapCount: 2 }).operationalState, "RUNNABLE");
});

test("an independently entitled expiring route keeps the goal runnable", () => {
  const state = buildGoalState({
    expiringAuthorizedAccessCount: 1,
    waitingExternalCount: 1
  });
  assert.equal(state.operationalState, "RUNNABLE");
  assert.equal(state.runnableCount, 1);
});
