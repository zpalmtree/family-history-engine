import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import assert from "node:assert/strict";
import { renderCurrentStateBlock } from "./build-research-current-state.mjs";
import { buildResearchProjections } from "./research-projections.mjs";
import { loadResearchStore, projectRoot, readJson } from "./research-store.mjs";
import { buildCompactNextResult, buildSignInReminders } from "./research-status-compact.mjs";
import { buildSessionQueueSummary, resolveSessionSelection } from "./research-session-status.mjs";
import { isQuestionOperationallyOpen } from "./research-question-state.mjs";

const store = loadResearchStore();
const manifest = readJson(path.join(projectRoot, "evidence", "records-manifest.json"));
const acquisitionTargets = buildResearchProjections(store, { manifest }).acquisitionSession.targets;

// Each research-status run loads and projects the whole store (about 1.5 s).
// These read-only runs used to execute one after another and made this file
// the critical path of research:test, so the independent ones start together
// here and each distinct argument list runs once.
const execFileAsync = promisify(execFile);
const statusRuns = new Map();
function runStatus(args) {
  const key = JSON.stringify(args);
  if (!statusRuns.has(key)) {
    const run = execFileAsync(process.execPath, ["tools/research-status.mjs", ...args], {
      cwd: projectRoot,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024
    }).then(({ stdout }) => stdout);
    run.catch(() => {}); // a failure is reported by the test that awaits it
    statusRuns.set(key, run);
  }
  return statusRuns.get(key);
}
const staleCheckpoint = "0".repeat(64);
const narrowedQuestionId = store.questions.find((question) => !question.researchScope).id;
for (const args of [
  ["--next", "--json"],
  ["--json"],
  ["--json", "--question", narrowedQuestionId],
  ["--needs-user", "--json"],
  ["--needs-user"],
  ["--needs-user", "--all", "--json"],
  ["--needs-user", "--checkpoint", staleCheckpoint, "--json"]
]) runStatus(args);

test("compact next status contains one exact work item within a fixed size budget", async () => {
  const output = await runStatus(["--next", "--json"]);
  const status = JSON.parse(output);
  assert.ok(Buffer.byteLength(output) <= 16 * 1024, `compact next status is ${Buffer.byteLength(output)} bytes`);
  assert.ok(!Object.hasOwn(status, "questions"));
  assert.ok(!Object.hasOwn(status, "actionableAcquisitions"));
  assert.equal(status.scope, "main");
  const establishedAssertionIds = new Set([
    ...store.people, ...store.unions, ...(store.kinships || [])
  ].flatMap((bundle) => bundle.assertions || [])
    .filter((assertion) => assertion.assessment === "established")
    .map((assertion) => assertion.id));
  assert.equal(status.counts.questions.open, store.questions.filter((question) =>
    !question.researchScope && isQuestionOperationallyOpen(question, { establishedAssertionIds })).length);
  assert.ok(status.counts.unblock.needsUser >= 0);
  assert.ok(status.counts.unblock.waitingExternal >= 0);
  // The master re-read campaign can be complete (it was on 11 Nov 2026), so
  // the live store may have no pending source review.
  assert.ok(Number.isInteger(status.counts.reviews.sourcePending) && status.counts.reviews.sourcePending >= 0);
  assert.equal(typeof status.counts.reviews.sourceByState, "object");

  if (status.nextKind === "question") {
    const question = store.questions.find((item) => item.id === status.next.id);
    assert.ok(question, status.next.id);
    const expectedAction = question.actions.find((action) => action.status === "ready") || status.next.action;
    assert.equal(status.next.kind, "question");
    assert.equal(status.next.action?.id || null, expectedAction?.id || null);
    assert.ok(status.next.action || status.next.acquisition);
    assert.ok(status.next.latestAttempts.length <= 3);
    if (status.next.action) {
      if (!status.next.action.derived) {
        assert.ok(status.next.latestAttempts.every((attempt) => attempt.actionId === status.next.action.id));
      }
    }
    const fullNeedsUser = JSON.parse(await runStatus(["--needs-user", "--all", "--json"]));
    const relatedIds = new Set(fullNeedsUser.items
      .filter((item) => item.questionIds.includes(question.id)).map((item) => item.id));
    assert.ok(status.next.blockers.every((blocker) => relatedIds.has(blocker.id) && blocker.resumeToken));
  } else if (status.nextKind === "source-review") {
    assert.equal(status.next.kind, "source-review");
    assert.equal(status.next.executable, true);
    assert.ok(status.next.records.length > 0 && status.next.records.length <= 20);
    assert.ok(status.next.records.every((record) => record.researchScope === "main" && record.state));
    assert.equal(status.scheduler.selection.itemId, status.next.id);
    assert.equal(status.scheduler.selection.kind, "source-review");
  } else if (status.nextKind === "acquisition") {
    assert.equal(status.next.kind, "acquisition");
    assert.equal(status.next.state, "actionable");
    assert.ok(status.next.latestAttempts.length <= 3);
  } else if (status.nextKind === "origin-gap") {
    assert.equal(status.next.kind, "origin-gap");
    assert.equal(status.next.executable, true);
    assert.ok(status.next.personId);
    assert.ok(status.next.generation > 0);
    assert.deepEqual(status.next.latestAttempts, []);
    assert.deepEqual(status.next.blockers, []);
  } else if (["closure-review", "reopen-trigger"].includes(status.nextKind)) {
    assert.equal(status.next.kind, status.nextKind);
    assert.equal(status.next.executable, true);
    assert.ok(status.next.questionId);
    assert.equal(status.next.action.derived, true);
    assert.ok(status.next.latestAttempts.length <= 3);
  } else if (status.nextKind === "route-discovery") {
    assert.equal(status.next.kind, "route-discovery");
    assert.equal(status.next.executable, true);
    assert.ok(status.next.targetId);
    assert.equal(status.next.action.derived, true);
  } else {
    assert.equal(status.next, null);
    assert.ok(status.noSelection?.reasonCode);
    assert.ok(status.blockers.length <= 5);
  }
});

