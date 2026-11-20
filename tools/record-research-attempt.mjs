#!/usr/bin/env node

import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeJsonAtomic, writeJsonCreateOnlyAtomic } from "./atomic-json.mjs";
import {
  isResearchAttemptOutcome,
  researchActionStatusAfterAttempt
} from "./research-actions.mjs";
import {
  loadResearchStore,
  researchAttemptDocument,
  researchAttemptFile,
  researchQuestionDocument
} from "./research-store.mjs";
import { verifiedBoundedCoverage } from "./research-provider-results.mjs";
import { researchAttemptsForQuestion } from "./research-question-state.mjs";
import { assertResearchScope, parseResearchScope } from "./research-scope.mjs";
import { coverageCorpus, extractLocators, loadDismissals, uncoveredLocators } from "./unarchived-reads.mjs";

const requestedScope = parseResearchScope(process.argv.slice(2));

const questionId = valueAfter("--question");
const actionId = valueAfter("--action");
const outcome = valueAfter("--outcome");
const note = valueAfter("--note") || "";
const query = valueAfter("--query") || "";
const source = valueAfter("--source") || "";
const coverage = valueAfter("--coverage") || "";
const coverageBasis = valueAfter("--coverage-basis") || "";
if (!questionId || !actionId || !isResearchAttemptOutcome(outcome)) {
  throw new Error("usage: --question <id> --action <id> --outcome <located|candidate-found|not-found-bounded|blocked|error|no-new-information> [--query <text>] [--source <route>] [--coverage <bounded scope> --coverage-basis <provider/date/place/class basis> --pagination-complete --results-untruncated --provider-coverage-verified] [--note <safe note>]");
}
for (const value of [note, query, source, coverage, coverageBasis]) {
  if (value.length > 1000 || /password|token|secret|card number|contact details/i.test(value)) {
    throw new Error("attempt text is too long or contains a sensitive-data marker");
  }
}
let boundedCoverage;
if (outcome === "not-found-bounded") {
  if (!coverage.trim() || !coverageBasis.trim()
      || !process.argv.includes("--pagination-complete")
      || !process.argv.includes("--results-untruncated")
      || !process.argv.includes("--provider-coverage-verified")) {
    throw new Error("not-found-bounded requires --coverage, --coverage-basis, --pagination-complete, --results-untruncated, and --provider-coverage-verified");
  }
  boundedCoverage = verifiedBoundedCoverage({ coverage, verificationBasis: coverageBasis });
}

const store = loadResearchStore();
const question = store.questions.find((item) => item.id === questionId);
if (!question) throw new Error(`unknown research question: ${questionId}`);
assertResearchScope(question, requestedScope, `question ${questionId}`);
const action = question.actions?.find((item) => item.id === actionId);
if (!action) throw new Error(`unknown action ${actionId} on ${questionId}`);
const normalized = {
  questionId,
  actionId,
  outcome,
  query: normalize(query),
  source: normalize(source),
  coverage: normalize(coverage),
  ...(boundedCoverage ? {
    coverageDetails: {
      coverageContractVersion: boundedCoverage.coverageContractVersion,
      paginationComplete: boundedCoverage.paginationComplete,
      truncated: boundedCoverage.truncated,
      providerCoverageVerified: boundedCoverage.providerCoverageVerified,
      verificationBasis: normalize(boundedCoverage.verificationBasis)
    }
  } : {})
};
const fingerprint = createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
const existing = (question.attempts || []).find((attempt) => attempt.fingerprint === fingerprint);
if (existing) {
  if (reconcileQuestionState(action, existing)) {
    writeJsonAtomic(question.__file, researchQuestionDocument(question));
  }
  console.log(`research attempt already recorded: ${existing.id}`);
  process.exit(0);
}
const inheritedDuplicate = researchAttemptsForQuestion(question, store.questions, { includeInherited: true })
  .filter((attempt) => attempt.inheritedFromQuestionId)
  .find((attempt) => semanticallyMatches(attempt, { outcome, query, source, coverage }));
if (inheritedDuplicate) {
  throw new Error(`bounded work duplicates ${inheritedDuplicate.id} on legacy question `
    + `${inheritedDuplicate.inheritedFromQuestionId}; reconcile that inherited attempt before recording a repeat`);
}
const nextActionStatus = researchActionStatusAfterAttempt(action.status, outcome);

const attemptedAt = new Date().toISOString();
const attempt = {
  id: `attempt-${fingerprint.slice(0, 16)}`,
  actionId,
  attemptedAt,
  outcome,
  fingerprint,
  ...(query ? { query } : {}),
  ...(source ? { source } : {}),
  ...(boundedCoverage ? { scope: boundedCoverage } : coverage ? { scope: { coverage } } : {}),
  ...(note ? { note } : {})
};
writeJsonCreateOnlyAtomic(
  researchAttemptFile(questionId, fingerprint),
  researchAttemptDocument(questionId, attempt)
);
action.status = nextActionStatus;
action.lastAttemptAt = attemptedAt;
action.lastAttemptId = attempt.id;
writeJsonAtomic(question.__file, researchQuestionDocument(question));
console.log(`recorded research attempt ${attempt.id} for ${questionId}/${actionId}`);
warnUnarchivedReads([query, source, note].join("\n"));

// An original read and used in a finding must be preserved as a source master
// (AGENTS.md). Warn, never fail: the attempt is already recorded, and pages read
// only to prove a negative are dismissed in unarchived-reads-dismissed.json.
function warnUnarchivedReads(text) {
  if (!extractLocators(text).length) return;
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const missing = uncoveredLocators(text, coverageCorpus(root), loadDismissals(root));
  if (!missing.length) return;
  console.warn(`UNARCHIVED READ ${attempt.id}: ${missing.join(" ")}`);
  console.warn("  Archive each original this finding relies on (target, acquire, register, review), or dismiss pages read only for a negative in evidence/research/unarchived-reads-dismissed.json. List all: npm run research:unarchived");
}

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  return index < 0 ? undefined : process.argv[index + 1];
}

function normalize(value) {
  return String(value || "").trim().toLocaleLowerCase().replace(/\s+/g, " ");
}

function semanticallyMatches(attempt, candidate) {
  const candidateFields = [candidate.query, candidate.source, candidate.coverage].map(normalize);
  if (!candidateFields.some(Boolean)) return false;
  return attempt.outcome === candidate.outcome
    && normalize(attempt.query) === candidateFields[0]
    && normalize(attempt.source) === candidateFields[1]
    && normalize(attempt.scope?.coverage) === candidateFields[2];
}

function reconcileQuestionState(action, attempt) {
  const actionTime = Date.parse(action.lastAttemptAt || "");
  const attemptTime = Date.parse(attempt.attemptedAt || "");
  const attemptIsNewer = Number.isFinite(attemptTime)
    && (!Number.isFinite(actionTime) || attemptTime > actionTime);
  const sameRecordedAttempt = action.lastAttemptAt === attempt.attemptedAt
    && !action.lastAttemptId;
  if (!attemptIsNewer && !sameRecordedAttempt) return false;

  if (attemptIsNewer && action.status === "ready") {
    action.status = researchActionStatusAfterAttempt(action.status, attempt.outcome);
  }
  action.lastAttemptAt = attempt.attemptedAt;
  action.lastAttemptId = attempt.id;
  return true;
}
