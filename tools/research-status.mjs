#!/usr/bin/env node

import path from "node:path";
import {
  buildGoalState,
  buildNoSelectionReason,
  isResearchActionExecutable
} from "./research-actions.mjs";
import { buildDepthReport } from "./research-depth.mjs";
import { findBriefsForQuestion } from "./research-briefs.mjs";
import { evaluateReopenTriggers } from "./reopen-triggers.mjs";
import { buildNeedsUserResult, priorityRank } from "./needs-user.mjs";
import {
  buildPaymentLedger,
  formatAttentionLine,
  formatLedgerHeadline,
  paymentAttentionEntries,
  summarizeLedger
} from "./payment-ledger.mjs";
import { buildExtractionStatus, loadExtractionStore } from "./extraction-store.mjs";
import { buildExpiringAuthorizedAccessItems } from "./research-access-preemption.mjs";
import {
  buildOriginGaps,
  buildAutonomousQuestionTriageQuestions,
  buildQuestionTriageAction,
  originGapQuestion
} from "./research-origin-gaps.mjs";
import {
  assertRunnableSelection,
  buildClosureReviewItems,
  buildReopenTriggerItems,
  buildRouteDiscoveryItems,
  buildSourceReviewItems,
  selectFairQueueItem
} from "./research-queue.mjs";
import {
  bindResearchSchedulerSelection,
  loadResearchSchedulerRecord,
  schedulerStatus
} from "./research-scheduler-store.mjs";
import {
  isLiveResearchQuestion,
  isQuestionExecutable,
  isQuestionOperationallyOpen,
  questionCompatibilityStatus,
  questionConclusionState,
  questionGoalKeys,
  questionLifecycleState,
  questionWorkState,
  researchAttemptsForQuestion,
  routeDependencyPending,
  trailingDryAttemptCount,
  DRY_ATTEMPT_STREAK_THRESHOLD
} from "./research-question-state.mjs";
import { targetResearchRole } from "./research-target-state.mjs";
import { buildResearchProjections } from "./research-projections.mjs";
import { loadResearchStore, projectRoot, readJson } from "./research-store.mjs";
import {
  buildCompactNeedsUserResult,
  buildCompactNextResult,
  buildFullNeedsUserResult
} from "./research-status-compact.mjs";
import { inResearchScope, parseResearchScope, researchScopeOf } from "./research-scope.mjs";
import { loadTreeConfig } from "./tree-config.mjs";

const args = process.argv.slice(2);
const scope = parseResearchScope(args);

const store = loadResearchStore();
const manifest = readJson(path.join(projectRoot, "evidence", "records-manifest.json"));
const projections = buildResearchProjections(store, { manifest });
const acquisition = {
  ...projections.acquisitionSession,
  targets: projections.acquisitionSession.targets.filter((target) => inResearchScope(target, scope))
};
const canonicalQuestions = store.questions.filter((question) => inResearchScope(question, scope));
const establishedAssertionIds = new Set([
  ...store.people,
  ...store.unions,
  ...(store.kinships || [])
].flatMap((bundle) => bundle.assertions || [])
  .filter((assertion) => assertion.assessment === "established")
  .map((assertion) => assertion.id));
