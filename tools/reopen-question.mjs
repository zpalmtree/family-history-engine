// Atomic re-entry for a closed research question.
//
// The rule that makes this worth having: the status change and the new action
// land in the SAME write. A question reopened to `open` with every action still
// `completed` falls into derived triage -- the rung whose remedy is "audit the
// acceptance criteria and add one bounded action", which is the same process
// that produced the thin closure in the first place. Reopening without a
// concrete next step just re-runs the mistake.
//
// Prior attempts are never touched. The original reopenWhen prose is preserved,
// because it is genuinely useful to a reader even though nothing evaluates it.

export const REOPENABLE_STATUSES = Object.freeze(["exhausted", "blocked"]);

export function buildReopenedQuestion(question, { reason, action, at, triggerId } = {}) {
  if (!question) throw new Error("reopen requires a question");
  const v2 = question.schemaVersion >= 2 || question.routeAssessment || question.conclusion?.state;
  const v2Reopenable = v2 && question.lifecycle !== "superseded"
    && question.conclusion?.state !== "established"
    && question.routeAssessment?.state === "current-no-known-route";
  if (!v2Reopenable && !REOPENABLE_STATUSES.includes(question.status)) {
    throw new Error(`cannot reopen a question that is ${question.status}; `
      + `only ${REOPENABLE_STATUSES.join(" or ")} questions or a v2 current-no-known-route assessment are reopenable`);
  }
  if (typeof reason !== "string" || reason.trim().length < 10) {
    throw new Error("reopen requires a reason describing what changed");
  }
  if (!action || !action.id || !action.kind) {
    throw new Error("reopen requires a concrete next action (--action-id and --action-kind); "
      + "a reason with no action only moves the question into generic triage");
  }
  if (typeof action.note !== "string" || !action.note.trim()) {
    throw new Error("the new action requires a note stating exactly what will be attempted");
  }
  if ((question.actions || []).some((existing) => existing.id === action.id)) {
    throw new Error(`action ${action.id} already exists on ${question.id}`);
  }

  const event = {
    type: "reopened",
    ...(v2Reopenable
      ? { fromRouteAssessment: question.routeAssessment.state }
      : { fromStatus: question.status }),
    reason: reason.trim(),
    actionId: action.id,
    at,
    ...(triggerId ? { triggerId } : {})
  };

  return {
    ...question,
    ...(v2Reopenable
      ? { routeAssessment: { ...question.routeAssessment, state: "in-progress" } }
      : { status: "open" }),
    // Completed and blocked actions are left exactly as they were: they are the
    // audit trail of what has already been tried.
    actions: [...(question.actions || []), { id: action.id, kind: action.kind, status: "ready", note: action.note.trim() }],
    reopenEvents: [...(question.reopenEvents || []), event],
    // conclusion is retained deliberately. It states what the earlier bounded
    // work established, which stays true after reopening.
    reopenWhen: [...(question.reopenWhen || [])]
  };
}
