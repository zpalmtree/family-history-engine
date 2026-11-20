import { createHash } from "node:crypto";
import { selectExecutableResearchAction } from "./research-actions.mjs";
import {
  questionConclusionState,
  questionOperationalLabel,
  questionWorkState,
  researchAttemptsForQuestion
} from "./research-question-state.mjs";

const latestAttemptLimit = 3;

export function buildCompactNextResult({
  fullResult,
  canonicalQuestions,
  acquisitionTargets,
  needsUser
}) {
  const compact = {
    scope: fullResult.scope || "main",
    generatedFrom: fullResult.generatedFrom,
    counts: {
      questions: {
        open: fullResult.openQuestionCount,
        ready: fullResult.readyQuestionCount,
        triage: fullResult.triageQuestionCount || 0,
        blocked: fullResult.questions.filter((question) => question.status === "blocked").length
      },
      acquisitions: {
        actionable: fullResult.actionableAcquisitionCount,
        runnable: fullResult.runnableAcquisitionCount ?? fullResult.standaloneActionableAcquisitionCount,
        standaloneActionable: fullResult.standaloneActionableAcquisitionCount,
        expiringAuthorized: fullResult.expiringAuthorizedAccessCount || 0
      },
      unblock: {
        needsUser: needsUser.needsUserCount,
        waitingExternal: needsUser.waitingExternalCount
      },
      originGaps: {
        total: fullResult.originGapCount || 0,
        uncovered: fullResult.uncoveredOriginGapCount || 0
      },
      reviews: {
        source: fullResult.sourceReviewCount || 0,
        sourcePending: fullResult.sourceReviewPendingCount || 0,
        sourceByState: { ...(fullResult.sourceReviewCounts || {}) },
        sourceIssues: fullResult.sourceReviewIssueCount || 0,
        closure: fullResult.closureReviewCount || 0,
        reopenTriggers: fullResult.reopenTriggerCount || 0,
        routeDiscovery: fullResult.routeDiscoveryCount || 0
      },
      runnable: fullResult.goalState?.runnableCount || 0
    },
    nextKind: fullResult.nextKind,
    scheduler: fullResult.scheduler || null,
    next: null,
    noSelection: fullResult.noSelection
  };

  if (fullResult.nextKind === "source-review" && fullResult.next?.id) {
    const summary = fullResult.next;
    compact.next = {
      kind: "source-review",
      executable: true,
      id: summary.id,
      researchScope: summary.researchScope,
      ...(summary.branchId ? { branchId: summary.branchId } : {}),
      priority: summary.priority,
      reviewState: summary.reviewState,
      implicitPacket: Boolean(summary.implicitPacket),
      ...(summary.packetId ? { packetId: summary.packetId } : {}),
      records: (summary.records || []).map((record) => ({
        recordId: record.recordId,
        sha256: record.sha256,
        sourceId: record.sourceId,
        researchScope: record.researchScope,
        state: record.state,
        ...(record.packetId ? { packetId: record.packetId } : {})
      })),
      action: compactAction(summary.action),
      latestAttempts: [],
      blockers: []
    };
    return compact;
  }

  if (fullResult.nextKind === "question" && fullResult.next?.id) {
    const summary = fullResult.next;
    const question = canonicalQuestions.find((item) => item.id === summary.id);
    if (!question) throw new Error(`compact status cannot find canonical question ${summary.id}`);
    const canonicalAction = selectExecutableResearchAction(question.actions || []);
    const action = canonicalAction || summary.triageAction || null;
    const acquisition = action ? null : selectQuestionAcquisition(summary, acquisitionTargets);
    const relevantId = action?.id || acquisition?.routeId || acquisition?.id;
    compact.next = {
      kind: "question",
      executable: Boolean(action || acquisition),
      id: question.id,
      branchId: question.branchId,
      priority: question.priority,
      status: summary.status || questionOperationalLabel(question),
      conclusionState: summary.conclusionState || questionConclusionState(question),
      workState: summary.workState || questionWorkState(question),
      question: question.question,
      ...(question.workstream ? { workstream: question.workstream, queueOrder: question.queueOrder } : {}),
      action: action ? compactAction(action) : null,
      acquisition,
      latestAttempts: action
        ? latestAttempts(action.derived
          ? attemptContext(question, canonicalQuestions)
          : attemptContext(question, canonicalQuestions)
            .filter((attempt) => attempt.actionId === action.id || attempt.inheritedFromQuestionId))
        : latestTargetAttempts(acquisitionTargets.find((target) => target.id === acquisition?.id), relevantId),
      blockers: compactBlockers(needsUser.items.filter((item) => item.questionIds.includes(question.id)))
    };
    return compact;
  }

  if (fullResult.nextKind === "origin-gap" && fullResult.next?.personId) {
    compact.next = {
      kind: "origin-gap",
      executable: true,
      id: fullResult.next.id,
      personId: fullResult.next.personId,
      displayName: fullResult.next.displayName,
      generation: fullResult.next.generation,
      knownParentCount: fullResult.next.knownParentCount,
      parentIds: [...(fullResult.next.parentIds || [])],
      ancestryOrigin: fullResult.next.ancestryOrigin,
      originAssessment: fullResult.next.originAssessment,
      gapKind: fullResult.next.kind,
      goalKeys: [...(fullResult.next.goalKeys || [])],
      uncoveredGoalKeys: [...(fullResult.next.uncoveredGoalKeys || [])],
      ...(fullResult.next.candidateParentId ? {
        candidateParentId: fullResult.next.candidateParentId,
        assessment: fullResult.next.assessment,
        assertionId: fullResult.next.assertionId
      } : {}),
      priority: fullResult.next.priority,
      question: fullResult.next.question,
      latestAttempts: [],
      blockers: []
    };
    return compact;
  }

  if (["closure-review", "reopen-trigger"].includes(fullResult.nextKind)
    && fullResult.next?.questionId) {
    const summary = fullResult.next;
    const question = canonicalQuestions.find((item) => item.id === summary.questionId);
    if (!question) throw new Error(`compact status cannot find canonical question ${summary.questionId}`);
    compact.next = {
      kind: fullResult.nextKind,
      executable: true,
      id: summary.id,
      questionId: question.id,
      branchId: question.branchId,
      priority: summary.priority || question.priority,
      status: summary.status || questionOperationalLabel(question),
      conclusionState: summary.conclusionState || questionConclusionState(question),
      workState: summary.workState || questionWorkState(question),
      question: question.question,
      action: compactAction(summary.action),
      ...(summary.trigger ? { trigger: summary.trigger } : {}),
      latestAttempts: latestAttempts(attemptContext(question, canonicalQuestions)),
      blockers: compactBlockers(needsUser.items.filter((item) => item.questionIds.includes(question.id)))
    };
    return compact;
  }

  if (fullResult.nextKind === "route-discovery" && fullResult.next?.targetId) {
    const summary = fullResult.next;
    const target = acquisitionTargets.find((item) => item.id === summary.targetId);
    compact.next = {
      kind: "route-discovery",
      executable: true,
      id: summary.id,
      targetId: summary.targetId,
      priority: summary.priority,
      provider: summary.provider,
      reference: summary.reference,
      questionIds: [...(summary.questionIds || [])],
      action: compactAction(summary.action),
      latestAttempts: latestTargetAttempts(target, target?.reconciliation?.routeId),
      blockers: []
    };
    return compact;
  }

  if (fullResult.nextKind === "acquisition" && fullResult.next?.id) {
    const target = acquisitionTargets.find((item) => item.id === fullResult.next.id);
    const acquisition = compactAcquisition(target, fullResult.next);
    compact.next = {
      kind: "acquisition",
      executable: true,
      ...acquisition,
      latestAttempts: latestTargetAttempts(target, acquisition.routeId),
      blockers: compactBlockers(needsUser.items.filter((item) => item.id === acquisition.id))
    };
    return compact;
  }

  compact.blockers = compactBlockers(needsUser.items.slice(0, 5));
  return compact;
}