test("compact selection preserves standalone acquisition route attempts", () => {
  const attempts = [1, 2, 3, 4].map((day) => ({
    id: `attempt-${day}`,
    attemptedAt: `2026-07-0${day}T00:00:00.000Z`,
    outcome: day === 4 ? "retryable-error" : "no-new-information",
    note: `attempt ${day}`
  }));
  const target = {
    id: "target-ready",
    priority: "P1",
    provider: "Archive",
    reference: "Exact record",
    questionIds: [],
    reconciliation: { state: "actionable", status: "ready-download", routeId: "route-ready" },
    routes: [{ id: "route-ready", attempts }]
  };
  const status = buildCompactNextResult({
    fullResult: {
      generatedFrom: "test",
      openQuestionCount: 0,
      readyQuestionCount: 0,
      actionableAcquisitionCount: 1,
      standaloneActionableAcquisitionCount: 1,
      questions: [],
      nextKind: "acquisition",
      next: { id: target.id },
      noSelection: null
    },
    canonicalQuestions: [],
    acquisitionTargets: [target],
    needsUser: { needsUserCount: 0, waitingExternalCount: 0, items: [] }
  });
  assert.equal(status.next.id, target.id);
  assert.equal(status.next.routeId, "route-ready");
  assert.deepEqual(status.next.latestAttempts.map((attempt) => attempt.id), ["attempt-4", "attempt-3", "attempt-2"]);
});

test("default needs-user output groups exact tokens and retains full detail behind --all", async () => {
  const compactOutput = await runStatus(["--needs-user", "--json"]);
  const humanOutput = await runStatus(["--needs-user"]);
  const fullOutput = await runStatus(["--needs-user", "--all", "--json"]);
  const compact = JSON.parse(compactOutput);
  const full = JSON.parse(fullOutput);
  // A new tree may have nothing waiting on its owner yet.
  if (!full.items.length) {
    assert.equal(compact.needsUserCount + compact.waitingExternalCount, 0);
    return;
  }
  assert.ok(Buffer.byteLength(compactOutput) <= 30 * 1024, `compact needs-user JSON is ${Buffer.byteLength(compactOutput)} bytes`);
  assert.ok(Buffer.byteLength(humanOutput) <= 16 * 1024, `compact needs-user text is ${Buffer.byteLength(humanOutput)} bytes`);
  assert.ok(Buffer.byteLength(compactOutput) < Buffer.byteLength(fullOutput));
  assert.ok(!Object.hasOwn(compact, "items"));
  assert.ok(Array.isArray(full.items));
  assert.equal(compact.groups.reduce((count, group) => count + (group.kind === "needs-user" ? group.count : 0), 0), compact.needsUserCount);
  assert.equal(compact.groups.reduce((count, group) => count + (group.kind === "waiting-external" ? group.count : 0), 0), compact.waitingExternalCount);
  assert.equal(new Set(compact.groups.map((group) => `${group.kind}\u0000${group.resumeToken}`)).size, compact.groups.length);
  assert.ok(compact.groups.every((group) => group.resumeToken && /^P[0-3]$/.test(group.highestPriority)
    && group.count === group.itemIds.length));
  const expectedGroups = new Map();
  for (const item of full.items) {
    const key = `${item.kind}\u0000${item.resumeToken}`;
    if (!expectedGroups.has(key)) expectedGroups.set(key, []);
    expectedGroups.get(key).push(item.id);
  }
  const normalizeGroups = (entries) => entries
    .map(([key, ids]) => [key, [...ids].sort()])
    .sort(([first], [second]) => first.localeCompare(second));
  assert.deepEqual(normalizeGroups(compact.groups.map((group) =>
    [`${group.kind}\u0000${group.resumeToken}`, group.itemIds])),
  normalizeGroups([...expectedGroups]));
  assert.match(humanOutput, /Use --needs-user --all for full/);
});

