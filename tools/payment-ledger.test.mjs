import assert from "node:assert/strict";
import test from "node:test";

import {
  appendExternalRequestEvent,
  deriveExternalRequest,
  externalRequestPayloadSha256
} from "./external-request-store.mjs";
import {
  automatedInvocation,
  buildPaymentLedger,
  classifyChannelText,
  formatLedgerHeadline,
  formatPaymentAttention,
  formatPaymentLedger,
  openPaymentStages,
  paymentChannel,
  providerMessageIds,
  providerReplyLookup,
  providerReplyUnavailable,
  summarizeLedger
} from "./payment-ledger.mjs";

const now = "2026-11-09T12:00:00.000Z";
const daysAgo = (days, hour = "09:00:00") => new Date(Date.parse(now) - days * 86_400_000).toISOString().slice(0, 10) + `T${hour}.000Z`;

function paidOrder(id, { provider = "General Register Office", maxAmount = 3, serviceOption = "GRO Online View digital image" } = {}) {
  const request = {
    schemaVersion: 1,
    id,
    provider,
    kind: "paid-order",
    items: [{ id: "item", targetId: id, routeId: id }],
    spec: { reference: "one exact entry", serviceOption },
    guard: { requiredPhrase: `PAY ${id}`, costMode: "maximum", maxAmount, currency: "GBP" },
    revision: 0,
    events: []
  };
  request.payloadSha256 = externalRequestPayloadSha256(request);
  return request;
}

function noChargeRequest(id, { provider = "Some County Society", kind = "no-charge-email" } = {}) {
  const request = {
    schemaVersion: 1,
    id,
    provider,
    kind,
    items: [{ id: "item", targetId: id, routeId: `${id}-inquiry` }],
    spec: { channel: "email", recipient: "archive@example.org", subject: "Enquiry", body: "Hello" },
    guard: { requiredPhrase: `SUBMIT ${id}`, costMode: "no-charge" },
    revision: 0,
    events: []
  };
  request.payloadSha256 = externalRequestPayloadSha256(request);
  return request;
}

const add = (request, event) => appendExternalRequestEvent(request, event);
const authorize = (request, at) => add(request, {
  type: "authorization-confirmed", phrase: request.guard.requiredPhrase, payloadSha256: request.payloadSha256, at
});
function quoted(request, { amount, currency, at, note = "", basis }) {
  let next = authorize(request, daysAgo(120));
  next = add(next, { type: "submission-started", at: daysAgo(120, "09:01:00") });
  next = add(next, { type: "submission-confirmed", at: daysAgo(120, "09:02:00") });
  return add(next, { type: "fee-quoted", amount, currency, note, at, ...(basis ? { basis } : {}) });
}
function approved(request, options) {
  const next = quoted(request, options);
  const fee = next.events.at(-1);
  return add(next, {
    type: "payment-authorized", phrase: `PAY ${request.id}`, amount: options.amount, currency: options.currency,
    feeEventId: fee.id, at: options.approvedAt || daysAgo(100)
  });
}

const liveQuestion = { id: "rq-live", schemaVersion: 2, lifecycle: "active", conclusion: { state: "unresolved" }, goalKeys: ["fact:rq-live"] };
const deferredQuestion = {
  id: "rq-deferred", schemaVersion: 2, lifecycle: "active", conclusion: { state: "unresolved" },
  deferred: true, dependsOnAssertionIds: ["assert-not-yet-established"], goalKeys: ["fact:rq-deferred"]
};
const target = (request, { questionIds = ["rq-live"], researchRole = "proof-blocking", routeStatus = "needs-interactive-payment", gate } = {}) => ({
  id: request.items[0].targetId,
  provider: request.provider,
  questionIds,
  researchRole,
  researchScope: "main",
  routes: [{
    id: request.items[0].routeId, targetId: request.items[0].targetId, status: routeStatus, requestId: request.id,
    requestProjection: { operationalState: deriveExternalRequest(request).operationalState, revision: request.revision },
    ...(gate ? { gate } : {})
  }]
});

