import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { withFileLockSync, writeJsonAtomic } from "./atomic-json.mjs";
import {
  buildExtractionStatus,
  extractionReviewFile,
  loadExtractionStore
} from "./extraction-store.mjs";
import {
  RESEARCH_QUEUE_CADENCE,
  RESEARCH_QUEUE_CADENCE_ID,
  resolveResearchScheduler
} from "./research-queue.mjs";
import { selectExecutableResearchAction } from "./research-actions.mjs";
import { projectRoot, readJson } from "./research-store.mjs";
import { researchScopeOf, researchScopes } from "./research-scope.mjs";

const counterFields = Object.freeze(["sourceReview", "proof", "frontier", "acquisition"]);
const schedulerDirectory = path.join("evidence", "research", "schedulers");

export function researchSchedulerFile(root = projectRoot, scope = "main") {
  assertScope(scope);
  return path.join(root, schedulerDirectory, `${scope}.json`);
}

export function loadResearchSchedulerRecord({ root = projectRoot, scope = "main" } = {}) {
  const record = readJson(researchSchedulerFile(root, scope));
  const issues = validateResearchSchedulerRecord(record, { scope });
  if (issues.length) throw new Error(`research scheduler record is invalid:\n- ${issues.join("\n- ")}`);
  return record;
}

export function validateResearchSchedulerRecord(record, { scope } = {}) {
  const issues = [];
  const label = `research scheduler ${scope || record?.scope || "(unknown scope)"}`;
  if (record?.schemaVersion !== 1) issues.push(`${label} must use schemaVersion 1`);
  if (!researchScopes.includes(record?.scope)) issues.push(`${label} has invalid scope ${record?.scope}`);
  if (scope && record?.scope !== scope) issues.push(`${label} belongs to ${record?.scope}, not ${scope}`);
  if (record?.cadenceId !== RESEARCH_QUEUE_CADENCE_ID) issues.push(`${label} has an unsupported cadenceId`);
  if (!Number.isSafeInteger(record?.revision) || record.revision < 0) issues.push(`${label} has invalid revision`);
  if (!Number.isInteger(record?.cursor) || record.cursor < 0 || record.cursor >= RESEARCH_QUEUE_CADENCE.length) {
    issues.push(`${label} has invalid cursor`);
  }
  try {
    const resolved = resolveResearchScheduler({ schedulerRecord: record });
    if (resolved.counters
      && record.cursor !== resolved.counters.cadenceSlotsAdvanced % RESEARCH_QUEUE_CADENCE.length) {
      issues.push(`${label} cursor disagrees with completed cadenceSlotsAdvanced`);
    }
  } catch (error) {
    issues.push(`${label}: ${error.message}`);
  }
  if (!Number.isSafeInteger(record?.preemptionsCompleted) || record.preemptionsCompleted < 0) {
    issues.push(`${label} has invalid preemptionsCompleted`);
  }
  if (!Array.isArray(record?.history)) issues.push(`${label} requires a history array`);
  const history = Array.isArray(record?.history) ? record.history : [];
  if (Number.isSafeInteger(record?.revision) && record.revision !== history.length) {
    issues.push(`${label} revision must equal its audited history length`);
  }
  const ids = new Set();
  let preemptions = 0;
  let replayCursor = 0;
  const replayCompleted = {
    sourceReview: 0,
    proof: 0,
    frontier: 0,
    acquisition: 0,
    cadenceSlotsAdvanced: 0
  };
  for (const [index, event] of history.entries()) {
    const eventLabel = `${label} history[${index}]`;
    if (!/^scheduler-event-[a-f0-9]{16}$/.test(event?.id || "")) issues.push(`${eventLabel} has invalid id`);
    else if (ids.has(event.id)) issues.push(`${eventLabel} repeats id ${event.id}`);
    else {
      const { id: ignored, ...eventValue } = event;
      if (event.id !== schedulerEventId(eventValue)) issues.push(`${eventLabel} id does not seal its event`);
    }
    ids.add(event?.id);
    if (!/^[a-f0-9]{64}$/.test(event?.selectionToken || "")) issues.push(`${eventLabel} has invalid selectionToken`);
    if (!validTimestamp(event?.selectedAt) || !validTimestamp(event?.completedAt)) {
      issues.push(`${eventLabel} has invalid timestamps`);
    } else if (Date.parse(event.completedAt) < Date.parse(event.selectedAt)) {
      issues.push(`${eventLabel} completedAt precedes selectedAt`);
    }
    if (!Array.isArray(event?.completionRefs) || !event.completionRefs.length
      || event.completionRefs.some((item) => !safeCanonicalRef(item?.path)
        || !/^[a-f0-9]{64}$/.test(item?.sha256 || "")
        || !(item?.previousSha256 === null || /^[a-f0-9]{64}$/.test(item?.previousSha256 || ""))
        || item?.previousSha256 === item?.sha256
        || !["created", "content-changed"].includes(item?.change)
        || (item?.previousSha256 === null) !== (item?.change === "created"))) {
      issues.push(`${eventLabel} has invalid completionRefs`);
    }
    if (!/^[a-f0-9]{64}$/.test(event?.ownerSnapshotSha256 || "")) {
      issues.push(`${eventLabel} has invalid ownerSnapshotSha256`);
    }
    if (event?.preempted) preemptions += 1;
    if (event?.fromCursor !== replayCursor) issues.push(`${eventLabel} fromCursor breaks the audit chain`);
    if (event?.preempted) {
      if (event.completionDelta !== null || event.toCursor !== replayCursor) {
        issues.push(`${eventLabel} preemption must preserve the cadence cursor`);
      }
    } else {
      const delta = event?.completionDelta;
      const laneField = laneCounterField(event?.lane);
      if (!delta || !counterFields.includes(laneField)
        || counterFields.some((field) => delta[field] !== Number(field === laneField))
        || !Number.isInteger(delta.cadenceSlotsAdvanced)
        || delta.cadenceSlotsAdvanced < 1
        || delta.cadenceSlotsAdvanced > RESEARCH_QUEUE_CADENCE.length) {
        issues.push(`${eventLabel} has invalid cadence completionDelta`);
      } else {
        for (const field of counterFields) replayCompleted[field] += delta[field];
        replayCompleted.cadenceSlotsAdvanced += delta.cadenceSlotsAdvanced;
        replayCursor = (replayCursor + delta.cadenceSlotsAdvanced) % RESEARCH_QUEUE_CADENCE.length;
        if (event.toCursor !== replayCursor) issues.push(`${eventLabel} toCursor breaks the audit chain`);
      }
    }
  }
  if (record?.preemptionsCompleted !== preemptions) {
    issues.push(`${label} preemptionsCompleted disagrees with history`);
  }
  if (record?.cursor !== replayCursor || JSON.stringify(record?.completed) !== JSON.stringify(replayCompleted)) {
    issues.push(`${label} completed counters or cursor disagree with audited history`);
  }
  const expectedLast = history.at(-1) || null;
  if (JSON.stringify(record?.lastCompletion ?? null) !== JSON.stringify(expectedLast)) {
    issues.push(`${label} lastCompletion disagrees with history`);
  }
  return issues;
}