export function buildCompactNeedsUserResult(value, { previousCheckpoint } = {}) {
  const checkpoint = buildNeedsUserCheckpoint(value);
  const groups = groupNeedsUserItems(value.items);
  const venues = groupNeedsUserVenues(value.items);
  const comparison = previousCheckpoint
    ? { checkpoint: previousCheckpoint, changed: previousCheckpoint !== checkpoint }
    : null;
  const visibleGroups = comparison?.changed === false ? [] : groups;
  return {
    signInReminders: buildSignInReminders(value.items),
    generatedFrom: value.generatedFrom,
    needsUserCount: value.needsUserCount,
    waitingExternalCount: value.waitingExternalCount,
    needsUserGateCount: groups.filter((group) => group.kind === "needs-user").length,
    waitingExternalGateCount: groups.filter((group) => group.kind === "waiting-external").length,
    highestPriorities: {
      needsUser: highestPriority(groups.filter((group) => group.kind === "needs-user")),
      waitingExternal: highestPriority(groups.filter((group) => group.kind === "waiting-external"))
    },
    checkpoint,
    comparison,
    venues: comparison?.changed === false ? [] : venues,
    groups: visibleGroups,
    groupsSuppressedUnchanged: comparison?.changed === false
  };
}

export function buildFullNeedsUserResult(value, { previousCheckpoint } = {}) {
  const checkpoint = buildNeedsUserCheckpoint(value);
  const groups = groupNeedsUserItems(value.items);
  return {
    ...value,
    signInReminders: buildSignInReminders(value.items),
    venues: groupNeedsUserVenues(value.items),
    needsUserGateCount: groups.filter((group) => group.kind === "needs-user").length,
    waitingExternalGateCount: groups.filter((group) => group.kind === "waiting-external").length,
    highestPriorities: {
      needsUser: highestPriority(groups.filter((group) => group.kind === "needs-user")),
      waitingExternal: highestPriority(groups.filter((group) => group.kind === "waiting-external"))
    },
    checkpoint,
    comparison: previousCheckpoint
      ? { checkpoint: previousCheckpoint, changed: previousCheckpoint !== checkpoint }
      : null
  };
}

