import assert from "node:assert/strict";
import test from "node:test";

import { buildNeedsUserResult, structuredGateForTarget, targetResumeToken } from "./needs-user.mjs";

test("requester-information replies resume the existing request without another submission", () => {
  const target = {
    id: "invoice-address",
    reconciliation: { reasonCode: "needs-requester-information", routeId: "inquiry" },
    routes: [{ id: "inquiry", status: "needs-requester-information",
      confirmationPhrase: "SUBMIT invoice-address",
      requestProjection: { operationalState: "information-required" } }],
  };
  assert.equal(targetResumeToken(target), "READY invoice-address");
  assert.equal(targetResumeToken(target, { routeId: "inquiry", reasonCode: "needs-requester-information" }),
    "READY invoice-address");
});

const liveQuestion = {
  id: "rq-live",
  schemaVersion: 2,
  lifecycle: "active",
  conclusion: { state: "unresolved" },
  goalKeys: ["fact:rq-live"]
};

test("only structured live user gates enter needs-user", () => {
  const target = (id, questionIds, gate) => ({
    id,
    priority: "P1",
    provider: "Archive",
    reference: "Item",
    questionIds,
    researchRole: "proof-blocking",
    gate,
    reconciliation: { state: "blocked", retryWhen: "gate-clears" },
    routes: []
  });
  const answered = {
    id: "rq-answered",
    schemaVersion: 2,
    lifecycle: "active",
    conclusion: { state: "established" },
    goalKeys: []
  };
  const result = buildNeedsUserResult([liveQuestion, answered], [
    target("live-gate", ["rq-live"], {
      actor: "user", type: "interactive-sign-in", state: "active", resumeToken: "READY live-gate"
    }),
    target("answered-recovery", ["rq-answered"], {
      actor: "user", type: "interactive-sign-in", state: "active", resumeToken: "READY answered-recovery"
    }),
    target("no-question-recovery", [], {
      actor: "user", type: "interactive-sign-in", state: "active", resumeToken: "READY no-question-recovery"
    }),
    target("system-route", ["rq-live"], {
      actor: "system", type: "route-discovery", state: "active"
    }),
    {
      ...target("recovery-gate", ["rq-live"], {
        actor: "user", type: "interactive-sign-in", state: "active", resumeToken: "READY recovery-gate"
      }),
      researchRole: "recovery-only"
    }
  ]);
  assert.equal(result.needsUserCount, 1);
  assert.deepEqual(result.items.map((item) => item.id), ["live-gate"]);
});

test("legacy alternate-route findings are system work, never synthetic user gates", () => {
  assert.equal(structuredGateForTarget({
    id: "alternate",
    status: "access-gated",
    reconciliation: { state: "blocked", reasonCode: "needs-alternate-route" }
  }), null);
  assert.deepEqual(buildNeedsUserResult([
    { id: "rq-blocked", status: "blocked", actions: [], reopenWhen: [] }
  ], []).items, []);
});

test("waiting-external retains sent recovery and control requests while user gates remain proof-only", () => {
  const target = (id, researchRole, gate) => ({
    id,
    priority: "P1",
    provider: "Archive",
    reference: "Item",
    questionIds: ["rq-answered"],
    researchRole,
    gate,
    reconciliation: { state: "blocked", retryWhen: "response-arrives" },
    routes: []
  });
  const answered = {
    id: "rq-answered",
    schemaVersion: 2,
    lifecycle: "active",
    conclusion: { state: "established" },
    goalKeys: []
  };
  const result = buildNeedsUserResult([answered], [
    target("sent-control", "control", {
      actor: "external", type: "delivery", state: "active"
    }),
    target("sent-recovery", "recovery-only", {
      actor: "external", type: "delivery", state: "active"
    }),
    target("user-recovery", "recovery-only", {
      actor: "user", type: "interactive-sign-in", state: "active"
    })
  ]);
  assert.equal(result.waitingExternalCount, 2);
  assert.equal(result.needsUserCount, 0);
  assert.deepEqual(result.items.map((item) => item.id), ["sent-control", "sent-recovery"]);
  assert.ok(result.items.every((item) => item.resumeToken.startsWith("RECEIVED ")));
});

test("fee quote projections produce a payment gate instead of a conflict-adjudication gate", () => {
  const gate = structuredGateForTarget({
    id: "fee-quote",
    priority: "P0",
    status: "access-gated",
    reconciliation: {
      state: "blocked",
      reasonCode: "request-conflict-hold",
      routeId: "quoted-route"
    },
    routes: [{
      id: "quoted-route",
      requestProjection: {
        operationalState: "fee-quote-hold",
        feeQuote: { amount: 25, currency: "USD" }
      }
    }]
  });
  assert.equal(gate.actor, "user");
  assert.equal(gate.type, "fee-quote-payment");
});

test("parallel autonomous routes cannot hide authoritative user or external gates", () => {
  const target = (id, gatedRoute) => ({
    id,
    priority: "P1",
    provider: "Archive",
    reference: "Item",
    questionIds: ["rq-live"],
    researchRole: "proof-blocking",
    status: "route-discovery",
    reconciliation: {
      state: "actionable",
      status: "route-discovery",
      routeId: `${id}-alternate`,
      reasonCode: "autonomous-route-discovery",
    },
    routes: [
      { id: `${id}-alternate`, status: "alternate-provider" },
      { id: `${id}-gate`, status: gatedRoute },
    ],
  });
  const result = buildNeedsUserResult([liveQuestion], [
    target("parallel-user", "needs-interactive-payment"),
    target("parallel-external", "pending-external-delivery"),
  ]);

  assert.equal(result.needsUserCount, 1);
  assert.equal(result.waitingExternalCount, 1);
  assert.deepEqual(result.items.map((item) => item.id), ["parallel-user", "parallel-external"]);
  assert.equal(result.items[0].resumeToken, "PAYMENT READY parallel-user");
  assert.equal(result.items[1].resumeToken, "RECEIVED parallel-external");
});