function ledgerFor(requests, targets, questions = [liveQuestion, deferredQuestion]) {
  return buildPaymentLedger({ externalRequests: requests, acquisitionTargets: targets, questions }, { now, establishedAssertionIds: new Set() });
}

test("an authorized GRO Online View is due for the agent even when its question is deferred", () => {
  const request = authorize(paidOrder("gro-agnes-online-view"), daysAgo(4));
  const ledger = ledgerFor([request], [target(request, { questionIds: ["rq-deferred"] })]);
  assert.equal(ledger.entries.length, 1);
  const [entry] = ledger.entries;
  assert.equal(entry.stage, "authorized");
  assert.equal(entry.alarm, "DUE");
  assert.equal(entry.ageDays, 4);
  assert.deepEqual(entry.channel, { kind: "card-checkout", reviewed: true, profileId: "gro", driver: "-GroOrder" });
  assert.equal(entry.next.actor, "agent");
  assert.equal(entry.next.command, "npm run pay:win -- -Request gro-agnes-online-view -GroOrder");
  assert.match(entry.next.userStep, /security code/);
  assert.deepEqual(entry.hiddenFromRollup, ["no live question (deferred or closed)"]);
  assert.deepEqual(automatedInvocation(entry), {
    label: "npm run pay:win -- -Request gro-agnes-online-view -GroOrder",
    npmArgs: ["run", "pay:win", "--", "-Request", "gro-agnes-online-view", "-GroOrder"]
  });
  assert.match(formatPaymentAttention(ledger), /PAYMENT DUE 4 d gro-agnes-online-view — General Register Office up to £3\.00 — agent: npm run pay:win/);
});

test("a PAY phrase older than a week is stale, and a recovery-only target still shows", () => {
  const request = authorize(paidOrder("newspapers-obituary", { provider: "Kenosha Public Library", maxAmount: 10 }), daysAgo(106));
  const ledger = ledgerFor([request], [target(request, { questionIds: [], researchRole: "recovery-only" })]);
  const [entry] = ledger.entries;
  assert.equal(entry.stage, "authorized");
  assert.equal(entry.alarm, "STALE");
  assert.equal(entry.channel.kind, "unknown");
  assert.equal(entry.submitted, false);
  assert.equal(entry.next.actor, "agent", "an unknown channel is the agent's to identify, not the user's to pay");
  assert.match(entry.next.text, /never been placed/);
  assert.equal(automatedInvocation(entry), null, "nothing runs blind");
  assert.deepEqual(entry.hiddenFromRollup, ["target role recovery-only"]);
});