export function buildNeedsUserCheckpoint(value) {
  const stableItems = [...value.items]
    .sort(compareNeedsUserItems)
    .map((item) => ({
      id: item.id,
      kind: item.kind,
      priority: item.priority,
      title: item.title,
      blockedItem: item.blockedItem,
      action: item.action,
      impact: item.impact,
      resumeToken: item.resumeToken,
      retryWhen: item.retryWhen,
      questionIds: [...item.questionIds].sort()
    }));
  return createHash("sha256").update(JSON.stringify(stableItems)).digest("hex");
}

// A sign-in takes the user seconds yet can block a whole provider, so open
// sign-ins are repeated on every rollup until cleared instead of being
// suppressed with the unchanged gates.
export function buildSignInReminders(items = []) {
  const grouped = new Map();
  for (const item of items) {
    const venueId = String(item.venue?.id || "");
    if (item.kind !== "needs-user" || !venueId.startsWith("sign-in-")) continue;
    if (!grouped.has(venueId)) {
      grouped.set(venueId, { id: venueId, label: item.venue.label, count: 0, resumeTokens: [] });
    }
    const reminder = grouped.get(venueId);
    reminder.count += 1;
    if (!reminder.resumeTokens.includes(item.resumeToken)) reminder.resumeTokens.push(item.resumeToken);
  }
  return [...grouped.values()].sort((first, second) => first.id.localeCompare(second.id));
}

export function groupNeedsUserVenues(items) {
  // One venue = one real-world user action (a center visit, a payment decision,
  // an email reply) that can clear every item grouped under it. Kept lean —
  // counts and labels only — because the per-token groups below already carry
  // the item IDs and this rollup leads user-facing reports.
  const grouped = new Map();
  for (const item of items) {
    const venue = item.venue || { id: "other", label: "other user action" };
    const key = `${item.kind}\u0000${venue.id}`;
    if (!grouped.has(key)) {
      grouped.set(key, {
        kind: item.kind,
        id: venue.id,
        label: venue.label,
        count: 0,
        highestPriority: item.priority
      });
    }
    const group = grouped.get(key);
    group.count += 1;
    if (priorityRank(item.priority) < priorityRank(group.highestPriority)) group.highestPriority = item.priority;
  }
  return [...grouped.values()].sort((first, second) =>
    Number(first.kind === "waiting-external") - Number(second.kind === "waiting-external")
    || second.count - first.count
    || priorityRank(first.highestPriority) - priorityRank(second.highestPriority)
    || first.id.localeCompare(second.id));
}

