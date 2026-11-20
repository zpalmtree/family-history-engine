import assert from "node:assert/strict";
import test from "node:test";

import {
  RESEARCH_QUEUE_CADENCE,
  RESEARCH_QUEUE_CADENCE_ID,
  assertRunnableSelection,
  buildClosureReviewItems,
  buildRouteDiscoveryItems,
  buildSourceReviewItems,
  resolveResearchScheduler,
  selectFairQueueItem
} from "./research-queue.mjs";

test("closure-review debt is selectable and satisfies the runnable invariant", () => {
  const [review] = buildClosureReviewItems({
    flagged: [{ id: "rq-thin", branchId: "worked", priority: "P1", attemptCount: 1 }]
  }, [{ id: "rq-thin", branchId: "worked", priority: "P1", status: "exhausted", question: "Who?", live: true }]);
  const next = selectFairQueueItem({ closureReviews: [review] });
  assert.equal(next.kind, "closure-review");
  assert.equal(next.item.questionId, "rq-thin");
  assert.doesNotThrow(() => assertRunnableSelection({ runnableCount: 1 }, next));
  assert.throws(() => assertRunnableSelection({ runnableCount: 1 }, null), /next is null/);
});

test("fired trigger precedes closure review and route discovery remains autonomous", () => {
  const trigger = { id: "trigger", kind: "reopen-trigger", branchId: "b", priority: "P2" };
  const closure = { id: "closure", kind: "closure-review", branchId: "b", priority: "P0" };
  assert.equal(selectFairQueueItem({ reopenTriggers: [trigger], closureReviews: [closure] }).item.id, "trigger");

  const targets = [{
    id: "target-alternate",
    priority: "P1",
    provider: "Archive",
    reference: "Register",
    questionIds: ["rq-live"],
    reconciliation: { reasonCode: "needs-alternate-route" }
  }];
  const questions = [{ id: "rq-live", status: "blocked", live: true }];
  const [route] = buildRouteDiscoveryItems(targets, questions);
  assert.equal(route.kind, "route-discovery");
  assert.match(route.action.note, /autonomous route discovery/i);

  const autonomous = [{
    ...targets[0],
    reconciliation: { reasonCode: "autonomous-route-discovery" },
    routes: [{ id: "alternate", status: "alternate-provider" }]
  }];
  assert.equal(buildRouteDiscoveryItems(autonomous, questions).length, 1);
  autonomous[0].routes.push({ id: "sent", status: "pending-external-delivery" });
  assert.equal(buildRouteDiscoveryItems(autonomous, questions).length, 0,
    "a parallel sent request belongs to waiting-external, not a duplicate discovery lane");
});

test("least-worked branch wins deterministically before static priority", () => {
  const next = selectFairQueueItem({
    readyQuestions: [
      { id: "rq-overworked", branchId: "overworked", priority: "P0" },
      { id: "rq-neglected", branchId: "neglected", priority: "P2" }
    ],
    branchEffort: new Map([
      ["overworked", { attemptTotal: 100, questionCount: 10 }],
      ["neglected", { attemptTotal: 2, questionCount: 10 }]
    ])
  });
  assert.equal(next.item.id, "rq-neglected");
  assert.deepEqual(selectFairQueueItem({
    readyQuestions: [
      { id: "rq-overworked", branchId: "overworked", priority: "P0" },
      { id: "rq-neglected", branchId: "neglected", priority: "P2" }
    ],
    branchEffort: new Map([
      ["overworked", { attemptTotal: 100, questionCount: 10 }],
      ["neglected", { attemptTotal: 2, questionCount: 10 }]
    ])
  }), next);
});

test("a question with a long dry attempt streak yields to fresher work before branch fairness", () => {
  const readyQuestions = [
    { id: "rq-dry", branchId: "neglected", priority: "P0" },
    { id: "rq-fresh", branchId: "overworked", priority: "P2" }
  ];
  const branchEffort = new Map([
    ["overworked", { attemptTotal: 100, questionCount: 10 }],
    ["neglected", { attemptTotal: 2, questionCount: 10 }]
  ]);
  assert.equal(selectFairQueueItem({ readyQuestions, branchEffort }).item.id, "rq-dry");
  assert.equal(selectFairQueueItem({
    readyQuestions,
    branchEffort,
    dryQuestionIds: new Set(["rq-dry"])
  }).item.id, "rq-fresh");
  assert.equal(selectFairQueueItem({
    readyQuestions: [readyQuestions[0]],
    branchEffort,
    dryQuestionIds: new Set(["rq-dry"])
  }).item.id, "rq-dry", "dry work still runs when nothing fresher is ready");
});

