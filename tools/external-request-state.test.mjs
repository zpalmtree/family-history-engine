import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  appendExternalRequestEvent,
  deriveExternalRequest,
  externalRequestPayloadSha256,
  projectExternalRequestOntoRoute,
  validateExternalRequest
} from "./external-request-store.mjs";

function fixture() {
  const request = {
    schemaVersion: 1,
    id: "test-request",
    provider: "Test archive",
    kind: "no-charge-email",
    items: [{ id: "item", targetId: "target", routeId: "route" }],
    spec: { channel: "email", recipient: "archive@example.test", subject: "Lookup", body: "Please check." },
    guard: { requiredPhrase: "SUBMIT test-request", costMode: "no-charge" },
    payloadSha256: "",
    revision: 0,
    events: []
  };
  request.payloadSha256 = externalRequestPayloadSha256(request);
  return request;
}

test("authorization is tied to the exact guarded payload", () => {
  let request = fixture();
  request = appendExternalRequestEvent(request, {
    type: "authorization-confirmed",
    phrase: request.guard.requiredPhrase,
    payloadSha256: request.payloadSha256,
    at: "2026-07-15T00:00:00.000Z"
  });
  assert.equal(deriveExternalRequest(request).operationalState, "authorized");
  request.spec.subject = "Changed lookup";
  request.payloadSha256 = externalRequestPayloadSha256(request);
  assert.equal(deriveExternalRequest(request).operationalState, "authorization-required");
});

test("paid subscription access confirmation unlocks capture without a duplicate payment gate", () => {
  let request = {
    ...fixture(),
    kind: "paid-order",
    guard: { requiredPhrase: "PAY test-request", costMode: "maximum", currency: "EUR", maxAmount: 19.9 },
    spec: { serviceOption: "one-month archive pass" }
  };
  request.payloadSha256 = externalRequestPayloadSha256(request);
  request = appendExternalRequestEvent(request, {
    type: "authorization-confirmed",
    phrase: request.guard.requiredPhrase,
    payloadSha256: request.payloadSha256,
    at: "2026-07-15T00:00:00.000Z"
  });
  request = appendExternalRequestEvent(request, {
    type: "access-confirmed",
    basis: "user-reported-checkout-complete-and-verified-volume-access",
    at: "2026-07-15T00:00:01.000Z"
  });
  assert.deepEqual(
    [deriveExternalRequest(request).operationalState, deriveExternalRequest(request).routeStatus],
    ["access-confirmed", "ready-subscription-capture"]
  );
  assert.deepEqual(validateExternalRequest(request), []);
});

test("access projection does not downgrade a captured paid route", () => {
  let request = {
    ...fixture(),
    kind: "paid-order",
    guard: { requiredPhrase: "PAY test-request", costMode: "maximum", currency: "EUR", maxAmount: 19.9 },
    spec: { serviceOption: "one-month archive pass" }
  };
  request.payloadSha256 = externalRequestPayloadSha256(request);
  request = appendExternalRequestEvent(request, {
    type: "authorization-confirmed",
    phrase: request.guard.requiredPhrase,
    payloadSha256: request.payloadSha256,
    at: "2026-07-15T00:00:00.000Z"
  });
  request = appendExternalRequestEvent(request, {
    type: "access-confirmed",
    basis: "user-reported-checkout-complete-and-verified-volume-access",
    at: "2026-07-15T00:00:01.000Z"
  });
  const route = { targetId: "target", id: "route", status: "acquired" };
  projectExternalRequestOntoRoute(route, request);
  assert.equal(route.status, "acquired");
});