export function schedulerStatus(record) {
  return {
    cadenceId: record.cadenceId,
    cadence: [...RESEARCH_QUEUE_CADENCE],
    scope: record.scope,
    recordRevision: record.revision,
    cursor: record.cursor,
    basis: "persisted-scheduler-record",
    counters: { ...record.completed },
    preemptionsCompleted: record.preemptionsCompleted
  };
}

export function bindResearchSchedulerSelection(nextEntry, {
  root = projectRoot,
  scope,
  schedulerRecord,
  now = new Date()
} = {}) {
  if (!nextEntry?.scheduler || !nextEntry?.item?.id || !nextEntry?.kind) return nextEntry;
  const selectedAt = isoTimestamp(now, "research scheduler selection time");
  if (schedulerRecord.scope !== scope) throw new Error(`scheduler scope ${schedulerRecord.scope} does not match ${scope}`);
  if (nextEntry.scheduler.cursor !== schedulerRecord.cursor) {
    throw new Error("scheduler selection cursor disagrees with persisted record");
  }
  const selection = {
    schemaVersion: 1,
    scope,
    cadenceId: RESEARCH_QUEUE_CADENCE_ID,
    recordRevision: schedulerRecord.revision,
    cursor: schedulerRecord.cursor,
    kind: nextEntry.kind,
    itemId: nextEntry.item.id,
    ...(nextEntry.kind === "question" && selectedQuestionActionId(nextEntry.item)
      ? { actionId: selectedQuestionActionId(nextEntry.item) }
      : {}),
    // Status has full, compact, and session renderings of the same work item.
    // Seal the scheduling identity rather than renderer-only fields so any of
    // those saved JSON documents can be used as the completion receipt.
    itemFingerprint: schedulerItemFingerprint(nextEntry.item, nextEntry.kind),
    selectedAt,
    preempted: Boolean(nextEntry.scheduler.preempted),
    ...(nextEntry.scheduler.preemptionReason
      ? { preemptionReason: nextEntry.scheduler.preemptionReason }
      : {}),
    ...(nextEntry.scheduler.selectedLane ? { selectedLane: nextEntry.scheduler.selectedLane } : {}),
    ...(Number.isInteger(nextEntry.scheduler.selectedSlot)
      ? { selectedSlot: nextEntry.scheduler.selectedSlot }
      : {}),
    nextCursor: nextEntry.scheduler.nextCursor,
    completionDelta: nextEntry.scheduler.completionDelta
      ? { ...nextEntry.scheduler.completionDelta }
      : null,
    ownerSnapshot: buildSchedulerOwnerSnapshot(nextEntry, { root, scope })
  };
  selection.token = selectionToken(selection);
  return {
    ...nextEntry,
    scheduler: {
      ...nextEntry.scheduler,
      scope,
      recordRevision: schedulerRecord.revision,
      preemptionsCompleted: schedulerRecord.preemptionsCompleted,
      selection
    }
  };
}

