import { isVerifiedBoundedNegativeAttempt } from "./research-provider-results.mjs";

export const acquisitionTargetStatuses = new Set([
  "published",
  "preserved-withheld",
  "archived-pending-upload",
  "satisfied-by-equivalent-route",
  "superseded",
  "citation-only",
  "search-audit-only",
  "access-entitlement",
  "user-declined",
  "pending-external",
  "requires-user-action",
  "access-gated",
  "not-found-bounded",
  "needs-locator",
  "queued-search",
  "needs-result-review",
  "ready-download",
  "reply-triage",
  "ready-subscription-capture",
  "retryable-error",
  "needs-interactive-sign-in",
  "needs-interactive-payment",
  "route-discovery"
]);

export const acquisitionRouteStatuses = new Set([
  "queued-free-search",
  "ready-download",
  "ready-subscription-capture",
  "acquired-pending-upload",
  "error-retryable",
  "needs-semantic-reconciliation",
  "search-no-candidates",
  "needs-interactive-sign-in",
  "needs-interactive-payment",
  "needs-alternate-route",
  "needs-familysearch-center",
  "needs-subscription-purchase",
  "needs-purchase-confirmation",
  "needs-requester-information",
  "needs-human-visual-review",
  "alternate-provider",
  "pending-external-delivery",
  "needs-submit-confirmation",
  "subscription-first",
  "inaccessible",
  "resolved-index-only",
  "not-found",
  "duplicate",
  "published",
  "preserved-withheld",
  "acquired",
  "archived-control",
  "request-conflict-hold"
]);

const actionableStatusMap = Object.freeze({
  "queued-free-search": "queued-search",
  "ready-download": "ready-download",
  "ready-subscription-capture": "ready-subscription-capture",
  "acquired-pending-upload": "archived-pending-upload",
  "error-retryable": "retryable-error",
  "needs-semantic-reconciliation": "needs-result-review",
  "search-no-candidates": "needs-locator",
  "needs-alternate-route": "route-discovery",
  "alternate-provider": "route-discovery",
  "subscription-first": "route-discovery"
});

const blockedStatuses = new Set([
  "needs-familysearch-center",
  "needs-subscription-purchase",
  "needs-purchase-confirmation",
  "pending-external-delivery",
  "needs-submit-confirmation",
  "needs-requester-information",
  "needs-human-visual-review",
  "inaccessible",
  "needs-interactive-sign-in",
  "needs-interactive-payment",
  "request-conflict-hold"
]);

// Routes on which a request is in flight or awaits the user's authorization.
// Access gates (sign-in, subscription, FamilySearch center, inaccessible) are
// deliberately absent: looking for another provider is the right response to
// those.
const heldRequestStatuses = new Set([
  "pending-external-delivery",
  "needs-submit-confirmation",
  "needs-interactive-payment",
  "needs-purchase-confirmation",
  "needs-requester-information",
  "request-conflict-hold"
]);

function isAuthorizedSubmission(route) {
  return route.status === "needs-submit-confirmation"
    && route.requestProjection?.operationalState === "authorized";
}

// An `alternate-provider` route is a reserve fallback for the same item. While
// a sibling route's request is in flight or awaiting the user, pursuing the
// fallback would duplicate that request or spend money early, so it waits
// until the primary route resolves one way or the other.
function effectiveActionableRoutes(routes = []) {
  const actionable = routes.filter((route) => Object.hasOwn(actionableStatusMap, route.status));
  const primaryHeld = routes.some((route) => heldRequestStatuses.has(route.status)
    && !isAuthorizedSubmission(route));
  return primaryHeld ? actionable.filter((route) => route.status !== "alternate-provider") : actionable;
}

export function acquisitionRoutesRequireExternalAction(routes = []) {
  return routes.some((route) => blockedStatuses.has(route.status))
    && !effectiveActionableRoutes(routes).length
    && !routes.some(isAuthorizedSubmission);
}