const stateOptions = { establishedAssertionIds };
const targetsByQuestion = new Map();
for (const target of acquisition.targets) for (const questionId of target.questionIds || []) {
  if (!targetsByQuestion.has(questionId)) targetsByQuestion.set(questionId, []);
  targetsByQuestion.get(questionId).push(target);
}
const branchRank = new Map(store.branches.branches.map((branch) => [branch.id, branch.priority]));
const questions = canonicalQuestions.map((question) => ({
  schemaVersion: question.schemaVersion,
  id: question.id,
  branchId: question.branchId,
  question: question.question,
  priority: question.priority,
  status: questionCompatibilityStatus(question, stateOptions),
  lifecycle: questionLifecycleState(question),
  conclusionState: questionConclusionState(question),
  live: isLiveResearchQuestion(question, stateOptions),
  workState: questionWorkState(question, stateOptions),
  deferred: Boolean(question.deferred),
  dependsOnAssertionIds: [...(question.dependsOnAssertionIds || [])],
  ...(question.frontierPersonId ? { frontierPersonId: question.frontierPersonId } : {}),
  legacyQuestionIds: [...(question.legacyQuestionIds || [])],
  legacyAttemptIds: [...(question.legacyAttemptIds || [])],
  goalKeys: questionGoalKeys(question, stateOptions),
  ...(question.routeAssessment ? { routeAssessment: question.routeAssessment } : {}),
  researchScope: researchScopeOf(question),
  ...(question.workstream ? { workstream: question.workstream, queueOrder: question.queueOrder } : {}),
  reopenWhen: [...(question.reopenWhen || [])],
  actions: (question.actions || []).map((action) => ({
    id: action.id,
    kind: action.kind,
    status: action.status,
    note: action.note,
    ...(action.acquisitionTargetId ? { acquisitionTargetId: action.acquisitionTargetId } : {})
  })),
  acquisition: (targetsByQuestion.get(question.id) || []).map((target) => {
    const state = !isQuestionExecutable(question, stateOptions) && target.reconciliation.state === "actionable"
      ? "not-applicable"
      : target.reconciliation.state;
    return {
      id: target.id,
      status: target.status,
      state,
      provider: target.provider,
      researchRole: targetResearchRole(target, canonicalQuestions, stateOptions),
      ...(state === "actionable" && target.reconciliation.routeId
        ? { routeId: target.reconciliation.routeId }
        : {})
    };
  })
})).sort((first, second) => workstreamRank(first) - workstreamRank(second)
  || queueRank(first) - queueRank(second)
  || priorityRank(first.priority) - priorityRank(second.priority)
  || (branchRank.get(first.branchId) || 999) - (branchRank.get(second.branchId) || 999)
  || first.id.localeCompare(second.id));
const canonicalById = new Map(canonicalQuestions.map((question) => [question.id, question]));
// A question that recorded a dependency on a gated request or on another
// question's pending action is not rescheduled around that wait. Only its own
// ready action can select it; target readiness and triage cannot.
const targetById = new Map(acquisition.targets.map((target) => [target.id, target]));
const awaitingDependencyIds = new Set(canonicalQuestions
  .filter((question) => routeDependencyPending(question, {
    targetById,
    questionById: canonicalById,
    isLive: (owner) => isLiveResearchQuestion(owner, stateOptions)
  }))
  .map((question) => question.id));
const ready = questions.filter((question) => isQuestionExecutable(canonicalById.get(question.id), stateOptions))
  .filter((question) => question.actions.some(isResearchActionExecutable)
    || (!awaitingDependencyIds.has(question.id)
      && question.acquisition.some((target) => target.state === "actionable"
        && target.researchRole === "proof-blocking")));
const actionableAcquisitions = acquisition.targets
  .filter((target) => target.reconciliation.state === "actionable")
  .map((target) => ({
    id: target.id,
    priority: target.priority,
    status: target.status,
    state: target.reconciliation.state,
    provider: target.provider,
    researchRole: targetResearchRole(target, canonicalQuestions, stateOptions),
    routeId: target.reconciliation.routeId,
    reference: target.reference,
    questionIds: [...(target.questionIds || [])]
  }))
  .sort((first, second) => priorityRank(first.priority) - priorityRank(second.priority)
    || first.id.localeCompare(second.id));
const runnableActionableAcquisitions = actionableAcquisitions
  .filter((target) => target.researchRole === "proof-blocking");
const representedActionableIds = new Set(ready.flatMap((question) => question.acquisition
  .filter((target) => target.state === "actionable" && target.researchRole === "proof-blocking")
  .map((target) => target.id)));
const standaloneActionableAcquisitions = runnableActionableAcquisitions
  .filter((target) => !representedActionableIds.has(target.id));
// Both roots use continuous typed parent-frontier traversal. An established
// country never closes a parent slot, and weak edges do not open the pedigree
// above them until their exact relationship bridge is established.
const directLineRoots = readJson(path.join(projectRoot, "evidence", "research", "tree-presentation.json"))
  .visualTree.directLineRoots || loadTreeConfig().tree.rootPersonIds;
const gapRoots = directLineRoots
  .map((rootId) => ({ rootId, mode: "frontier" }))
  .sort((first, second) => first.rootId.localeCompare(second.rootId));
