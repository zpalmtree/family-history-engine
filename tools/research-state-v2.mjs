import { structuredGateForTarget } from "./needs-user.mjs";
import {
  isLiveResearchQuestion,
  questionConclusionState,
  questionGoalKeys,
  questionLifecycleState
} from "./research-question-state.mjs";
import { targetResearchRole } from "./research-target-state.mjs";

const alternateRouteReasons = new Set(["needs-alternate-route", "alternate-provider", "inaccessible"]);

// Pure migration projections. They never write canonical files; callers must
// review inferred goal keys and use the repository's normal atomic writers.
export function projectQuestionStateV2(question = {}, { questions = [], assertions = [] } = {}) {
  const goalKeys = questionGoalKeys(question.deferred ? { ...question, deferred: false } : question);
  const assertionById = assertions instanceof Map
    ? assertions
    : new Map(assertions.map((assertion) => [assertion.id, assertion]));
  const frontierPersonIds = new Set();
  for (const goalKey of goalKeys) {
    const parentSlot = /^parent-slot:([^:]+):(father|mother)$/.exec(goalKey);
    if (parentSlot) frontierPersonIds.add(parentSlot[1]);
    const bridge = /^relationship-bridge:(.+)$/.exec(goalKey);
    if (bridge) {
      const assertion = assertionById.get(bridge[1]);
      if (assertion?.claim?.childId) frontierPersonIds.add(assertion.claim.childId);
      else if (bridge[1].includes(":")) frontierPersonIds.add(bridge[1].split(":")[0]);
    }
  }
  if (!frontierPersonIds.size && goalKeys.some(isFrontierGoalKey)
    && (question.personIds || []).length === 1) {
    frontierPersonIds.add(question.personIds[0]);
  }
  const frontierStateNeedsPerson = questionLifecycleState(question) === "active"
    && ["unresolved", "candidate", "conflicted"].includes(questionConclusionState(question))
    && goalKeys.some(isFrontierGoalKey);
  const frontierPersonId = frontierStateNeedsPerson
    ? question.frontierPersonId || (frontierPersonIds.size === 1 ? [...frontierPersonIds][0] : null)
    : null;
  const questionById = new Map(questions.map((item) => [item.id, item]));
  const inheritedAttemptIds = (question.legacyQuestionIds || [])
    .flatMap((id) => (questionById.get(id)?.attempts || []).map((attempt) => attempt.id))
    .filter(Boolean);
  const legacyAttemptIds = Array.isArray(question.legacyAttemptIds)
    ? question.legacyAttemptIds
    : inheritedAttemptIds;
  return {
    schemaVersion: 2,
    lifecycle: questionLifecycleState(question),
    goalKeys,
    conclusion: {
      ...(question.conclusion && typeof question.conclusion === "object" ? question.conclusion : {}),
      state: questionConclusionState(question)
    },
    routeAssessment: question.routeAssessment || {
      state: "unassessed",
      legacyStatus: question.status || null
    },
    actions: (question.actions || []).map((action) => ({
      ...action,
      status: action.status === "blocked" ? "gated" : action.status
    })),
    ...(frontierPersonId ? { frontierPersonId } : {}),
    ...(question.legacyQuestionIds ? { legacyQuestionIds: [...question.legacyQuestionIds] } : {}),
    ...(legacyAttemptIds.length ? { legacyAttemptIds: [...new Set(legacyAttemptIds)].sort() } : {}),
    ...(question.deferred ? {
      deferred: true,
      dependsOnAssertionIds: [...(question.dependsOnAssertionIds || [])]
    } : {}),
    migration: {
      sourceSchemaVersion: question.schemaVersion || 1,
      goalKeyBasis: question.goalKeys?.length ? "explicit" : "conservative-v1-purpose-inference",
      requiresGoalKeyReview: !question.goalKeys?.length && isLiveResearchQuestion(question),
      requiresFrontierPersonReview: frontierStateNeedsPerson && !frontierPersonId
    }
  };
}

export function projectTargetStateV2(target = {}, questions = []) {
  const byId = new Map(questions.map((question) => [question.id, question]));
  const liveQuestionIds = [...new Set((target.questionIds || [])
    .filter((id) => isLiveResearchQuestion(byId.get(id))))].sort();
  const gate = structuredGateForTarget(target);
  const routeDiscovery = alternateRouteReasons.has(target.reconciliation?.reasonCode);
  return {
    // Acquisition authority, sync, and bootstrap writers currently define
    // canonical target schema v4. These role fields extend v4; a later schema
    // bump must update every authority writer atomically.
    schemaVersion: 4,
    liveQuestionIds,
    researchRole: targetResearchRole(target, questions),
    workState: routeDiscovery && liveQuestionIds.length
      ? "route-discovery"
      : gate?.actor === "user" && liveQuestionIds.length
        ? "needs-user"
        : gate?.actor === "external" && liveQuestionIds.length
          ? "waiting-external"
          : target.reconciliation?.state === "actionable"
            ? "ready"
            : "resolved",
    migration: {
      sourceSchemaVersion: target.schemaVersion || 1,
      gateBasis: gate?.compatibility || (gate ? "explicit" : "none"),
      requiresGateReview: Boolean(gate?.compatibility)
    }
  };
}

function isFrontierGoalKey(value) {
  return /^(?:parent-slot|relationship-bridge):/.test(value);
}
