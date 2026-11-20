#!/usr/bin/env node

import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { getDeploymentStatus } from "./deploy-status.mjs";
import { selectExecutableResearchAction } from "./research-actions.mjs";
import { loadResearchStore } from "./research-store.mjs";
import { researchAttemptsForQuestion } from "./research-question-state.mjs";
import { assertResearchScope, parseResearchScope } from "./research-scope.mjs";
import { findBriefsForQuestion } from "./research-briefs.mjs";
import fs from "node:fs";
import { inboxStatus } from "./inquiry-inbox-sweep-lib.mjs";

const execFileAsync = promisify(execFile);
const PROJECT_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

function valueAfter(args, flag) { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : undefined; }

async function jsonCommand(script, args = []) {
  // These parallel, read-only projections share the desktop's CPU/I/O quota.
  // Gaming Mode can exceed 45 seconds without a stalled process; retain a
  // bounded three-minute timeout while allowing the reservation to work.
  // The buffer is a backstop: the requested-question path asks research-status
  // for that one question's row, so output no longer grows with the store.
  const { stdout } = await execFileAsync(process.execPath, [path.join(PROJECT_ROOT, "tools", script), ...args], { cwd: PROJECT_ROOT, maxBuffer: 64 * 1024 * 1024, timeout: 180_000 });
  return JSON.parse(stdout);
}

// The Codex rollout analysis reads every recent rollout (or the current one,
// which can be hundreds of megabytes) and took ~16 s of every status call, so
// it is opt-in with --performance; `npm run research:performance` remains the
// dedicated diagnostic.
export async function buildResearchSessionStatus({ questionId, scope = "main", includePerformance = false } = {}) {
  const headSha = await currentHeadSha();
  const [research, needsUser, performance, deployment] = await Promise.all([
    jsonCommand("research-status.mjs", questionId
      ? ["--scope", scope, "--question", questionId, "--json"]
      : ["--scope", scope, "--next", "--json"]),
    jsonCommand("research-status.mjs", questionId
      ? ["--scope", scope, "--needs-user", "--all", "--json"]
      : ["--scope", scope, "--needs-user", "--json"]),
    includePerformance ? jsonCommand("analyze-codex-performance.mjs", ["--json"]) : null,
    getDeploymentStatus(headSha, { cwd: PROJECT_ROOT }),
  ]);
  const selection = resolveSessionSelection(research, { questionId });
  const selectedId = selection.kind === "question" ? selection.id : null;
  let selected = null;
  if (!questionId && selection.kind === "question") {
    selected = { ...research.next, selectionSource: "queue" };
  } else if (selectedId) {
    const requestedQuestionStatus = research.questions.find((item) => item.id === selectedId) || null;
    const store = loadResearchStore();
    const question = store.questions.find((item) => item.id === selectedId);
    if (!question) throw new Error(`Unknown canonical question: ${selectedId}.`);
    assertResearchScope(question, scope, `question ${selectedId}`);
    const selectedAction = selectExecutableResearchAction(question.actions || []);
    const latestAttempts = researchAttemptsForQuestion(question, store.questions)
      .filter((attempt) => !selectedAction || attempt.actionId === selectedAction.id || attempt.inheritedFromQuestionId)
      .sort((left, right) => Date.parse(right.attemptedAt) - Date.parse(left.attemptedAt)).slice(0, 3).map((attempt) => ({
      id: attempt.id, actionId: attempt.actionId, inheritedFromQuestionId: attempt.inheritedFromQuestionId,
      attemptedAt: attempt.attemptedAt, outcome: attempt.outcome, query: attempt.query, coverage: attempt.scope?.coverage, note: attempt.note,
    }));
    const selectedAcquisition = requestedQuestionStatus?.acquisition.find((target) => target.state === "actionable") || null;
    selected = {
      kind: "question",
      selectionSource: selection.source,
      executable: Boolean(selectedAction || selectedAcquisition),
      id: question.id,
      question: question.question,
      priority: question.priority,
      status: question.status,
      briefs: findBriefsForQuestion(question),
      action: selectedAction,
      acquisition: selectedAcquisition,
      latestAttempts,
      blockers: needsUser.items.filter((item) => item.questionIds.includes(question.id)).map((item) => ({
        id: item.id,
        kind: item.kind,
        priority: item.priority,
        resumeToken: item.resumeToken
      }))
    };
  } else if (selection.kind === "acquisition") {
    selected = {
      kind: "acquisition",
      selectionSource: selection.source,
      executable: true,
      ...selection.item
    };
  } else if (selection.kind === "origin-gap") {
    selected = {
      kind: "origin-gap",
      selectionSource: selection.source,
      executable: true,
      ...selection.item
    };
  } else if (["source-review", "closure-review", "reopen-trigger", "route-discovery"].includes(selection.kind)) {
    selected = {
      selectionSource: selection.source,
      executable: true,
      ...selection.item
    };
  }
  return {
    scope,
    generatedAt: new Date().toISOString(),
    selected,
    queue: buildSessionQueueSummary(research),
    unblock: {
      needsUserCount: needsUser.needsUserCount,
      waitingExternalCount: needsUser.waitingExternalCount,
      needsUserGateCount: needsUser.needsUserGateCount,
      waitingExternalGateCount: needsUser.waitingExternalGateCount,
      highestPriorities: needsUser.highestPriorities,
      checkpoint: needsUser.checkpoint,
      // The payment ledger rides along with the rollup so an authorized but
      // unexecuted payment is on screen at every session start.
      payments: needsUser.payments || null
    },
    inbox: readInboxStatus(scope),
    performance: performance ? { sessionId: performance.sessionId, turnCount: performance.turnCount, context: performance.context, warnings: performance.warnings } : null,
    deployment,
  };
}