const originGaps = scope === "main" ? buildOriginGaps({
  roots: gapRoots,
  people: projections.people.people,
  parentLinks: projections.relationships.parents,
  questions
}) : [];
const needsUser = buildNeedsUserResult(questions, acquisition.targets, stateOptions);
// The payment ledger is derived from the request events, not from the gate
// rollup, so an authorized payment hidden behind a deferred question, a
// recovery-only target or a provider hold still surfaces here. Its ages change
// daily, so it stays outside the rollup checkpoint hash.
const paymentLedger = (() => {
  const ledger = buildPaymentLedger({
    externalRequests: store.externalRequests || [],
    acquisitionTargets: acquisition.targets,
    questions: canonicalQuestions
  }, stateOptions);
  const entries = ledger.entries.filter((entry) => entry.scope === scope);
  const scopedLedger = { ...ledger, entries, summary: summarizeLedger(entries) };
  const attention = paymentAttentionEntries(scopedLedger);
  // Counts and one line per due or alarmed payment: the full entries live in
  // `npm run payments:status --json`, so this stays inside the compact budget.
  const { byStage, alarms, ...summary } = scopedLedger.summary;
  return {
    headline: formatLedgerHeadline(scopedLedger.summary),
    summary,
    attentionIds: attention.map((entry) => entry.requestId),
    attentionLines: attention.map(formatAttentionLine)
  };
})();
needsUser.payments = paymentLedger;
const canonicalQuestionById = new Map(canonicalQuestions.map((question) => [question.id, question]));
const attemptsByQuestion = new Map(canonicalQuestions.map((question) => [
  question.id,
  researchAttemptsForQuestion(question, canonicalQuestionById)
]));
const depthReport = buildDepthReport(canonicalQuestions, attemptsByQuestion);
const reopenTriggers = evaluateReopenTriggers({
  questions: canonicalQuestions.filter((question) => isLiveResearchQuestion(question, stateOptions)),
  requests: store.externalRequests || [],
  targets: acquisition.targets
});
const closureReviews = buildClosureReviewItems(depthReport, questions);
const reopenTriggerItems = buildReopenTriggerItems(reopenTriggers.fired, questions);
const routeDiscoveries = buildRouteDiscoveryItems(acquisition.targets, questions);
const extractionStatus = buildExtractionStatus(loadExtractionStore({ researchStore: store }), { scope });
const sourceReviews = buildSourceReviewItems(extractionStatus, { scope });
const schedulerRecord = loadResearchSchedulerRecord({ scope });
const expiringAuthorizedAccess = buildExpiringAuthorizedAccessItems(acquisition.targets, {
  externalRequests: store.externalRequests || [],
  scope
});
const autonomousOriginGaps = originGaps.filter((gap) => gap.uncovered).map((gap) => ({
  ...gap,
  priority: "P1",
  question: originGapQuestion(gap)
}));
const triageItems = buildAutonomousQuestionTriageQuestions(questions
  .filter((question) => !awaitingDependencyIds.has(question.id))).map((question) => ({
  ...question,
  triageAction: buildQuestionTriageAction(question)
}));
const frontierReadyQuestions = ready.filter(isFrontierQuestion);
const proofReadyQuestions = ready.filter((question) => !isFrontierQuestion(question));
const frontierTriageQuestions = triageItems.filter(isFrontierQuestion);
const proofTriageQuestions = triageItems.filter((question) => !isFrontierQuestion(question));
const branchEffort = new Map(depthReport.branches.map((branch) => [branch.branchId, branch]));
const dryQuestionIds = new Set(canonicalQuestions
  .filter((question) => trailingDryAttemptCount(attemptsByQuestion.get(question.id))
    >= DRY_ATTEMPT_STREAK_THRESHOLD)
  .map((question) => question.id));
