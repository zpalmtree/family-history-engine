import assert from "node:assert/strict";
import test from "node:test";

import {
  applyGateReopening,
  canonicalAccessProvider,
  planGateReopenings,
  providerAccessSignals,
  reopenNotePrefix,
  signInVenue
} from "./access-gates.mjs";
import { buildNeedsUserResult } from "./needs-user.mjs";

const route = (id, provider, status, attempts, extra = {}) => ({
  id, provider, status, lastAttemptAt: attempts.at(-1)?.attemptedAt, attempts, ...extra
});
const attempt = (outcome, attemptedAt, note) => ({ outcome, attemptedAt, ...(note ? { note } : {}) });

function corpus() {
  return [
    { id: "fs-gated", provider: "FamilySearch, Germany, Marriages, 1558-1929", routes: [
      route("fs-gated", "FamilySearch", "needs-interactive-sign-in", [attempt("needs-interactive-sign-in", "2026-07-30T10:00:00Z")])
    ] },
    { id: "fs-read", provider: "FamilySearch", routes: [
      route("fs-read", "FamilySearch", "acquired", [attempt("acquired-original", "2026-10-02T10:00:00Z")])
    ] },
    { id: "fmp-old-gate", provider: "Findmypast, Staffordshire Baptisms", routes: [
      route("fmp-old-gate", "Findmypast", "needs-interactive-sign-in", [attempt("needs-interactive-sign-in", "2026-07-30T10:00:00Z")])
    ] },
    { id: "fmp-read", provider: "Findmypast", routes: [
      route("fmp-read", "Findmypast", "acquired", [attempt("acquired-original", "2026-08-12T10:00:00Z")])
    ] },
    { id: "fmp-new-gate", provider: "Findmypast", routes: [
      route("fmp-new-gate", "Findmypast", "needs-interactive-sign-in", [attempt("needs-interactive-sign-in", "2026-10-03T10:00:00Z")])
    ] },
    { id: "fmp-subscription", provider: "Findmypast", routes: [
      route("fmp-subscription", "Findmypast", "needs-subscription-purchase", [attempt("needs-subscription-purchase", "2026-09-30T10:00:00Z")], {
        gate: { actor: "user", type: "record-access", state: "active", reasonCode: "needs-subscription-purchase", resumeToken: "READY fmp-subscription", venue: { id: "findmypast-record-access", label: "Findmypast record access" } }
      })
    ] }
  ];
}

test("provider labels collapse to one account identity", () => {
  assert.equal(canonicalAccessProvider("FamilySearch, Germany, Marriages, 1558-1929"), "familysearch");
  assert.equal(canonicalAccessProvider("FamilySearch Digital Library"), "familysearch");
  assert.equal(canonicalAccessProvider("Findmypast, Staffordshire Baptisms"), "findmypast");
  assert.equal(canonicalAccessProvider("Ancestry, London, England, Church of England Marriages and Banns, 1754-1941"), "ancestry");
  assert.equal(canonicalAccessProvider("The National Archives"), "tna");
  assert.equal(canonicalAccessProvider("Maryland State Archives Land Records"), "mdlandrec");
  assert.equal(canonicalAccessProvider("Some Archive", "https://search.findmypast.co.uk/record?id=1"), "findmypast");
  assert.deepEqual(signInVenue("findmypast"), { id: "sign-in-findmypast", label: "Findmypast sign-in" });
});

test("only a sign-in gate superseded by a later authenticated read is stale", () => {
  const targets = corpus();
  const signals = providerAccessSignals({ acquisitionTargets: targets });
  const { plan } = planGateReopenings(targets, { signals });
  assert.deepEqual(plan.map((item) => item.target.id), ["fs-gated"],
    "Findmypast's newest signal is a gate, so its older gate is not stale; subscriptions never auto-reopen");
  assert.equal(plan[0].restoredStatus, "ready-download");
});

test("FamilySearch question searches count as a live session, local reviews do not", () => {
  const targets = corpus().filter((target) => target.id === "fs-gated");
  const local = providerAccessSignals({ acquisitionTargets: targets, questionAttempts: [
    { outcome: "located", attemptedAt: "2026-10-06T00:00:00Z", source: "Local held FamilySearch images and canonical store" }
  ] });
  assert.equal(planGateReopenings(targets, { signals: local }).plan.length, 0);
  const live = providerAccessSignals({ acquisitionTargets: targets, questionAttempts: [
    { outcome: "located", attemptedAt: "2026-10-06T00:00:00Z", source: "FamilySearch historical-record search via the shared Windows Chrome batch" }
  ] });
  assert.equal(planGateReopenings(targets, { signals: live }).plan.length, 1);
});

test("verified sign-in and reported entitlement reopen exactly their provider's gates", () => {
  const targets = corpus();
  const signals = providerAccessSignals({ acquisitionTargets: targets });
  const signedIn = planGateReopenings(targets, { signals, signedIn: ["findmypast"] }).plan.map((item) => item.target.id);
  assert.deepEqual(signedIn, ["fs-gated", "fmp-old-gate", "fmp-new-gate"], "a sign-in does not clear a subscription gate");
  const entitled = planGateReopenings(targets, { signals, entitlement: ["findmypast"] }).plan;
  assert.deepEqual(entitled.map((item) => item.target.id), ["fs-gated", "fmp-old-gate", "fmp-new-gate", "fmp-subscription"]);
  assert.ok(entitled.filter((item) => item.providerId === "findmypast").every((item) => item.restoredStatus === "ready-subscription-capture"));
});

