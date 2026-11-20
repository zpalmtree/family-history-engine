import assert from "node:assert/strict";
import test from "node:test";

import { buildNeedsUserResult } from "./needs-user.mjs";
import { actionableStatuses, terminalStatuses } from "./acquisition-session-lib.mjs";
import { reconcileAcquisitionTarget, routeHasVerifiedBoundedNegative } from "./research-acquisition.mjs";

const emptyStore = {
  recordsById: new Map(),
  recordsBySourceId: new Map(),
  sourcesById: new Map(),
};

function targetWith(status) {
  return {
    id: `target-${status}`,
    sourceId: `source-${status}`,
    provider: "Example provider",
    reference: "One exact record",
    priority: "P1",
    routes: [{ id: `route-${status}`, status }],
  };
}

test("alternate-route, alternate-provider, and subscription-first are autonomous route discovery", () => {
  assert.equal(actionableStatuses.has("route-discovery"), true);
  assert.equal(terminalStatuses.has("route-discovery"), false);
  for (const status of ["needs-alternate-route", "alternate-provider", "subscription-first"]) {
    const target = targetWith(status);
    const result = reconcileAcquisitionTarget(target, emptyStore);
    assert.deepEqual(result, {
      state: "actionable",
      status: "route-discovery",
      routeId: `route-${status}`,
      actionableRouteIds: [`route-${status}`],
      reasonCode: "autonomous-route-discovery",
    });
    target.reconciliation = result;
    target.status = result.status;
    assert.equal(buildNeedsUserResult([], [target]).needsUserCount, 0);
  }
});

test("real payment, submission, sign-in, FamilySearch Center, and external gates remain blocked", () => {
  const expected = new Map([
    ["needs-subscription-purchase", "requires-user-action"],
    ["needs-purchase-confirmation", "requires-user-action"],
    ["needs-submit-confirmation", "requires-user-action"],
    ["needs-human-visual-review", "requires-user-action"],
    ["needs-interactive-sign-in", "needs-interactive-sign-in"],
    ["needs-interactive-payment", "needs-interactive-payment"],
    ["needs-familysearch-center", "access-gated"],
    ["pending-external-delivery", "pending-external"],
  ]);
  for (const [routeStatus, targetStatus] of expected) {
    const result = reconcileAcquisitionTarget(targetWith(routeStatus), emptyStore);
    assert.equal(result.state, "blocked", routeStatus);
    assert.equal(result.status, targetStatus, routeStatus);
  }
});

test("a ready alternate route outranks a simultaneous human access gate", () => {
  const target = targetWith("needs-familysearch-center");
  target.routes.push({ id: "route-public-alternate", status: "needs-alternate-route" });
  const result = reconcileAcquisitionTarget(target, emptyStore);
  assert.equal(result.state, "actionable");
  assert.equal(result.status, "route-discovery");
  assert.equal(result.routeId, "route-public-alternate");
});

test("legacy text-only negatives return to autonomous review", () => {
  const target = targetWith("not-found");
  target.routes[0].attempts = [{
    outcome: "not-found-bounded",
    scope: { coverage: "one old prose-only scope" },
  }];
  assert.equal(routeHasVerifiedBoundedNegative(target.routes[0]), false);
  const result = reconcileAcquisitionTarget(target, emptyStore);
  assert.equal(result.state, "actionable");
  assert.equal(result.status, "route-discovery");
  assert.equal(result.reasonCode, "bounded-negative-review-required");
});

test("only versioned complete, untruncated, verified negatives close a route", () => {
  const target = targetWith("not-found");
  target.routes[0].attempts = [{
    outcome: "not-found-bounded",
    scope: {
      coverageContractVersion: 1,
      coverage: "all named collection pages for the exact date and place",
      paginationComplete: true,
      truncated: false,
      providerCoverageVerified: true,
      verificationBasis: "provider collection coverage plus complete page traversal",
    },
  }];
  assert.equal(routeHasVerifiedBoundedNegative(target.routes[0]), true);
  const result = reconcileAcquisitionTarget(target, emptyStore);
  assert.equal(result.state, "exhausted");
  assert.equal(result.status, "not-found-bounded");
});

test("a target may be superseded by one exact acquisition target", () => {
  const result = reconcileAcquisitionTarget({
    id: "generic-target",
    supersession: {
      targetIds: ["exact-target"],
      reason: "The exact target owns the same source recovery task.",
    },
    routes: [],
  }, emptyStore);

  assert.equal(result.state, "not-applicable");
  assert.equal(result.status, "superseded");
  assert.deepEqual(result.supersededByTargetIds, ["exact-target"]);
});

test("a reserve alternate-provider route waits while its primary request is held", () => {
  const withRoutes = (routes) => ({ ...targetWith("alternate-provider"), routes });
  const alternate = { id: "route-alternate", status: "alternate-provider" };
  const pending = reconcileAcquisitionTarget(withRoutes([
    alternate,
    { id: "route-inquiry", status: "pending-external-delivery" }
  ]), emptyStore);
  assert.equal(pending.state, "blocked");
  assert.equal(pending.status, "pending-external");
  assert.equal(pending.routeId, "route-inquiry");

  const awaitingUser = reconcileAcquisitionTarget(withRoutes([
    alternate,
    { id: "route-form", status: "needs-interactive-payment" }
  ]), emptyStore);
  assert.equal(awaitingUser.state, "blocked");

  // An access gate is exactly when another provider should be tried.
  const signIn = reconcileAcquisitionTarget(withRoutes([
    alternate,
    { id: "route-viewer", status: "needs-interactive-sign-in" }
  ]), emptyStore);
  assert.equal(signIn.state, "actionable");
  assert.equal(signIn.routeId, "route-alternate");

  // Genuine parallel work is never held back by a pending request.
  const parallel = reconcileAcquisitionTarget(withRoutes([
    alternate,
    { id: "route-capture", status: "ready-subscription-capture" },
    { id: "route-inquiry", status: "pending-external-delivery" }
  ]), emptyStore);
  assert.equal(parallel.state, "actionable");
  assert.equal(parallel.routeId, "route-capture");
});