test("an accepted quote without recorded payment instructions is owed money, not a delivery wait", () => {
  let request = approved(noChargeRequest("asdm-archive", { provider: "Archivio Storico Diocesano" }), {
    amount: 50, currency: "EUR", at: daysAgo(104), approvedAt: daysAgo(12, "05:58:00"),
    note: "EUR 50 by bank transfer before any work begins; payment is by bank transfer, not card."
  });
  const fee = request.events.find((event) => event.type === "fee-quoted");
  request = add(request, { type: "quote-accepted", phrase: "PAY asdm-archive", feeEventId: fee.id, amount: 50, currency: "EUR", at: daysAgo(12, "05:59:00") });
  const derived = deriveExternalRequest(request);
  assert.equal(derived.operationalState, "awaiting-payment-instructions");
  assert.equal(derived.routeStatus, "pending-external-delivery");
  const ledger = ledgerFor([request], [target(request, { routeStatus: "pending-external-delivery" })]);
  const [entry] = ledger.entries;
  assert.equal(entry.stage, "awaiting-instructions");
  assert.equal(entry.ageDays, 12);
  assert.equal(entry.alarm, null, "two weeks have not passed");
  assert.equal(entry.channel.kind, "bank-transfer");
  assert.equal(entry.channel.reviewed, false);
  assert.match(entry.next.command, /archive:win:inspect-response -- -Request asdm-archive/);
  assert.match(entry.next.command, /--type payment-requested --expected-revision 6/);
  const later = buildPaymentLedger({ externalRequests: [request], acquisitionTargets: [target(request, { routeStatus: "pending-external-delivery" })], questions: [liveQuestion] },
    { now: daysAgo(-5), establishedAssertionIds: new Set() });
  assert.equal(later.entries[0].alarm, "CHASE");
  assert.match(later.entries[0].next.text, /accepted 17 days ago and the provider has sent no payment instructions: remind it/);
  assert.equal(later.entries[0].next.command, 'npm run archive:win:submit-inquiry -- -Target asdm-archive -Confirmation "PAY asdm-archive" -PaymentReminder');
  assert.deepEqual(automatedInvocation(later.entries[0]).npmArgs,
    ["run", "archive:win:submit-inquiry", "--", "-Target", "asdm-archive", "-Confirmation", "PAY asdm-archive", "-PaymentReminder"],
    "the reminder is automated only once the chase alarm fires");
  const read = automatedInvocation(entry);
  assert.equal(read.kind, "inspect", "before the alarm the agent reads the thread itself");
  assert.equal(read.readOnly, true);
  assert.deepEqual(read.npmArgs, ["run", "archive:win:inspect-response", "--", "-Request", "asdm-archive"]);
  assert.deepEqual(read.lookup.queries, ["Archivio Storico Diocesano", "Archivio Storico"]);

  // A sent reminder restarts the chase clock.
  const reminded = add(request, { type: "reminder-sent", phrase: "PAY asdm-archive", feeEventId: fee.id, basis: "verified-Gmail-thread-reply", at: daysAgo(2) });
  const [afterReminder] = ledgerFor([reminded], [target(reminded, { routeStatus: "pending-external-delivery" })]).entries;
  assert.equal(afterReminder.stage, "awaiting-instructions");
  assert.equal(afterReminder.ageDays, 2);
  assert.equal(afterReminder.alarm, null);
});

test("recorded instructions for a reviewed bank-transfer beneficiary make the Wise helper the next step", () => {
  let request = approved(noChargeRequest("hunts-clarification", { provider: "Huntingdonshire Archives" }), {
    amount: 18, currency: "GBP", at: daysAgo(30), approvedAt: daysAgo(12)
  });
  const fee = request.events.find((event) => event.type === "fee-quoted");
  request = add(request, { type: "quote-accepted", phrase: "PAY hunts-clarification", feeEventId: fee.id, amount: 18, currency: "GBP", at: daysAgo(12, "10:00:00") });
  request = add(request, { type: "payment-requested", basis: "payment options attached", at: daysAgo(6) });
  const [entry] = ledgerFor([request], [target(request)]).entries;
  assert.equal(entry.stage, "authorized");
  assert.equal(entry.instructionsRecorded, true);
  assert.deepEqual(entry.channel, { kind: "bank-transfer", reviewed: true, profileId: "huntingdonshire", driver: "wise" });
  assert.equal(entry.next.command, "npm run transfer:win -- -Request hunts-clarification");
  assert.match(entry.next.userStep, /Send now/);
  assert.deepEqual(automatedInvocation(entry).npmArgs, ["run", "transfer:win", "--", "-Request", "hunts-clarification"]);
  const paid = add(add(request, { type: "payment-started", amount: 18, currency: "GBP", at: daysAgo(5) }),
    { type: "payment-submitted", amount: 18, currency: "GBP", at: daysAgo(5, "09:05:00") });
  const [paidEntry] = ledgerFor([paid], [target(paid, { routeStatus: "pending-external-delivery" })]).entries;
  assert.equal(paidEntry.stage, "paid");
  assert.equal(paidEntry.alarm, null);
  assert.equal(paidEntry.deliveryAlarmDays, 45);
  assert.equal(paidEntry.next.actor, "provider");
  assert.equal(paidEntry.next.token, "RECEIVED hunts-clarification");
});