test("needs-user checkpoints suppress unchanged repetition without claiming a delta", async () => {
  const initial = JSON.parse(await runStatus(["--needs-user", "--json"]));
  if (!initial.needsUserCount && !initial.waitingExternalCount) return; // nothing to suppress in a new tree
  const unchangedOutput = await runStatus(["--needs-user", "--checkpoint", initial.checkpoint, "--json"]);
  const unchanged = JSON.parse(unchangedOutput);
  assert.equal(unchanged.checkpoint, initial.checkpoint);
  assert.deepEqual(unchanged.comparison, { checkpoint: initial.checkpoint, changed: false });
  assert.equal(unchanged.groupsSuppressedUnchanged, true);
  assert.deepEqual(unchanged.groups, []);
  assert.deepEqual(unchanged.signInReminders, initial.signInReminders,
    "open sign-ins are repeated even when the rollup is unchanged");
  assert.ok(Buffer.byteLength(unchangedOutput) <= 2 * 1024);

  const oldCheckpoint = staleCheckpoint;
  const changed = JSON.parse(await runStatus(["--needs-user", "--checkpoint", oldCheckpoint, "--json"]));
  assert.deepEqual(changed.comparison, { checkpoint: oldCheckpoint, changed: true });
  assert.equal(changed.groupsSuppressedUnchanged, false);
  assert.ok(changed.groups.length > 0);
});

test("generated branch blocks keep operational detail and summarize history within budget", () => {
  const targetsByQuestion = new Map();
  for (const target of acquisitionTargets) for (const questionId of target.questionIds || []) {
    if (!targetsByQuestion.has(questionId)) targetsByQuestion.set(questionId, []);
    targetsByQuestion.get(questionId).push(target);
  }
  let totalBytes = 0;
  for (const branch of store.branches.branches) {
    const questions = store.questions.filter((question) => question.branchId === branch.id);
    const questionIds = new Set(questions.map((question) => question.id));
    const branchTargets = acquisitionTargets.filter((target) =>
      (target.questionIds || []).some((questionId) => questionIds.has(questionId)));
    const block = renderCurrentStateBlock({ questions, targetsByQuestion, branchTargets });
    const bytes = Buffer.byteLength(block);
    totalBytes += bytes;
    assert.ok(bytes <= 30 * 1024, `${branch.id} generated block is ${bytes} bytes`);
    assert.match(block, /\[question store\]\(\.\.\/research\/questions\/\)/);
    assert.match(block, /\[acquisition store\]\(\.\.\/acquisition\/targets\/\)/);
    for (const question of questions.filter((item) => ["open", "blocked"].includes(item.status))) {
      assert.match(block, new RegExp("Canonical ID: `" + escapeRegex(question.id) + "`"));
    }
    for (const question of questions.filter((item) => !["open", "blocked"].includes(item.status))) {
      assert.doesNotMatch(block, new RegExp("Canonical ID: `" + escapeRegex(question.id) + "`"));
    }
    for (const target of branchTargets.filter((item) => item.reconciliation.state !== "satisfied")) {
      assert.match(block, new RegExp(`acquisition/targets/${escapeRegex(target.id)}\\.json`));
      if (target.reconciliation.routeId) {
        assert.doesNotMatch(block, new RegExp(" via `" + escapeRegex(target.reconciliation.routeId) + "`"));
      }
    }
    for (const target of branchTargets.filter((item) => item.reconciliation.state === "satisfied")) {
      assert.doesNotMatch(block, new RegExp(`acquisition/targets/${escapeRegex(target.id)}\\.json`));
    }
  }
  // Each run reads only the selected branch's block (GOAL.md, start step 5),
  // so the per-branch cap above is the real context bound. A total across
  // branches grows with every legitimately unresolved question and was raised
  // from 56 to 60 KiB in August before ordinary route-state lines exceeded it
  // again on 2026-10-07 (61,575 bytes; largest branch 24.7 KiB). Keep the total
  // only as a runaway guard: no larger than every branch at its own cap.
  assert.ok(totalBytes <= store.branches.branches.length * 30 * 1024,
    `all generated current-state blocks total ${totalBytes} bytes`);
});

