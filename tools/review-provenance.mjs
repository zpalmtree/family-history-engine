export const legacySourceVerificationBasis = "Legacy corpus metadata reconciled; name readings match preserved source-reference text, while unmatched pre-existing links make no recorded-name claim.";
export const legacyAssertionRationalePrefix = "The verified source metadata and person links are relevant to the displayed ";

export const sourceReviewStatuses = new Set(["migration-inferred", "reviewed"]);
export const sourceReviewMethods = new Set([
  "legacy-reference-text",
  "original-visual",
  "provider-index",
  "provider-transcript",
  "family-statement",
  "catalogue"
]);
export const evidenceReviewStatuses = new Set(["migration-inferred", "claim-reviewed"]);
export const evidenceReviewMethods = new Set([
  "bootstrap-keyword-scoring",
  "original",
  "provider-index-transcript",
  "family-statement",
  "legacy-provenance"
]);

export function isLegacySourceReview(source) {
  return source?.personLinksVerificationBasis === legacySourceVerificationBasis;
}

export function isLegacyAssertionEvidence(evidence) {
  return typeof evidence?.rationale === "string"
    && evidence.rationale.startsWith(legacyAssertionRationalePrefix);
}

export function evidenceReviewKey(assertionId, sourceId) {
  return `${assertionId}::${sourceId}`;
}

export function validateSourceReview(source) {
  const review = source?.personLinkReview;
  if (!review) return [];
  const issues = [];
  if (!sourceReviewStatuses.has(review.status)) issues.push(`${source.id} has invalid person-link review status`);
  if (!sourceReviewMethods.has(review.method)) issues.push(`${source.id} has invalid person-link review method`);
  if (review.status === "migration-inferred") {
    if (review.method !== "legacy-reference-text") issues.push(`${source.id} migration review has the wrong method`);
    if (!isLegacySourceReview(source)) issues.push(`${source.id} migration review lacks the frozen legacy basis`);
    if (!review.migratedAt) issues.push(`${source.id} migration review requires migratedAt`);
  }
  if (review.status === "reviewed") {
    if (review.method === "legacy-reference-text") issues.push(`${source.id} reviewed source cannot use the migration method`);
    if (!review.reviewedAt) issues.push(`${source.id} reviewed source requires reviewedAt`);
    if (isLegacySourceReview(source)) issues.push(`${source.id} reviewed source retains the legacy basis`);
  }
  return issues;
}

export function validateEvidenceReview(assertion, evidence) {
  const review = evidence?.review;
  if (!review) return [];
  const label = `${assertion.id} evidence ${evidence.sourceId}`;
  const issues = [];
  if (!evidenceReviewStatuses.has(review.status)) issues.push(`${label} has invalid review status`);
  if (!evidenceReviewMethods.has(review.method)) issues.push(`${label} has invalid review method`);
  if (review.status === "migration-inferred") {
    if (review.method !== "bootstrap-keyword-scoring") issues.push(`${label} migration review has the wrong method`);
    if (!isLegacyAssertionEvidence(evidence)) issues.push(`${label} migration review lacks the frozen bootstrap rationale`);
    if (!review.migratedAt) issues.push(`${label} migration review requires migratedAt`);
  }
  if (review.status === "claim-reviewed") {
    if (review.method === "bootstrap-keyword-scoring") issues.push(`${label} reviewed evidence cannot use the migration method`);
    if (!review.reviewedAt) issues.push(`${label} reviewed evidence requires reviewedAt`);
    if (isLegacyAssertionEvidence(evidence)) issues.push(`${label} reviewed evidence retains the bootstrap rationale`);
  }
  return issues;
}
