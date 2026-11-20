// Compatibility helpers for the question-state v2 rollout.
//
// Canonical v2 questions separate lifecycle, conclusion, route assessment,
// action state, and semantic goal ownership.  The existing store is schema v1,
// so readers deliberately accept both shapes while projections migrate.

export const questionConclusionStates = Object.freeze([
  "unresolved",
  "candidate",
  "established",
  "conflicted"
]);

const conclusionStates = new Set(questionConclusionStates);
const liveConclusionStates = new Set(["unresolved", "candidate", "conflicted"]);
const parentRoles = new Set(["father", "mother"]);

export function questionLifecycleState(question = {}) {
  const lifecycle = typeof question.lifecycle === "string"
    ? question.lifecycle
    : question.lifecycle?.state;
  return lifecycle === "superseded" ? "superseded" : "active";
}

export function questionConclusionState(question = {}) {
  const state = question.conclusion?.state;
  if (conclusionStates.has(state)) return state;
  return question.status === "answered" ? "established" : "unresolved";
}

export function questionDependenciesSatisfied(question = {}, { establishedAssertionIds = new Set() } = {}) {
  if (!question.deferred) return true;
  const dependencies = question.dependsOnAssertionIds || [];
  return dependencies.length > 0 && dependencies.every((id) => establishedAssertionIds.has(id));
}

export function isLiveResearchQuestion(question = {}, options = {}) {
  if (question.live === false) return false;
  return questionLifecycleState(question) === "active"
    && liveConclusionStates.has(questionConclusionState(question))
    && questionDependenciesSatisfied(question, options);
}

export function isQuestionExecutable(question = {}, options = {}) {
  if (!questionDependenciesSatisfied(question, options)) return false;
  // In v1 only an open question can execute a ready action.  V2 has no
  // overloaded status field: an active unresolved conclusion may execute any
  // explicitly ready action.
  if (question.schemaVersion >= 2 || question.lifecycle || question.conclusion?.state) {
    return isLiveResearchQuestion(question, options);
  }
  return question.status === "open";
}

export function isQuestionOperationallyOpen(question = {}, options = {}) {
  return question.schemaVersion >= 2 || question.lifecycle || question.conclusion?.state
    ? isLiveResearchQuestion(question, options)
    : question.status === "open";
}

export function questionWorkState(question = {}, options = {}) {
  if (questionLifecycleState(question) === "superseded") return "superseded";
  if (questionConclusionState(question) === "established") return "resolved";
  if (!questionDependenciesSatisfied(question, options)) return "waiting-system";
  if ((question.actions || []).some((action) => action.status === "ready")) return "ready";
  if (question.routeAssessment?.state === "current-no-known-route") return "awaiting-trigger";
  if ((question.actions || []).some((action) => ["gated", "blocked"].includes(action.status))) {
    return "review-needed";
  }
  return "review-needed";
}

export function questionOperationalLabel(question = {}, options = {}) {
  if (!(question.schemaVersion >= 2 || question.lifecycle || question.conclusion?.state)) {
    return question.status;
  }
  return `${questionConclusionState(question)}/${questionWorkState(question, options)}`;
}

// Stable one-word label for v1-compatible projections. Ordering matters:
// lifecycle and proof conclusions outrank dependency readiness, and only a
// live unresolved v2 question is projected as open.
export function questionCompatibilityStatus(question = {}, options = {}) {
  if (!(question.schemaVersion >= 2 || question.lifecycle || question.conclusion?.state)) {
    return question.status;
  }
  if (questionLifecycleState(question) === "superseded") return "superseded";
  if (questionConclusionState(question) === "established") return "answered";
  if (!questionDependenciesSatisfied(question, options)) return "deferred";
  return "open";
}

export function parentSlotGoalKey(personId, role) {
  if (!personId || !parentRoles.has(role)) return null;
  return `parent-slot:${personId}:${role}`;
}

export function relationshipBridgeGoalKey(assertionId, { childId, parentId, role } = {}) {
  if (assertionId) return `relationship-bridge:${assertionId}`;
  if (!childId || !parentId) return null;
  return `relationship-bridge:${childId}:${role || "parent"}:${parentId}`;
}

export function normalizeGoalKey(value) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (typeof value.key === "string" && value.key.trim()) return value.key.trim();
  if (value.kind === "parent-slot") return parentSlotGoalKey(value.personId, value.role);
  if (value.kind === "relationship-bridge") {
    return relationshipBridgeGoalKey(value.assertionId, value);
  }
  if (value.kind && value.personId) return `${value.kind}:${value.personId}`;
  return null;
}