// Attempt file names are 64-hex digests plus ".json". The owner snapshot
// travels inside every compact scheduler receipt, and a long-running question
// can hold well over a hundred attempts, so the inventory keeps only a short
// unique prefix of each name. Receipts written before this change carry full
// names; attemptInventoryIncludes accepts both forms.
export const SCHEDULER_ATTEMPT_NAME_LENGTH = 12;

export function attemptInventoryIncludes(inventory, name) {
  const paths = Array.isArray(inventory?.paths) ? inventory.paths : [];
  if (paths.includes(name)) return true;
  const length = Number.isInteger(inventory?.nameLength) ? inventory.nameLength : 0;
  return length > 0 && paths.includes(name.slice(0, length));
}

export function buildSchedulerOwnerSnapshot(nextEntry, {
  root = projectRoot,
  scope = "main"
} = {}) {
  assertScope(scope);
  const kind = nextEntry?.kind;
  const item = nextEntry?.item;
  if (!kind || !item?.id) throw new Error("scheduler owner snapshot requires one selected item");

  if (["question", "closure-review", "reopen-trigger"].includes(kind)) {
    const questionId = item.questionId || item.id;
    const questionPath = `evidence/research/questions/${questionId}.json`;
    const questionFile = path.join(root, questionPath);
    if (!fs.existsSync(questionFile)) throw new Error(`scheduler cannot snapshot missing question owner ${questionId}`);
    const question = readJson(questionFile);
    if (researchScopeOf(question) !== scope) {
      throw new Error(`scheduler question owner ${questionId} belongs to another research scope`);
    }
    const attemptPrefix = `evidence/research/attempts/${questionId}/`;
    const attemptDirectory = path.join(root, attemptPrefix);
    const attempts = fs.existsSync(attemptDirectory)
      ? fs.readdirSync(attemptDirectory, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map((entry) => ({
          name: entry.name,
          sha256: sha256(fs.readFileSync(path.join(attemptDirectory, entry.name)))
        }))
        .sort((left, right) => left.name.localeCompare(right.name))
      : [];
    return {
      schemaVersion: 1,
      scope,
      ownerKind: "question",
      ownerId: questionId,
      primary: { path: questionPath, sha256: sha256(fs.readFileSync(questionFile)) },
      attemptInventory: {
        prefix: attemptPrefix,
        count: attempts.length,
        nameLength: SCHEDULER_ATTEMPT_NAME_LENGTH,
        paths: attempts.map((entry) => entry.name.slice(0, SCHEDULER_ATTEMPT_NAME_LENGTH)),
        sha256: sha256(JSON.stringify(attempts))
      }
    };
  }

  if (["acquisition", "route-discovery"].includes(kind)) {
    const targetId = item.targetId || item.id;
    const targetPath = `evidence/acquisition/targets/${targetId}.json`;
    const targetFile = path.join(root, targetPath);
    if (!fs.existsSync(targetFile)) throw new Error(`scheduler cannot snapshot missing acquisition owner ${targetId}`);
    const target = readJson(targetFile);
    if (researchScopeOf(target) !== scope) {
      throw new Error(`scheduler acquisition owner ${targetId} belongs to another research scope`);
    }
    return {
      schemaVersion: 1,
      scope,
      ownerKind: "target",
      ownerId: targetId,
      primary: { path: targetPath, sha256: sha256(fs.readFileSync(targetFile)) }
    };
  }

  if (kind === "source-review") {
    const extractionStatus = buildExtractionStatus(loadExtractionStore({ root }), { scope });
    const currentById = new Map(extractionStatus.items.map((record) => [record.recordId, record]));
    const expectedRecords = extractionStatus.next?.records || [];
    const selectedKeys = (item.records || []).map((record) => `${record.recordId}@${record.sha256}`).sort();
    const expectedKeys = expectedRecords.map((record) => `${record.recordId}@${record.sha256}`).sort();
    if (JSON.stringify(selectedKeys) !== JSON.stringify(expectedKeys)) {
      throw new Error("scheduler source-review selection is not the complete current extraction packet");
    }
    const records = (item.records || []).map((record) => {
      const current = currentById.get(record.recordId);
      if (record.researchScope !== scope || record.state === "complete") {
        throw new Error(`scheduler cannot snapshot invalid source-review record ${record.recordId}`);
      }
      if (!current || current.sha256 !== record.sha256 || current.sourceId !== record.sourceId
        || current.researchScope !== record.researchScope || current.state !== record.state
        || (current.packetId || null) !== (record.packetId || item.packetId || null)) {
        throw new Error(`scheduler source-review record ${record.recordId} disagrees with current extraction state`);
      }
      const reviewFile = extractionReviewFile(root, record.recordId, record.sha256);
      return {
        recordId: record.recordId,
        sourceId: record.sourceId,
        researchScope: record.researchScope,
        sha256: record.sha256,
        selectedState: record.state,
        packetId: record.packetId || item.packetId || null,
        reviewPath: canonicalRelative(root, reviewFile),
        reviewSha256: fs.existsSync(reviewFile) ? sha256(fs.readFileSync(reviewFile)) : null
      };
    });
    if (!records.length) throw new Error("scheduler source-review owner snapshot requires records");
    return {
      schemaVersion: 1,
      scope,
      ownerKind: "source-review",
      ownerId: item.id,
      packetId: item.packetId || null,
      records
    };
  }

  return {
    schemaVersion: 1,
    scope,
    ownerKind: "frontier",
    ownerId: item.id,
    personId: item.personId || null,
    goalKeys: [...(item.uncoveredGoalKeys || item.goalKeys || [])].sort()
  };
}

export function advanceResearchScheduler({
  root = projectRoot,
  scope = "main",
  selectionDocument,
  completionRefs,
  completedAt = new Date(),
  expectedRevision,
  write = true,
  verifySourceProgress = true
} = {}) {
  assertScope(scope);
  const selected = parseSchedulerSelection(selectionDocument);
  const completedAtIso = isoTimestamp(completedAt, "research scheduler completion time");
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw new Error("scheduler completion requires a non-negative expectedRevision");
  }
  if (selected.selection.scope !== scope) {
    throw new Error(`scheduler selection belongs to ${selected.selection.scope}, not ${scope}`);
  }
  if (selected.selection.recordRevision !== expectedRevision) {
    throw new Error("scheduler selection revision disagrees with expectedRevision");
  }
  if (Date.parse(completedAtIso) < Date.parse(selected.selection.selectedAt)) {
    throw new Error("scheduler completion cannot precede its selection");
  }
  const normalizedRefs = validateCompletionRefs(completionRefs, {
    root,
    scope,
    selectedAt: selected.selection.selectedAt,
    selection: selected
  });
  if (selected.kind === "question") {
    verifyCompletedQuestionAction(selected, normalizedRefs, { root, scope });
  }
  if (selected.kind === "source-review" && verifySourceProgress) {
    verifyCompletedSourceReview(selected.item, selected.selection.ownerSnapshot, normalizedRefs, {
      root,
      scope
    });
  }

  const file = researchSchedulerFile(root, scope);
  let result;
  withFileLockSync(file, () => {
    const current = loadResearchSchedulerRecord({ root, scope });
    const alreadyApplied = current.history.find((event) => event.selectionToken === selected.selection.token);
    if (alreadyApplied) {
      result = { record: current, event: alreadyApplied, changed: false };
      return;
    }
    if (current.revision !== expectedRevision) {
      throw new Error(`stale scheduler revision ${expectedRevision}; current revision is ${current.revision}`);
    }
    if (current.cursor !== selected.selection.cursor) {
      throw new Error(`stale scheduler cursor ${selected.selection.cursor}; current cursor is ${current.cursor}`);
    }
    const next = applySchedulerCompletion(current, selected.selection, {
      completionRefs: normalizedRefs,
      completedAt: completedAtIso
    });
    const issues = validateResearchSchedulerRecord(next, { scope });
    if (issues.length) throw new Error(`scheduler completion produced invalid state:\n- ${issues.join("\n- ")}`);
    if (write) writeJsonAtomic(file, next);
    result = { record: next, event: next.lastCompletion, changed: true };
  });
  return result;
}