// The inbox sweep's local state and the canonical requests' untriaged replies.
// A missing or unreadable state reads as never swept, which is stale.
function readInboxStatus(scope) {
  const requestsDir = path.join(PROJECT_ROOT, "evidence", "acquisition", "requests");
  let sweepState = null;
  try { sweepState = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, ".inbox-sweep", "state.json"), "utf8")); } catch {}
  const requests = fs.readdirSync(requestsDir).filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(fs.readFileSync(path.join(requestsDir, name), "utf8")));
  return inboxStatus({ requests, sweepState, scope });
}

export function buildSessionQueueSummary(research) {
  return {
    openQuestionCount: research.counts?.questions.open ?? research.openQuestionCount,
    readyQuestionCount: research.counts?.questions.ready ?? research.readyQuestionCount,
    triageQuestionCount: research.counts?.questions.triage ?? research.triageQuestionCount ?? 0,
    originGapCount: research.counts?.originGaps.total ?? research.originGapCount ?? 0,
    uncoveredOriginGapCount: research.counts?.originGaps.uncovered ?? research.uncoveredOriginGapCount ?? 0,
    sourceReviewCount: research.counts?.reviews?.source ?? research.sourceReviewCount ?? 0,
    sourceReviewPendingCount: research.counts?.reviews?.sourcePending
      ?? research.sourceReviewPendingCount ?? 0,
    sourceReviewCounts: research.counts?.reviews?.sourceByState
      ?? research.sourceReviewCounts ?? {},
    sourceReviewIssueCount: research.counts?.reviews?.sourceIssues
      ?? research.sourceReviewIssueCount ?? 0,
    closureReviewCount: research.counts?.reviews?.closure ?? research.closureReviewCount ?? 0,
    reopenTriggerCount: research.counts?.reviews?.reopenTriggers ?? research.reopenTriggerCount ?? 0,
    routeDiscoveryCount: research.counts?.reviews?.routeDiscovery ?? research.routeDiscoveryCount ?? 0,
    expiringAuthorizedAccessCount: research.counts?.acquisitions?.expiringAuthorized
      ?? research.expiringAuthorizedAccessCount ?? 0,
    runnableCount: research.counts?.runnable ?? research.goalState?.runnableCount ?? 0,
    nextKind: research.nextKind,
    nextId: research.next?.id || null,
    scheduler: research.scheduler || null,
    noSelection: research.noSelection
  };
}

