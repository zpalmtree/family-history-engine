import { priorityRank, structuredGateForTarget } from "./needs-user.mjs";
import { isProofBlockingTarget } from "./research-target-state.mjs";
import { isDormantScope } from "./research-scope.mjs";

// The user asked on 7 Oct 2026 to favour frontier work and acquisitions (newly
// reopened Findmypast records among them) over rereads, keeping one reread
// slot in eight. The cadence length stays eight, so audited history replays.
export const RESEARCH_QUEUE_CADENCE_ID = "research-queue-3-frontier-2-proof-2-acquisition-1-source-v2";
export const AUTHORIZED_ACCESS_PREEMPTION_HORIZON_DAYS = 45;
export const RESEARCH_QUEUE_CADENCE = Object.freeze([
  "frontier",
  "proof",
  "acquisition",
  "frontier",
  "source-review",
  "acquisition",
  "frontier",
  "proof"
]);

const schedulerCounterFields = Object.freeze([
  "sourceReview",
  "proof",
  "frontier",
  "acquisition"
]);

const alternateRouteReasons = new Set([
  "needs-alternate-route",
  "alternate-provider",
  "inaccessible",
  "autonomous-route-discovery"
]);

export function buildClosureReviewItems(depthReport, questions = []) {
  const byId = new Map(questions.map((question) => [question.id, question]));
  return (depthReport?.flagged || []).filter((flag) => byId.get(flag.id)?.live !== false).map((flag) => {
    const question = byId.get(flag.id) || flag;
    return {
      id: `closure-review-${flag.id}`,
      kind: "closure-review",
      questionId: flag.id,
      branchId: flag.branchId,
      priority: flag.priority || question.priority || "P2",
      status: question.status,
      conclusionState: question.conclusionState,
      workState: question.workState,
      question: question.question,
      attemptCount: flag.attemptCount,
      hasOriginalEvidence: flag.hasOriginalEvidence,
      action: {
        id: "review-thin-closure",
        kind: "review",
        status: "derived",
        derived: true,
        note: "Independently review the acceptance criteria, evidence grades, attempt coverage, and current free or already-accessible routes. Reopen with one exact bounded action when work remains; otherwise record a reviewed current-no-known-route assessment."
      }
    };
  });
}

export function buildReopenTriggerItems(fired = [], questions = []) {
  const byId = new Map(questions.map((question) => [question.id, question]));
  return fired.map((trigger) => {
    const question = byId.get(trigger.questionId) || {};
    return {
      id: `reopen-trigger-${trigger.questionId}-${trigger.triggerId}`,
      kind: "reopen-trigger",
      questionId: trigger.questionId,
      branchId: question.branchId,
      priority: question.priority || "P1",
      status: trigger.questionStatus,
      conclusionState: question.conclusionState,
      workState: question.workState,
      question: question.question,
      trigger,
      action: {
        id: `consume-${trigger.triggerId}`,
        kind: "review",
        status: "derived",
        derived: true,
        note: "Review the newly fired evidence trigger, reopen the question with the concrete work it enables, and consume this trigger exactly once."
      }
    };
  });
}

export function buildRouteDiscoveryItems(targets = [], questions = []) {
  const liveById = new Map(questions.map((question) => [question.id, question]));
  const isLive = (question) => question?.live !== false
    && question?.conclusionState !== "established"
    && question?.lifecycle !== "superseded"
    && question?.status !== "answered";

  return targets.filter((target) => alternateRouteReasons.has(target.reconciliation?.reasonCode)
    // A parallel alternate remains available through the normal actionable
    // acquisition path, but targets with a live user/external gate belong in
    // that authoritative attention rollup rather than a duplicate discovery
    // lane. This keeps one selectable route-discovery item per ungated target.
    && !structuredGateForTarget(target)
    && isProofBlockingTarget(target, questions))
    .map((target) => ({
      target,
      questionIds: [...new Set((target.questionIds || []).filter((id) => isLive(liveById.get(id))))].sort()
    }))
    // Optional/standalone source recovery remains visible in acquisition tools,
    // but it does not make the direct-line research goal runnable or blocked.
    .filter((entry) => entry.questionIds.length)
    .map(({ target, questionIds }) => ({
      id: `route-discovery-${target.id}`,
      kind: "route-discovery",
      targetId: target.id,
      priority: target.priority || "P2",
      provider: target.provider,
      reference: target.reference,
      questionIds,
      action: {
        id: "discover-accessible-equivalent-route",
        kind: "review",
        status: "derived",
        derived: true,
        note: "Search current free and already-authorized provider catalogs for an accessible equivalent, record exact coverage, and either add a concrete route or retain a versioned provider watch. This is autonomous route discovery, not a user gate."
      }
    }));
}

