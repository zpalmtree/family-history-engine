import { execFileSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildNoSelectionReason,
  isResearchActionExecutable,
  isResearchAttemptOutcome,
  researchActionStatusAfterAttempt,
  researchActionStatuses,
  selectExecutableResearchAction,
  validateResearchAction
} from "./research-actions.mjs";
import { resolveSessionSelection } from "./research-session-status.mjs";
import { loadResearchStore, projectRoot } from "./research-store.mjs";

test("research actions use one explicit executable status", () => {
  assert.deepEqual(researchActionStatuses, ["ready", "gated", "blocked", "completed", "retired"]);
  assert.equal(isResearchActionExecutable({ status: "ready" }), true);
  assert.equal(isResearchActionExecutable({ status: "blocked" }), false);
  assert.equal(isResearchActionExecutable({ status: "completed" }), false);
  assert.equal(isResearchActionExecutable({ status: "planned" }), false);
  assert.equal(selectExecutableResearchAction([
    { id: "gated", status: "blocked" },
    { id: "done", status: "completed" },
    { id: "run-me", status: "ready" }
  ])?.id, "run-me");
  assert.equal(selectExecutableResearchAction([
    { id: "gated", status: "blocked" },
    { id: "done", status: "completed" }
  ]), null);
});

test("research action validation rejects ambiguous lifecycle states", () => {
  assert.deepEqual(validateResearchAction(
    { id: "work", kind: "search", status: "ready" },
    { questionId: "rq-test", questionStatus: "open" }
  ), []);
  assert.match(validateResearchAction(
    { id: "work", kind: "search", status: "planned" },
    { questionId: "rq-test", questionStatus: "open" }
  )[0], /invalid status planned/);
  assert.match(validateResearchAction(
    { id: "work", kind: "search", status: "ready" },
    { questionId: "rq-test", questionStatus: "blocked" }
  )[0], /ready while its question is blocked/);
  assert.match(validateResearchAction(
    { id: "work", kind: "search", status: "blocked" },
    { questionId: "rq-test", questionStatus: "open" }
  )[0], /without a structured gate or resume condition/);
  assert.deepEqual(validateResearchAction(
    { id: "work", kind: "search", status: "gated", gate: { actor: "user" } },
    { questionId: "rq-test", questionStatus: "open" }
  ), []);
  assert.deepEqual(validateResearchAction(
    { id: "work", kind: "search", status: "blocked", note: "Resume after READY rq-test." },
    { questionId: "rq-test", questionStatus: "open" }
  ), []);
});

test("attempt outcomes make lifecycle transitions explicit", () => {
  assert.equal(isResearchAttemptOutcome("candidate-found"), true);
  assert.equal(isResearchAttemptOutcome("pending"), false);
  for (const outcome of ["located", "not-found-bounded", "no-new-information"]) {
    assert.equal(researchActionStatusAfterAttempt("ready", outcome), "completed", outcome);
  }
  assert.equal(researchActionStatusAfterAttempt("ready", "blocked"), "blocked");
  assert.equal(researchActionStatusAfterAttempt("ready", "candidate-found"), "ready");
  assert.equal(researchActionStatusAfterAttempt("ready", "error"), "ready");
  assert.throws(
    () => researchActionStatusAfterAttempt("blocked", "located"),
    /only a ready action/
  );
  assert.throws(
    () => researchActionStatusAfterAttempt("completed", "candidate-found"),
    /only a ready action/
  );
});

test("no-selection states name both the reason and resume path", () => {
  const gated = buildNoSelectionReason({
    openQuestionCount: 4,
    blockedActionCount: 3,
    needsUserCount: 2,
    waitingExternalCount: 1
  });
  assert.equal(gated.reasonCode, "all-open-work-gated");
  assert.match(gated.message, /none has a ready action/);
  assert.match(gated.resume, /2 need user action/);

  const triage = buildNoSelectionReason({
    openQuestionCount: 1,
    blockedActionCount: 0,
    needsUserCount: 0,
    waitingExternalCount: 0
  });
  assert.equal(triage.reasonCode, "open-work-needs-triage");
  assert.match(triage.resume, /Add a justified ready action/);

  const empty = buildNoSelectionReason({
    openQuestionCount: 0,
    blockedActionCount: 0,
    needsUserCount: 0,
    waitingExternalCount: 0
  });
  assert.equal(empty.reasonCode, "no-open-questions");
  assert.match(empty.resume, /Create or reopen/);
});