function verifyCompletedQuestionAction(selected, completionRefs, { root, scope }) {
  const selectedActionId = selected.selection.actionId;
  if (!selectedActionId) return;
  const snapshot = selected.selection.ownerSnapshot;
  if (snapshot.ownerKind !== "question" || snapshot.scope !== scope) {
    throw new Error("question completion has an invalid owner snapshot");
  }
  const question = readJson(path.join(root, snapshot.primary.path));
  const currentAction = question.actions?.find((action) => action.id === selectedActionId);
  if (!currentAction) {
    throw new Error(`selected research action ${selectedActionId} is missing from ${snapshot.ownerId}`);
  }
  const attemptRefs = completionRefs
    .filter((reference) => reference.path.startsWith(snapshot.attemptInventory.prefix));
  const attempts = attemptRefs.map((reference) => readJson(path.join(root, reference.path)).attempt);
  const mismatched = attempts.find((attempt) => attempt?.actionId !== selectedActionId);
  if (mismatched) {
    throw new Error(`scheduler completion attempt ${mismatched.id || "(unknown)"} belongs to action `
      + `${mismatched.actionId || "(missing)"}, not selected action ${selectedActionId}`);
  }
  if (currentAction.status === "ready") {
    throw new Error(`selected research action ${selectedActionId} remains ready; error or candidate attempts do not complete it`);
  }
  const expectedOutcomes = currentAction.status === "completed"
    ? new Set(["located", "not-found-bounded", "no-new-information"])
    : currentAction.status === "blocked"
      ? new Set(["blocked"])
      : null;
  if (expectedOutcomes && !attempts.some((attempt) => expectedOutcomes.has(attempt?.outcome))) {
    throw new Error(`selected research action ${selectedActionId} is ${currentAction.status} without a matching terminal attempt`);
  }
  if (["gated", "retired"].includes(currentAction.status)
    && !completionRefs.some((reference) => reference.path === snapshot.primary.path)) {
    throw new Error(`selected research action ${selectedActionId} is ${currentAction.status} without its changed question file`);
  }
}

