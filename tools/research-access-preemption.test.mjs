import assert from "node:assert/strict";
import test from "node:test";

import {
  buildExpiringAuthorizedAccessItems,
  validateRouteAccessEntitlement
} from "./research-access-preemption.mjs";
import { RESEARCH_QUEUE_CADENCE_ID, selectFairQueueItem } from "./research-queue.mjs";

const accessEvent = {
  id: "event-0123456789abcdef",
  type: "access-confirmed",
  at: "2026-07-26T20:53:26.618Z"
};
const request = {
  id: "request-one",
  provider: "Archion",
  kind: "paid-order",
  items: [{ id: "authorization-item", targetId: "target-one", routeId: "route-one" }],
  events: [accessEvent]
};
const entitlement = {
  schemaVersion: 1,
  authorizationState: "authorized",
  requestId: "request-one",
  authorizationTargetId: "target-one",
  accessConfirmedEventId: accessEvent.id,
  confirmedAt: accessEvent.at,
  expiresAt: "2026-08-25T20:53:26.618Z",
  basis: "Provider account displayed an exact fixed access end timestamp after the authorized checkout."
};

test("explicit direct-route access entitlement has one strict, auditable shape", () => {
  const route = {
    id: "route-one",
    provider: "Archion",
    requestId: "request-one",
    status: "ready-subscription-capture",
    accessEntitlement: entitlement
  };
  assert.deepEqual(validateRouteAccessEntitlement(route, {
    target: { id: "target-one" },
    requests: new Map([[request.id, request]])
  }), []);
  const [entry] = buildExpiringAuthorizedAccessItems([{
    id: "target-one",
    priority: "P0",
    provider: "Archion",
    reference: "Exact register",
    questionIds: ["rq-one"],
    researchScope: "main",
    researchRole: "proof-blocking",
    reconciliation: { state: "actionable", status: "ready-download", routeId: "route-one" },
    routes: [route]
  }], { externalRequests: [request], scope: "main", now: "2026-07-28T00:00:00.000Z" });
  assert.deepEqual(entry.access, {
    authorizationState: "authorized",
    provider: "Archion",
    expiresAt: entitlement.expiresAt,
    requestId: "request-one",
    authorizationTargetId: "target-one",
    accessConfirmedEventId: accessEvent.id
  });
});

test("expiry is never inferred and entitlement cannot drift from its access event", () => {
  const route = { id: "route-one", provider: "Archion", requestId: "request-one", accessEntitlement: entitlement };
  for (const mutate of [
    (value) => { delete value.expiresAt; },
    (value) => { value.confirmedAt = "2026-07-27T00:00:00.000Z"; },
    (value) => { value.requestId = "another-request"; },
    (value) => { value.authorizationTargetId = "another-target"; },
    (value) => { value.credential = "forbidden"; }
  ]) {
    const changed = structuredClone(route);
    mutate(changed.accessEntitlement);
    assert.ok(validateRouteAccessEntitlement(changed, {
      target: { id: "target-one" },
      requests: new Map([[request.id, request]])
    }).length > 0);
  }
  const wrongProvider = structuredClone(route);
  wrongProvider.provider = "Unrelated provider";
  assert.ok(validateRouteAccessEntitlement(wrongProvider, {
    target: { id: "target-one" },
    requests: new Map([[request.id, request]])
  }).some((issue) => issue.includes("provider must match")));
});

test("acquired and expired entitled routes do not become preemptions", () => {
  const entries = buildExpiringAuthorizedAccessItems([{
    id: "target-one",
    priority: "P0",
    provider: "Provider",
    reference: "Exact register",
    questionIds: [],
    researchScope: "main",
    reconciliation: { state: "satisfied", status: "published", routeId: "route-one" },
    routes: [{ id: "route-one", provider: "Archion", requestId: "request-one", status: "acquired", accessEntitlement: entitlement }]
  }], { externalRequests: [request], scope: "main", now: "2026-07-28T00:00:00.000Z" });
  assert.deepEqual(entries, []);

  const expired = buildExpiringAuthorizedAccessItems([{
    id: "target-one",
    provider: "Provider",
    researchScope: "main",
    routes: [{ id: "route-one", provider: "Archion", requestId: "request-one", status: "ready-subscription-capture", accessEntitlement: entitlement }]
  }], { externalRequests: [request], scope: "main", now: "2026-09-01T00:00:00.000Z" });
  assert.deepEqual(expired, []);
});

