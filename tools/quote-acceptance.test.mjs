import assert from "node:assert/strict";
import test from "node:test";

import {
  appendExternalRequestEvent,
  deriveExternalRequest,
  externalRequestPayloadSha256
} from "./external-request-store.mjs";
import {
  formatQuotedAmount,
  paymentReminderBody,
  planPaymentReminder,
  planQuoteAcceptance,
  quoteAcceptanceBody,
  quoteAcceptanceStyle,
  quoteAcceptedEvent,
  quoteGmailMessageId,
  reminderSentEvent
} from "./quote-acceptance.mjs";

// Signatures come from tree.config.json owner.name; these tests use their own
// config so they pass in any tree.
{
  const fs = await import("node:fs");
  const os = await import("node:os");
  const pathModule = await import("node:path");
  const file = pathModule.join(fs.mkdtempSync(pathModule.join(os.tmpdir(), "quote-config-")), "tree.config.json");
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, owner: { name: "Test Owner" } }));
  process.env.TREE_CONFIG_PATH = file;
}

function quotedRequest() {
  const request = {
    schemaVersion: 1,
    id: "archive-quote",
    provider: "Archive",
    kind: "no-charge-email",
    items: [{ id: "item", targetId: "target", routeId: "route" }],
    spec: { channel: "email", recipient: "archive@example.org", subject: "Enquiry", body: "Hello" },
    guard: { requiredPhrase: "SUBMIT archive-quote", costMode: "no-charge" },
    revision: 0,
    events: []
  };
  request.payloadSha256 = externalRequestPayloadSha256(request);
  let next = appendExternalRequestEvent(request, {
    type: "authorization-confirmed", phrase: "SUBMIT archive-quote", payloadSha256: request.payloadSha256,
    at: "2026-10-01T00:00:00.000Z"
  });
  next = appendExternalRequestEvent(next, { type: "submission-started", at: "2026-10-01T00:01:00.000Z" });
  next = appendExternalRequestEvent(next, { type: "submission-confirmed", at: "2026-10-01T00:02:00.000Z" });
  next = appendExternalRequestEvent(next, { type: "fee-quoted", amount: 18, currency: "GBP", at: "2026-10-02T00:00:00.000Z" });
  return next;
}

function approve(request, amount = 18) {
  const fee = request.events.findLast((event) => event.type === "fee-quoted");
  return appendExternalRequestEvent(request, {
    type: "payment-authorized", phrase: `PAY ${request.id}`, amount, currency: fee.currency, feeEventId: fee.id,
    at: "2026-10-03T00:00:00.000Z"
  });
}

test("quoted amounts are written with the provider's currency", () => {
  assert.equal(formatQuotedAmount({ amount: 18, currency: "GBP" }), "£18.00");
  assert.equal(formatQuotedAmount({ amount: 9.92, currency: "GBP" }), "£9.92");
  assert.equal(formatQuotedAmount({ amount: 10, currency: "USD" }), "$10.00");
  assert.equal(formatQuotedAmount({ amount: 50, currency: "EUR" }), "€50.00");
  assert.equal(formatQuotedAmount({ amount: 5, currency: "CAD" }), "5.00 CAD");
});

test("only the exact PAY phrase approving the current quote can accept it, once", () => {
  const quoted = quotedRequest();
  assert.throws(() => planQuoteAcceptance(quoted, "PAY archive-quote"), /fee-quote-hold/);
  const approved = approve(quoted);
  assert.throws(() => planQuoteAcceptance(approved, "SUBMIT archive-quote"), /exactly: PAY archive-quote/);
  assert.throws(() => planQuoteAcceptance(approved, "PAY other-request"), /exactly: PAY archive-quote/);

  const plan = planQuoteAcceptance(approved, "PAY archive-quote");
  assert.match(plan.body, /go ahead with the work you quoted at £18\.00/);
  assert.match(plan.body, /card-payment link or an invoice/);
  assert.doesNotMatch(plan.body, /\d{4}|@/, "the reply carries no card, account or address data");

  const accepted = appendExternalRequestEvent(approved, { ...quoteAcceptedEvent(plan.fee, "PAY archive-quote"), at: "2026-10-04T00:00:00.000Z" });
  const derived = deriveExternalRequest(accepted);
  // Accepting the quote does not pay it: the route waits on the provider's
  // payment instructions, but the state never reads as a plain external wait.
  assert.equal(derived.operationalState, "awaiting-payment-instructions");
  assert.equal(derived.routeStatus, "pending-external-delivery");
  assert.equal(derived.quoteAccepted, true);
  assert.equal(derived.paymentRequested, false);
  assert.throws(() => planQuoteAcceptance(accepted, "PAY archive-quote"), /awaiting-payment-instructions/);
});