export function parseSchedulerSelection(document) {
  const scheduler = document?.scheduler || document?.queue?.scheduler;
  const item = document?.next || document?.selected;
  const kind = document?.nextKind || item?.kind;
  const selection = scheduler?.selection;
  if (!scheduler || !selection || !item || !kind) {
    throw new Error("selection document must contain scheduler selection metadata and one selected item");
  }
  if (selection.kind !== kind || selection.itemId !== item.id) {
    throw new Error("selection metadata disagrees with the selected item");
  }
  if (kind === "question" && (selection.actionId || null) !== selectedQuestionActionId(item)) {
    throw new Error("selection metadata disagrees with the selected research action");
  }
  if (selection.ownerSnapshot?.schemaVersion !== 1
    || selection.ownerSnapshot.scope !== selection.scope
    || selection.ownerSnapshot.ownerId !== ownerIdFor(kind, item)) {
    throw new Error("scheduler selection has an invalid canonical owner snapshot");
  }
  if (selection.itemFingerprint !== schedulerItemFingerprint(item, kind)) {
    throw new Error("scheduler selection item fingerprint is invalid");
  }
  if (selection.token !== selectionToken(selection)) throw new Error("scheduler selection token is invalid");
  return { scheduler, selection, item, kind };
}

function selectedQuestionActionId(item) {
  if (item?.action?.derived !== true && item?.action?.id) return item.action.id;
  return selectExecutableResearchAction(item?.actions || [])?.id || null;
}