export function reconcileAcquisitionTarget(target, { recordsById, recordsBySourceId, sourcesById }) {
  const ownedRecord = recordsBySourceId.get(target.sourceId);
  if (ownedRecord) {
    const source = sourcesById?.get(target.sourceId);
    if (!source) throw new Error(`${target.id} has custody but links a missing canonical source`);
    if (ownedRecord.viewer?.approved) {
      return reconciliation("satisfied", "published", { recordId: ownedRecord.id });
    }
    if (source.viewerPolicy === "approved-private") {
      return reconciliation("actionable", "archived-pending-upload", { recordId: ownedRecord.id });
    }
    return reconciliation("satisfied", "preserved-withheld", { recordId: ownedRecord.id });
  }

  if (target.satisfaction) {
    const recordIds = target.satisfaction.recordIds || [];
    const missing = recordIds.filter((id) => !recordsById.has(id));
    if (missing.length) throw new Error(`${target.id} satisfaction references missing record(s): ${missing.join(", ")}`);
    return reconciliation("satisfied", "satisfied-by-equivalent-route", {
      satisfiedByRecordIds: recordIds,
      equivalenceBasis: target.satisfaction.basis
    });
  }

  if (target.supersession) {
    const recordIds = target.supersession.recordIds || [];
    const targetIds = target.supersession.targetIds || [];
    const missing = recordIds.filter((id) => !recordsById.has(id));
    if (missing.length) throw new Error(`${target.id} supersession references missing record(s): ${missing.join(", ")}`);
    return reconciliation("not-applicable", "superseded", {
      ...(recordIds.length ? { supersededByRecordIds: recordIds } : {}),
      ...(targetIds.length ? { supersededByTargetIds: targetIds } : {}),
      reason: target.supersession.reason
    });
  }

  if (target.disposition === "citation-only") return reconciliation("not-applicable", "citation-only");
  if (target.disposition === "search-audit") return reconciliation("not-applicable", "search-audit-only");
  // A paid pass or subscription target that only authorizes other routes holds no record of its
  // own: its captures run through the routes that reuse its entitlement, so it is never capture work.
  if (target.disposition === "access-entitlement") return reconciliation("not-applicable", "access-entitlement");
  // The user reviewed a provider's terms and chose not to order (first used 20 Nov
  // 2026 for the Stafford relief abstract). The target stays on record, cancelled,
  // and is neither capture work nor a user action; a new decision reopens it.
  if (target.disposition === "user-declined") return reconciliation("not-applicable", "user-declined");

  const routes = target.routes || [];
  // A provider replied in a request's bound thread and the inbox sweep recorded
  // the message, but no classification event answers it yet. Triage comes
  // before any other route work: the reply may deliver the item, quote a fee,
  // ask for information or close the route, and the route's own status (still
  // waiting, still owing a payment) is deliberately left untouched until then.
  const triageRoutes = routes.filter((route) => route.requestProjection?.untriagedReplyIds?.length);
  if (triageRoutes.length) {
    const primary = [...triageRoutes].sort((first, second) => first.id.localeCompare(second.id))[0];
    return reconciliation("actionable", "reply-triage", {
      routeId: primary.id,
      reasonCode: "provider-reply-untriaged",
      untriagedReplyIds: [...primary.requestProjection.untriagedReplyIds]
    });
  }
  const actionableRoutes = effectiveActionableRoutes(routes);
  for (const route of actionableRoutes) validateActionableRoute(target, route);
  if (actionableRoutes.length) {
    const ranked = [...actionableRoutes].sort((first, second) =>
      actionableRank(first.status) - actionableRank(second.status) || first.id.localeCompare(second.id));
    const primary = ranked[0];
    return reconciliation("actionable", actionableStatusMap[primary.status], {
      routeId: primary.id,
      actionableRouteIds: ranked.map((route) => route.id),
      ...(primary.status === "search-no-candidates" ? { reasonCode: "search-returned-no-candidates" } : {}),
      ...(isRouteDiscoveryStatus(primary.status) ? { reasonCode: "autonomous-route-discovery" } : {})
    });
  }

  const blockedRoutes = routes.filter((route) => blockedStatuses.has(route.status));
  if (blockedRoutes.length) {
    const primary = [...blockedRoutes].sort((first, second) =>
      blockedRank(first.status) - blockedRank(second.status) || first.id.localeCompare(second.id))[0];
    if (primary.status === "pending-external-delivery") {
      return reconciliation("blocked", "pending-external", {
        routeId: primary.id,
        blockedRouteIds: blockedRoutes.map((route) => route.id).sort(),
        reasonCode: "external-delivery",
        retryWhen: "delivery-arrives"
      });
    }
    if (["needs-submit-confirmation", "needs-subscription-purchase", "needs-purchase-confirmation", "needs-requester-information", "needs-human-visual-review", "request-conflict-hold"].includes(primary.status)) {
      return reconciliation("blocked", "requires-user-action", {
        routeId: primary.id,
        blockedRouteIds: blockedRoutes.map((route) => route.id).sort(),
        reasonCode: primary.status,
        retryWhen: primary.status === "needs-requester-information"
          ? "requester-information-is-supplied"
          : primary.status === "needs-human-visual-review"
            ? "user-completes-and-reports-the-visual-review"
            : "explicit-authorization"
      });
    }
    if (["needs-interactive-sign-in", "needs-interactive-payment"].includes(primary.status)) {
      return reconciliation("blocked", primary.status, {
        routeId: primary.id,
        blockedRouteIds: blockedRoutes.map((route) => route.id).sort(),
        reasonCode: primary.status,
        retryWhen: accessRetryWhen(primary.status)
      });
    }
    return reconciliation("blocked", "access-gated", {
      routeId: primary.id,
      blockedRouteIds: blockedRoutes.map((route) => route.id).sort(),
      reasonCode: primary.status,
      retryWhen: accessRetryWhen(primary.status)
    });
  }

  const indexOnlyRoute = routes.find((route) => route.status === "resolved-index-only");
  if (indexOnlyRoute) {
    return reconciliation("not-applicable", "citation-only", {
      routeId: indexOnlyRoute.id,
      reasonCode: "provider-index-only"
    });
  }

  if (routes.length && routes.every((route) => route.status === "not-found")) {
    const unverifiedRouteIds = routes.filter((route) => !routeHasVerifiedBoundedNegative(route)).map((route) => route.id).sort();
    if (!unverifiedRouteIds.length) return reconciliation("exhausted", "not-found-bounded");
    return reconciliation("actionable", "route-discovery", {
      routeId: unverifiedRouteIds[0],
      actionableRouteIds: unverifiedRouteIds,
      reasonCode: "bounded-negative-review-required"
    });
  }

  return reconciliation("actionable", "needs-locator");
}