// Adapter contract for the extraction lane. buildExtractionStatus() returns
// one bounded next packet (or one implicit single-record packet); the research
// scheduler treats that packet as one source-review work item. This module
// deliberately does not load or mutate the extraction store.
export function buildSourceReviewItems(extractionStatus, { scope } = {}) {
  if (scope && extractionStatus?.researchScope !== scope) {
    throw new Error(`extraction status belongs to ${extractionStatus?.researchScope || "an unknown scope"}, not ${scope}`);
  }
  const next = extractionStatus?.next;
  if (!next || !Array.isArray(next.records) || !next.records.length) return [];
  if (scope && next.records.some((record) => record.researchScope !== scope)) {
    throw new Error(`source-review packet crosses the ${scope} research-scope boundary`);
  }
  const records = next.records.map((record) => ({
    recordId: record.recordId,
    sha256: record.sha256,
    sourceId: record.sourceId,
    researchScope: record.researchScope,
    state: record.state,
    ...(record.packetId ? { packetId: record.packetId } : {})
  }));
  const packetKey = next.packetId || records.map((record) => record.recordId).join("-");
  return [{
    id: `source-review-${packetKey}`,
    kind: "source-review",
    researchScope: extractionStatus.researchScope,
    ...(isDormantScope(extractionStatus.researchScope) ? { branchId: extractionStatus.researchScope } : {}),
    priority: "P0",
    reviewState: next.kind,
    implicitPacket: Boolean(next.implicitPacket),
    ...(next.packetId ? { packetId: next.packetId } : {}),
    records,
    action: {
      id: "review-source-master-packet",
      kind: "review",
      status: "derived",
      derived: true,
      note: "Visually review the bounded source-master packet, record its extraction outcome, and apply any resulting canonical claim or question changes."
    }
  }];
}

/**
 * Resolve the audited cursor used by selectFairQueueItem(). Exactly one input
 * source may be supplied:
 *
 * - schedulerRecord: persisted `{schemaVersion: 1, cadenceId, cursor}`. `cursor`
 *   is the next cadence slot (0..7).
 * - auditedWorkCounters: completed-work counts `{sourceReview, proof,
 *   frontier, acquisition, cadenceSlotsAdvanced?}`. `cadenceSlotsAdvanced`
 *   also counts unavailable slots skipped before completed work; when omitted,
 *   it defaults to the four work-count sum. The next cursor is this audited
 *   advance count modulo eight.
 *
 * The returned object records the input basis and normalized counters so a
 * status caller can expose and audit the scheduling decision. A default cursor
 * exists only for the pre-v2 queue, which has no source-review input.
 */
export function resolveResearchScheduler({ schedulerRecord, auditedWorkCounters } = {}) {
  if (schedulerRecord && auditedWorkCounters) {
    throw new Error("research scheduler accepts either schedulerRecord or auditedWorkCounters, not both");
  }
  if (schedulerRecord) {
    if (schedulerRecord.schemaVersion !== 1) throw new Error("research scheduler record must use schemaVersion 1");
    if (schedulerRecord.cadenceId !== RESEARCH_QUEUE_CADENCE_ID) {
      throw new Error(`research scheduler record must use cadenceId ${RESEARCH_QUEUE_CADENCE_ID}`);
    }
    assertCadenceCursor(schedulerRecord.cursor, "research scheduler record cursor");
    return {
      cadenceId: RESEARCH_QUEUE_CADENCE_ID,
      cadence: [...RESEARCH_QUEUE_CADENCE],
      cursor: schedulerRecord.cursor,
      basis: "persisted-scheduler-record",
      counters: schedulerRecord.completed
        ? normalizeSchedulerCounters(schedulerRecord.completed)
        : null
    };
  }
  if (auditedWorkCounters) {
    const counters = normalizeSchedulerCounters(auditedWorkCounters);
    return {
      cadenceId: RESEARCH_QUEUE_CADENCE_ID,
      cadence: [...RESEARCH_QUEUE_CADENCE],
      cursor: counters.cadenceSlotsAdvanced % RESEARCH_QUEUE_CADENCE.length,
      basis: "audited-work-counters",
      counters
    };
  }
  return {
    cadenceId: RESEARCH_QUEUE_CADENCE_ID,
    cadence: [...RESEARCH_QUEUE_CADENCE],
    cursor: 0,
    basis: "legacy-default",
    counters: null
  };
}