function applySchedulerCompletion(current, selection, { completionRefs, completedAt }) {
  const preempted = Boolean(selection.preempted);
  const delta = selection.completionDelta;
  if (preempted && delta !== null) throw new Error("preempted scheduler work cannot consume a cadence slot");
  if (!preempted) validateCompletionDelta(selection);
  const completed = { ...current.completed };
  if (!preempted) {
    for (const field of counterFields) completed[field] += delta[field];
    completed.cadenceSlotsAdvanced += delta.cadenceSlotsAdvanced;
  }
  const nextCursor = preempted ? current.cursor : selection.nextCursor;
  const eventValue = {
    selectionToken: selection.token,
    kind: selection.kind,
    itemId: selection.itemId,
    ...(selection.selectedLane ? { lane: selection.selectedLane } : {}),
    preempted,
    ...(selection.preemptionReason ? { preemptionReason: selection.preemptionReason } : {}),
    selectedAt: selection.selectedAt,
    completedAt,
    fromCursor: current.cursor,
    toCursor: nextCursor,
    completionDelta: delta,
    ownerSnapshotSha256: sha256(JSON.stringify(selection.ownerSnapshot)),
    completionRefs
  };
  const id = schedulerEventId(eventValue);
  const event = { id, ...eventValue };
  return {
    ...current,
    revision: current.revision + 1,
    cursor: nextCursor,
    completed,
    preemptionsCompleted: current.preemptionsCompleted + Number(preempted),
    lastCompletion: event,
    history: [...current.history, event]
  };
}

function validateCompletionDelta(selection) {
  const delta = selection.completionDelta;
  if (!delta || !selection.selectedLane || !Number.isInteger(selection.selectedSlot)) {
    throw new Error("cadence completion requires selected lane, slot, and completionDelta");
  }
  const expectedLane = RESEARCH_QUEUE_CADENCE[selection.selectedSlot];
  if (selection.selectedLane !== expectedLane) throw new Error("selected cadence lane disagrees with its slot");
  for (const field of counterFields) {
    const expected = Number(field === laneCounterField(selection.selectedLane));
    if (delta[field] !== expected) throw new Error(`invalid scheduler completion delta for ${field}`);
  }
  const expectedAdvance = (selection.selectedSlot - selection.cursor + RESEARCH_QUEUE_CADENCE.length)
    % RESEARCH_QUEUE_CADENCE.length + 1;
  if (delta.cadenceSlotsAdvanced !== expectedAdvance) throw new Error("invalid scheduler cadence advance");
  if (selection.nextCursor !== (selection.selectedSlot + 1) % RESEARCH_QUEUE_CADENCE.length) {
    throw new Error("invalid scheduler next cursor");
  }
}

function validateCompletionRefs(refs, { root, scope, selectedAt, selection }) {
  if (!Array.isArray(refs) || !refs.length) throw new Error("scheduler completion requires at least one --completion-ref");
  const normalized = [...new Set(refs)].map((reference) => {
    if (!safeCanonicalRef(reference)) throw new Error(`unsafe or non-canonical completion ref: ${reference}`);
    const file = path.resolve(root, reference);
    if (!isWithin(root, file) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      throw new Error(`scheduler completion ref is not a current file: ${reference}`);
    }
    validateReferenceScope(file, reference, scope, selection);
    const previousSha256 = completionRefBaseline(reference, file, selection, { root, selectedAt });
    const currentSha256 = sha256(fs.readFileSync(file));
    if (previousSha256 === currentSha256) {
      throw new Error(`scheduler completion ref was only touched, not content-changed: ${reference}`);
    }
    return {
      path: reference,
      sha256: currentSha256,
      previousSha256,
      change: previousSha256 === null ? "created" : "content-changed"
    };
  }).sort((left, right) => left.path.localeCompare(right.path));
  return normalized;
}