test("a provider that takes only a mailed cheque hands the user an exact PAID step", () => {
  const request = approved(noChargeRequest("county-row", { provider: "County Register of Wills", kind: "no-charge-form" }), {
    amount: 10, currency: "USD", at: daysAgo(105), approvedAt: daysAgo(100),
    note: "Send a check or money order payable to the Register of Wills with the request."
  });
  const [entry] = ledgerFor([request], [target(request)]).entries;
  assert.equal(entry.stage, "authorized");
  assert.equal(entry.channel.kind, "mail");
  assert.equal(entry.next.actor, "user");
  assert.equal(entry.next.token, "PAID county-row");
  assert.match(entry.next.text, /post \(cheque or money order\)/);
  assert.equal(automatedInvocation(entry), null);
});

test("a started payment without a result must be reconciled before anything retries", () => {
  let request = approved(noChargeRequest("archive-card"), { amount: 10, currency: "GBP", at: daysAgo(10), approvedAt: daysAgo(9) });
  request = add(request, { type: "payment-started", amount: 10, currency: "GBP", at: daysAgo(1) });
  const [entry] = ledgerFor([request], [target(request, { routeStatus: "request-conflict-hold" })]).entries;
  assert.equal(entry.stage, "in-flight");
  assert.equal(entry.alarm, "RECONCILE");
  assert.match(entry.next.text, /nothing pays twice/);
  const declined = add(request, { type: "payment-retryable", basis: "declined", at: daysAgo(0, "11:00:00") });
  const [retry] = ledgerFor([declined], [target(declined)]).entries;
  assert.equal(retry.stage, "retryable");
  assert.equal(retry.alarm, "RETRY");
});

test("a paid GRO certificate is overdue after four weeks and an Online View after a day", () => {
  const certificate = add(authorize(paidOrder("gro-certificate", { maxAmount: 12.5, serviceOption: "standard certificate" }), daysAgo(118)),
    { type: "submission-confirmed", basis: "GRO-order-history", at: daysAgo(117) });
  const view = add(authorize(paidOrder("gro-view"), daysAgo(3)), { type: "submission-confirmed", basis: "guarded-card-payment", at: daysAgo(2) });
  const recent = add(authorize(paidOrder("gro-recent", { maxAmount: 12.5, serviceOption: "standard certificate" }), daysAgo(13)),
    { type: "submission-confirmed", basis: "GRO-order-history", at: daysAgo(12) });
  const requests = [certificate, view, recent];
  const ledger = ledgerFor(requests, requests.map((request) => target(request, { routeStatus: "pending-external-delivery" })));
  const byId = Object.fromEntries(ledger.entries.map((entry) => [entry.requestId, entry]));
  assert.equal(byId["gro-certificate"].stage, "paid");
  assert.equal(byId["gro-certificate"].alarm, "OVERDUE");
  assert.equal(byId["gro-certificate"].deliveryAlarmDays, 28);
  assert.match(byId["gro-certificate"].next.text, /Paid 117 days ago/);
  assert.deepEqual(automatedInvocation(byId["gro-certificate"]).npmArgs, ["run", "gro:win:check-orders", "--", "-Target", "gro-certificate"]);
  assert.equal(byId["gro-view"].alarm, "OVERDUE");
  assert.equal(byId["gro-view"].deliveryAlarmDays, 1);
  assert.equal(byId["gro-recent"].alarm, null);
  assert.equal(automatedInvocation(byId["gro-recent"]), null, "a delivery within its window is not chased");
  assert.equal(ledger.summary.overdueDeliveryCount, 2);
});

test("a quote without a PAY phrase is the user's decision; an explicit provider hold is re-checked", () => {
  const quoteOnly = quoted(noChargeRequest("archive-quote", { provider: "Staffordshire Record Office" }), { amount: 9.5, currency: "GBP", at: daysAgo(38) });
  const [quote] = ledgerFor([quoteOnly], [target(quoteOnly, { routeStatus: "request-conflict-hold" })]).entries;
  assert.equal(quote.stage, "quoted");
  assert.equal(quote.alarm, "DECIDE");
  assert.equal(quote.next.actor, "user");
  assert.equal(quote.next.token, "PAY archive-quote");

  const held = approved(noChargeRequest("library-pagopa", { provider: "Biblioteca nazionale" }), {
    amount: 4.5, currency: "EUR", at: daysAgo(41), approvedAt: daysAgo(40), note: "pay via pagoPA, then send the receipt"
  });
  const [hold] = ledgerFor([held], [target(held, {
    gate: { actor: "external", type: "delivery", state: "active", title: "checkout status pending", resumeToken: "RECEIVED library-pagopa" }
  })]).entries;
  assert.equal(hold.stage, "provider-processing");
  assert.equal(hold.alarm, "RECHECK");
  assert.equal(hold.channel.kind, "pagopa");
  assert.deepEqual(hold.hiddenFromRollup, ["explicit external hold"]);
  assert.match(hold.next.command, /pagoPA purchase history/);
});

