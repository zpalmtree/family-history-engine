// Collection identifiers that denote custody: only the named repository holds
// the item, so citing one is a claim about who can pull it. Deliberately
// excluded are identifiers that aggregators legitimately republish -- NARA
// publication numbers, FHL film numbers, and TNA class references all appear on
// Ancestry and FamilySearch records without implying those archives were asked.
export const foreignHoldingTokens = [
  [/\bBGSU\b|\bBowling Green State University\b/i, /BGSU|Bowling Green/i],
  [/\bMSA\s+[A-Z]\d/, /Maryland State Archives/i]
];

// Statuses where the next step is contacting the provider.
export const outboundRouteStatuses = new Set([
  "needs-submit-confirmation",
  "needs-purchase-confirmation",
  "needs-requester-information",
  "queued-free-search",
  "pending-external-delivery",
  "request-conflict-hold"
]);

// Returns the repositories a route cites but does not belong to. A route may
// only be sent once someone has recorded item-level proof that its own provider
// holds the cited item: Monroe County Library System pulled a reel for us on
// 27 Jul 2026 to answer a request citing BGSU MS 480 mf, which it never held.
export function foreignHoldingClaims(target, route, { requireOutboundStatus = true } = {}) {
  const cited = `${target?.reference || ""} ${route?.reference || ""}`;
  const provider = `${route?.provider || ""} ${target?.provider || ""}`;
  if (requireOutboundStatus && !outboundRouteStatuses.has(route?.status)) return [];
  if (route?.holdingVerification?.verifiedAt && route?.holdingVerification?.basis) return [];
  return foreignHoldingTokens
    .filter(([token, holder]) => token.test(cited) && !holder.test(provider))
    .map(([token]) => String(token));
}

// Statuses where a SUBMIT or PAY gate is being offered to the user. A gate must
// not exist until someone has verified both halves of the request: that the
// named repository actually holds the item, and that the address belongs to it.
export const authorizationGateStatuses = new Set([
  "needs-submit-confirmation",
  "needs-purchase-confirmation"
]);

function verified(record) {
  return Boolean(record?.verifiedAt && record?.basis);
}

// Returns why an outbound request is not yet safe to authorize or send.
// Monroe County Library System spent staff time on a reel it never held because
// the repository was chosen for having a convenient request form, and the
// holding claim behind it was never checked at item level.
export function outboundVerificationIssues(target, route, request) {
  const issues = [];
  if (!verified(route?.holdingVerification)) {
    issues.push(`${route?.provider || target?.provider || "the provider"} has no recorded item-level holdingVerification for what is being requested`);
  }
  if (request && !verified(request.recipientVerification)) {
    issues.push(`${request.id} has no recorded recipientVerification for ${request.spec?.recipient || "its submission route"}`);
  }
  return issues;
}
