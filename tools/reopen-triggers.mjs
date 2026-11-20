// Structured reopen triggers, evaluated as a projection.
//
// Scope is deliberately one trigger kind. `record-delivered` is unambiguous:
// either the request delivered a registered artifact or it did not.
// `route-class-available` is indefinitely deferred -- it needed a versioned
// route vocabulary, and the Stage 0 trial showed that vocabulary is not
// reproducible enough to enforce. `person-fact-changed` needs deduplication
// and consumption state or one edit to a shared ancestor fans out across every
// dependent question. There is no age trigger and never will be: manufacturing
// work from the passage of time is the churn that terminal statuses exist to
// prevent.
//
// Firing NEVER mutates a question. A fired trigger surfaces a closed question
// on the `reopenable` rung; a human or agent then runs research:question:reopen,
// which performs the locked atomic transition with a concrete action.

export const supportedTriggerKinds = Object.freeze(["record-delivered"]);

const DELIVERED_EVENTS = new Set(["delivery-complete", "delivery-item-imported"]);
// A delivery that was reconciled as irrelevant or terminal must not reopen
// anything: the artifact arrived and settled the route, which is the opposite
// of new work.
const INERT_RECONCILIATION = new Set([
  "not-found-bounded", "superseded", "satisfied-by-equivalent-route", "citation-only", "search-audit-only", "access-entitlement", "user-declined"
]);

export function evaluateReopenTriggers({ questions = [], requests = [], targets = [] } = {}) {
  const requestById = new Map(requests.map((request) => [request.id, request]));
  const targetById = new Map(targets.map((target) => [target.id, target]));
  const fired = [];
  const skipped = [];

  for (const question of questions) {
    const legacyClosed = ["exhausted", "blocked"].includes(question.status);
    const v2Watching = question.lifecycle !== "superseded"
      && question.routeAssessment?.state === "current-no-known-route"
      && question.conclusion?.state !== "established";
    if (!legacyClosed && !v2Watching) continue;
    const consumed = new Set((question.reopenEvents || []).map((event) => event.triggerId).filter(Boolean));

    for (const trigger of question.reopenTriggers || []) {
      const triggerId = trigger.id || `${trigger.kind}:${trigger.requestId || ""}`;
      const note = (reason) => ({ questionId: question.id, triggerId, reason });

      if (trigger.kind !== "record-delivered") {
        skipped.push(note(`unsupported trigger kind ${trigger.kind}`));
        continue;
      }
      if (consumed.has(triggerId)) {
        // Consumption state: one delivery may justify one re-entry, not a
        // question that is perpetually reopenable.
        skipped.push(note("already consumed by a recorded reopen event"));
        continue;
      }
      const request = requestById.get(trigger.requestId);
      if (!request) {
        skipped.push(note(`request ${trigger.requestId} does not exist`));
        continue;
      }
      // The evidence edge: the request must actually belong to this question,
      // not merely be mentioned by it.
      const owned = (request.items || []).some((item) => {
        const target = targetById.get(item.targetId);
        return (target?.questionIds || []).includes(question.id);
      });
      if (!owned) {
        skipped.push(note(`request ${trigger.requestId} is not bound to this question through any target`));
        continue;
      }
      const delivered = (request.events || []).some((event) => DELIVERED_EVENTS.has(event.type));
      if (!delivered) {
        skipped.push(note(`request ${trigger.requestId} has no delivery event`));
        continue;
      }
      const inert = (request.items || []).every((item) => {
        const target = targetById.get(item.targetId);
        return INERT_RECONCILIATION.has(target?.reconciliation?.state || target?.status);
      });
      if (inert) {
        skipped.push(note(`delivered artifact for ${trigger.requestId} reconciled as irrelevant or terminal`));
        continue;
      }
      fired.push({
        questionId: question.id,
        questionStatus: question.status || question.routeAssessment?.state,
        triggerId,
        kind: trigger.kind,
        requestId: trigger.requestId,
        resume: `npm run research:question:reopen -- --id ${question.id} --trigger ${triggerId} `
          + "--reason \"<what the delivered record makes newly possible>\" --action-id <id> "
          + "--action-kind search --action-note \"<exactly what will be attempted>\""
      });
    }
  }

  return { fired, skipped, supportedTriggerKinds: [...supportedTriggerKinds] };
}