test("the full report narrows to one requested question without changing its counts or selection", async () => {
  const full = JSON.parse(await runStatus(["--json"]));
  const narrowed = JSON.parse(await runStatus(["--json", "--question", narrowedQuestionId]));
  assert.deepEqual(narrowed.questions, full.questions.filter((question) => question.id === narrowedQuestionId));
  assert.equal(narrowed.questions.length, 1);
  const { questions: fullQuestions, scheduler: fullScheduler, ...fullRest } = full;
  const { questions: narrowedQuestions, scheduler: narrowedScheduler, ...narrowedRest } = narrowed;
  assert.deepEqual(narrowedRest, fullRest);
  assert.equal(narrowedScheduler?.selection?.itemId, fullScheduler?.selection?.itemId);
  await assert.rejects(runStatus(["--next", "--json", "--question", narrowedQuestionId]), /only with the full --json report/);
});

test("session status consumes compact selection without duplicating selected summary", () => {
  const source = fs.readFileSync(path.join(projectRoot, "tools", "research-session-status.mjs"), "utf8");
  assert.match(source, /\["--scope", scope, "--next", "--json"\]/);
  assert.doesNotMatch(source, /queue:\s*\{[^}]*selectedSummary/s);
});

test("full, compact, and session selection agree and runnable work always has a next item", async () => {
  const full = JSON.parse(await runStatus(["--json"]));
  const compact = JSON.parse(await runStatus(["--next", "--json"]));
  assert.equal(compact.nextKind, full.nextKind);
  assert.equal(compact.next?.id || null, full.next?.id || null);
  assert.equal(compact.counts.runnable, full.goalState.runnableCount);
  assert.equal(compact.counts.reviews.closure, full.closureReviewCount);
  assert.equal(compact.counts.reviews.source, full.sourceReviewCount);
  assert.equal(compact.counts.reviews.sourcePending, full.sourceReviewPendingCount);
  assert.deepEqual(compact.counts.reviews.sourceByState, full.sourceReviewCounts);
  assert.equal(compact.counts.reviews.sourceIssues, full.sourceReviewIssueCount);
  assert.equal(compact.counts.reviews.reopenTriggers, full.reopenTriggerCount);
  assert.equal(compact.counts.reviews.routeDiscovery, full.routeDiscoveryCount);
  if (full.goalState.runnableCount > 0) assert.ok(full.next, "RUNNABLE must imply a selected next item");
  const session = resolveSessionSelection(compact);
  assert.equal(session.kind, compact.nextKind);
  assert.equal(session.id, compact.next?.id || null);
  const sessionQueue = buildSessionQueueSummary(compact);
  assert.equal(sessionQueue.sourceReviewPendingCount, compact.counts.reviews.sourcePending);
  assert.deepEqual(sessionQueue.sourceReviewCounts, compact.counts.reviews.sourceByState);
  assert.equal(sessionQueue.nextKind, compact.nextKind);
  // An exhausted queue (every question parked or gated) is legitimate and binds no selection.
  if (compact.next) assert.equal(sessionQueue.scheduler.selection.itemId, compact.next.id);
  else assert.ok(!sessionQueue.scheduler?.selection?.itemId, "an exhausted queue binds no selected item");
  assert.deepEqual({
    cadenceId: compact.scheduler.cadenceId,
    scope: compact.scheduler.scope,
    recordRevision: compact.scheduler.recordRevision,
    cursor: compact.scheduler.cursor,
    selectedLane: compact.scheduler.selectedLane,
    selectedSlot: compact.scheduler.selectedSlot,
    nextCursor: compact.scheduler.nextCursor
  }, {
    cadenceId: full.scheduler.cadenceId,
    scope: full.scheduler.scope,
    recordRevision: full.scheduler.recordRevision,
    cursor: full.scheduler.cursor,
    selectedLane: full.scheduler.selectedLane,
    selectedSlot: full.scheduler.selectedSlot,
    nextCursor: full.scheduler.nextCursor
  });
});

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("sign-in reminders group open provider sign-ins and ignore every other gate", () => {
  const item = (id, kind, venueId, resumeToken) => ({
    id, kind, resumeToken, venue: { id: venueId, label: `${venueId} label` }
  });
  assert.deepEqual(buildSignInReminders([
    item("a", "needs-user", "sign-in-tna", "READY a"),
    item("b", "needs-user", "sign-in-tna", "READY b"),
    item("c", "needs-user", "sign-in-mdlandrec", "READY sign-in-mdlandrec"),
    item("d", "needs-user", "payment-decision", "PAY d"),
    item("e", "waiting-external", "sign-in-tna", "RECEIVED e")
  ]), [
    { id: "sign-in-mdlandrec", label: "sign-in-mdlandrec label", count: 1, resumeTokens: ["READY sign-in-mdlandrec"] },
    { id: "sign-in-tna", label: "sign-in-tna label", count: 2, resumeTokens: ["READY a", "READY b"] }
  ]);
});
