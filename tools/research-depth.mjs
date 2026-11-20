// Depth reporting for the research queue.
//
// The queue commands report what is selectable. Nothing reported coverage
// quality, so a branch worked at one attempt per question sat beside one worked
// at six for weeks without the asymmetry being visible. This module makes that
// visible.
//
// Two deliberate constraints, both from the Stage 0 trial:
//
//  1. It reports a DISTRIBUTION, never a median. A one-attempt original baptism
//     can answer a narrow question outright, while ten index searches can leave
//     a parentage question untouched. Attempt count measures effort, not quality,
//     so the evidence grade is reported alongside it.
//
//  2. The flag is called `closure review needed`, never "premature". The trial
//     confirmed 6 of 6 thin exhaustions were under-searched, which justifies
//     surfacing them -- but a structural signal cannot establish that any
//     individual closure was wrong. That is a judgement, and it belongs to the
//     review queue this flag feeds.

// Below this many questions, a branch-level rate is noise rather than signal.
export const MIN_BRANCH_SAMPLE = 5;

// A closure is flagged when it is thin AND exhausted. The originally proposed
// third term -- "and carries no closure dispositions" -- was dropped: the
// disposition field does not exist, so it is true of every legacy question and
// carries no information.
export const THIN_ATTEMPT_THRESHOLD = 2;

export const evidenceGrades = Object.freeze(["original", "index", "bounded-negative", "other"]);

export function gradeAttempt(attempt = {}) {
  const text = `${attempt.source || ""} ${attempt.query || ""} ${attempt.note || ""}`;
  // An acquired image or register page outranks how the search was framed.
  if (/\boriginal\b|\bimage\b|register page|bishop.?s transcript|\bfilm\b/i.test(text)) return "original";
  if (attempt.outcome === "not-found-bounded") return "bounded-negative";
  if (/freereg|freebmd|freecen|\bindex\b|transcript|catalog|catalogue/i.test(text)) return "index";
  return "other";
}

function bucket(count) {
  if (count === 0) return "0";
  if (count === 1) return "1";
  if (count === 2) return "2";
  if (count <= 5) return "3-5";
  if (count <= 10) return "6-10";
  return "11+";
}

export const attemptBuckets = Object.freeze(["0", "1", "2", "3-5", "6-10", "11+"]);

/**
 * @param {Array<{id, branchId, status, priority}>} questions
 * @param {Map<string, Array<object>>} attemptsByQuestion question id -> attempt objects
 */
export function buildDepthReport(questions = [], attemptsByQuestion = new Map()) {
  const perQuestion = questions.map((question) => {
    const attempts = attemptsByQuestion.get(question.id) || [];
    const grades = Object.fromEntries(evidenceGrades.map((grade) => [grade, 0]));
    for (const attempt of attempts) grades[gradeAttempt(attempt)] += 1;
    const thin = attempts.length <= THIN_ATTEMPT_THRESHOLD;
    const closureCandidate = question.status === "exhausted"
      || question.routeAssessment?.legacyStatus === "exhausted"
      || (question.routeAssessment?.state === "current-no-known-route"
        && question.routeAssessment?.review?.state !== "accepted");
    return {
      id: question.id,
      branchId: question.branchId || "(unassigned)",
      status: question.status || question.routeAssessment?.state || question.conclusion?.state,
      priority: question.priority,
      attemptCount: attempts.length,
      bucket: bucket(attempts.length),
      grades,
      // Only original evidence can carry a thin question on its own; a thin
      // question resting purely on indexes is the shape the trial examined.
      hasOriginalEvidence: grades.original > 0,
      closureReviewNeeded: thin && closureCandidate
    };
  });

  const branches = new Map();
  for (const entry of perQuestion) {
    if (!branches.has(entry.branchId)) {
      branches.set(entry.branchId, {
        branchId: entry.branchId,
        questionCount: 0,
        attemptTotal: 0,
        distribution: Object.fromEntries(attemptBuckets.map((key) => [key, 0])),
        byStatus: {},
        closureReviewNeeded: 0,
        thinWithoutOriginal: 0
      });
    }
    const branch = branches.get(entry.branchId);
    branch.questionCount += 1;
    branch.attemptTotal += entry.attemptCount;
    branch.distribution[entry.bucket] += 1;
    branch.byStatus[entry.status] = (branch.byStatus[entry.status] || 0) + 1;
    if (entry.closureReviewNeeded) branch.closureReviewNeeded += 1;
    if (entry.attemptCount <= THIN_ATTEMPT_THRESHOLD && !entry.hasOriginalEvidence) {
      branch.thinWithoutOriginal += 1;
    }
  }

  const warnings = [];
  for (const branch of branches.values()) {
    // Guard the rate, not the list: a two-question branch with both flagged is
    // not evidence of a branch-level problem, though each question still shows
    // up individually in flagged[].
    if (branch.questionCount < MIN_BRANCH_SAMPLE) {
      branch.sampleTooSmallForRate = true;
      continue;
    }
    const flaggedShare = branch.closureReviewNeeded / branch.questionCount;
    if (flaggedShare >= 0.25) {
      warnings.push(`${branch.branchId}: ${branch.closureReviewNeeded} of ${branch.questionCount} `
        + `question(s) are thin exhaustions needing closure review.`);
    }
  }

  return {
    questionCount: perQuestion.length,
    attemptTotal: perQuestion.reduce((sum, entry) => sum + entry.attemptCount, 0),
    closureReviewNeeded: perQuestion.filter((entry) => entry.closureReviewNeeded).length,
    branches: [...branches.values()].sort((left, right) => right.closureReviewNeeded - left.closureReviewNeeded
      || left.branchId.localeCompare(right.branchId)),
    flagged: perQuestion.filter((entry) => entry.closureReviewNeeded)
      .sort((left, right) => left.branchId.localeCompare(right.branchId) || left.id.localeCompare(right.id)),
    questions: perQuestion,
    warnings,
    flagMeaning: "Thin (<=2 attempts) and exhausted. A structural signal that a closure deserves "
      + "human review; not a finding that any individual closure was wrong."
  };
}