const rootProgress = new Map(gapRoots.map(({ rootId }) => {
  const rootGaps = originGaps.filter((gap) => gap.rootId === rootId);
  return [rootId, {
    covered: rootGaps.filter((gap) => !gap.uncovered).length,
    total: rootGaps.length
  }];
}));
const selectedEntry = selectFairQueueItem({
  readyQuestions: proofReadyQuestions,
  standaloneAcquisitions: standaloneActionableAcquisitions,
  reopenTriggers: reopenTriggerItems,
  closureReviews,
  routeDiscoveries,
  sourceReviews,
  frontierQuestions: [...frontierReadyQuestions, ...frontierTriageQuestions],
  expiringAuthorizedAccess,
  schedulerRecord,
  originGaps: autonomousOriginGaps,
  triageQuestions: proofTriageQuestions,
  branchEffort,
  dryQuestionIds,
  rootProgress
});
const nextEntry = bindResearchSchedulerSelection(selectedEntry, {
  scope,
  schedulerRecord
});
const openQuestions = questions.filter((question) => isQuestionOperationallyOpen(
  canonicalById.get(question.id), stateOptions
));
const blockedActionCount = openQuestions.reduce((count, question) => count
  + question.actions.filter((action) => action.status === "blocked").length, 0);
const triageQuestionCount = triageItems.length;
const normallyRunnableTargetIds = new Set(runnableActionableAcquisitions.map((target) => target.id));
const independentExpiringAuthorizedAccessCount = expiringAuthorizedAccess
  .filter((entry) => !normallyRunnableTargetIds.has(entry.item.id)).length;
const goalState = buildGoalState({
  readyQuestionCount: ready.length,
  actionableAcquisitionCount: standaloneActionableAcquisitions.length,
  closureReviewCount: closureReviews.length,
  sourceReviewCount: sourceReviews.length,
  expiringAuthorizedAccessCount: independentExpiringAuthorizedAccessCount,
  reopenableCount: reopenTriggerItems.length,
  routeDiscoveryCount: routeDiscoveries.length,
  triageQuestionCount,
  needsUserCount: needsUser.needsUserCount,
  waitingExternalCount: needsUser.waitingExternalCount,
  uncoveredOriginGapCount: originGaps.filter((gap) => gap.uncovered).length,
  originGapCount: originGaps.length
});
assertRunnableSelection(goalState, nextEntry);
const result = {
  scope,
  generatedFrom: "canonical research/acquisition stores and the scoped source-extraction campaign",
  openQuestionCount: openQuestions.length,
  readyQuestionCount: ready.length,
  actionableAcquisitionCount: actionableAcquisitions.length,
  runnableAcquisitionCount: runnableActionableAcquisitions.length,
  standaloneActionableAcquisitionCount: standaloneActionableAcquisitions.length,
  originGapCount: originGaps.length,
  reopenable: reopenTriggers.fired,
  reopenTriggerCount: reopenTriggerItems.length,
  closureReviewCount: closureReviews.length,
  sourceReviewCount: sourceReviews.length,
  sourceReviewPendingCount: extractionStatus.pending,
  sourceReviewCounts: extractionStatus.counts,
  sourceReviewCampaignId: extractionStatus.campaignId,
  sourceReviewIssueCount: extractionStatus.issues.length,
  expiringAuthorizedAccessCount: expiringAuthorizedAccess.length,
  routeDiscoveryCount: routeDiscoveries.length,
  uncoveredOriginGapCount: originGaps.filter((gap) => gap.uncovered).length,
  triageQuestionCount,
  nextKind: nextEntry?.kind || null,
  next: nextEntry?.item || null,
  scheduler: nextEntry?.scheduler || schedulerStatus(schedulerRecord),
  goalState,
  noSelection: nextEntry ? null : buildNoSelectionReason({
    openQuestionCount: openQuestions.length,
    blockedActionCount,
    needsUserCount: needsUser.needsUserCount,
    waitingExternalCount: needsUser.waitingExternalCount
  }),
  actionableAcquisitions,
  closureReviews,
  sourceReviews,
  routeDiscoveries,
  originGaps,
  questions
};
const needsUserMode = args.includes("--needs-user");
const nextMode = args.includes("--next");
const allDetails = args.includes("--all");
const depthMode = args.includes("--depth");
const previousCheckpoint = valueAfter(args, "--checkpoint")?.toLowerCase();
if (needsUserMode && nextMode) throw new Error("--needs-user and --next are mutually exclusive");
if (depthMode && (needsUserMode || nextMode)) throw new Error("--depth is mutually exclusive with --needs-user and --next");
if (allDetails && !needsUserMode) throw new Error("--all is available only with --needs-user");
if (args.includes("--checkpoint") && !previousCheckpoint) throw new Error("--checkpoint requires a SHA-256 value");
if (previousCheckpoint && !/^[a-f0-9]{64}$/i.test(previousCheckpoint)) {
  throw new Error("--checkpoint must be a 64-character SHA-256 value");
}
if (previousCheckpoint && !needsUserMode) throw new Error("--checkpoint is available only with --needs-user");
// The full JSON report lists every question (about 2 MB of its 2.7 MB on
// 9 Nov 2026). A caller that needs one question's row, such as
// research-session-status, narrows it here; every count and the queue
// selection still describe the whole scope.
const onlyQuestionId = valueAfter(args, "--question");
if (args.includes("--question") && !onlyQuestionId) throw new Error("--question requires a question id");
if (onlyQuestionId && (depthMode || needsUserMode || nextMode || !args.includes("--json"))) {
  throw new Error("--question is available only with the full --json report");
}

