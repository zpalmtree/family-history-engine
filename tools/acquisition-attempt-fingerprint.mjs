import { createHash } from "node:crypto";

export const acquisitionAttemptOutcomeToRoute = new Map([
  ["queued-search", "queued-free-search"],
  ["needs-result-review", "needs-semantic-reconciliation"],
  ["ready-download", "ready-download"],
  ["ready-subscription-capture", "ready-subscription-capture"],
  ["acquired-original", "acquired"],
  ["archived-pending-upload", "acquired-pending-upload"],
  ["retryable-error", "error-retryable"],
  ["needs-interactive-sign-in", "needs-interactive-sign-in"],
  ["needs-interactive-payment", "needs-interactive-payment"],
  ["not-found-bounded", "not-found"],
  ["search-no-candidates", "search-no-candidates"],
]);

export function acquisitionAttemptFingerprint({ targetId, routeId, outcome, note, coverage, coverageDetails, candidateUrls = [], legacySalt }) {
  const payload = {
    targetId,
    routeId,
    outcome: acquisitionAttemptOutcomeToRoute.get(outcome) || outcome,
    note: normalizeWhitespace(note),
    ...(coverage ? { coverage: normalize(coverage) } : {}),
    ...(coverageDetails ? { coverageDetails: normalizeCoverageDetails(coverageDetails) } : {}),
    candidateUrls: [...new Set(candidateUrls)].sort(),
    ...(legacySalt ? { legacySalt } : {}),
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function normalizeCoverageDetails(value) {
  return {
    coverageContractVersion: value.coverageContractVersion,
    paginationComplete: value.paginationComplete,
    truncated: value.truncated,
    providerCoverageVerified: value.providerCoverageVerified,
    verificationBasis: normalize(value.verificationBasis),
  };
}

function normalizeWhitespace(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function normalize(value) {
  return normalizeWhitespace(value).toLocaleLowerCase();
}