/**
 * Select one item from the research frontier.
 *
 * Cadence inputs are `sourceReviews`, proof work (`closureReviews`,
 * `readyQuestions`, `triageQuestions`), frontier work (`frontierQuestions`,
 * `originGaps`), and acquisition work
 * (`routeDiscoveries`, `standaloneAcquisitions`). If source reviews exist, the
 * caller MUST also pass auditedWorkCounters or schedulerRecord; this prevents
 * a read-only status command from restarting at the source slot forever.
 *
 * `expiringAuthorizedAccess` is an optional preemption queue. Each entry is
 * `{kind, item, access: {authorizationState: "authorized", expiresAt,
 * provider?}}`. Only an unexpired access window ending within
 * `accessExpiryHorizonDays` preempts cadence. `now` is injectable for tests.
 *
 * A cadence selection returns `{kind, item, scheduler}`. `scheduler` includes
 * selectedLane, selectedSlot, nextCursor, and a completionDelta to apply only
 * after successful work. Preemptions leave nextCursor unchanged.
 */
export function selectFairQueueItem({
  readyQuestions = [],
  standaloneAcquisitions = [],
  reopenTriggers = [],
  closureReviews = [],
  routeDiscoveries = [],
  sourceReviews = [],
  frontierQuestions = [],
  originGaps = [],
  triageQuestions = [],
  expiringAuthorizedAccess = [],
  schedulerRecord,
  auditedWorkCounters,
  now = new Date(),
  accessExpiryHorizonDays = AUTHORIZED_ACCESS_PREEMPTION_HORIZON_DAYS,
  branchEffort = new Map(),
  dryQuestionIds = new Set(),
  rootProgress = new Map()
} = {}) {
  const first = (items, compare = compareGeneric) => [...items].sort(compare)[0] || null;
  const questionCompare = (left, right) => compareQuestionWork(left, right, branchEffort, dryQuestionIds);
  const scheduler = resolveResearchScheduler({ schedulerRecord, auditedWorkCounters });
  if (sourceReviews.length && scheduler.basis === "legacy-default") {
    throw new Error("source-review scheduling requires auditedWorkCounters or a persisted schedulerRecord");
  }

  const access = selectExpiringAuthorizedAccess(expiringAuthorizedAccess, {
    now,
    accessExpiryHorizonDays,
    rootProgress
  });
  if (access) return selectionWithPreemption(access.kind, access.item, scheduler, {
    reason: "expiring-authorized-access",
    access: access.access
  });

  // A fired evidence trigger is consumed exactly once. It does not consume a
  // cadence slot because it was not pending when the cursor was last audited.
  const trigger = first(reopenTriggers, questionCompare);
  if (trigger) return selectionWithPreemption("reopen-trigger", trigger, scheduler, {
    reason: "fired-reopen-trigger"
  });

  const laneItems = {
    "source-review": () => {
      const item = first(sourceReviews, (left, right) => compareSourceReview(left, right, {
        branchEffort,
        rootProgress
      }));
      return item ? { kind: "source-review", item } : null;
    },
    proof: () => first([
      ...closureReviews.map((item) => ({ kind: "closure-review", item })),
      ...readyQuestions.map((item) => ({ kind: "question", item })),
      ...triageQuestions.map((item) => ({ kind: "question", item }))
    ], (left, right) => questionCompare(left.item, right.item)
      || proofKindRank(left.kind) - proofKindRank(right.kind)),
    frontier: () => first([
      ...frontierQuestions.map((item) => ({ kind: "question", item })),
      ...originGaps.filter((gap) => gap.uncovered).map((item) => ({ kind: "origin-gap", item }))
    ], (left, right) => {
      if (left.kind === "question" && right.kind === "question") {
        return questionCompare(left.item, right.item);
      }
      if (left.kind === "origin-gap" && right.kind === "origin-gap") {
        return compareFrontier(left.item, right.item, rootProgress);
      }
      return Number(left.kind === "origin-gap") - Number(right.kind === "origin-gap");
    }),
    acquisition: () => first([
      ...routeDiscoveries.map((item) => ({ kind: "route-discovery", item })),
      ...standaloneAcquisitions.map((item) => ({ kind: "acquisition", item }))
    ], (left, right) => compareGeneric(left.item, right.item)
      || Number(left.kind !== "route-discovery") - Number(right.kind !== "route-discovery"))
  };
  for (let offset = 0; offset < RESEARCH_QUEUE_CADENCE.length; offset += 1) {
    const selectedSlot = (scheduler.cursor + offset) % RESEARCH_QUEUE_CADENCE.length;
    const selectedLane = RESEARCH_QUEUE_CADENCE[selectedSlot];
    const selected = laneItems[selectedLane]();
    if (selected) return selectionWithCadence(selected.kind, selected.item, scheduler, {
      selectedLane,
      selectedSlot
    });
  }
  return null;
}