test("delivered and cancelled requests leave the open ledger; the headline counts what is owed", () => {
  const delivered = add(add(add(authorize(paidOrder("gro-done"), daysAgo(9)), { type: "submission-confirmed", at: daysAgo(9, "09:01:00") }),
    { type: "delivery-reported", at: daysAgo(9, "09:02:00") }), { type: "delivery-item-imported", itemId: "item", routeStatus: "acquired", at: daysAgo(9, "09:03:00") });
  const complete = add(delivered, { type: "delivery-complete", at: daysAgo(9, "09:04:00") });
  const cancelled = add(authorize(paidOrder("gro-cancelled"), daysAgo(9)), { type: "cancelled", at: daysAgo(8) });
  const plain = authorize(noChargeRequest("free-enquiry"), daysAgo(3));
  const due = authorize(paidOrder("gro-due"), daysAgo(4));
  const requests = [complete, cancelled, plain, due];
  const ledger = ledgerFor(requests, requests.map((request) => target(request)));
  assert.deepEqual(ledger.entries.map((entry) => [entry.requestId, entry.stage]), [
    ["gro-due", "authorized"], ["gro-done", "delivered"], ["gro-cancelled", "cancelled"]
  ], "a request without any fee is not a payment");
  assert.equal(ledger.summary.openCount, 1);
  assert.equal(ledger.summary.dueCount, 1);
  assert.deepEqual(openPaymentStages.includes("delivered"), false);
  const text = formatPaymentLedger(ledger);
  assert.match(text, /^Payments: 1 authorized but not executed \(oldest 4 d\)/);
  assert.doesNotMatch(text, /gro-done|gro-cancelled/);
  assert.match(formatPaymentLedger(ledger, { includeClosed: true }), /gro-done/);
  assert.equal(formatLedgerHeadline(summarizeLedger([])), "Payments: nothing authorized, quoted or paid is outstanding.");
});

test("a recorded Gmail message id lets the inspector open the provider's exact reply", () => {
  const request = approved(noChargeRequest("society-quote", { provider: "County Historical Society", kind: "no-charge-form" }), {
    amount: 10, currency: "USD", at: daysAgo(105), approvedAt: daysAgo(100)
  });
  request.events.find((event) => event.type === "fee-quoted").basis = "gmail-message-19f8f34b153e07bb";
  const [entry] = ledgerFor([request], [target(request)]).entries;
  assert.deepEqual(entry.providerMessageIds, ["19f8f34b153e07bb"]);
  assert.match(entry.next.command, /^npm run archive:win:inspect-response -- -Request society-quote -MessageId 19f8f34b153e07bb/);
  assert.deepEqual(providerMessageIds({ events: [
    { type: "fee-quoted", basis: "Gmail reply 1a0fc5d57530fa67; thread 1a0f8a6f30d7a08a." },
    { type: "payment-requested", basis: "Gmail message 1a186ed01e03da36 (29 Oct 2026)" }
  ] }), ["1a186ed01e03da36", "1a0fc5d57530fa67"], "newest message first; a bare thread id is not a message");
  assert.deepEqual(providerMessageIds({ events: [{ type: "fee-quoted", note: "USD 10 per scan" }] }), []);
});