test("an interrupted submission becomes a conflict hold until explicitly resolved", () => {
  let request = fixture();
  request = appendExternalRequestEvent(request, {
    type: "authorization-confirmed",
    phrase: request.guard.requiredPhrase,
    payloadSha256: request.payloadSha256,
    at: "2026-07-15T00:00:00.000Z"
  });
  request = appendExternalRequestEvent(request, { type: "submission-started", at: "2026-07-15T00:00:01.000Z" });
  assert.deepEqual(
    [deriveExternalRequest(request).operationalState, deriveExternalRequest(request).routeStatus],
    ["conflict-hold", "request-conflict-hold"]
  );
  request = appendExternalRequestEvent(request, { type: "submission-retryable", at: "2026-07-15T00:00:02.000Z" });
  assert.equal(deriveExternalRequest(request).operationalState, "authorized");
});

test("confirmed submission, delivery, and import advance monotonically", () => {
  let request = fixture();
  for (const event of [
    { type: "authorization-confirmed", phrase: request.guard.requiredPhrase, payloadSha256: request.payloadSha256, at: "2026-07-15T00:00:00.000Z" },
    { type: "submission-started", at: "2026-07-15T00:00:01.000Z" },
    { type: "submission-confirmed", at: "2026-07-15T00:00:02.000Z" },
    { type: "delivery-reported", at: "2026-07-15T00:00:03.000Z" },
    { type: "delivery-item-imported", itemId: "item", at: "2026-07-15T00:00:04.000Z" },
    { type: "delivery-complete", at: "2026-07-15T00:00:05.000Z" }
  ]) request = appendExternalRequestEvent(request, event);
  assert.equal(deriveExternalRequest(request).operationalState, "complete");
  assert.deepEqual(validateExternalRequest(request), []);
});

test("a completed delivery keeps a published route published", () => {
  let request = fixture();
  for (const event of [
    { type: "authorization-confirmed", phrase: request.guard.requiredPhrase, payloadSha256: request.payloadSha256, at: "2026-07-15T00:00:00.000Z" },
    { type: "submission-confirmed", at: "2026-07-15T00:00:01.000Z" },
    { type: "delivery-reported", at: "2026-07-15T00:00:02.000Z" },
    { type: "delivery-item-imported", itemId: "item", at: "2026-07-15T00:00:03.000Z" },
    { type: "delivery-complete", at: "2026-07-15T00:00:04.000Z" }
  ]) request = appendExternalRequestEvent(request, event);
  const item = request.items.find((candidate) => candidate.id === "item");
  const published = { targetId: item.targetId, id: item.routeId, status: "published" };
  projectExternalRequestOntoRoute(published, request);
  assert.equal(published.status, "published");
  const queued = { targetId: item.targetId, id: item.routeId, status: "pending-external-delivery" };
  projectExternalRequestOntoRoute(queued, request);
  assert.equal(queued.status, "acquired");
});

test("a completed bounded negative projects as not-found for its request item", () => {
  let request = fixture();
  for (const event of [
    { type: "authorization-confirmed", phrase: request.guard.requiredPhrase, payloadSha256: request.payloadSha256, at: "2026-07-15T00:00:00.000Z" },
    { type: "submission-confirmed", at: "2026-07-15T00:00:01.000Z" },
    { type: "delivery-reported", at: "2026-07-15T00:00:02.000Z" },
    { type: "delivery-item-imported", itemId: "item", routeStatus: "not-found", at: "2026-07-15T00:00:03.000Z" },
    { type: "delivery-complete", at: "2026-07-15T00:00:04.000Z" }
  ]) request = appendExternalRequestEvent(request, event);
  assert.equal(deriveExternalRequest(request, "item").routeStatus, "not-found");
  assert.equal(deriveExternalRequest(request).routeStatus, "acquired");
  assert.deepEqual(validateExternalRequest(request), []);
});