test("an accepted quote awaiting payment instructions waits externally but says the money is still owed", () => {
  const target = {
    id: "asdm-files", priority: "P1", provider: "Archivio Storico Diocesano", reference: "status files",
    questionIds: ["rq-live"], researchRole: "proof-blocking", status: "pending-external",
    reconciliation: { state: "blocked", routeId: "asdm-files-inquiry", retryWhen: "delivery-arrives" },
    routes: [{ id: "asdm-files-inquiry", status: "pending-external-delivery", requestId: "asdm-files",
      requestProjection: { operationalState: "awaiting-payment-instructions", revision: 6,
        feeQuote: { amount: 50, currency: "EUR" }, approvedPayment: { amount: 50, currency: "EUR" } } }]
  };
  const gate = structuredGateForTarget(target);
  assert.equal(gate.actor, "external");
  assert.equal(gate.type, "payment-instructions");
  assert.equal(gate.resumeToken, "RECEIVED asdm-files");
  assert.match(gate.title, /€50\.00 quote accepted; the payment is still owed/);
  assert.match(gate.action, /archive:win:inspect-response -- -Request asdm-files/);
  assert.match(gate.action, /records payment-requested/);
  assert.match(gate.action, /Do not pay by hand/);
  const result = buildNeedsUserResult([liveQuestion], [target]);
  assert.equal(result.items[0].kind, "waiting-external");
  assert.equal(result.items[0].title, gate.title);
});

test("an approved quote names the guarded route that pays it, or the agent's discovery step", () => {
  const target = (id, provider) => ({
    id, priority: "P1", provider, reference: id, questionIds: ["rq-live"], researchRole: "proof-blocking",
    reconciliation: { state: "blocked", routeId: `${id}-inquiry` },
    routes: [{ id: `${id}-inquiry`, status: "needs-interactive-payment", requestId: id, provider,
      requestProjection: { operationalState: "paid-followup-authorized", revision: 5,
        feeQuote: { amount: 18, currency: "GBP" }, approvedPayment: { amount: 18, currency: "GBP" } } }]
  });
  const bank = buildNeedsUserResult([liveQuestion], [target("hunts-quote", "Huntingdonshire Archives")]).items[0];
  assert.equal(bank.resumeToken, "PAYMENT READY hunts-quote");
  assert.match(bank.action, /Wise transfer/);
  assert.match(bank.action, /payments:run -- --execute --id hunts-quote/);
  const card = buildNeedsUserResult([liveQuestion], [target("norris-quote", "Norris Museum")]).items[0];
  assert.equal(card.resumeToken, "PAYMENT READY norris-quote");
  assert.match(card.action, /guarded checkout/);
  const unknown = buildNeedsUserResult([liveQuestion], [target("society-quote", "Some County Society")]).items[0];
  assert.equal(unknown.resumeToken, "PAID society-quote");
  assert.match(unknown.action, /agent first reads the provider's own reply/);
  assert.match(unknown.action, /Only if Some County Society takes a mailed cheque or a phone payment/);
});

test("a recorded PAY phrase on an order tells the agent to run the checkout, not the user to wait", () => {
  const target = (id, provider) => ({
    id, priority: "P1", provider, reference: id, questionIds: ["rq-live"], researchRole: "proof-blocking",
    reconciliation: { state: "blocked", routeId: id },
    routes: [{ id, status: "needs-interactive-payment", requestId: id, provider, estimatedCostGbp: 3,
      serviceOption: "Online View", requestProjection: { operationalState: "authorized", revision: 1 } }]
  });
  const gro = buildNeedsUserResult([liveQuestion], [target("gro-view", "General Register Office")]).items[0];
  assert.equal(gro.resumeToken, "PAYMENT READY gro-view");
  assert.match(gro.action, /Your PAY phrase is recorded; nothing is paid until the agent runs the guarded Online View at no more than £3\.00 \(npm run payments:run -- --execute --id gro-view\)/);
  const library = buildNeedsUserResult([liveQuestion], [target("library-copy", "Kenosha Public Library")]).items[0];
  assert.equal(library.resumeToken, "PAYMENT READY library-copy");
  assert.match(library.action, /no guarded checkout exists for Kenosha Public Library/);
  assert.match(library.action, /reply PAID library-copy/);
});

test("one quoted request spanning two targets emits the exact shared PAY phrase", () => {
  const targets = ["court-copies", "rental"].map((id) => ({
    id, priority: "P1", provider: "Archive", reference: id,
    questionIds: ["rq-live"], researchRole: "proof-blocking", status: "requires-user-action",
    reconciliation: { state: "blocked", reasonCode: "request-conflict-hold", routeId: `${id}-quote` },
    routes: [{ id: `${id}-quote`, status: "request-conflict-hold", requestId: "shared-clarification",
      authorizationTargetId: id,
      requestProjection: { operationalState: "fee-quote-hold", feeQuote: { amount: 18, currency: "GBP" } } }],
  }));
  const result = buildNeedsUserResult([liveQuestion], targets);
  assert.equal(result.items.length, 2);
  for (const item of result.items) {
    assert.equal(item.resumeToken, "PAY shared-clarification");
    assert.match(item.action, /Reply PAY shared-clarification /);
    assert.match(item.action, /£18.00/);
  }
});