test("the channel is read from the provider's own words, and a reviewed profile always wins", () => {
  assert.equal(paymentChannel({ provider: "Maryland State Archives", events: [] }).driver, "-MsaOrder");
  assert.equal(paymentChannel({ provider: "The National Archives", events: [] }).driver, "-TnaPageCheck");
  assert.equal(paymentChannel({ provider: "Ancestry", events: [] }).driver, "-AncestryMembership", "never a bare checkout URL");
  assert.equal(paymentChannel({ provider: "Norris Museum", events: [] }).driver, "gmail-link");
  assert.equal(paymentChannel({ provider: "Huntingdonshire Archives", events: [{ type: "fee-quoted", note: "pay by PayPal" }] }).kind, "bank-transfer", "the reviewed beneficiary outranks a note");
  assert.equal(paymentChannel({ provider: "X", events: [{ type: "fee-quoted", note: "Pay via PayPal link" }] }).kind, "paypal");
  assert.equal(paymentChannel({ provider: "X", events: [{ type: "fee-quoted", note: "call us by telephone with a card" }] }).kind, "phone");
  assert.equal(paymentChannel({ provider: "X", events: [{ type: "fee-quoted", note: "We will send an invoice with a payment link" }] }).kind, "web-link");
  assert.equal(paymentChannel({ provider: "X", events: [{ type: "fee-quoted", note: "USD 10 per scan" }] }).kind, "unknown");
});