export function questionGoalKeys(question = {}, options = {}) {
  if (!isLiveResearchQuestion(question, options)) return [];
  const explicit = (question.goalKeys || []).map(normalizeGoalKey).filter(Boolean);
  if (explicit.length) return [...new Set(explicit)].sort();

  // Conservative v1 adapter.  A person mention never owns the person's parent
  // frontier.  Only a question whose declared purpose explicitly asks for
  // parentage receives exact parent-slot keys.
  const purpose = [question.id, question.question, ...(question.acceptanceCriteria || [])]
    .filter(Boolean).join(" ");
  const inferred = [];
  if (/\bparent(?:age|s)?\b|\bfather\b|\bmother\b/i.test(purpose)) {
    for (const personId of question.personIds || []) {
      inferred.push(parentSlotGoalKey(personId, "father"), parentSlotGoalKey(personId, "mother"));
    }
  }
  // V1 relationship-resolution work owns the exact assertion bridge even if
  // its prose does not repeat the word parent.
  if (question.workstream === "tree-evidence-resolution") {
    for (const assertionId of question.assertionIds || []) {
      inferred.push(relationshipBridgeGoalKey(assertionId));
    }
  }
  return [...new Set(inferred.filter(Boolean))].sort();
}

export function questionOwnsGoalKey(question, goalKey) {
  return questionGoalKeys(question).includes(normalizeGoalKey(goalKey));
}

// Direct attempts are the operational effort/coverage record. Split questions
// retain exact immutable legacy pointers, but those broad catchall attempts do
// not become atom-level coverage for every child until a caller explicitly
// requests historical context (for example, duplicate-work prevention).
export function researchAttemptsForQuestion(question = {}, questions = [], { includeInherited = false } = {}) {
  const byId = questions instanceof Map ? questions : new Map(questions.map((item) => [item.id, item]));
  const output = [];
  const visited = new Set();
  const legacyAttemptIds = Array.isArray(question.legacyAttemptIds)
    ? new Set(question.legacyAttemptIds)
    : null;
  const visit = (current, inheritedFromQuestionId = null) => {
    if (!current?.id || visited.has(current.id)) return;
    visited.add(current.id);
    for (const attempt of current.attempts || []) {
      if (inheritedFromQuestionId && legacyAttemptIds && !legacyAttemptIds.has(attempt.id)) continue;
      output.push(inheritedFromQuestionId ? { ...attempt, inheritedFromQuestionId } : attempt);
    }
    if (includeInherited) {
      for (const legacyQuestionId of current.legacyQuestionIds || []) {
        visit(byId.get(legacyQuestionId), legacyQuestionId);
      }
    }
  };
  visit(question);
  return output.sort((first, second) => Date.parse(first.attemptedAt) - Date.parse(second.attemptedAt)
    || String(first.id || "").localeCompare(String(second.id || "")));
}

// A recorded route dependency defers scheduling only. The question stays live
// and keeps its goal keys; it returns to the queue as soon as the item it waits
// on moves. A missing, retired, or self-referencing dependency never parks it.
const pendingDependencyActionStatuses = new Set(["ready", "gated"]);

export function routeDependencyPending(question = {}, {
  targetById = new Map(),
  questionById = new Map(),
  isLive = () => true
} = {}) {
  const dependency = question.routeAssessment?.dependency;
  if (!dependency || typeof dependency !== "object") return false;
  if (dependency.targetId) {
    return targetById.get(dependency.targetId)?.reconciliation?.state === "blocked";
  }
  if (dependency.questionId && dependency.actionId) {
    const owner = questionById.get(dependency.questionId);
    if (!owner || owner.id === question.id || !isLive(owner)) return false;
    const action = (owner.actions || []).find((item) => item.id === dependency.actionId);
    return pendingDependencyActionStatuses.has(action?.status);
  }
  return false;
}

// Attempts since the question last produced a candidate, newest first.
// Adapter errors are neither effort nor progress. A long streak is the signal
// to rotate to fresher frontier work rather than drill the same routes again.
export const DRY_ATTEMPT_STREAK_THRESHOLD = 5;

export function trailingDryAttemptCount(attempts = []) {
  let count = 0;
  for (const attempt of [...attempts].reverse()) {
    if (attempt.outcome === "candidate-found") break;
    if (attempt.outcome !== "error") count += 1;
  }
  return count;
}

export function validateQuestionSupersession(question = {}, questions = []) {
  if (question.schemaVersion !== 2) return [];
  const byId = questions instanceof Map ? questions : new Map(questions.map((item) => [item.id, item]));
  const lifecycle = questionLifecycleState(question);
  const issues = [];
  if (lifecycle === "active") {
    if (Object.hasOwn(question, "supersededBy")) {
      issues.push(`${question.id} active lifecycle must not carry supersededBy`);
    }
    return issues;
  }
  if (!Array.isArray(question.supersededBy) || !question.supersededBy.length) {
    return [`${question.id} superseded lifecycle requires nonempty supersededBy IDs`];
  }
  if (new Set(question.supersededBy).size !== question.supersededBy.length) {
    issues.push(`${question.id} repeats a supersededBy question ID`);
  }
  for (const id of question.supersededBy) {
    const replacement = byId.get(id);
    if (id === question.id) issues.push(`${question.id} cannot supersede itself`);
    else if (!replacement) issues.push(`${question.id} supersededBy links missing question ${id}`);
    else if ((replacement.researchScope || "main") !== (question.researchScope || "main")) {
      issues.push(`${question.id} scope disagrees with superseding question ${id}`);
    }
  }
  return issues;
}