function validateReferenceScope(file, reference, scope, selection) {
  if (selection.kind === "source-review") return;
  if (!reference.endsWith(".json")) return;
  let value;
  try {
    value = readJson(file);
  } catch {
    return;
  }
  if (reference.startsWith("evidence/research/attempts/")) {
    const pathQuestionId = reference.split("/")[3];
    const fingerprint = path.basename(reference, ".json");
    if (value.questionId !== pathQuestionId
      || (selection.selection.ownerSnapshot.ownerKind === "question"
        && value.questionId !== selection.selection.ownerSnapshot.ownerId)) {
      throw new Error(`scheduler completion attempt is not owned by its selected question: ${reference}`);
    }
    if (!/^[a-f0-9]{64}$/.test(fingerprint)
      || value.attempt?.fingerprint !== fingerprint
      || value.attempt?.id !== `attempt-${fingerprint.slice(0, 16)}`) {
      throw new Error(`scheduler completion attempt is not a canonical fingerprint shard: ${reference}`);
    }
    const questionFile = path.join(path.dirname(path.dirname(file)), "..", "questions", `${value.questionId}.json`);
    if (fs.existsSync(questionFile) && researchScopeOf(readJson(questionFile)) !== scope) {
      throw new Error(`scheduler completion ref belongs to another research scope: ${reference}`);
    }
    return;
  }
  if (reference.startsWith("evidence/research/questions/")
    && value.id !== path.basename(reference, ".json")) {
    throw new Error(`scheduler completion question id disagrees with its path: ${reference}`);
  }
  if (reference.startsWith("evidence/acquisition/targets/")
    && value.id !== path.basename(reference, ".json")) {
    throw new Error(`scheduler completion target id disagrees with its path: ${reference}`);
  }
  if (researchScopeOf(value) !== scope) {
    throw new Error(`scheduler completion ref belongs to another research scope: ${reference}`);
  }
}

function completionRefBaseline(reference, file, selection, { selectedAt }) {
  const snapshot = selection.selection.ownerSnapshot;
  if (snapshot.ownerKind === "question") {
    if (reference === snapshot.primary.path) return snapshot.primary.sha256;
    if (!reference.startsWith(snapshot.attemptInventory.prefix)) {
      throw new Error(`scheduler completion ref is unrelated to question ${snapshot.ownerId}: ${reference}`);
    }
    const name = reference.slice(snapshot.attemptInventory.prefix.length);
    if (!name || name.includes("/") || !name.endsWith(".json")) {
      throw new Error(`scheduler completion ref is not a direct attempt for ${snapshot.ownerId}: ${reference}`);
    }
    if (attemptInventoryIncludes(snapshot.attemptInventory, name)) {
      throw new Error(`existing immutable attempt cannot prove new scheduler work: ${reference}`);
    }
    return null;
  }
  if (snapshot.ownerKind === "target") {
    if (reference !== snapshot.primary.path) {
      throw new Error(`scheduler completion ref is unrelated to target ${snapshot.ownerId}: ${reference}`);
    }
    return snapshot.primary.sha256;
  }
  if (snapshot.ownerKind === "source-review") {
    const record = snapshot.records.find((candidate) => candidate.reviewPath === reference);
    if (!record) throw new Error(`scheduler completion ref is unrelated to the selected source packet: ${reference}`);
    return record.reviewSha256;
  }
  if (snapshot.ownerKind === "frontier") {
    if (!reference.startsWith("evidence/research/questions/") && !reference.startsWith("evidence/proof/")) {
      throw new Error(`scheduler frontier completion ref is unrelated: ${reference}`);
    }
    if (fs.statSync(file).mtimeMs + 1 < Date.parse(selectedAt)) {
      throw new Error(`scheduler frontier completion ref predates the selection: ${reference}`);
    }
    return null;
  }
  throw new Error(`unsupported scheduler owner snapshot kind: ${snapshot.ownerKind}`);
}