export function groupNeedsUserItems(items) {
  const grouped = new Map();
  for (const item of items) {
    const key = `${item.kind}\u0000${item.resumeToken}`;
    if (!grouped.has(key)) {
      grouped.set(key, {
        kind: item.kind,
        resumeToken: item.resumeToken,
        count: 0,
        highestPriority: item.priority,
        itemIds: []
      });
    }
    const group = grouped.get(key);
    group.count += 1;
    group.itemIds.push(item.id);
    if (priorityRank(item.priority) < priorityRank(group.highestPriority)) group.highestPriority = item.priority;
  }
  return [...grouped.values()].map((group) => ({
    ...group,
    itemIds: [...new Set(group.itemIds)].sort()
  })).sort(compareNeedsUserGroups);
}

function selectQuestionAcquisition(question, targets) {
  const summaries = question.acquisition.filter((target) => target.state === "actionable");
  const ids = new Set(summaries.map((target) => target.id));
  const target = targets.filter((item) => ids.has(item.id))
    .sort((first, second) => priorityRank(first.priority) - priorityRank(second.priority)
      || first.id.localeCompare(second.id))[0];
  return target ? compactAcquisition(target, summaries.find((item) => item.id === target.id)) : null;
}

function compactAction(action) {
  return {
    id: action.id,
    kind: action.kind,
    status: action.status,
    note: action.note,
    ...(action.derived ? { derived: true } : {}),
    ...(action.acquisitionTargetId ? { acquisitionTargetId: action.acquisitionTargetId } : {})
  };
}

function compactAcquisition(target, fallback = {}) {
  if (!target) return fallback?.id ? { ...fallback } : null;
  return {
    id: target.id,
    priority: target.priority,
    status: fallback.status || target.reconciliation.status,
    state: fallback.state || target.reconciliation.state,
    provider: fallback.provider || target.provider,
    ...(target.researchRole || fallback.researchRole
      ? { researchRole: target.researchRole || fallback.researchRole }
      : {}),
    routeId: fallback.routeId || target.reconciliation.routeId,
    reference: fallback.reference || target.reference,
    questionIds: [...(target.questionIds || [])]
  };
}

function latestTargetAttempts(target, routeId) {
  const route = target?.routes?.find((item) => item.id === routeId)
    || target?.routes?.find((item) => item.attempts?.length);
  return latestAttempts(route?.attempts || []);
}

function latestAttempts(attempts) {
  return [...attempts]
    .sort((first, second) => Date.parse(second.attemptedAt) - Date.parse(first.attemptedAt))
    .slice(0, latestAttemptLimit)
    .map((attempt) => ({
      id: attempt.id,
      attemptedAt: attempt.attemptedAt,
      outcome: attempt.outcome,
      ...(attempt.actionId ? { actionId: attempt.actionId } : {}),
      ...(attempt.inheritedFromQuestionId ? { inheritedFromQuestionId: attempt.inheritedFromQuestionId } : {}),
      ...(attempt.query ? { query: attempt.query } : {}),
      ...(attempt.source ? { source: attempt.source } : {}),
      ...(attempt.scope?.coverage ? { coverage: attempt.scope.coverage } : {}),
      ...(attempt.note ? { note: attempt.note } : {})
    }));
}

function attemptContext(question, questions) {
  return researchAttemptsForQuestion(question, new Map(questions.map((item) => [item.id, item])));
}

function compactBlockers(items) {
  return [...items].sort(compareNeedsUserItems).map((item) => ({
    id: item.id,
    kind: item.kind,
    priority: item.priority,
    resumeToken: item.resumeToken
  }));
}

function compareNeedsUserItems(first, second) {
  return Number(first.kind === "waiting-external") - Number(second.kind === "waiting-external")
    || priorityRank(first.priority) - priorityRank(second.priority)
    || first.resumeToken.localeCompare(second.resumeToken)
    || first.id.localeCompare(second.id);
}

function compareNeedsUserGroups(first, second) {
  return Number(first.kind === "waiting-external") - Number(second.kind === "waiting-external")
    || priorityRank(first.highestPriority) - priorityRank(second.highestPriority)
    || first.resumeToken.localeCompare(second.resumeToken);
}

function highestPriority(groups) {
  return groups.sort((first, second) => priorityRank(first.highestPriority) - priorityRank(second.highestPriority))[0]?.highestPriority || null;
}

function priorityRank(priority) {
  const value = Number(priority?.slice(1));
  return Number.isInteger(value) ? value : 99;
}