test("a provider information request is not misclassified as a downloadable delivery", () => {
  let request = fixture();
  for (const event of [
    { type: "authorization-confirmed", phrase: request.guard.requiredPhrase, payloadSha256: request.payloadSha256, at: "2026-07-15T00:00:00.000Z" },
    { type: "submission-confirmed", at: "2026-07-15T00:00:01.000Z" },
    { type: "delivery-reported", at: "2026-07-15T00:00:02.000Z" },
    { type: "provider-information-required", at: "2026-07-15T00:00:03.000Z" }
  ]) request = appendExternalRequestEvent(request, event);
  assert.deepEqual(
    [deriveExternalRequest(request).operationalState, deriveExternalRequest(request).routeStatus],
    ["information-required", "needs-requester-information"]
  );
  request = appendExternalRequestEvent(request, {
    type: "provider-information-supplied",
    phrase: request.guard.requiredPhrase,
    payloadSha256: request.payloadSha256,
    at: "2026-07-15T00:00:04.000Z"
  });
  assert.equal(deriveExternalRequest(request).operationalState, "waiting-external");
});

test("an acknowledgement-only reply resumes external waiting after inspection", () => {
  let request = fixture();
  for (const event of [
    { type: "authorization-confirmed", phrase: request.guard.requiredPhrase, payloadSha256: request.payloadSha256, at: "2026-07-15T00:00:00.000Z" },
    { type: "submission-confirmed", at: "2026-07-15T00:00:01.000Z" },
    { type: "delivery-reported", at: "2026-07-15T00:00:02.000Z" },
    { type: "provider-acknowledged", at: "2026-07-15T00:00:03.000Z" }
  ]) request = appendExternalRequestEvent(request, event);
  assert.deepEqual(
    [deriveExternalRequest(request).operationalState, deriveExternalRequest(request).routeStatus],
    ["waiting-external", "pending-external-delivery"]
  );
  assert.deepEqual(validateExternalRequest(request), []);
});

test("requester information cannot advance out of sequence or without the exact checkpoint", () => {
  const request = fixture();
  assert.throws(() => appendExternalRequestEvent(request, {
    type: "provider-information-supplied",
    phrase: request.guard.requiredPhrase,
    payloadSha256: request.payloadSha256
  }), /requires prior provider-information-required|requires valid authorization/);
});

test("a voided confirmation returns a paid order to needing a fresh approval", () => {
  let request = fixture();
  request.id = "test-order";
  request.kind = "paid-order";
  request.guard = { requiredPhrase: "PAY test-order", costMode: "maximum", maxAmount: 12.5, currency: "GBP" };
  request.payloadSha256 = externalRequestPayloadSha256(request);
  const approve = (at) => ({ type: "authorization-confirmed", phrase: request.guard.requiredPhrase, payloadSha256: request.payloadSha256, at });
  // Nothing was confirmed yet, so there is nothing to void.
  assert.throws(() => appendExternalRequestEvent(request, { type: "submission-voided", note: "wrong item", at: "2026-07-15T00:30:00.000Z" }),
    /requires a prior confirmed submission/);
  request = appendExternalRequestEvent(request, approve("2026-07-15T00:00:00.000Z"));
  request = appendExternalRequestEvent(request, { type: "submission-confirmed", basis: "order list", at: "2026-07-15T01:00:00.000Z" });
  assert.equal(deriveExternalRequest(request).operationalState, "waiting-external");
  assert.throws(() => appendExternalRequestEvent(request, { type: "submission-voided", at: "2026-11-10T00:00:00.000Z" }),
    /must say why/);
  request = appendExternalRequestEvent(request, {
    type: "submission-voided", note: "The listed order was a second copy of another certificate.", at: "2026-11-10T00:00:00.000Z"
  });
  // The earlier approval was spent on the wrong order and does not carry over.
  assert.equal(deriveExternalRequest(request).operationalState, "authorization-required");
  assert.equal(deriveExternalRequest(request).routeStatus, "needs-purchase-confirmation");
  assert.throws(() => appendExternalRequestEvent(request, { type: "payment-started", at: "2026-11-10T00:01:00.000Z" }),
    /requires a prior PAY authorization/);
  request = appendExternalRequestEvent(request, approve("2026-11-10T00:02:00.000Z"));
  assert.equal(deriveExternalRequest(request).operationalState, "authorized");
  assert.equal(deriveExternalRequest(request).routeStatus, "needs-interactive-payment");
  request = appendExternalRequestEvent(request, { type: "submission-confirmed", basis: "order detail read", at: "2026-11-10T00:10:00.000Z" });
  assert.equal(deriveExternalRequest(request).operationalState, "waiting-external");
  assert.deepEqual(validateExternalRequest(request), []);
});

