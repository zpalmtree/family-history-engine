import {
  isLiveResearchQuestion,
  parentSlotGoalKey,
  questionGoalKeys,
  relationshipBridgeGoalKey
} from "./research-question-state.mjs";
import { loadTreeConfig } from "./tree-config.mjs";

const parentRoles = Object.freeze(["father", "mother"]);

export function buildOriginGaps({ roots = loadTreeConfig().tree.rootPersonIds.map((rootId) => ({ rootId, mode: "frontier" })), people = [], parentLinks = [], questions = [] } = {}) {
  const peopleById = new Map(people.map((person) => [person.id, person]));
  const establishedByChild = new Map();
  const weakByChild = new Map();
  for (const relationship of parentLinks) {
    const assessment = parentAssessment(relationship);
    if (assessment === "rejected") continue;
    const destination = assessment === "established" ? establishedByChild : weakByChild;
    if (!destination.has(relationship.childId)) destination.set(relationship.childId, []);
    destination.get(relationship.childId).push({ ...relationship, assessment });
  }

  const ownersByGoalKey = new Map();
  for (const question of questions.filter(isLiveResearchQuestion)) {
    for (const goalKey of questionGoalKeys(question)) {
      if (!ownersByGoalKey.has(goalKey)) ownersByGoalKey.set(goalKey, []);
      ownersByGoalKey.get(goalKey).push(question.id);
    }
  }

  const seenPersonIds = new Set();
  const gaps = [];
  for (const root of roots) {
    const rootId = typeof root === "string" ? root : root.rootId;
    // Origin mode is retained only as a compatibility label. Both direct-line
    // roots now use the same continuous parent-frontier traversal.
    const mode = (typeof root === "string" ? null : root.mode) || "frontier";
    const generations = ancestorGenerations(rootId, establishedByChild);
    for (const [personId, generation] of generations.entries()) {
      if (personId === rootId || generation === 0 || seenPersonIds.has(personId)) continue;
      const person = peopleById.get(personId);
      if (!person) continue;

      const established = uniqueParents(establishedByChild.get(personId) || []);
      const weak = uniqueParents(weakByChild.get(personId) || []);
      const occupiedRoles = assignedRoles([...established, ...weak]);
      const establishedRoles = assignedRoles(established);
      const openSlotRoles = parentRoles.filter((role) => !occupiedRoles.has(role));
      const unresolvedRoles = parentRoles.filter((role) => !establishedRoles.has(role));
      const weakBridges = weak.map((relationship) => {
        const assertionId = relationship.proof?.assertionId || relationship.assertionId;
        const goalKey = relationshipBridgeGoalKey(assertionId, relationship);
        return {
          goalKey,
          parentId: relationship.parentId,
          role: normalizedRole(relationship.role),
          assertionId: assertionId || null,
          assessment: relationship.assessment
        };
      }).filter((bridge) => bridge.goalKey);
      const goalKeys = [
        ...weakBridges.map((bridge) => bridge.goalKey),
        ...openSlotRoles.map((role) => parentSlotGoalKey(personId, role))
      ].filter(Boolean);
      if (!goalKeys.length) continue;
      seenPersonIds.add(personId);
      const uncoveredGoalKeys = goalKeys.filter((goalKey) => !ownersByGoalKey.has(goalKey));
      const coveredGoalKeys = goalKeys.filter((goalKey) => ownersByGoalKey.has(goalKey));
      const coveringQuestionIds = owners(ownersByGoalKey, goalKeys);
      const originProof = person.factEvidence?.ancestryOrigin;
      gaps.push({
        id: `${weakBridges.length ? "bridge-gap" : "origin-gap"}-${personId}`,
        kind: weakBridges.length ? "relationship-bridge" : "parent-frontier",
        goalKeys,
        rootId,
        mode: "frontier",
        personId,
        displayName: displayName(person),
        generation,
        knownParentCount: established.length,
        parentIds: established.map((relationship) => relationship.parentId).sort(),
        establishedParentRoles: [...establishedRoles].sort(),
        weakParentCount: weak.length,
        weakParentIds: weak.map((relationship) => relationship.parentId).sort(),
        weakBridges,
        ...(weakBridges[0] ? {
          goalKey: weakBridges[0].goalKey,
          childId: personId,
          candidateParentId: weakBridges[0].parentId,
          candidateParentIds: weakBridges.map((bridge) => bridge.parentId).sort(),
          role: weakBridges[0].role,
          assertionId: weakBridges[0].assertionId,
          assessment: weakBridges.some((bridge) => bridge.assessment === "unresolved")
            ? "unresolved" : "candidate"
        } : {}),
        openParentRoles: unresolvedRoles,
        openParentSlots: unresolvedRoles.length,
        ancestryOrigin: person.ancestryOrigin || null,
        originAssessment: originProof?.assessment || "missing",
        usAssociated: person.ancestryOrigin === "United States"
          || (person.places || []).some((place) => place.country === "United States"),
        coveringQuestionIds,
        liveQuestionIds: coveringQuestionIds,
        uncoveredGoalKeys,
        coveredGoalKeys,
        frontier: true,
        uncovered: uncoveredGoalKeys.length > 0
      });
    }
  }
  return gaps.sort(compareOriginGaps);
}