export function assertRunnableSelection(goalState, nextEntry) {
  if ((goalState?.runnableCount || 0) > 0 && !nextEntry) {
    throw new Error(`research queue invariant failed: ${goalState.runnableCount} runnable item(s) but next is null`);
  }
  if (!(goalState?.runnableCount || 0) && nextEntry) {
    throw new Error(`research queue invariant failed: selected ${nextEntry.kind} while runnableCount is zero`);
  }
}

// A question whose recent attempts keep returning nothing yields to fresher
// work before branch fairness applies; it still runs once fresher work is done.
function compareQuestionWork(first, second, branchEffort, dryQuestionIds = new Set()) {
  const dry = Number(dryQuestionIds.has(first.id)) - Number(dryQuestionIds.has(second.id));
  if (dry) return dry;
  const firstEffort = branchEffort.get(first.branchId) || { attemptTotal: 0, questionCount: 1 };
  const secondEffort = branchEffort.get(second.branchId) || { attemptTotal: 0, questionCount: 1 };
  // Cross-multiply rather than divide, keeping the comparison deterministic.
  const effort = firstEffort.attemptTotal * Math.max(secondEffort.questionCount, 1)
    - secondEffort.attemptTotal * Math.max(firstEffort.questionCount, 1);
  return effort
    || priorityRank(first.priority) - priorityRank(second.priority)
    || Number(first.workstream !== "tree-evidence-resolution")
      - Number(second.workstream !== "tree-evidence-resolution")
    || queueRank(first) - queueRank(second)
    || String(first.branchId || "").localeCompare(String(second.branchId || ""))
    || String(first.id).localeCompare(String(second.id));
}

function compareSourceReview(first, second, { branchEffort, rootProgress }) {
  const root = compareRootNeed(first, second, rootProgress);
  if (root) return root;
  if (first.branchId || second.branchId) {
    const branch = compareQuestionWork(first, second, branchEffort);
    if (branch) return branch;
  }
  return compareGeneric(first, second);
}

function compareFrontier(first, second, rootProgress) {
  return compareRootNeed(first, second, rootProgress)
    || String(first.rootId || "").localeCompare(String(second.rootId || ""))
    || Number(first.kind !== "relationship-bridge") - Number(second.kind !== "relationship-bridge")
    || Number(second.generation || 0) - Number(first.generation || 0)
    || String(first.id).localeCompare(String(second.id));
}

function compareRootNeed(first, second, rootProgress) {
  if (!first.rootId && !second.rootId) return 0;
  const firstProgress = rootProgress.get(first.rootId) || { covered: 0, total: 1 };
  const secondProgress = rootProgress.get(second.rootId) || { covered: 0, total: 1 };
  return firstProgress.covered * Math.max(secondProgress.total, 1)
    - secondProgress.covered * Math.max(firstProgress.total, 1);
}