function validateActionableRoute(target, route) {
  if (route.status === "needs-semantic-reconciliation" && !(route.candidateUrls || []).length) {
    throw new Error(`${target.id}/${route.id} needs semantic review without a candidate URL`);
  }
  if (route.status === "search-no-candidates" && (route.candidateUrls || []).length) {
    throw new Error(`${target.id}/${route.id} is zero-candidate but contains candidate URLs`);
  }
}

function reconciliation(state, status, extra = {}) {
  if (!acquisitionTargetStatuses.has(status)) throw new Error(`unsupported acquisition target status: ${status}`);
  return { state, status, ...extra };
}

function actionableRank(status) {
  return [
    "ready-download",
    "acquired-pending-upload",
    "ready-subscription-capture",
    "needs-semantic-reconciliation",
    "queued-free-search",
    "search-no-candidates",
    "needs-alternate-route",
    "alternate-provider",
    "subscription-first",
    "error-retryable"
  ].indexOf(status);
}

function blockedRank(status) {
  return [
    "pending-external-delivery",
    // An authorized payment awaiting only the visible checkout is closer to
    // done than any route still needing a venue visit or a new provider, so it
    // outranks them: reporting "go to a FamilySearch center" would bury work
    // the user has already paid for.
    "needs-interactive-payment",
    "needs-submit-confirmation",
    "needs-requester-information",
    "needs-human-visual-review",
    "request-conflict-hold",
    "needs-purchase-confirmation",
    "needs-subscription-purchase",
    "needs-familysearch-center",
    "inaccessible",
    "needs-interactive-sign-in"
  ].indexOf(status);
}

function accessRetryWhen(status) {
  if (status === "needs-interactive-sign-in") return "interactive-sign-in-completes";
  if (status === "needs-interactive-payment") return "interactive-payment-completes";
  if (status === "needs-familysearch-center") return "familysearch-center-access";
  return "provider-access-changes";
}

export function isRouteDiscoveryStatus(status) {
  return ["needs-alternate-route", "alternate-provider", "subscription-first"].includes(status);
}

export function routeHasVerifiedBoundedNegative(route) {
  if (route?.status !== "not-found") return false;
  const attempt = [...(route.attempts || [])].reverse()
    .find((item) => ["not-found", "not-found-bounded"].includes(item.outcome));
  return isVerifiedBoundedNegativeAttempt(attempt);
}
