export const lifeFactCategories = new Set([
  "residence",
  "migration",
  "naturalization",
  "education",
  "employment",
  "business",
  "military-registration",
  "military-service",
  "organization-membership",
  "religious-affiliation",
  "civic-community-role",
  "property",
  "achievement",
  // Arms a source blazons for this person, or what the heralds ruled about the
  // family's right to them. Never arms inferred from a surname.
  "heraldry",
  "other"
]);

export const biographyProminences = new Set(["core", "supporting", "context-only"]);
export const biographicalReviewDispositions = new Set([
  "captured",
  "no-additional-facts",
  "pending-source-recovery"
]);

export function assertionPersonIds(assertion) {
  const claim = assertion?.claim || {};
  return new Set([
    claim.personId,
    claim.childId,
    claim.parentId,
    claim.associatedPersonId,
    claim.subjectType === "person" ? claim.subjectId : null,
    ...(claim.personIds || []),
    ...(claim.relatedPersonIds || [])
  ].filter(Boolean));
}

export function validateLifeFact(assertion) {
  if (assertion?.claim?.kind !== "life-fact") return [];
  const claim = assertion.claim;
  const issues = [];
  if (!claim.personId || typeof claim.personId !== "string") issues.push(`${assertion.id} life fact requires personId`);
  if (!lifeFactCategories.has(claim.category)) issues.push(`${assertion.id} has invalid life-fact category ${claim.category}`);
  if (!claim.value || typeof claim.value !== "string") issues.push(`${assertion.id} life fact requires value`);
  for (const field of ["dateText", "fromDateText", "toDateText", "place", "fromPlace", "toPlace",
    "organization", "role", "rank", "employer", "country", "state"]) {
    if (claim[field] != null && (typeof claim[field] !== "string" || !claim[field].trim())) {
      issues.push(`${assertion.id} life fact ${field} must be a non-empty string`);
    }
  }
  if (claim.relatedPersonIds != null
    && (!Array.isArray(claim.relatedPersonIds) || claim.relatedPersonIds.some((id) => typeof id !== "string" || !id))) {
    issues.push(`${assertion.id} life fact relatedPersonIds must contain stable ids`);
  }
  // country and state locate the fact's place for a reader, as a place row's do; a life
  // story may name a country only when a fact supplies it.
  if ((claim.country != null || claim.state != null) && !claim.place) {
    issues.push(`${assertion.id} life fact country or state locates its place; add place`);
  }
  if (claim.state != null && claim.country !== "United States") {
    issues.push(`${assertion.id} life fact state is for a place in the United States`);
  }
  if (claim.category === "migration" && !(claim.fromPlace || claim.toPlace || claim.place)) {
    issues.push(`${assertion.id} migration fact requires fromPlace, toPlace, or place`);
  }
  if (claim.category === "organization-membership" && !claim.organization) {
    issues.push(`${assertion.id} organization membership requires organization`);
  }
  if (claim.category === "military-registration" && /\bserved|veteran|enlisted\b/i.test(claim.value)) {
    issues.push(`${assertion.id} military registration must not imply military service`);
  }
  if (claim.category === "heraldry" && /\b(?:family|surname) (?:crest|arms|coat of arms)\b/i.test(claim.value)) {
    issues.push(`${assertion.id} heraldry belongs to the person or line a source names, not to a family name`);
  }
  if (claim.category === "religious-affiliation" && /\bbapti[sz](?:ed|m)\b/i.test(claim.value)) {
    issues.push(`${assertion.id} baptism alone must not be represented as religious affiliation`);
  }
  return issues;
}

export function validateBiographyPresentation(bundle, local) {
  const issues = [];
  const seen = new Set();
  for (const [index, entry] of (bundle.presentation?.biographyFacts || []).entries()) {
    const label = `${bundle.personId} biographyFacts[${index}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      issues.push(`${label} must be an object`);
      continue;
    }
    const assertion = local.get(entry.assertionId);
    if (!assertion) issues.push(`${label} references missing assertion ${entry.assertionId}`);
    else if (assertion.assessment === "rejected") issues.push(`${label} references rejected assertion ${entry.assertionId}`);
    else if (assertion.claim?.personId !== bundle.personId) issues.push(`${label} references another person's assertion`);
    else if (!new Set(["life-fact", "occupation", "narrative"]).has(assertion.claim?.kind)) {
      issues.push(`${label} references unsupported ${assertion.claim?.kind} assertion`);
    }
    if (!biographyProminences.has(entry.prominence)) issues.push(`${label} has invalid prominence ${entry.prominence}`);
    if (seen.has(entry.assertionId)) issues.push(`${label} repeats ${entry.assertionId}`);
    seen.add(entry.assertionId);
  }
  return issues;
}

export function validateBiographicalReview(source, link, { assertions, targets }) {
  if (link.identificationStatus !== "confirmed" || ["search-audit", "legacy-project-data"].includes(source.kind)) return [];
  const label = `${source.id}/${link.personId} biographicalReview`;
  const review = link.biographicalReview;
  const issues = [];
  if (!review || typeof review !== "object") return [`${label} is required`];
  if (!biographicalReviewDispositions.has(review.disposition)) issues.push(`${label} has invalid disposition ${review.disposition}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(review.reviewedAt || "")) issues.push(`${label} requires reviewedAt`);
  if (!review.basis || typeof review.basis !== "string") issues.push(`${label} requires basis`);
  const ids = review.assertionIds || [];
  if (!Array.isArray(ids)) issues.push(`${label} assertionIds must be an array`);
  if (review.disposition === "captured" && !ids.length) issues.push(`${label} captured disposition requires assertionIds`);
  if (review.disposition !== "captured" && ids.length) issues.push(`${label} ${review.disposition} cannot retain assertionIds`);
  for (const id of ids) {
    const assertion = assertions.get(id);
    if (!assertion) issues.push(`${label} references missing assertion ${id}`);
    else {
      if (!assertionPersonIds(assertion).has(link.personId)) issues.push(`${label} assertion ${id} does not concern linked person`);
      if (!(assertion.evidence || []).some((evidence) => evidence.sourceId === source.id)) {
        issues.push(`${label} assertion ${id} does not cite this source`);
      }
    }
  }
  if (review.disposition === "pending-source-recovery") {
    if (!review.targetId || !targets.has(review.targetId)) issues.push(`${label} requires a canonical targetId`);
  } else if (review.targetId) {
    issues.push(`${label} retains targetId outside pending-source-recovery`);
  }
  return issues;
}
