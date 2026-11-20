export const researchActionKinds = Object.freeze([
  "search",
  "review",
  "acquisition",
  "request",
  "purchase"
]);

export const researchActionStatuses = Object.freeze([
  "ready",
  "gated",
  "blocked",
  "completed",
  "retired"
]);

export const researchAttemptOutcomes = Object.freeze([
  "located",
  "candidate-found",
  "not-found-bounded",
  "blocked",
  "error",
  "no-new-information"
]);

const actionKinds = new Set(researchActionKinds);
const actionStatuses = new Set(researchActionStatuses);
const attemptOutcomes = new Set(researchAttemptOutcomes);
const completedAttemptOutcomes = new Set(["located", "not-found-bounded", "no-new-information"]);

export function isResearchActionKind(value) {
  return actionKinds.has(value);
}

export function isResearchActionStatus(value) {
  return actionStatuses.has(value);
}

export function isResearchAttemptOutcome(value) {
  return attemptOutcomes.has(value);
}

export function isResearchActionExecutable(action) {
  return action?.status === "ready";
}

export function selectExecutableResearchAction(actions = []) {
  return actions.find(isResearchActionExecutable) || null;
}

export function validateResearchAction(action, { questionId, questionStatus } = {}) {
  const label = `${questionId || "research question"}/${action?.id || "(missing action id)"}`;
  const issues = [];
  if (!isResearchActionKind(action?.kind)) issues.push(`${label} has invalid kind ${action?.kind || "(missing)"}`);
  if (!isResearchActionStatus(action?.status)) {
    issues.push(`${label} has invalid status ${action?.status || "(missing)"}`);
    return issues;
  }
  if (action.status === "ready" && questionStatus !== undefined && questionStatus !== "open") {
    issues.push(`${label} is ready while its question is ${questionStatus || "missing a status"}`);
  }
  if (["blocked", "gated"].includes(action.status)
    && (typeof action.note !== "string" || !action.note.trim()) && !action.gate) {
    issues.push(`${label} is gated without a structured gate or resume condition in its note`);
  }
  return issues;
}

export function researchActionStatusAfterAttempt(currentStatus, outcome) {
  if (!isResearchActionStatus(currentStatus)) throw new Error(`invalid research action status: ${currentStatus}`);
  if (!isResearchAttemptOutcome(outcome)) throw new Error(`invalid research attempt outcome: ${outcome}`);
  if (currentStatus !== "ready") {
    throw new Error(`research action is ${currentStatus}; only a ready action can record a new attempt`);
  }
  if (outcome === "blocked") return "blocked";
  if (completedAttemptOutcomes.has(outcome)) return "completed";
  return "ready";
}

// Separates what the harness operationally knows from what it may claim to
// know. The distinction exists because a real report once said the whole goal
// was blocked with "no more leads to pursue": the first half was true and the
// second was an epistemic claim nothing in the selection ladder could support.
// A goal legitimately IS blocked when exact gates are the only remaining paths
// -- that is what blocked means -- but an empty queue is never evidence that
// the research frontier is empty.
export const goalOperationalStates = Object.freeze([
  "RUNNABLE",
  "NEEDS USER",
  "WAITING EXTERNAL",
  "NO CANONICAL WORK KNOWN"
]);

const NEVER_CLAIM =
  "This is a statement about the canonical queue, not about the research frontier. "
  + "It does not mean no leads exist, and must never be reported as such.";

export function buildGoalState({
  readyQuestionCount = 0,
  actionableAcquisitionCount = 0,
  reopenableCount = 0,
  closureReviewCount = 0,
  sourceReviewCount = 0,
  expiringAuthorizedAccessCount = 0,
  routeDiscoveryCount = 0,
  triageQuestionCount = 0,
  needsUserCount = 0,
  waitingExternalCount = 0,
  uncoveredOriginGapCount = 0,
  originGapCount = 0
} = {}) {
  const runnable = readyQuestionCount + actionableAcquisitionCount + reopenableCount
    + closureReviewCount + sourceReviewCount + routeDiscoveryCount + triageQuestionCount
    + expiringAuthorizedAccessCount + uncoveredOriginGapCount;
  const coverageNote = originGapCount && !uncoveredOriginGapCount
    ? `All ${originGapCount} origin/frontier gap(s) are owned by an open, blocked, or exhausted question. `
      + "That is a coverage result, not a depth result: an owning question may itself have been closed on a single search."
    : null;

  const base = { runnableCount: runnable, neverClaim: NEVER_CLAIM, ...(coverageNote ? { coverageNote } : {}) };

  if (runnable) {
    return {
      ...base,
      operationalState: "RUNNABLE",
      blocked: false,
      message: `${runnable} canonical item(s) are runnable now.`,
      resume: "Take the selected next item."
    };
  }
  // Gates are the reason a goal is blocked, not a reason it cannot be.
  if (needsUserCount || waitingExternalCount) {
    const userLed = needsUserCount >= waitingExternalCount;
    return {
      ...base,
      operationalState: userLed ? "NEEDS USER" : "WAITING EXTERNAL",
      blocked: true,
      message: `No autonomous work remains. ${needsUserCount} item(s) need user action; `
        + `${waitingExternalCount} await an external response.`,
      resume: userLed
        ? "Clear a user gate; run --needs-user for the venue rollup, which groups gates by the single real-world action that clears them."
        : "Await the pending external responses, or clear a user gate in the meantime."
    };
  }
  return {
    ...base,
    operationalState: "NO CANONICAL WORK KNOWN",
    blocked: true,
    message: "No runnable canonical item and no recorded gate.",
    resume: "Reopen a closed question with a justified action, or record a new question. "
      + "An empty queue with no gates usually means questions were closed faster than routes were exhausted."
  };
}

export function buildNoSelectionReason({
  openQuestionCount,
  blockedActionCount,
  needsUserCount,
  waitingExternalCount
}) {
  if (!openQuestionCount) {
    const gated = needsUserCount || waitingExternalCount;
    return {
      reasonCode: "no-open-questions",
      message: "No open research question or actionable acquisition is currently selectable.",
      resume: gated
        ? `Resolve a canonical blocker (${needsUserCount} need user action; ${waitingExternalCount} await an external response), then reopen its question or make the acquisition actionable.`
        : "Create or reopen a canonical research question when new evidence or access supplies a justified next step."
    };
  }
  if (blockedActionCount || needsUserCount || waitingExternalCount) {
    return {
      reasonCode: "all-open-work-gated",
      message: `${openQuestionCount} open question(s) remain, but none has a ready action or actionable acquisition.`,
      resume: `Resolve a canonical blocker (${needsUserCount} need user action; ${waitingExternalCount} await an external response) or mark a newly executable action ready.`,
      blockedActionCount,
      needsUserCount,
      waitingExternalCount
    };
  }
  return {
    reasonCode: "open-work-needs-triage",
    message: `${openQuestionCount} open question(s) remain without a ready action, actionable acquisition, or recorded blocker.`,
    resume: "Add a justified ready action, record a blocked action with an exact resume condition, or close each question as answered or exhausted."
  };
}