test("session selection never falls back to the first open question", () => {
  const openButGated = {
    nextKind: null,
    next: null,
    questions: [{ id: "rq-blocked", status: "open" }]
  };
  assert.deepEqual(resolveSessionSelection(openButGated), {
    kind: null,
    id: null,
    item: null,
    source: "queue"
  });
  assert.deepEqual(resolveSessionSelection(openButGated, { questionId: "rq-blocked" }), {
    kind: "question",
    id: "rq-blocked",
    source: "requested"
  });
  assert.deepEqual(resolveSessionSelection({
    nextKind: "question",
    next: { id: "rq-ready" }
  }), {
    kind: "question",
    id: "rq-ready",
    source: "queue"
  });
  assert.deepEqual(resolveSessionSelection({
    nextKind: "closure-review",
    next: { id: "closure-review-rq-ready", questionId: "rq-ready" }
  }), {
    kind: "closure-review",
    id: "closure-review-rq-ready",
    item: { id: "closure-review-rq-ready", questionId: "rq-ready" },
    source: "queue"
  });
  assert.deepEqual(resolveSessionSelection({
    nextKind: "acquisition",
    next: { id: "record-ready", provider: "Archive" }
  }), {
    kind: "acquisition",
    id: "record-ready",
    item: { id: "record-ready", provider: "Archive" },
    source: "queue"
  });
  assert.deepEqual(resolveSessionSelection({
    nextKind: "origin-gap",
    next: { id: "origin-gap-example", personId: "example-person" }
  }), {
    kind: "origin-gap",
    id: "origin-gap-example",
    item: { id: "origin-gap-example", personId: "example-person" },
    source: "queue"
  });
});

test("canonical questions contain only validated lifecycle states", () => {
  const store = loadResearchStore();
  for (const question of store.questions) {
    for (const action of question.actions || []) {
      assert.deepEqual(validateResearchAction(action, {
        questionId: question.id,
        questionStatus: question.status
      }), [], `${question.id}/${action.id}`);
    }
  }

  const status = JSON.parse(execFileSync(
    process.execPath,
    ["tools/research-status.mjs", "--json"],
    { cwd: projectRoot, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }
  ));
  if (status.nextKind === "question") {
    const ownedAcquisition = (status.next.acquisition || []).find((target) =>
      target.state === "actionable" && target.researchRole === "proof-blocking");
    assert.ok(status.next.actions.some(isResearchActionExecutable)
      || status.next.triageAction?.derived || ownedAcquisition);
    if (ownedAcquisition) {
      assert.ok(status.actionableAcquisitions.some((target) =>
        target.id === ownedAcquisition.id && target.state === "actionable"
        && target.researchRole === "proof-blocking"
        && target.questionIds.includes(status.next.id)));
    }
  } else if (status.nextKind === "source-review") {
    assert.equal(status.next.researchScope, "main");
    assert.ok(status.next.records.length > 0 && status.next.records.length <= 20);
    assert.ok(status.next.records.every((record) => record.researchScope === "main" && record.state));
  } else if (status.nextKind === "acquisition") {
    assert.equal(status.next.state, "actionable");
  } else if (status.nextKind === "origin-gap") {
    assert.ok(status.next.personId);
    assert.equal(status.next.uncovered, true);
  } else if (["closure-review", "reopen-trigger"].includes(status.nextKind)) {
    assert.ok(status.next.questionId);
    assert.equal(status.next.action?.derived, true);
  } else if (status.nextKind === "route-discovery") {
    assert.ok(status.next.targetId);
    assert.equal(status.next.action?.derived, true);
  } else {
    assert.ok(status.noSelection?.reasonCode);
    assert.ok(status.noSelection?.resume);
  }
  assert.equal(status.next ? status.noSelection : null, null);
});