if (depthMode) {
  if (args.includes("--json")) console.log(JSON.stringify(depthReport, null, 2));
  else printDepth(depthReport);
} else if (needsUserMode) {
  const output = allDetails
    ? buildFullNeedsUserResult(needsUser, { previousCheckpoint })
    : buildCompactNeedsUserResult(needsUser, { previousCheckpoint });
  const scopedOutput = { scope, ...output, payments: paymentLedger };
  // An unchanged rollup is reported in a couple of kilobytes; the payments
  // then shrink to their headline and ids, which still say how many are due
  // and how old, so a silent payment cannot hide behind "unchanged". The
  // changed report carries the lines (which name the ids) and the counts.
  const { attentionIds, ...paymentsWithLines } = paymentLedger;
  const jsonOutput = output.groupsSuppressedUnchanged
    ? { ...scopedOutput, payments: { headline: paymentLedger.headline, attentionIds, unchangedRollup: true } }
    : { ...scopedOutput, payments: paymentsWithLines };
  if (args.includes("--json")) console.log(JSON.stringify(jsonOutput, null, 2));
  else if (allDetails) printNeedsUser(scopedOutput);
  else printCompactNeedsUser(scopedOutput);
} else if (nextMode) {
  const output = buildCompactNextResult({
    fullResult: result,
    canonicalQuestions,
    acquisitionTargets: acquisition.targets,
    needsUser
  });
  if (args.includes("--json")) console.log(JSON.stringify(output, null, 2));
  else printCompactNext(output);
} else if (args.includes("--json")) {
  console.log(JSON.stringify(onlyQuestionId
    ? { ...result, questions: result.questions.filter((question) => question.id === onlyQuestionId) }
    : result, null, 2));
} else {
  console.log(
    `${result.openQuestionCount} open questions; ${result.readyQuestionCount} have ready or actionable work; `
      + `${result.standaloneActionableAcquisitionCount} standalone acquisition target(s) remain actionable.`
  );
  console.log(
    `Source reread ${result.sourceReviewCampaignId}: ${result.sourceReviewPendingCount} pending; `
      + `${result.sourceReviewCount} bounded packet(s) selectable; ${result.sourceReviewIssueCount} issue(s).`
  );
  const goal = result.goalState;
  console.log(`${goal.operationalState}: ${goal.message}`);
  console.log(`  Resume: ${goal.resume}`);
  if (goal.coverageNote) console.log(`  Note: ${goal.coverageNote}`);
  if (goal.blocked) console.log(`  ${goal.neverClaim}`);
  for (const entry of reopenTriggers.fired) {
    console.log(`  reopenable ${entry.questionId} (${entry.questionStatus}): trigger ${entry.triggerId} fired.`);
  }
  if (depthReport.closureReviewNeeded) {
    console.log(`  Depth: ${depthReport.closureReviewNeeded} closed question(s) need closure review `
      + "(npm run research:status -- --depth).");
  }
  for (const question of ready) {
    const queue = question.workstream ? ` [${question.workstream} ${question.queueOrder}]` : "";
    console.log(`${question.priority}${queue} ${question.id}: ${question.question}`);
    for (const brief of findBriefsForQuestion(canonicalById.get(question.id))) console.log(`  brief ${brief}`);
    for (const action of question.actions.filter(isResearchActionExecutable)) {
      console.log(`  action ${action.id} (${action.kind}): ${action.note || "ready"}`);
    }
    for (const target of question.acquisition.filter((item) => item.state === "actionable")) {
      console.log(`  acquisition ${target.id}: ${target.status} via ${target.provider}${target.routeId ? ` (${target.routeId})` : ""}`);
    }
  }
  for (const target of standaloneActionableAcquisitions) {
    console.log(
      `${target.priority} acquisition ${target.id}: ${target.status} via ${target.provider}`
        + `${target.routeId ? ` (${target.routeId})` : ""}`
    );
  }
}