function compareGeneric(first, second) {
  return priorityRank(first.priority) - priorityRank(second.priority)
    || String(first.id).localeCompare(String(second.id));
}

function queueRank(item) {
  return Number.isFinite(item.queueOrder) ? item.queueOrder : Number.MAX_SAFE_INTEGER;
}

function proofKindRank(kind) {
  return kind === "closure-review" ? 0 : 1;
}

function normalizeSchedulerCounters(value) {
  const counters = {};
  for (const field of schedulerCounterFields) {
    const count = value?.[field] ?? 0;
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error(`research scheduler counter ${field} must be a non-negative safe integer`);
    }
    counters[field] = count;
  }
  const completedTotal = schedulerCounterFields.reduce((total, field) => total + counters[field], 0);
  const cadenceSlotsAdvanced = value?.cadenceSlotsAdvanced ?? completedTotal;
  if (!Number.isSafeInteger(cadenceSlotsAdvanced) || cadenceSlotsAdvanced < completedTotal) {
    throw new Error("research scheduler counter cadenceSlotsAdvanced must be a safe integer no smaller than completed work");
  }
  counters.cadenceSlotsAdvanced = cadenceSlotsAdvanced;
  return counters;
}

function assertCadenceCursor(value, label) {
  if (!Number.isInteger(value) || value < 0 || value >= RESEARCH_QUEUE_CADENCE.length) {
    throw new Error(`${label} must be an integer from 0 through ${RESEARCH_QUEUE_CADENCE.length - 1}`);
  }
}

function selectionWithCadence(kind, item, scheduler, { selectedLane, selectedSlot }) {
  const cadenceAdvance = (selectedSlot - scheduler.cursor + RESEARCH_QUEUE_CADENCE.length)
    % RESEARCH_QUEUE_CADENCE.length + 1;
  return {
    kind,
    item,
    scheduler: {
      ...scheduler,
      preempted: false,
      selectedLane,
      selectedSlot,
      nextCursor: (selectedSlot + 1) % RESEARCH_QUEUE_CADENCE.length,
      completionDelta: {
        sourceReview: Number(selectedLane === "source-review"),
        proof: Number(selectedLane === "proof"),
        frontier: Number(selectedLane === "frontier"),
        acquisition: Number(selectedLane === "acquisition"),
        cadenceSlotsAdvanced: cadenceAdvance
      }
    }
  };
}

function selectionWithPreemption(kind, item, scheduler, { reason, access }) {
  return {
    kind,
    item,
    scheduler: {
      ...scheduler,
      preempted: true,
      preemptionReason: reason,
      nextCursor: scheduler.cursor,
      completionDelta: null,
      ...(access ? { access } : {})
    }
  };
}

function selectExpiringAuthorizedAccess(entries, {
  now,
  accessExpiryHorizonDays,
  rootProgress
}) {
  const nowMs = timeValue(now, "research scheduler now");
  if (!Number.isFinite(accessExpiryHorizonDays) || accessExpiryHorizonDays < 0) {
    throw new Error("accessExpiryHorizonDays must be a non-negative number");
  }
  const horizonMs = nowMs + accessExpiryHorizonDays * 24 * 60 * 60 * 1000;
  const eligible = entries.map((entry) => {
    if (!entry?.item?.id || !entry.kind || !entry.access) {
      throw new Error("expiring authorized access entries require kind, item.id, and access");
    }
    if (entry.access.authorizationState !== "authorized") {
      throw new Error(`${entry.item.id} expiring access must explicitly declare authorizationState authorized`);
    }
    const expiresMs = timeValue(entry.access.expiresAt, `${entry.item.id} access expiresAt`);
    return { ...entry, expiresMs };
  }).filter((entry) => entry.expiresMs > nowMs && entry.expiresMs <= horizonMs);
  return eligible.sort((left, right) => left.expiresMs - right.expiresMs
    || compareRootNeed(left.item, right.item, rootProgress)
    || compareGeneric(left.item, right.item))[0] || null;
}

function timeValue(value, label) {
  const timestamp = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error(`${label} must be a valid date or timestamp`);
  return timestamp;
}