test("frontier selection favors the less-covered root rather than alphabetic starvation", () => {
  const next = selectFairQueueItem({
    originGaps: [
      { id: "a-gap", rootId: "alpha", uncovered: true, generation: 2 },
      { id: "z-gap", rootId: "zeta", uncovered: true, generation: 2 }
    ],
    rootProgress: new Map([
      ["alpha", { covered: 9, total: 10 }],
      ["zeta", { covered: 1, total: 10 }]
    ])
  });
  assert.equal(next.item.id, "z-gap");
});

test("owned atomic frontier questions consume frontier cadence slots", () => {
  const selected = selectFairQueueItem({
    readyQuestions: [{ id: "proof", branchId: "b", priority: "P0" }],
    frontierQuestions: [{
      id: "rq-frontier-person",
      frontierPersonId: "person",
      goalKeys: ["parent-slot:person:father"],
      branchId: "b",
      priority: "P1"
    }],
    schedulerRecord: {
      schemaVersion: 1,
      cadenceId: RESEARCH_QUEUE_CADENCE_ID,
      cursor: 3,
      completed: {
        sourceReview: 2,
        proof: 1,
        frontier: 0,
        acquisition: 0,
        cadenceSlotsAdvanced: 3
      }
    }
  });
  assert.equal(selected.kind, "question");
  assert.equal(selected.item.id, "rq-frontier-person");
  assert.equal(selected.scheduler.selectedLane, "frontier");
  assert.equal(selected.scheduler.nextCursor, 4);
});

test("audited scheduler contract enforces the frontier-first 3:2:2:1 cadence", () => {
  assert.deepEqual(RESEARCH_QUEUE_CADENCE, [
    "frontier", "proof", "acquisition", "frontier",
    "source-review", "acquisition", "frontier", "proof"
  ]);
  assert.deepEqual(Object.fromEntries([...new Set(RESEARCH_QUEUE_CADENCE)]
    .map((lane) => [lane, RESEARCH_QUEUE_CADENCE.filter((item) => item === lane).length])), {
    frontier: 3,
    proof: 2,
    acquisition: 2,
    "source-review": 1
  });
  const work = {
    sourceReviews: [{ id: "source", priority: "P0" }],
    readyQuestions: [{ id: "proof", branchId: "b", priority: "P0" }],
    originGaps: [{ id: "frontier", rootId: "root", uncovered: true, priority: "P0" }],
    standaloneAcquisitions: [{ id: "acquisition", priority: "P0" }]
  };
  const expected = [
    ["frontier", "frontier"],
    ["proof", "proof"],
    ["acquisition", "acquisition"],
    ["frontier", "frontier"],
    ["source-review", "source"],
    ["acquisition", "acquisition"],
    ["frontier", "frontier"],
    ["proof", "proof"]
  ];
  for (let completed = 0; completed < expected.length; completed += 1) {
    const counters = {
      sourceReview: 0,
      proof: 0,
      frontier: 0,
      acquisition: 0,
      cadenceSlotsAdvanced: completed
    };
    // cadenceSlotsAdvanced cannot be smaller than completed work, so attribute
    // prior completions to the lane counters exactly as an audited run would.
    for (const [lane] of expected.slice(0, completed)) {
      const field = lane === "source-review" ? "sourceReview" : lane;
      counters[field] += 1;
    }
    const selected = selectFairQueueItem({ ...work, auditedWorkCounters: counters });
    assert.deepEqual([selected.scheduler.selectedLane, selected.item.id], expected[completed]);
    assert.equal(selected.scheduler.nextCursor, (completed + 1) % RESEARCH_QUEUE_CADENCE.length);
    assert.equal(selected.scheduler.basis, "audited-work-counters");
  }
  assert.throws(() => selectFairQueueItem(work), /requires auditedWorkCounters/);
});