test("optimistic revisions reject concurrent writers", () => {
  const request = fixture();
  assert.throws(() => appendExternalRequestEvent(request, { type: "cancelled" }, { expectedRevision: 1 }), /revision changed/);
});

test("external request synchronization rebuilds downstream research projections", () => {
  const helper = fs.readFileSync(new URL("./sync-external-request-projections.mjs", import.meta.url), "utf8");
  assert.match(helper, /if \(!checkOnly\)[\s\S]*build-research-system\.mjs[\s\S]*--write/);
});

test("a quoted no-charge request needs a separate approval of that exact quote", () => {
  let request = fixture();
  request = appendExternalRequestEvent(request, {
    type: "authorization-confirmed",
    phrase: request.guard.requiredPhrase,
    payloadSha256: request.payloadSha256,
    at: "2026-07-15T00:00:00.000Z"
  });
  request = appendExternalRequestEvent(request, { type: "submission-started", at: "2026-07-15T00:01:00.000Z" });
  request = appendExternalRequestEvent(request, { type: "submission-confirmed", at: "2026-07-15T00:02:00.000Z" });
  request = appendExternalRequestEvent(request, {
    type: "fee-quoted",
    amount: 10,
    currency: "USD",
    at: "2026-07-16T00:00:00.000Z"
  });
  assert.equal(deriveExternalRequest(request).operationalState, "fee-quote-hold");

  const quote = request.events.at(-1);
  assert.throws(() => appendExternalRequestEvent(request, {
    type: "payment-authorized",
    phrase: "SUBMIT test-request",
    amount: 10,
    currency: "USD",
    feeEventId: quote.id,
    at: "2026-07-16T00:01:00.000Z"
  }), /exact PAY test-request phrase/);
  assert.throws(() => appendExternalRequestEvent(request, {
    type: "payment-authorized",
    phrase: "PAY test-request",
    amount: 25,
    currency: "USD",
    feeEventId: quote.id,
    at: "2026-07-16T00:01:00.000Z"
  }), /exactly the quoted amount/);

  request = appendExternalRequestEvent(request, {
    type: "payment-authorized",
    phrase: "PAY test-request",
    amount: 10,
    currency: "USD",
    feeEventId: quote.id,
    at: "2026-07-16T00:01:00.000Z"
  });
  const authorized = deriveExternalRequest(request);
  assert.equal(authorized.operationalState, "paid-followup-authorized");
  assert.equal(authorized.routeStatus, "needs-interactive-payment");

  // Approval alone must never read as money already sent.
  request = appendExternalRequestEvent(request, { type: "payment-submitted", at: "2026-07-16T00:02:00.000Z" });
  assert.equal(deriveExternalRequest(request).operationalState, "waiting-external");
});