function verifyCompletedSourceReview(item, snapshot, completionRefs, { root, scope }) {
  if (snapshot.ownerKind !== "source-review" || snapshot.scope !== scope) {
    throw new Error("source review completion has an invalid owner snapshot");
  }
  const selectedRecords = item.records || [];
  if (selectedRecords.length !== snapshot.records.length) {
    throw new Error("source review owner snapshot no longer matches its selected packet");
  }
  const status = buildExtractionStatus(loadExtractionStore({ root }), { scope });
  const currentById = new Map(status.items.map((record) => [record.recordId, record]));
  for (const selected of selectedRecords) {
    const owner = snapshot.records.find((record) => record.recordId === selected.recordId);
    if (!owner || owner.sha256 !== selected.sha256 || owner.sourceId !== selected.sourceId
      || owner.researchScope !== selected.researchScope || owner.selectedState !== selected.state
      || owner.packetId !== (selected.packetId || item.packetId || null)) {
      throw new Error(`source review owner snapshot disagrees with selected record ${selected.recordId}`);
    }
    if (selected.researchScope !== scope) throw new Error(`selected source ${selected.recordId} crosses scope`);
    if (selected.state === "complete") throw new Error(`selected source ${selected.recordId} was already complete`);
    const current = currentById.get(selected.recordId);
    if (!current) throw new Error(`selected source ${selected.recordId} left the extraction campaign unexpectedly`);
    if (current.researchScope !== scope || current.sha256 !== selected.sha256
      || current.sourceId !== selected.sourceId) {
      throw new Error(`source review ${selected.recordId} changed identity, scope, or current hash`);
    }
    if ((current.packetId || null) !== owner.packetId) {
      throw new Error(`source review ${selected.recordId} left its selected packet`);
    }
    if (current.state !== "complete") {
      throw new Error(`source review ${selected.recordId} regressed or remains ${current.state}; expected complete`);
    }
  }
  const expectedRefs = snapshot.records.map((record) => record.reviewPath).sort();
  const actualRefs = completionRefs.map((record) => record.path).sort();
  if (JSON.stringify(actualRefs) !== JSON.stringify(expectedRefs)) {
    throw new Error("source review completion must reference every and only selected current-hash review file");
  }
}

function selectionToken(selection) {
  const { token: ignored, ...payload } = selection;
  return sha256(JSON.stringify(payload));
}

function schedulerEventId(eventValue) {
  return `scheduler-event-${sha256(JSON.stringify(eventValue)).slice(0, 16)}`;
}

function schedulerItemFingerprint(item, kind) {
  const identity = { kind, id: item?.id };
  if (kind === "source-review") {
    identity.researchScope = item?.researchScope;
    identity.reviewState = item?.reviewState;
    identity.implicitPacket = Boolean(item?.implicitPacket);
    identity.packetId = item?.packetId || null;
    identity.records = (item?.records || []).map((record) => ({
      recordId: record.recordId,
      sha256: record.sha256,
      sourceId: record.sourceId,
      researchScope: record.researchScope,
      state: record.state,
      packetId: record.packetId || null
    }));
  } else if (kind === "acquisition") {
    identity.routeId = item?.routeId || null;
  } else if (kind === "route-discovery") {
    identity.targetId = item?.targetId || null;
  } else if (["closure-review", "reopen-trigger"].includes(kind)) {
    identity.questionId = item?.questionId || null;
  } else if (kind === "origin-gap") {
    identity.personId = item?.personId || null;
  }
  return sha256(JSON.stringify(identity));
}

function ownerIdFor(kind, item) {
  if (["question", "closure-review", "reopen-trigger"].includes(kind)) return item.questionId || item.id;
  if (["acquisition", "route-discovery"].includes(kind)) return item.targetId || item.id;
  return item.id;
}

function safeCanonicalRef(value) {
  if (typeof value !== "string" || !value || value.includes("\\") || path.posix.isAbsolute(value)) return false;
  const normalized = path.posix.normalize(value);
  if (normalized !== value || normalized.startsWith("../")) return false;
  return [
    "evidence/extraction/",
    "evidence/research/questions/",
    "evidence/research/attempts/",
    "evidence/acquisition/",
    "evidence/proof/",
    "evidence/sources/",
    "evidence/citations/"
  ].some((prefix) => value.startsWith(prefix)) || value === "evidence/records-manifest.json";
}

function laneCounterField(lane) {
  return lane === "source-review" ? "sourceReview" : lane;
}

function isoTimestamp(value, label) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`${label} must be a valid timestamp`);
  return date.toISOString();
}

function validTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function assertScope(scope) {
  if (!researchScopes.includes(scope)) throw new Error(`unsupported scheduler research scope: ${scope}`);
}

function isWithin(root, file) {
  const relative = path.relative(path.resolve(root), path.resolve(file));
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function canonicalRelative(root, file) {
  const relative = path.relative(path.resolve(root), path.resolve(file));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`canonical owner path escapes the research root: ${file}`);
  }
  return relative.split(path.sep).join("/");
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}