test("skipped empty cadence slots are returned as an auditable cursor advance", () => {
  const selected = selectFairQueueItem({
    readyQuestions: [{ id: "proof", branchId: "b", priority: "P0" }],
    auditedWorkCounters: {
      sourceReview: 0,
      proof: 0,
      frontier: 0,
      acquisition: 0,
      cadenceSlotsAdvanced: 0
    }
  });
  assert.equal(selected.scheduler.selectedSlot, 1);
  assert.equal(selected.scheduler.nextCursor, 2);
  assert.deepEqual(selected.scheduler.completionDelta, {
    sourceReview: 0,
    proof: 1,
    frontier: 0,
    acquisition: 0,
    cadenceSlotsAdvanced: 2
  });
  const resumed = resolveResearchScheduler({
    auditedWorkCounters: {
      sourceReview: 0,
      proof: 1,
      frontier: 0,
      acquisition: 0,
      cadenceSlotsAdvanced: 2
    }
  });
  assert.equal(resumed.cursor, selected.scheduler.nextCursor);
});

test("persisted scheduler records are validated and expose the next persisted cursor", () => {
  const selected = selectFairQueueItem({
    originGaps: [{ id: "gap", rootId: "root", uncovered: true }],
    schedulerRecord: {
      schemaVersion: 1,
      cadenceId: RESEARCH_QUEUE_CADENCE_ID,
      cursor: 3
    }
  });
  assert.equal(selected.kind, "origin-gap");
  assert.equal(selected.scheduler.basis, "persisted-scheduler-record");
  assert.equal(selected.scheduler.selectedSlot, 3);
  assert.equal(selected.scheduler.nextCursor, 4);
  assert.throws(() => resolveResearchScheduler({
    schedulerRecord: { schemaVersion: 1, cadenceId: "wrong", cursor: 0 }
  }), /cadenceId/);
});

test("expiring authorized access preempts cadence, retains its cursor, and is fair across roots", () => {
  const access = {
    authorizationState: "authorized",
    provider: "subscription-provider",
    expiresAt: "2026-08-02T00:00:00.000Z"
  };
  const selected = selectFairQueueItem({
    readyQuestions: [{ id: "proof", branchId: "b", priority: "P0" }],
    expiringAuthorizedAccess: [
      { kind: "source-review", item: { id: "alpha-source", rootId: "alpha", priority: "P0" }, access },
      { kind: "source-review", item: { id: "zeta-source", rootId: "zeta", priority: "P2" }, access }
    ],
    now: "2026-07-28T00:00:00.000Z",
    rootProgress: new Map([
      ["alpha", { covered: 9, total: 10 }],
      ["zeta", { covered: 1, total: 10 }]
    ]),
    schedulerRecord: {
      schemaVersion: 1,
      cadenceId: RESEARCH_QUEUE_CADENCE_ID,
      cursor: 6
    }
  });
  assert.equal(selected.kind, "source-review");
  assert.equal(selected.item.id, "zeta-source");
  assert.equal(selected.scheduler.preemptionReason, "expiring-authorized-access");
  assert.equal(selected.scheduler.nextCursor, 6);
  assert.equal(selected.scheduler.completionDelta, null);

  const notYetUrgent = selectFairQueueItem({
    readyQuestions: [{ id: "proof", branchId: "b", priority: "P0" }],
    expiringAuthorizedAccess: [{
      kind: "source-review",
      item: { id: "later-source", priority: "P0" },
      access: { ...access, expiresAt: "2026-10-01T00:00:00.000Z" }
    }],
    now: "2026-07-28T00:00:00.000Z"
  });
  assert.equal(notYetUrgent.kind, "question");
  assert.throws(() => selectFairQueueItem({
    expiringAuthorizedAccess: [{
      kind: "source-review",
      item: { id: "implicit-auth" },
      access: { expiresAt: "2026-08-01T00:00:00.000Z" }
    }]
  }), /explicitly declare authorizationState authorized/);
});

test("extraction status adapter emits one bounded, read-only source-review work item", () => {
  const [item] = buildSourceReviewItems({
    next: {
      kind: "packet-ready",
      packetId: "packet-01",
      records: [{
        recordId: "record-01",
        sha256: "a".repeat(64),
        sourceId: "source-01",
        researchScope: "main",
        packetId: "packet-01"
      }]
    }
  });
  assert.deepEqual({
    id: item.id,
    kind: item.kind,
    reviewState: item.reviewState,
    packetId: item.packetId,
    recordId: item.records[0].recordId,
    actionId: item.action.id
  }, {
    id: "source-review-packet-01",
    kind: "source-review",
    reviewState: "packet-ready",
    packetId: "packet-01",
    recordId: "record-01",
    actionId: "review-source-master-packet"
  });
  assert.deepEqual(buildSourceReviewItems({ next: null }), []);
});