test("an accepted quote is owed money until its payment instructions are recorded", () => {
  let request = fixture();
  request = appendExternalRequestEvent(request, { type: "fee-quoted", amount: 50, currency: "EUR", at: "2026-07-28T00:00:00.000Z" });
  const quote = request.events.at(-1);
  request = appendExternalRequestEvent(request, {
    type: "payment-authorized", phrase: "PAY test-request", amount: 50, currency: "EUR", feeEventId: quote.id, at: "2026-10-28T00:00:00.000Z"
  });
  request = appendExternalRequestEvent(request, {
    type: "quote-accepted", phrase: "PAY test-request", amount: 50, currency: "EUR", feeEventId: quote.id, at: "2026-10-28T00:01:00.000Z"
  });
  const accepted = deriveExternalRequest(request);
  assert.deepEqual([accepted.operationalState, accepted.routeStatus], ["awaiting-payment-instructions", "pending-external-delivery"]);
  assert.deepEqual([accepted.quoteAccepted, accepted.paymentRequested], [true, false]);
  const route = { id: "route", targetId: "target", status: "requires-user-action" };
  projectExternalRequestOntoRoute(route, request);
  assert.equal(route.status, "pending-external-delivery");
  assert.equal(route.requestProjection.operationalState, "awaiting-payment-instructions");
  assert.deepEqual(route.requestProjection.approvedPayment, { amount: 50, currency: "EUR" });

  request = appendExternalRequestEvent(request, { type: "payment-requested", basis: "bank details in the quote message", at: "2026-11-09T00:00:00.000Z" });
  const invoiced = deriveExternalRequest(request);
  assert.deepEqual([invoiced.operationalState, invoiced.routeStatus, invoiced.paymentRequested],
    ["paid-followup-authorized", "needs-interactive-payment", true]);
  request = appendExternalRequestEvent(request, { type: "payment-submitted", amount: 50, currency: "EUR", at: "2026-11-09T00:01:00.000Z" });
  assert.equal(deriveExternalRequest(request).operationalState, "waiting-external", "only a submitted payment waits on the provider alone");
  assert.deepEqual(validateExternalRequest(request), []);
});

test("a later or larger quote invalidates an earlier payment approval", () => {
  let request = fixture();
  request = appendExternalRequestEvent(request, {
    type: "fee-quoted",
    amount: 10,
    currency: "USD",
    at: "2026-07-16T00:00:00.000Z"
  });
  const firstQuote = request.events.at(-1);
  request = appendExternalRequestEvent(request, {
    type: "payment-authorized",
    phrase: "PAY test-request",
    amount: 10,
    currency: "USD",
    feeEventId: firstQuote.id,
    at: "2026-07-16T00:01:00.000Z"
  });
  assert.equal(deriveExternalRequest(request).operationalState, "paid-followup-authorized");

  request = appendExternalRequestEvent(request, {
    type: "fee-quoted",
    amount: 48,
    currency: "USD",
    at: "2026-07-17T00:00:00.000Z"
  });
  const revised = deriveExternalRequest(request);
  assert.equal(revised.operationalState, "fee-quote-hold");
  assert.equal(revised.fee.amount, 48);
  assert.throws(() => appendExternalRequestEvent(request, {
    type: "payment-submitted",
    at: "2026-07-17T00:01:00.000Z"
  }), /superseded quote/);
});

test("payment cannot be recorded as submitted without an approval", () => {
  let request = fixture();
  request = appendExternalRequestEvent(request, {
    type: "fee-quoted",
    amount: 10,
    currency: "USD",
    at: "2026-07-16T00:00:00.000Z"
  });
  assert.throws(() => appendExternalRequestEvent(request, {
    type: "payment-submitted",
    at: "2026-07-16T00:01:00.000Z"
  }), /requires a prior payment-authorized event/);
});

test("a clarification answers the exact message of the outstanding provider question", async () => {
  const { outstandingQuestionMessageId } = await import("./external-request-store.mjs");
  const asked = { type: "provider-information-required", basis: "gmail-message-1a1e3b06c88053e8" };
  assert.equal(outstandingQuestionMessageId({ events: [asked] }), "1a1e3b06c88053e8");
  assert.equal(outstandingQuestionMessageId({ events: [asked, { type: "provider-information-supplied" }] }), "", "an answered question has no target");
  assert.equal(outstandingQuestionMessageId({ events: [{ type: "provider-information-required", basis: "verified-Gmail-thread-reply" }] }), "", "no id falls back to the subject binding");
  assert.equal(outstandingQuestionMessageId({ events: [] }), "");
});