function printDepth(report) {
  console.log(`${report.questionCount} question(s); ${report.attemptTotal} attempt(s) recorded.`);
  console.log(`${report.closureReviewNeeded} flagged: ${report.flagMeaning}`);
  for (const branch of report.branches) {
    const spread = Object.entries(branch.distribution).filter(([, count]) => count)
      .map(([key, count]) => `${key}:${count}`).join(" ");
    const guard = branch.sampleTooSmallForRate ? " (sample too small for a branch rate)" : "";
    console.log(`  ${branch.branchId} — ${branch.questionCount} question(s), ${branch.attemptTotal} attempt(s)`);
    console.log(`      attempts per question  ${spread}${guard}`);
    console.log(`      closure review needed  ${branch.closureReviewNeeded}`
      + `; thin without any original  ${branch.thinWithoutOriginal}`);
  }
  for (const warning of report.warnings) console.log(`  warning: ${warning}`);
  if (report.flagged.length) {
    console.log("Flagged for closure review:");
    for (const entry of report.flagged) {
      console.log(`  ${entry.id} (${entry.attemptCount} attempt(s)`
        + `${entry.hasOriginalEvidence ? ", has an original" : ", index/negative only"})`);
    }
  }
}

function workstreamRank(question) {
  return question.workstream === "tree-evidence-resolution" ? 0 : 1;
}

function isFrontierQuestion(question) {
  return Boolean(question.frontierPersonId)
    && (question.goalKeys || []).some((key) => key.startsWith("parent-slot:")
      || key.startsWith("relationship-bridge:"));
}

function queueRank(question) {
  return question.workstream ? question.queueOrder : Number.MAX_SAFE_INTEGER;
}

// Payments print above the rollup in both modes and are never suppressed as
// "unchanged": an authorized payment that has not been executed is the first
// thing a session should see.
function printPayments(payments) {
  if (!payments) return;
  console.log(payments.headline);
  for (const line of payments.attentionLines || []) console.log(`  ${line}`);
  if (payments.summary?.openCount) {
    console.log("  Full ledger: npm run payments:status; run due payments with npm run payments:run -- --execute while the user is at the computer.");
  }
}

function printNeedsUser(value) {
  printPayments(value.payments);
  console.log(
    `${value.needsUserCount} item(s) need user action; `
      + `${value.waitingExternalCount} item(s) are waiting on an external response.`
  );
  console.log(`Checkpoint: ${value.checkpoint}`);
  if (value.comparison) {
    console.log(`Changed since ${value.comparison.checkpoint}: ${value.comparison.changed ? "yes" : "no"}.`);
  }
  if (!value.items.length) {
    console.log("No canonical user-unblock items are open.");
    return;
  }
  for (const item of value.items) {
    console.log(`${item.kind === "needs-user" ? "NEEDS USER" : "WAITING EXTERNAL"} ${item.id} — ${item.title}`);
    console.log(`  Blocked: ${item.blockedItem}`);
    console.log(`  Action: ${item.action}`);
    console.log(`  Impact: ${item.impact}`);
  }
}