test("an entitled alternate route preempts independently of waiting-external reconciliation", () => {
  const reused = {
    ...entitlement,
    authorizationTargetId: "subscription-target"
  };
  const subscriptionRequest = {
    ...request,
    items: [{ id: "subscription-item", targetId: "subscription-target", routeId: "subscription-route" }]
  };
  const target = {
    id: "alternate-target",
    priority: "P0",
    provider: "FamilySearch",
    reference: "Exact register",
    questionIds: ["rq-one"],
    researchScope: "main",
    researchRole: "proof-blocking",
    reconciliation: {
      state: "waiting-external",
      status: "pending-external",
      routeId: "waiting-route"
    },
    routes: [{
      id: "waiting-route",
      status: "pending-external-delivery"
    }, {
      id: "archion-alternate",
      provider: "Archion",
      sourceQueue: "archion-access",
      route: "paid-provider-subscription",
      status: "ready-subscription-capture",
      serviceOption: "Reuse the active subscription-target Archion pass.",
      accessEntitlement: reused
    }]
  };
  const [entry] = buildExpiringAuthorizedAccessItems([target], {
    externalRequests: [subscriptionRequest],
    scope: "main",
    now: "2026-07-28T00:00:00.000Z"
  });
  assert.equal(entry.item.routeId, "archion-alternate");
  assert.equal(entry.item.status, "ready-subscription-capture");
  assert.equal(entry.access.authorizationTargetId, "subscription-target");
  const selected = selectFairQueueItem({
    readyQuestions: [{ id: "ordinary-proof", priority: "P0" }],
    expiringAuthorizedAccess: [entry],
    schedulerRecord: {
      schemaVersion: 1,
      cadenceId: RESEARCH_QUEUE_CADENCE_ID,
      cursor: 1
    },
    now: "2026-07-28T00:00:00.000Z"
  });
  assert.equal(selected.item.routeId, "archion-alternate");
  assert.equal(selected.scheduler.preemptionReason, "expiring-authorized-access");
  assert.deepEqual(validateRouteAccessEntitlement(target.routes[1], {
    target,
    requests: new Map([[subscriptionRequest.id, subscriptionRequest]])
  }), []);

  const unnamed = structuredClone(target.routes[1]);
  unnamed.serviceOption = "Reuse an active pass.";
  assert.ok(validateRouteAccessEntitlement(unnamed, {
    target,
    requests: new Map([[subscriptionRequest.id, subscriptionRequest]])
  }).some((issue) => issue.includes("serviceOption")));
});

test("subscription-first preempts only when the route carries an explicit valid entitlement", () => {
  const subscriptionRequest = {
    ...request,
    items: [{ id: "subscription-item", targetId: "subscription-target", routeId: "subscription-route" }]
  };
  const route = {
    id: "catalog-discovery",
    provider: "Archion",
    sourceQueue: "archion-access",
    route: "paid-provider-subscription",
    status: "subscription-first",
    serviceOption: "Use subscription-target for bounded Archion in-book discovery."
  };
  const target = {
    id: "catalog-target",
    provider: "FamilySearch",
    researchScope: "main",
    routes: [route]
  };
  assert.deepEqual(buildExpiringAuthorizedAccessItems([target], {
    externalRequests: [subscriptionRequest],
    scope: "main",
    now: "2026-07-28T00:00:00.000Z"
  }), []);

  route.accessEntitlement = { ...entitlement, authorizationTargetId: "subscription-target" };
  const [entry] = buildExpiringAuthorizedAccessItems([target], {
    externalRequests: [subscriptionRequest],
    scope: "main",
    now: "2026-07-28T00:00:00.000Z"
  });
  assert.equal(entry.item.routeId, "catalog-discovery");
  assert.equal(entry.item.status, "subscription-first");
});

test("a valid Archion route can be owned by a non-FamilySearch target", () => {
  const subscriptionRequest = {
    ...request,
    items: [{ id: "subscription-item", targetId: "subscription-target", routeId: "subscription-route" }]
  };
  const [entry] = buildExpiringAuthorizedAccessItems([{
    id: "holzminden-target",
    provider: "Online Ortsfamilienbuch Holzminden",
    researchScope: "main",
    routes: [{
      id: "holzminden-archion-route",
      provider: "Archion",
      sourceQueue: "archion-access",
      route: "paid-provider-subscription",
      status: "ready-subscription-capture",
      serviceOption: "Reuse subscription-target for the exact Archion volume.",
      accessEntitlement: { ...entitlement, authorizationTargetId: "subscription-target" }
    }]
  }], {
    externalRequests: [subscriptionRequest],
    scope: "main",
    now: "2026-07-28T00:00:00.000Z"
  });
  assert.equal(entry.item.routeId, "holzminden-archion-route");
  assert.equal(entry.item.provider, "Online Ortsfamilienbuch Holzminden");
});
