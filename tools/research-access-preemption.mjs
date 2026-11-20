import { researchScopeOf } from "./research-scope.mjs";

const entitlementFields = new Set([
  "schemaVersion",
  "authorizationState",
  "requestId",
  "authorizationTargetId",
  "accessConfirmedEventId",
  "confirmedAt",
  "expiresAt",
  "basis"
]);

export const authorizedAccessRouteStatuses = new Set([
  "ready-subscription-capture",
  "ready-download",
  "error-retryable",
  // Catalog/in-book discovery is autonomous once the separately guarded pass
  // is explicitly entitled, and must finish before that access window closes.
  "subscription-first"
]);

// Strict integration point for temporary provider access. Nothing is inferred
// from a purchase date, product description, provider prose, or today's login
// state. A route becomes eligible only after canonical data records the exact
// access-confirmed event and an explicit expiry timestamp.
export function buildExpiringAuthorizedAccessItems(targets = [], {
  externalRequests = [],
  scope = "main",
  now = new Date()
} = {}) {
  const requests = externalRequests instanceof Map
    ? externalRequests
    : new Map(externalRequests.map((request) => [request.id, request]));
  const output = [];
  for (const target of targets) {
    if (researchScopeOf(target) !== scope) {
      throw new Error(`authorized-access target ${target.id} belongs to ${researchScopeOf(target)}, not ${scope}`);
    }
    for (const route of target.routes || []) {
      if (!route.accessEntitlement) continue;
      const { issues } = resolveRouteAccessEntitlement(route, { target, requests });
      if (issues.length) throw new Error(`invalid access entitlement:\n- ${issues.join("\n- ")}`);
      if (!authorizedAccessRouteStatuses.has(route.status)) continue;
      if (Date.parse(route.accessEntitlement.expiresAt) <= timeValue(now)) continue;
      output.push({
        kind: "acquisition",
        item: {
          id: target.id,
          priority: target.priority,
          status: route.status,
          state: "actionable",
          provider: target.provider,
          researchRole: target.researchRole,
          routeId: route.id,
          reference: target.reference,
          questionIds: [...(target.questionIds || [])]
        },
        access: {
          authorizationState: "authorized",
          provider: route.provider,
          expiresAt: route.accessEntitlement.expiresAt,
          requestId: route.accessEntitlement.requestId,
          authorizationTargetId: route.accessEntitlement.authorizationTargetId,
          accessConfirmedEventId: route.accessEntitlement.accessConfirmedEventId
        }
      });
    }
  }
  return output.sort((left, right) => Date.parse(left.access.expiresAt) - Date.parse(right.access.expiresAt)
    || left.item.id.localeCompare(right.item.id));
}

export function validateRouteAccessEntitlement(route, { target, requests = new Map() } = {}) {
  return resolveRouteAccessEntitlement(route, { target, requests }).issues;
}

export function resolveRouteAccessEntitlement(route, { target, requests = new Map() } = {}) {
  const entitlement = route?.accessEntitlement;
  if (entitlement === undefined) return { issues: [], request: null, authorizationItem: null, reused: false };
  const label = `${target?.id || "target"}/${route?.id || "route"} accessEntitlement`;
  const issues = [];
  if (!entitlement || typeof entitlement !== "object" || Array.isArray(entitlement)) {
    return { issues: [`${label} must be an object`], request: null, authorizationItem: null, reused: false };
  }
  for (const field of Object.keys(entitlement)) {
    if (!entitlementFields.has(field)) issues.push(`${label} has unsupported field ${field}`);
  }
  if (entitlement.schemaVersion !== 1) issues.push(`${label} must use schemaVersion 1`);
  if (entitlement.authorizationState !== "authorized") {
    issues.push(`${label} authorizationState must be explicitly authorized`);
  }
  if (!safeId(entitlement.requestId)) issues.push(`${label} requires a safe requestId`);
  if (!safeId(entitlement.authorizationTargetId)) issues.push(`${label} requires a safe authorizationTargetId`);
  if (!validTimestamp(entitlement.confirmedAt)) issues.push(`${label} requires confirmedAt`);
  if (!validTimestamp(entitlement.expiresAt)) issues.push(`${label} requires explicit expiresAt`);
  if (validTimestamp(entitlement.confirmedAt) && validTimestamp(entitlement.expiresAt)
    && Date.parse(entitlement.expiresAt) <= Date.parse(entitlement.confirmedAt)) {
    issues.push(`${label} expiresAt must follow confirmedAt`);
  }
  if (!String(entitlement.basis || "").trim()) issues.push(`${label} requires a non-empty basis`);
  if (!/^event-[a-f0-9]{16}$/.test(entitlement.accessConfirmedEventId || "")) {
    issues.push(`${label} requires an accessConfirmedEventId`);
  }
  const request = requests.get(entitlement.requestId);
  if (!request) issues.push(`${label} links missing request ${entitlement.requestId || "(missing)"}`);
  else {
    if (request.kind !== "paid-order") issues.push(`${label} request must be a paid-order`);
    if (!route?.provider || request.provider !== route.provider) {
      issues.push(`${label} paid-order request provider must match the selected route provider`);
    }
    const event = request.events?.find((candidate) => candidate.id === entitlement.accessConfirmedEventId);
    if (!event || event.type !== "access-confirmed") {
      issues.push(`${label} does not link an access-confirmed request event`);
    } else if (validTimestamp(entitlement.confirmedAt) && event.at !== entitlement.confirmedAt) {
      issues.push(`${label} confirmedAt must exactly match its access-confirmed event`);
    }
  }
  const authorizationItems = (request?.items || [])
    .filter((item) => item.targetId === entitlement.authorizationTargetId);
  const authorizationItem = authorizationItems.length === 1 ? authorizationItems[0] : null;
  if (request && authorizationItems.length !== 1) {
    issues.push(`${label} paid-order request must contain exactly one item for authorization target ${entitlement.authorizationTargetId || "(missing)"}`);
  } else if (authorizationItem && (!safeId(authorizationItem.routeId) || !safeId(authorizationItem.id))) {
    issues.push(`${label} paid-order request item must identify its exact authorization route`);
  }
  const direct = authorizationItem?.targetId === target?.id && authorizationItem?.routeId === route?.id;
  if (direct) {
    if (route.requestId !== entitlement.requestId) {
      issues.push(`${label} direct authorization requestId must match its route`);
    }
  } else if (!String(route?.serviceOption || "").includes(entitlement.authorizationTargetId || "\0")) {
    issues.push(`${label} reused route serviceOption must explicitly name authorizationTargetId`);
  }
  return { issues, request: request || null, authorizationItem, reused: Boolean(authorizationItem && !direct) };
}

function validTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function safeId(value) {
  return typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,127}$/.test(value);
}

function timeValue(value) {
  const timestamp = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error("authorized access now must be a valid date or timestamp");
  return timestamp;
}