function printStatus(result) {
  if (result.inbox) {
    const age = result.inbox.lastSweptAt ? `last swept ${result.inbox.ageHours} h ago` : "never swept";
    if (result.inbox.stale) console.log(`INBOX STALE: ${age}; run ${result.inbox.command} before taking the next item.`);
    for (const entry of result.inbox.untriaged) {
      console.log(`INBOX REPLY ${entry.requestId}: ${entry.messageIds.length} untriaged provider message(s) (${entry.messageIds.map((id) => `gmail-message-${id}`).join(", ")})`);
    }
  }
  console.log(
    `${result.queue.openQuestionCount} open question(s); ${result.queue.readyQuestionCount} ready/actionable; `
      + `${result.queue.triageQuestionCount} autonomously triageable; `
      + `${result.queue.uncoveredOriginGapCount} uncovered direct-line origin/frontier gap(s).`
  );
  console.log(
    `Source reread: ${result.queue.sourceReviewPendingCount} pending; `
      + `${result.queue.sourceReviewCount} bounded packet(s) selectable; `
      + `${result.queue.sourceReviewIssueCount} store issue(s).`
  );
  if (result.selected) {
    const label = result.selected.selectionSource === "requested" ? "Requested" : "Selected";
    if (result.selected.kind === "question") {
      console.log(`${label} ${result.selected.priority} ${result.selected.id} [${result.selected.status}]: ${result.selected.question}`);
      for (const brief of result.selected.briefs || []) console.log(`  Brief: ${brief} (planning document: read first; canonical files win)`);
      if (result.selected.action) console.log(`  action ${result.selected.action.id} [${result.selected.action.status}]: ${result.selected.action.note || result.selected.action.kind}`);
      if (result.selected.acquisition) console.log(`  acquisition ${result.selected.acquisition.id} [${result.selected.acquisition.status}] via ${result.selected.acquisition.provider}`);
      if (!result.selected.executable) console.log("  No ready action or actionable acquisition exists for this requested question.");
      for (const attempt of result.selected.latestAttempts) console.log(`  attempt ${attempt.attemptedAt} ${attempt.outcome}: ${attempt.query || attempt.note || attempt.id}`);
      for (const blocker of result.selected.blockers || []) console.log(`  ${blocker.kind === "needs-user" ? "NEEDS USER" : "WAITING EXTERNAL"} ${blocker.id} — ${blocker.resumeToken}`);
    } else if (result.selected.kind === "origin-gap") {
      console.log(`${label} origin gap ${result.selected.priority} ${result.selected.personId}: ${result.selected.question}`);
      if (result.selected.gapKind === "relationship-bridge") {
        console.log(`  ${result.selected.assessment} bridge to ${result.selected.candidateParentId}`);
      } else {
        console.log(`  generation ${result.selected.generation}; known parents ${result.selected.knownParentCount}; current origin ${result.selected.ancestryOrigin || "missing"} [${result.selected.originAssessment}]`);
      }
    } else if (result.selected.kind === "source-review") {
      console.log(`${label} source review ${result.selected.id}: ${(result.selected.records || []).map((item) => item.recordId).join(", ")}`);
    } else if (result.selected.kind === "route-discovery") {
      console.log(`${label} route discovery ${result.selected.priority} ${result.selected.targetId}: ${result.selected.reference}`);
    } else if (["closure-review", "reopen-trigger"].includes(result.selected.kind)) {
      console.log(`${label} ${result.selected.kind} ${result.selected.priority} ${result.selected.questionId}: ${result.selected.question}`);
    } else {
      console.log(`${label} acquisition ${result.selected.priority} ${result.selected.id} [${result.selected.status}] via ${result.selected.provider}`);
    }
  } else if (result.queue.noSelection) {
    console.log(`No selection (${result.queue.noSelection.reasonCode}): ${result.queue.noSelection.message}`);
    console.log(`  Resume: ${result.queue.noSelection.resume}`);
  }
  console.log(
    `Unblock rollup: ${result.unblock.needsUserCount} needs user across ${result.unblock.needsUserGateCount} gate(s); `
      + `${result.unblock.waitingExternalCount} waiting external across ${result.unblock.waitingExternalGateCount} gate(s).`
  );
  console.log(`Unblock checkpoint: ${result.unblock.checkpoint}`);
  if (result.unblock.payments) {
    console.log(result.unblock.payments.headline);
    for (const line of result.unblock.payments.attentionLines || []) console.log(`  ${line}`);
    if (result.unblock.payments.summary?.openCount) console.log("  Full ledger: npm run payments:status; run due payments with npm run payments:run -- --execute while the user is at the computer.");
  }
  if (result.performance) {
    console.log(`Performance: ${result.performance.turnCount} turn(s); ${result.performance.warnings.length} warning(s).`);
    for (const item of result.performance.warnings) console.log(`  ${item.severity.toUpperCase()} ${item.code}: ${item.message}`);
  } else console.log("Performance: no matching current rollout.");
  console.log(`Deployment: ${result.deployment.coverage} — ${result.deployment.detail}`);
}

export function resolveSessionSelection(research, { questionId } = {}) {
  if (questionId) return { kind: "question", id: questionId, source: "requested" };
  if (research.nextKind === "question" && research.next?.id) {
    return { kind: "question", id: research.next.id, source: "queue" };
  }
  if (research.nextKind === "acquisition" && research.next?.id) {
    return { kind: "acquisition", id: research.next.id, item: research.next, source: "queue" };
  }
  if (research.nextKind === "origin-gap" && research.next?.personId) {
    return { kind: "origin-gap", id: research.next.id, item: research.next, source: "queue" };
  }
  if (["source-review", "closure-review", "reopen-trigger", "route-discovery"].includes(research.nextKind)
    && research.next?.id) {
    return { kind: research.nextKind, id: research.next.id, item: research.next, source: "queue" };
  }
  return { kind: null, id: null, item: null, source: "queue" };
}

async function main() {
  const args = process.argv.slice(2);
  const scope = parseResearchScope(args);
  const result = await buildResearchSessionStatus({
    questionId: valueAfter(args, "--question"),
    scope,
    includePerformance: args.includes("--performance")
  });
  if (args.includes("--json")) console.log(JSON.stringify(result, null, 2));
  else printStatus(result);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}

// deploy:main validates the staged tree in a temporary export that has no .git of its own; it
// passes the exported HEAD in the environment so this status still records which commit it read.
async function currentHeadSha() {
  try {
    return (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: PROJECT_ROOT })).stdout.trim();
  } catch (error) {
    if (process.env.DEPLOY_MAIN_HEAD_SHA) return process.env.DEPLOY_MAIN_HEAD_SHA;
    throw error;
  }
}