test("a quote acceptance must answer the approved, current quote", () => {
  const quoted = quotedRequest();
  const fee = quoted.events.at(-1);
  assert.throws(() => appendExternalRequestEvent(quoted, quoteAcceptedEvent(fee, "PAY archive-quote")),
    /requires a prior payment-authorized event/);
  const approved = approve(quoted);
  assert.throws(() => appendExternalRequestEvent(approved, quoteAcceptedEvent(fee, "SUBMIT archive-quote")),
    /exact PAY archive-quote phrase/);
  const requoted = appendExternalRequestEvent(approved, { type: "fee-quoted", amount: 30, currency: "GBP", at: "2026-10-05T00:00:00.000Z" });
  assert.equal(deriveExternalRequest(requoted).operationalState, "fee-quote-hold", "a larger quote needs a new decision");
  assert.throws(() => appendExternalRequestEvent(requoted, quoteAcceptedEvent(fee, "PAY archive-quote")), /superseded quote/);
});

test("the quote's own Gmail message ID is recovered from its recorded basis", () => {
  assert.equal(quoteGmailMessageId({ basis: "gmail-message-19f8f34b153e07bb" }), "19f8f34b153e07bb");
  assert.equal(quoteGmailMessageId({ basis: "Gmail archive reply 1a11ae70835c76d9, received 8 October 2026, clarifying 1a0fc5d57530fa67" }), "1a11ae70835c76d9");
  assert.equal(quoteGmailMessageId({ basis: "Gmail message 1a10209fff0bf2b0; reply received 3 October 2026" }), "1a10209fff0bf2b0");
  assert.equal(quoteGmailMessageId({ basis: "provider phone call" }), "");
  assert.equal(quoteGmailMessageId({}), "");
});

test("the acceptance follows the enquiry's language and the quote's payment method", () => {
  const italian = { spec: { subject: "Richiesta preventivo — Monreale", body: "Buongiorno,\nvorrei chiedere" } };
  const transfer = { amount: 50, currency: "EUR", note: "EUR 50 by bank transfer before any work begins" };
  assert.deepEqual(quoteAcceptanceStyle(italian, transfer), { language: "it", method: "transfer" });
  assert.deepEqual(quoteAcceptanceStyle({ spec: { subject: "Enquiry", body: "Hello" } }, { note: "Invoice and card-payment link" }), { language: "en", method: "card" });
  const body = quoteAcceptanceBody(transfer, { language: "it", method: "transfer" });
  assert.match(body, /al costo indicato di €50\.00/);
  assert.match(body, /intestatario, IBAN e BIC\/SWIFT/);
  assert.match(quoteAcceptanceBody(transfer, { method: "transfer" }), /account name, IBAN and BIC\/SWIFT/);
});

test("an accepted quote whose instructions never came is reminded after a week, never sooner, and the reminder changes no state", () => {
  const quoted = quotedRequest();
  const fee = quoted.events.at(-1);
  const approved = approve(quoted);
  assert.throws(() => planPaymentReminder(approved, "PAY archive-quote"), /paid-followup-authorized; a reminder is sent only/);
  const accepted = appendExternalRequestEvent(approved, { ...quoteAcceptedEvent(fee, "PAY archive-quote"), at: "2026-10-04T00:00:00.000Z" });
  assert.throws(() => planPaymentReminder(accepted, "PAY other-request"), /exactly: PAY archive-quote/);
  assert.throws(() => planPaymentReminder(accepted, "PAY archive-quote", { now: Date.parse("2026-10-09T00:00:00.000Z") }),
    /asked for its payment instructions 5 day\(s\) ago; a reminder waits 7 days/);
  const plan = planPaymentReminder(accepted, "PAY archive-quote", { now: Date.parse("2026-10-18T00:00:00.000Z") });
  assert.equal(plan.daysSince, 14);
  assert.match(plan.body, /my acceptance of your £18\.00 quote stands/);
  assert.match(plan.body, /card-payment link or invoice/);
  assert.doesNotMatch(plan.body, /\d{4}|@/, "the reminder carries no card, account or address data");
  const italian = paymentReminderBody({ amount: 50, currency: "EUR" }, { language: "it", method: "transfer" });
  assert.match(italian, /preventivo di €50\.00/);
  assert.match(italian, /intestatario, IBAN e BIC\/SWIFT/);

  const reminded = appendExternalRequestEvent(accepted, { ...reminderSentEvent(plan.fee, "PAY archive-quote"), at: "2026-10-18T00:00:00.000Z" });
  assert.equal(deriveExternalRequest(reminded).operationalState, "awaiting-payment-instructions", "a reminder changes no state");
  assert.throws(() => planPaymentReminder(reminded, "PAY archive-quote", { now: Date.parse("2026-10-20T00:00:00.000Z") }), /2 day\(s\) ago/,
    "the reminder itself restarts the waiting period");
  const invoiced = appendExternalRequestEvent(reminded, { type: "payment-requested", basis: "invoice", at: "2026-10-21T00:00:00.000Z" });
  assert.equal(deriveExternalRequest(invoiced).operationalState, "paid-followup-authorized");
  assert.throws(() => planPaymentReminder(invoiced, "PAY archive-quote", { now: Date.parse("2026-11-01T00:00:00.000Z") }), /paid-followup-authorized/);
});