test("reopening records an auditable attempt, resolves the gate, and is capped", () => {
  const targets = corpus();
  const { plan } = planGateReopenings(targets, { entitlement: ["findmypast"] });
  const item = plan.find((entry) => entry.target.id === "fmp-subscription");
  const now = new Date("2026-10-07T12:00:00Z");
  const recorded = applyGateReopening(item, { now, fingerprint: ({ routeId, note }) => `${routeId}:${note}`.padEnd(64, "0") });
  assert.equal(item.route.status, "ready-subscription-capture");
  assert.equal(recorded.outcome, "ready-subscription-capture");
  assert.ok(recorded.note.startsWith(reopenNotePrefix));
  assert.equal(item.route.gate.state, "resolved");
  assert.equal(item.route.gate.resolvedAt, now.toISOString());

  // Two reopenings that each gated again mark a collection-specific restriction.
  const stubborn = route("stubborn", "FamilySearch", "needs-interactive-sign-in", [
    attempt("needs-interactive-sign-in", "2026-07-01T00:00:00Z"),
    attempt("ready-download", "2026-07-02T00:00:00Z", `${reopenNotePrefix}: one`),
    attempt("needs-interactive-sign-in", "2026-07-03T00:00:00Z"),
    attempt("ready-download", "2026-07-04T00:00:00Z", `${reopenNotePrefix}: two`),
    attempt("needs-interactive-sign-in", "2026-07-05T00:00:00Z")
  ]);
  const capped = [{ id: "stubborn", provider: "FamilySearch", routes: [stubborn] }, ...corpus().filter((target) => target.id === "fs-read")];
  const result = planGateReopenings(capped, { signedIn: ["familysearch"] });
  assert.equal(result.plan.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.equal(planGateReopenings(capped, { signedIn: ["familysearch"], force: true }).plan.length, 1);
});

test("needs-user groups every sign-in gate for one provider under one venue and token", () => {
  const question = { id: "rq-live", schemaVersion: 2, lifecycle: "active", conclusion: { state: "unresolved" }, goalKeys: ["parent-slot:x:father"], status: "open" };
  const gated = (id, provider, routeProvider, gate) => ({
    id, provider, priority: "P1", reference: id, questionIds: ["rq-live"], researchRole: "proof-blocking",
    status: "needs-interactive-sign-in",
    reconciliation: { state: "blocked", status: "needs-interactive-sign-in", routeId: id, reasonCode: "needs-interactive-sign-in" },
    routes: [{ id, provider: routeProvider, status: "needs-interactive-sign-in", ...(gate ? { gate } : {}) }]
  });
  const result = buildNeedsUserResult([question], [
    gated("fmp-a", "Findmypast", "Findmypast"),
    gated("fmp-b", "Findmypast, Staffordshire Baptisms", "Findmypast"),
    gated("fmp-c", "Ancestry, 1851 England Census", "Findmypast", {
      actor: "user", type: "record-access", state: "active", reasonCode: "needs-interactive-sign-in",
      resumeToken: "READY fmp-c", venue: { id: "findmypast-record-access", label: "Findmypast sign-in or supplied originals" }
    })
  ]);
  assert.deepEqual([...new Set(result.items.map((item) => item.venue.id))], ["sign-in-findmypast"]);
  assert.equal(result.items.find((item) => item.id === "fmp-a").resumeToken, "READY sign-in-findmypast");
});

test("a plain subscription-wall attempt projects as a provider subscription gate", () => {
  const question = { id: "rq-live", schemaVersion: 2, lifecycle: "active", conclusion: { state: "unresolved" }, goalKeys: ["parent-slot:x:father"], status: "open" };
  const walled = (id, routeProvider) => ({
    id, provider: `${routeProvider}, Derbyshire Wills`, priority: "P1", reference: id, questionIds: ["rq-live"], researchRole: "proof-blocking",
    status: "requires-user-action",
    reconciliation: { state: "blocked", status: "requires-user-action", routeId: id, reasonCode: "needs-subscription-purchase" },
    routes: [{ id, provider: routeProvider, status: "needs-subscription-purchase", attempts: [{ outcome: "needs-subscription-purchase", attemptedAt: "2026-10-07T10:00:00Z" }] }]
  });
  const result = buildNeedsUserResult([question], [walled("fmp-will-a", "Findmypast"), walled("fmp-will-b", "Findmypast")]);
  assert.equal(result.needsUserCount, 2, "no hand-written gate object is needed");
  assert.deepEqual([...new Set(result.items.map((item) => item.venue.id))], ["subscription-findmypast"]);
  assert.equal(result.items[0].resumeToken, "READY subscription-findmypast");
  assert.match(result.items[0].action, /research:gates:refresh -- --entitlement findmypast/);
});