test("a provider reply that is gone from the shared mailbox hands the step to the user, and a newer provider message takes it back", () => {
  const request = approved(noChargeRequest("lchs-tabor", { provider: "Lebanon County Historical Society", kind: "no-charge-form" }), {
    amount: 10, currency: "USD", at: daysAgo(109), approvedAt: daysAgo(105),
    note: "One digital scan of the exact register page for USD 10.", basis: "gmail-message-19f8f34b153e07bb"
  });
  const [before] = ledgerFor([request], [target(request)]).entries;
  assert.equal(before.stage, "authorized");
  assert.equal(before.alarm, "STALE");
  assert.equal(before.channel.kind, "unknown");
  assert.equal(before.next.actor, "agent");
  const read = automatedInvocation(before);
  assert.equal(read.kind, "inspect", "a submitted request with an unknown channel has its thread read by the dispatcher");
  assert.deepEqual(read.npmArgs, ["run", "archive:win:inspect-response", "--", "-Request", "lchs-tabor", "-MessageId", "19f8f34b153e07bb"]);
  assert.deepEqual(read.lookup.queries, ["Lebanon County Historical Society", "Lebanon County"]);
  const event = read.lookup.event("2026-11-09T22:00:00.000Z");
  assert.equal(event.type, "provider-message-unavailable");
  assert.equal(event.basis, 'gmail-message-19f8f34b153e07bb not in the shared mailbox on 2026-11-09; in:anywhere "Lebanon County Historical Society", "Lebanon County" matched 0 threads');
  assert.match(event.note, /^Lebanon County Historical Society's message could not be opened or found/);

  const recorded = add(request, { ...event, at: daysAgo(0, "10:00:00") });
  assert.equal(deriveExternalRequest(recorded).operationalState, deriveExternalRequest(request).operationalState, "the event is informational");
  assert.deepEqual(providerReplyUnavailable(recorded), { at: daysAgo(0, "10:00:00"), basis: event.basis, note: event.note });
  const ledger = ledgerFor([recorded], [target(recorded)]);
  const [after] = ledger.entries;
  assert.equal(after.stage, "authorized");
  assert.equal(after.alarm, "LOCATE");
  assert.equal(after.ageDays, 105, "the money has been owed since the PAY phrase, whatever the mailbox did");
  assert.equal(after.next.actor, "user");
  assert.equal(after.next.token, null);
  assert.match(after.next.text, /Lebanon County Historical Society's reply \(Gmail message 19f8f34b153e07bb\) is no longer in the shared mailbox \(checked 2026-11-09: not in any folder, spam or bin\), so the agent cannot read how it takes payment and the authorized \$10\.00 cannot move/);
  assert.match(after.next.userStep, /^forward the provider's reply \(Gmail 19f8f34b153e07bb\) to the shared Gmail account, state how Lebanon County Historical Society takes payment, or say "re-ask"/);
  assert.equal(automatedInvocation(after), null, "nothing runs against a thread that is gone");
  assert.equal(ledger.summary.locateCount, 1);
  assert.equal(ledger.summary.userActionCount, 1);
  assert.match(formatLedgerHeadline(ledger.summary), /1 provider reply missing from the shared mailbox \(the user locates it\)/);
  assert.match(formatPaymentAttention(ledger), /PAYMENT LOCATE 105 d lchs-tabor — Lebanon County Historical Society \$10\.00 — USER: forward the provider's reply \(Gmail 19f8f34b153e07bb\)/);
  assert.doesNotMatch(formatPaymentLedger(ledger), /token:/, "no token is promised where none applies");

  const replied = add(recorded, {
    type: "provider-acknowledged", basis: "gmail-message-1a1b2c3d4e5f6a7b", at: daysAgo(0, "11:00:00"),
    note: "Please mail a check payable to the Society with the request."
  });
  const [cleared] = ledgerFor([replied], [target(replied)]).entries;
  assert.equal(providerReplyUnavailable(replied), null);
  assert.equal(cleared.alarm, "STALE");
  assert.equal(cleared.channel.kind, "mail");
  assert.equal(cleared.next.actor, "user");
  assert.match(cleared.next.text, /post \(cheque or money order\)/);
});

test("a missing thread changes nothing for a reviewed route, and a paid delivery only once it is overdue", () => {
  const gro = add(authorize(paidOrder("gro-reviewed"), daysAgo(3)), {
    type: "provider-message-unavailable", basis: "nothing to read", at: daysAgo(1)
  });
  const [groEntry] = ledgerFor([gro], [target(gro)]).entries;
  assert.equal(groEntry.alarm, "DUE", "the GRO checkout needs no thread");
  assert.equal(groEntry.next.command, "npm run pay:win -- -Request gro-reviewed -GroOrder");

  let archive = approved(noChargeRequest("archive-paid", { provider: "County Archive" }), { amount: 20, currency: "GBP", at: daysAgo(40), approvedAt: daysAgo(30) });
  const fee = archive.events.find((event) => event.type === "fee-quoted");
  archive = add(archive, { type: "quote-accepted", phrase: "PAY archive-paid", feeEventId: fee.id, amount: 20, currency: "GBP", at: daysAgo(30, "10:00:00") });
  archive = add(archive, { type: "payment-requested", basis: "gmail-message-1a1b2c3d4e5f6a7c", note: "card link", at: daysAgo(29) });
  archive = add(archive, { type: "payment-started", amount: 20, currency: "GBP", at: daysAgo(28) });
  archive = add(archive, { type: "payment-submitted", amount: 20, currency: "GBP", at: daysAgo(28, "09:05:00") });
  archive = add(archive, { type: "provider-message-unavailable", basis: "gmail-message-1a1b2c3d4e5f6a7c not in the shared mailbox", at: daysAgo(1) });
  const routeStatus = "pending-external-delivery";
  const [recent] = ledgerFor([archive], [target(archive, { routeStatus })]).entries;
  assert.equal(recent.stage, "paid");
  assert.equal(recent.alarm, null, "within the delivery window the provider is still acting");
  const overdue = buildPaymentLedger({ externalRequests: [archive], acquisitionTargets: [target(archive, { routeStatus })], questions: [liveQuestion] },
    { now: daysAgo(-20), establishedAssertionIds: new Set() }).entries[0];
  assert.equal(overdue.alarm, "LOCATE");
  assert.equal(overdue.next.actor, "user");
  assert.equal(overdue.next.token, "RECEIVED archive-paid");
  assert.match(overdue.next.text, /cannot see whether the paid delivery was sent/);
});

test("an overdue posted GRO certificate says the post and the order-history limit and keeps the user's RECEIVED answer", () => {
  let request = authorize(paidOrder("gro-david-cert", { maxAmount: 12.5, serviceOption: "standard certificate" }), daysAgo(118));
  request = add(request, { type: "submission-confirmed", basis: "GRO-order-history", at: daysAgo(117) });
  const [entry] = ledgerFor([request], [target(request, { routeStatus: "pending-external-delivery" })]).entries;
  assert.equal(entry.stage, "paid");
  assert.equal(entry.alarm, "OVERDUE");
  assert.equal(entry.deliveryAlarmDays, 28);
  assert.equal(entry.next.actor, "provider");
  assert.equal(entry.next.token, "RECEIVED gro-david-cert");
  assert.match(entry.next.text, /the paper certificate is posted to the user, and GRO's order history lists an order only for a limited time/);
  assert.match(entry.next.text, /only the user can say whether it arrived: RECEIVED gro-david-cert, or "not arrived"/);
  assert.deepEqual(automatedInvocation(entry), { label: "npm run gro:win:check-orders -- -Target gro-david-cert", npmArgs: ["run", "gro:win:check-orders", "--", "-Target", "gro-david-cert"], readOnly: true });
  const fresh = ledgerFor([authorize(paidOrder("gro-fresh-cert", { maxAmount: 12.5, serviceOption: "standard certificate" }), daysAgo(2))], []).entries[0];
  assert.equal(fresh.stage, "authorized", "an unsubmitted certificate order is simply due");
});

test("the provider's words classify the channel with the phrase that matched", () => {
  assert.deepEqual(classifyChannelText("Please send a check payable to the Register of Wills."), { kind: "mail", match: "send a check" });
  assert.deepEqual(classifyChannelText("Pay online with a credit card at the link below."), { kind: "web-link", match: "Pay online" });
  assert.deepEqual(classifyChannelText("We will advise."), { kind: "unknown", match: null });
  assert.deepEqual(providerReplyLookup({ provider: "University of Wisconsin-Parkside Archives & Area Research Center", providerMessageIds: [] }).queries,
    ["University of Wisconsin-Parkside Archives Area Research Center", "University of"]);
  assert.match(providerReplyLookup({ provider: "Norris Museum", providerMessageIds: [] }).event("2026-11-10T01:00:00.000Z").basis,
    /^the bound provider thread not in the shared mailbox on 2026-11-10; in:anywhere "Norris Museum" matched 0 threads$/);
});

test("a started GRO order without a recorded result is settled from its own order history", () => {
  let request = authorize(paidOrder("gro-started-online-view"), daysAgo(5));
  request = add(request, { type: "submission-started", at: daysAgo(0, "08:08:56"), basis: "guarded-card-payment https://payments.worldpay.com/app/hpp/174-0/payment/start" });
  const ledger = ledgerFor([request], [target(request)]);
  const [entry] = ledger.entries;
  assert.equal(entry.stage, "in-flight");
  assert.deepEqual(automatedInvocation(entry), {
    label: "npm run gro:win:check-orders -- -Target gro-started-online-view",
    npmArgs: ["run", "gro:win:check-orders", "--", "-Target", "gro-started-online-view"],
    readOnly: true,
    kind: "gro-reconcile"
  });
});

test("a provider asking to be sent a check reads as payment by mail", () => {
  assert.equal(classifyChannelText("You can send the $10 per name fee and we will get back to you, you can send us a blank check \"not to exceed\" a certain amount").kind, "mail");
  assert.equal(classifyChannelText("Channel: a mailed check to the Register of Wills").kind, "mail");
  assert.equal(classifyChannelText("check the index first").kind, "unknown");
});

test("an overdue web order points at the provider's own order history, not the email inspector", () => {
  let request = authorize(paidOrder("tna-page-check", { provider: "The National Archives", maxAmount: 10, serviceOption: "page check" }), daysAgo(25));
  request = add(request, { type: "submission-started", at: daysAgo(25, "09:01:00") });
  request = add(request, { type: "submission-confirmed", at: daysAgo(25, "09:02:00") });
  const ledger = ledgerFor([request], [target(request, { routeStatus: "pending-external" })]);
  const [entry] = ledger.entries;
  assert.equal(entry.stage, "paid");
  assert.equal(entry.alarm, "OVERDUE");
  assert.match(entry.next.command, /^Check The National Archives's own account order history read-only/);
  assert.doesNotMatch(entry.next.command, /^npm run archive:win:inspect-response/);
  assert.equal(automatedInvocation(entry), null, "the email-thread inspector refuses web orders, so nothing runs");
});