export function buildEmilyOriginGaps({ people = [], parentLinks = [], questions = [] } = {}) {
  // Kept for this tree's tests: the second root's frontier on its own.
  return buildOriginGaps({ roots: [{ rootId: loadTreeConfig().tree.rootPersonIds.at(-1), mode: "frontier" }], people, parentLinks, questions });
}

export function originGapQuestion(gap) {
  const side = `${gap.rootId.charAt(0).toUpperCase()}${gap.rootId.slice(1)}`;
  if (gap.kind === "relationship-bridge") {
    return `Resolve the unowned ${side}-side ${gap.assessment} parent bridge from ${gap.displayName} to ${gap.candidateParentId}.`;
  }
  return `Resolve the unowned ${side}-side direct-ancestor frontier (${gap.uncoveredGoalKeys?.length || gap.openParentSlots} open parent slot(s)) for ${gap.displayName}.`;
}

export function selectAutonomousOriginGap(gaps = []) {
  return gaps.find((gap) => gap.uncovered) || null;
}

export function buildQuestionTriageAction() {
  return {
    id: "autonomous-triage-unresolved-question",
    kind: "review",
    status: "derived",
    derived: true,
    note: "Audit the unresolved acceptance criteria against completed attempt fingerprints and current free or already-accessible routes. Add one bounded canonical ready action before searching, or record a reviewed current-no-known-route assessment. Do not repeat a bounded search merely because another route is gated."
  };
}

export function selectAutonomousQuestionTriage(questions = []) {
  return buildAutonomousQuestionTriageQuestions(questions)[0] || null;
}

export function buildAutonomousQuestionTriageQuestions(questions = []) {
  return questions
    .filter((question) => question.status === "open")
    // Status is a compatibility label. Selection requires the independently
    // derived live bit so superseded and dependency-deferred v2 questions
    // cannot enter triage through a stale or synthesized `open` value.
    .filter((question) => question.live === true
      && question.routeAssessment?.state !== "current-no-known-route")
    .filter((question) => !question.actions?.some((action) => action.status === "ready"))
    .sort((first, second) => blockedCount(first) - blockedCount(second)
      || completedCount(first) - completedCount(second)
      || priorityRank(first.priority) - priorityRank(second.priority)
      || first.id.localeCompare(second.id));
}

function ancestorGenerations(rootId, establishedByChild) {
  const generations = new Map();
  const queue = [[rootId, 0]];
  while (queue.length) {
    const [personId, generation] = queue.shift();
    if (generations.has(personId) && generations.get(personId) <= generation) continue;
    generations.set(personId, generation);
    for (const relationship of establishedByChild.get(personId) || []) {
      queue.push([relationship.parentId, generation + 1]);
    }
  }
  return generations;
}

function parentAssessment(relationship) {
  const explicit = relationship.proof?.assessment || relationship.assessment;
  if (explicit) return explicit;
  if (["candidate", "unresolved"].includes(relationship.status)) return relationship.status;
  if (relationship.status === "rejected") return "rejected";
  // Schema-v1 fixtures and relationships predate proof.assessment. Treat only
  // that missing legacy shape as established for compatibility.
  return "established";
}

function uniqueParents(relationships) {
  const seen = new Set();
  return relationships.filter((relationship) => {
    const key = `${relationship.parentId}\u0000${relationship.role || ""}\u0000${relationship.proof?.assertionId || relationship.assertionId || ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function assignedRoles(relationships) {
  const roles = new Set(relationships.map((relationship) => normalizedRole(relationship.role)).filter(Boolean));
  let unassigned = relationships.filter((relationship) => !normalizedRole(relationship.role)).length;
  for (const role of parentRoles) {
    if (unassigned <= 0) break;
    if (!roles.has(role)) {
      roles.add(role);
      unassigned -= 1;
    }
  }
  return roles;
}

function normalizedRole(role) {
  return parentRoles.includes(role) ? role : null;
}

function owners(ownersByGoalKey, goalKeys) {
  return [...new Set(goalKeys.flatMap((goalKey) => ownersByGoalKey.get(goalKey) || []))].sort();
}

function displayName(person) {
  return person.names?.find((name) => name.display)?.value
    || person.names?.find((name) => name.type === "birth")?.value
    || person.names?.[0]?.value
    || person.id;
}

function compareOriginGaps(first, second) {
  return Number(second.uncovered) - Number(first.uncovered)
    || first.rootId.localeCompare(second.rootId)
    || Number(first.kind !== "relationship-bridge") - Number(second.kind !== "relationship-bridge")
    || Number(second.usAssociated || false) - Number(first.usAssociated || false)
    || Number(second.openParentSlots || 0) - Number(first.openParentSlots || 0)
    || second.generation - first.generation
    || first.id.localeCompare(second.id);
}

function blockedCount(question) {
  return question.actions?.filter((action) => ["blocked", "gated"].includes(action.status)).length || 0;
}

function completedCount(question) {
  return question.actions?.filter((action) => action.status === "completed").length || 0;
}

function priorityRank(priority) {
  const value = Number(priority?.slice(1));
  return Number.isInteger(value) ? value : 99;
}