test("an invoice or payment link for the accepted quote turns the wait into an authorized payment", () => {
  const quoted = quotedRequest();
  const fee = quoted.events.at(-1);
  const approved = approve(quoted);
  assert.throws(() => appendExternalRequestEvent(approved, { type: "payment-requested", at: "2026-10-03T12:00:00.000Z" }),
    /requires the approved quote to be accepted first/);
  const accepted = appendExternalRequestEvent(approved, { ...quoteAcceptedEvent(fee, "PAY archive-quote"), at: "2026-10-04T00:00:00.000Z" });
  const invoiced = appendExternalRequestEvent(accepted, { type: "payment-requested", basis: "invoice", at: "2026-10-05T00:00:00.000Z" });
  const derived = deriveExternalRequest(invoiced);
  assert.equal(derived.operationalState, "paid-followup-authorized");
  assert.equal(derived.routeStatus, "needs-interactive-payment");
  assert.equal(derived.paymentRequested, true);

  const paid = appendExternalRequestEvent(invoiced, { type: "payment-submitted", at: "2026-10-06T00:00:00.000Z" });
  assert.equal(deriveExternalRequest(paid).operationalState, "waiting-external", "a paid invoice returns to the provider's wait");

  const requoted = appendExternalRequestEvent(invoiced, { type: "fee-quoted", amount: 30, currency: "GBP", at: "2026-10-06T00:00:00.000Z" });
  assert.equal(deriveExternalRequest(requoted).operationalState, "fee-quote-hold", "an invoice never carries over to a larger quote");
  assert.throws(() => appendExternalRequestEvent(requoted, { type: "payment-requested", at: "2026-10-07T00:00:00.000Z" }),
    /superseded quote/);

  const unapproved = appendExternalRequestEvent(quotedRequest(), { type: "provider-acknowledged", at: "2026-10-03T00:00:00.000Z" });
  assert.throws(() => appendExternalRequestEvent(unapproved, { type: "payment-requested", at: "2026-10-04T00:00:00.000Z" }),
    /requires a prior payment-authorized event/);
});

test("a payment notice needs the exact SUBMIT phrase and a recorded payment, answers the payment request, and goes once", async () => {
  const { planPaymentNotice, paymentNoticeSentEvent } = await import("./quote-acceptance.mjs");
  const base = {
    id: "asdm-example", guard: { requiredPhrase: "SUBMIT asdm-example" },
    spec: { subject: "Richiesta di ricerca", body: "Buongiorno, ... Cordiali saluti" },
    events: [
      { type: "payment-requested", basis: "gmail-message-1a1ee6ed86e8ffa2", at: "2026-11-18T20:17:59Z" },
      { id: "e2", type: "payment-submitted", amount: 50, currency: "EUR", at: "2026-11-18T23:59:37Z" }
    ]
  };
  const options = { beneficiary: "Diocesi di Monreale", reference: "ricerche genealogiche personale Archivio" };
  const plan = planPaymentNotice(base, "SUBMIT asdm-example", options);
  assert.equal(plan.messageId, "1a1ee6ed86e8ffa2");
  assert.equal(plan.date, "2026-11-18");
  assert.match(plan.body, /in data 18\/11\/2026 ho effettuato il bonifico di € 50,00 a favore della Diocesi di Monreale, con causale "ricerche genealogiche personale Archivio"/);
  assert.doesNotMatch(plan.body, /IBAN|BIC|\bIT\d\d/);
  assert.throws(() => planPaymentNotice(base, "PAY asdm-example", options), /requires exactly/);
  assert.throws(() => planPaymentNotice({ ...base, events: base.events.slice(0, 1) }, "SUBMIT asdm-example", options), /no recorded payment/);
  const sent = { ...base, events: [...base.events, paymentNoticeSentEvent(plan, "SUBMIT asdm-example")] };
  assert.throws(() => planPaymentNotice(sent, "SUBMIT asdm-example", options), /already told/);
});