function printCompactNeedsUser(value) {
  printPayments(value.payments);
  console.log(
    `${value.needsUserCount} item(s) need user action across ${value.needsUserGateCount} gate(s); `
      + `${value.waitingExternalCount} item(s) await external responses across ${value.waitingExternalGateCount} gate(s).`
  );
  console.log(`Checkpoint: ${value.checkpoint}`);
  if (value.comparison) {
    console.log(`Changed since ${value.comparison.checkpoint}: ${value.comparison.changed ? "yes" : "no"}.`);
  }
  if (value.signInReminders?.length) {
    console.log("Sign-in still needed — repeated until cleared:");
    for (const reminder of value.signInReminders) {
      console.log(`  ${reminder.label} (${reminder.count} item(s)) — reply ${reminder.resumeTokens.join(" or ")}`);
    }
  }
  if (value.groupsSuppressedUnchanged) {
    console.log("No unblock-state changes; repeated gate details are suppressed.");
    return;
  }
  if (!value.groups.length) {
    console.log("No canonical user-unblock items are open.");
    return;
  }
  const needsUserVenues = (value.venues || []).filter((venue) => venue.kind === "needs-user");
  if (needsUserVenues.length) {
    console.log("Unblock venues — one action clears every item it groups:");
    for (const venue of needsUserVenues) {
      console.log(`  ${venue.highestPriority} ${venue.count} item(s) — ${venue.label}`);
    }
  }
  for (const group of value.groups) {
    const label = group.kind === "needs-user" ? "NEEDS USER" : "WAITING EXTERNAL";
    console.log(`${label} ${group.highestPriority} ${group.resumeToken} — ${group.count} item(s)`);
    console.log(`  IDs: ${group.itemIds.join(", ")}`);
  }
  console.log("Use --needs-user --all for full blocked-item, action, and impact detail.");
}

function printCompactNext(value) {
  console.log(
    `${value.counts.questions.open} open question(s); ${value.counts.questions.ready} ready/actionable; `
      + `${value.counts.acquisitions.actionable} actionable acquisition(s); `
      + `${value.counts.reviews.sourcePending} source master(s) pending reread.`
  );
  if (!value.next) {
    console.log(`No selection (${value.noSelection.reasonCode}): ${value.noSelection.message}`);
    console.log(`  Resume: ${value.noSelection.resume}`);
    for (const blocker of value.blockers) {
      console.log(`  ${blocker.kind === "needs-user" ? "NEEDS USER" : "WAITING EXTERNAL"} ${blocker.id} — ${blocker.resumeToken}`);
    }
    return;
  }
  if (value.next.kind === "question") {
    console.log(`Next ${value.next.priority} ${value.next.id}: ${value.next.question}`);
    if (value.next.action) console.log(`  action ${value.next.action.id} (${value.next.action.kind}): ${value.next.action.note || "ready"}`);
    if (value.next.acquisition) console.log(`  acquisition ${value.next.acquisition.id} via ${value.next.acquisition.provider}`);
  } else {
    if (value.next.kind === "origin-gap") {
      console.log(`Next origin gap ${value.next.priority} ${value.next.personId}: ${value.next.question}`);
      if (value.next.gapKind === "relationship-bridge") {
        console.log(`  ${value.next.assessment} bridge to ${value.next.candidateParentId}`);
      } else {
        console.log(`  generation ${value.next.generation}; known parents ${value.next.knownParentCount}; current origin ${value.next.ancestryOrigin || "missing"} [${value.next.originAssessment}]`);
      }
    } else if (value.next.kind === "source-review") {
      console.log(`Next source review ${value.next.id}: ${value.next.records.map((item) => item.recordId).join(", ")}`);
    } else if (value.next.kind === "route-discovery") {
      console.log(`Next route discovery ${value.next.priority} ${value.next.targetId}: ${value.next.reference}`);
    } else if (["closure-review", "reopen-trigger"].includes(value.next.kind)) {
      console.log(`Next ${value.next.kind} ${value.next.priority} ${value.next.questionId}: ${value.next.question}`);
    } else {
      console.log(`Next acquisition ${value.next.priority} ${value.next.id} via ${value.next.provider}`);
    }
  }
  for (const attempt of value.next.latestAttempts) {
    console.log(`  attempt ${attempt.attemptedAt} ${attempt.outcome}: ${attempt.query || attempt.note || attempt.id}`);
  }
  for (const blocker of value.next.blockers) {
    console.log(`  ${blocker.kind === "needs-user" ? "NEEDS USER" : "WAITING EXTERNAL"} ${blocker.id} — ${blocker.resumeToken}`);
  }
}

function valueAfter(values, flag) {
  const index = values.indexOf(flag);
  return index >= 0 ? values[index + 1] : undefined;
}
