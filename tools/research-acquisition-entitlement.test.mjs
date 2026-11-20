import test from "node:test";
import assert from "node:assert/strict";
import { reconcileAcquisitionTarget, acquisitionTargetStatuses } from "./research-acquisition.mjs";

test("an access-entitlement pass target is never capture work", () => {
  const target = {
    id: "archion-example-pass",
    disposition: "access-entitlement",
    routes: [{ id: "archion-example-pass", targetId: "archion-example-pass", provider: "Archion", sourceQueue: "archion-access", route: "paid-provider-subscription", status: "ready-subscription-capture" }]
  };
  const result = reconcileAcquisitionTarget(target, { recordsById: new Map(), recordsBySourceId: new Map(), sourcesById: new Map() });
  assert.equal(result.state, "not-applicable");
  assert.equal(result.status, "access-entitlement");
  assert.ok(acquisitionTargetStatuses.has("access-entitlement"));
});

test("a target whose order the user declined is neither capture work nor a user action", () => {
  const target = {
    id: "archive-example-declined",
    disposition: "user-declined",
    routes: [{ id: "archive-example-declined-inquiry", targetId: "archive-example-declined", provider: "Example Archive", route: "authorized-archive-inquiry", status: "duplicate", requestProjection: { operationalState: "cancelled", revision: 5, classifiedRevision: 5 } }]
  };
  const result = reconcileAcquisitionTarget(target, { recordsById: new Map(), recordsBySourceId: new Map(), sourcesById: new Map() });
  assert.equal(result.state, "not-applicable");
  assert.equal(result.status, "user-declined");
  assert.ok(acquisitionTargetStatuses.has("user-declined"));
});
