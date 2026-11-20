import crypto from "node:crypto";

export const externalRequestKinds = new Set([
  "no-charge-email",
  "no-charge-form",
  "paid-order",
  "paid-library-request"
]);

export const externalRequestEventTypes = new Set([
  "authorization-confirmed",
  "access-confirmed",
  "submission-started",
  "submission-confirmed",
  "submission-uncertain",
  "submission-retryable",
  // A recorded confirmation turned out to belong to something else (the
  // provider's order list showed a new order, but it was not this item). The
  // request is back to having placed nothing, and the approval that was spent
  // on the wrong thing is spent: a new submission needs the exact phrase again.
  "submission-voided",
  "provider-acknowledged",
  "fee-quoted",
  "payment-authorized",
  "quote-accepted",
  "payment-requested",
  // A reminder sent in the provider's thread for payment instructions that
  // have not arrived; informational, it changes no state but re-arms the
  // payment ledger's chase clock.
  "reminder-sent",
  // A note sent in the provider's thread, on the exact SUBMIT phrase, that a
  // requested payment has been made (date, amount, reference; never bank
  // details). Informational: it changes no state.
  "payment-notice-sent",
  // The provider message a recorded basis names (a Gmail id or bound subject)
  // could not be opened or found anywhere in the shared mailbox; informational,
  // it changes no state but hands the payment ledger's next step to the user
  // (forward a copy, state the channel, or authorize a fresh enquiry) until a
  // newer provider message is recorded.
  "provider-message-unavailable",
  // The inbox sweep found a provider message in the request's bound thread that
  // no recorded event cites yet. Informational: it changes no operational
  // state (a quote, payment or information gate stays exactly as it was), but
  // it marks the reply as untriaged until a later classification event is
  // recorded, so the acquisition queue hands it to the research loop instead
  // of leaving it in the inbox until someone notices.
  "provider-reply-received",
  "payment-started",
  "payment-retryable",
  "payment-submitted",
  "delivery-reported",
  "provider-information-required",
  "provider-information-supplied",
  "delivery-item-imported",
  "delivery-complete",
  "cancelled",
  "conflict-detected",
  "conflict-resolved"
]);

const completedItemRouteStatuses = new Set([
  "acquired",
  "archived-control",
  "duplicate",
  "not-found",
  "preserved-withheld",
  "published",
  "resolved-index-only"
]);

export function externalRequestPayload(request) {
  return {
    provider: request.provider,
    kind: request.kind,
    items: request.items,
    spec: request.spec,
    guard: {
      requiredPhrase: request.guard?.requiredPhrase,
      costMode: request.guard?.costMode,
      ...(request.guard?.currency ? { currency: request.guard.currency } : {}),
      ...(Number.isFinite(request.guard?.maxAmount) ? { maxAmount: request.guard.maxAmount } : {})
    }
  };
}

export function externalRequestPayloadSha256(request) {
  return crypto.createHash("sha256").update(stableJson(externalRequestPayload(request))).digest("hex");
}

// Events that report on the thread without classifying a provider reply: they
// must not clear an untriaged reply.
const replyNeutralEventTypes = new Set(["provider-reply-received", "reminder-sent", "payment-notice-sent", "provider-message-unavailable"]);

// Gmail message ids of provider replies the inbox sweep recorded that no later
// classification event has answered yet.
// The Gmail message id of the provider's outstanding question (the basis of
// the latest unanswered provider-information-required event), so a
// clarification answers that exact message even when several threads share
// the request's subject.
export function outstandingQuestionMessageId(request) {
  const events = request?.events || [];
  const asked = events.findLastIndex((event) => event.type === "provider-information-required");
  const answered = events.findLastIndex((event) => event.type === "provider-information-supplied");
  if (asked < 0 || answered > asked) return "";
  return /gmail-message-([0-9a-f]{16})\b/.exec(String(events[asked].basis || ""))?.[1] || "";
}

export function untriagedReplyIds(request) {
  const events = [...(request.events || [])].sort(compareEvents);
  let pending = [];
  for (const event of events) {
    if (event.type === "provider-reply-received") {
      if (event.messageId && !pending.includes(event.messageId)) pending.push(event.messageId);
    } else if (!replyNeutralEventTypes.has(event.type)) {
      pending = [];
    }
  }
  return pending;
}

// The revision a request had at its last classification. Reply-neutral events
// (a detected reply, a sent reminder, an unavailable-message note) append
// revisions without changing what the request means, so contracts that pin a
// reviewed revision accept any revision in [classifiedRevision, revision].
export function externalRequestRevisionWindow(request) {
  const events = [...(request.events || [])].sort(compareEvents);
  let trailingNeutral = 0;
  for (let index = events.length - 1; index >= 0 && replyNeutralEventTypes.has(events[index].type); index -= 1) trailingNeutral += 1;
  const revision = request.revision ?? events.length;
  return { revision, classifiedRevision: Math.max(0, revision - trailingNeutral) };
}

export function pinnedRevisionMatches(window, pinnedRevision) {
  if (!window || !Number.isInteger(pinnedRevision)) return false;
  const low = window.classifiedRevision ?? window.revision;
  return pinnedRevision >= low && pinnedRevision <= window.revision;
}

export function deriveExternalRequest(request, itemId) {
  const derived = deriveExternalRequestState(request, itemId);
  const untriaged = ["complete", "cancelled"].includes(derived.operationalState) ? [] : untriagedReplyIds(request);
  return { ...derived, untriagedReplyIds: untriaged };
}

function deriveExternalRequestState(request, itemId) {
  const payloadSha256 = externalRequestPayloadSha256(request);
  const events = [...(request.events || [])].sort(compareEvents);
  let authorization = null;
  let accessConfirmed = false;
  let started = false;
  let confirmed = false;
  let uncertain = false;
  let conflict = false;
  let cancelled = false;
  let fee = null;
  let paymentAuthorization = null;
  let paymentSubmittedFeeEventId = "";
  let quoteAcceptedFeeEventId = "";
  let paymentInFlight = false;
  let paymentRequestedFeeEventId = "";
  let delivered = false;
  let informationRequired = false;
  let complete = false;
  const importedItemIds = new Set();

  for (const event of events) {
    if (event.type === "authorization-confirmed") authorization = event;
    if (event.type === "access-confirmed") accessConfirmed = true;
    if (event.type === "submission-started") started = true;
    if (["submission-confirmed", "provider-acknowledged"].includes(event.type)) {
      confirmed = true;
      uncertain = false;
    }
    // Acknowledgement-only replies are useful deliveries to inspect, but they do
    // not contain the requested result. Once classified, resume monitoring the
    // already-confirmed request instead of leaving it stuck in ready-download.
    if (event.type === "provider-acknowledged") delivered = false;
    if (event.type === "submission-uncertain") uncertain = true;
    if (event.type === "submission-retryable") {
      started = false;
      uncertain = false;
    }
    if (event.type === "submission-voided") {
      started = false;
      uncertain = false;
      confirmed = false;
      authorization = null;
    }
    if (event.type === "fee-quoted") fee = event;
    // A payment approval and a placed payment are both bound to the exact quote
    // they answer, so a later or larger quote silently invalidates neither: it
    // stops matching, and the request falls back to a fresh payment decision.
    if (event.type === "payment-authorized") paymentAuthorization = event;
    if (event.type === "quote-accepted") quoteAcceptedFeeEventId = event.feeEventId || "";
    // The provider has answered an accepted quote with its invoice or
    // card-payment link: the next step is the requester's payment, not theirs.
    if (event.type === "payment-requested") paymentRequestedFeeEventId = paymentAuthorization?.feeEventId || "";
    // A pay click is bracketed: started before the click, then submitted or
    // retryable once the provider shows a result. A started payment with no
    // result is held for review so a rerun can never pay twice.
    if (event.type === "payment-started") paymentInFlight = true;
    if (["payment-submitted", "payment-retryable"].includes(event.type)) paymentInFlight = false;
    if (event.type === "payment-submitted") paymentSubmittedFeeEventId = paymentAuthorization?.feeEventId || "";
    if (event.type === "delivery-reported") delivered = true;
    if (event.type === "provider-information-required") {
      informationRequired = true;
      delivered = false;
    }
    if (event.type === "provider-information-supplied") {
      informationRequired = false;
      delivered = false;
    }
    if (event.type === "delivery-item-imported" && event.itemId) importedItemIds.add(event.itemId);
    if (event.type === "delivery-complete") complete = true;
    if (event.type === "cancelled") cancelled = true;
    if (event.type === "conflict-detected") conflict = true;
    if (event.type === "conflict-resolved") {
      conflict = false;
      uncertain = false;
      started = false;
    }
  }

  const authorizationValid = authorization?.payloadSha256 === payloadSha256;
  if (cancelled) return state("cancelled", "duplicate", { payloadSha256, authorizationValid });
  if (conflict || uncertain || (started && !confirmed) || paymentInFlight) {
    return state("conflict-hold", "request-conflict-hold", { payloadSha256, authorizationValid });
  }
  if (complete) {
    const importedItem = itemId
      ? [...events].reverse().find((event) => event.type === "delivery-item-imported" && event.itemId === itemId)
      : null;
    return state("complete", importedItem?.routeStatus || "acquired", {
      payloadSha256,
      authorizationValid,
      importedItemIds: [...importedItemIds]
    });
  }
  if (accessConfirmed && authorizationValid && request.kind === "paid-order") {
    return state("access-confirmed", "ready-subscription-capture", { payloadSha256, authorizationValid });
  }
  if (informationRequired) return state("information-required", "needs-requester-information", { payloadSha256, authorizationValid });
  if (delivered) return state("delivery-reported", "ready-download", { payloadSha256, authorizationValid, importedItemIds: [...importedItemIds] });
  if (fee && !request.kind.startsWith("paid-")) {
    // A no-charge request that came back with a fee cannot become a paid one on
    // its original authorization. It needs a separate approval of that exact
    // quote, and then a separately recorded payment, before it is waiting on
    // the provider again.
    const approvesCurrentQuote = paymentAuthorization?.feeEventId === fee.id;
    if (approvesCurrentQuote && paymentSubmittedFeeEventId === fee.id) {
      return state("waiting-external", "pending-external-delivery", {
        payloadSha256,
        authorizationValid,
        fee,
        paymentAuthorization
      });
    }
    // The approved quote was accepted in the provider's thread; the provider
    // now owes payment instructions (an invoice or a card-payment link).
    if (approvesCurrentQuote && quoteAcceptedFeeEventId === fee.id && paymentRequestedFeeEventId === fee.id) {
      return state("paid-followup-authorized", "needs-interactive-payment", {
        payloadSha256,
        authorizationValid,
        fee,
        paymentAuthorization,
        quoteAccepted: true,
        paymentRequested: true
      });
    }
    // The approved quote was accepted in the provider's thread, but no payment
    // instructions (an invoice, a card link, bank details) are on record yet.
    // The route still waits on the provider, yet the money is still owed by
    // the requester, so this is never plain "waiting-external": the payment
    // ledger and the rollup keep saying that a payment is pending. The
    // instructions may already sit in the quote message itself; recording
    // payment-requested against that message is what moves this on.
    if (approvesCurrentQuote && quoteAcceptedFeeEventId === fee.id) {
      return state("awaiting-payment-instructions", "pending-external-delivery", {
        payloadSha256,
        authorizationValid,
        fee,
        paymentAuthorization,
        quoteAccepted: true,
        paymentRequested: false
      });
    }
    if (approvesCurrentQuote) {
      return state("paid-followup-authorized", "needs-interactive-payment", {
        payloadSha256,
        authorizationValid,
        fee,
        paymentAuthorization,
        quoteAccepted: false,
        paymentRequested: false
      });
    }
    return state("fee-quote-hold", "request-conflict-hold", { payloadSha256, authorizationValid, fee });
  }
  if (fee && !authorizationValid) return state("fee-approval-required", "needs-purchase-confirmation", { payloadSha256, authorizationValid, fee });
  if (confirmed && authorizationValid) return state("waiting-external", "pending-external-delivery", { payloadSha256, authorizationValid });
  if (!authorizationValid) {
    return state("authorization-required", request.kind.startsWith("paid-")
      ? "needs-purchase-confirmation"
      : "needs-submit-confirmation", { payloadSha256, authorizationValid });
  }
  return state("authorized", request.kind.startsWith("paid-")
    ? "needs-interactive-payment"
    : "needs-submit-confirmation", { payloadSha256, authorizationValid });
}

export function validateExternalRequest(request) {
  const issues = [];
  if (request.schemaVersion !== 1) issues.push("unsupported schemaVersion");
  if (!/^[a-z0-9][a-z0-9-]*$/.test(request.id || "")) issues.push("invalid id");
  if (!externalRequestKinds.has(request.kind)) issues.push("invalid kind");
  if (!request.provider) issues.push("provider is required");
  if (!Array.isArray(request.items) || !request.items.length) issues.push("items are required");
  const itemIds = new Set();
  for (const item of request.items || []) {
    if (!item.id || !item.targetId || !item.routeId) issues.push("each item requires id, targetId, and routeId");
    if (itemIds.has(item.id)) issues.push(`duplicate item ${item.id}`);
    itemIds.add(item.id);
  }
  const phrase = request.guard?.requiredPhrase;
  if (phrase !== `SUBMIT ${request.id}` && phrase !== `PAY ${request.id}`) issues.push("guard phrase must be exact SUBMIT/PAY request id");
  const paid = request.kind.startsWith("paid-");
  if (paid && request.guard?.costMode !== "maximum") issues.push("paid requests require a maximum cost guard");
  if (paid && (!Number.isFinite(request.guard?.maxAmount) || request.guard.maxAmount <= 0 || !request.guard.currency)) {
    issues.push("paid requests require positive maxAmount and currency");
  }
  if (!paid && request.guard?.costMode !== "no-charge") issues.push("no-charge requests require a no-charge guard");
  const expectedHash = externalRequestPayloadSha256(request);
  if (request.payloadSha256 !== expectedHash) issues.push("payloadSha256 does not match the guarded payload");
  let priorAt = "";
  const eventIds = new Set();
  let validAuthorizationSeen = false;
  let confirmedSubmissionSeen = false;
  let informationOutstanding = false;
  const quotesById = new Map();
  let latestQuote = null;
  let paymentAuthorizedQuoteId = "";
  const quoteAcceptedIds = new Set();
  for (const event of request.events || []) {
    if (!event.id || eventIds.has(event.id)) issues.push(`invalid or duplicate event id ${event.id || "(missing)"}`);
    eventIds.add(event.id);
    if (!externalRequestEventTypes.has(event.type)) issues.push(`invalid event type ${event.type}`);
    if (!Number.isFinite(Date.parse(event.at))) issues.push(`event ${event.id} has invalid at`);
    if (priorAt && event.at < priorAt) issues.push("events must be chronological");
    priorAt = event.at;
    if (event.type === "authorization-confirmed") {
      if (event.phrase !== phrase) issues.push(`event ${event.id} has the wrong authorization phrase`);
      if (event.payloadSha256 !== expectedHash) issues.push(`event ${event.id} authorizes a different payload`);
      if (event.phrase === phrase && event.payloadSha256 === expectedHash) validAuthorizationSeen = true;
    }
    if (event.type === "access-confirmed") {
      if (request.kind !== "paid-order") issues.push(`event ${event.id} is only valid for paid-order access`);
      if (!validAuthorizationSeen) issues.push(`event ${event.id} requires valid authorization`);
    }
    if (event.type === "provider-reply-received"
      && (!/^[0-9a-f]{12,20}$/.test(event.messageId || "") || event.basis !== `gmail-message-${event.messageId}`)) {
      issues.push(`${event.id || "event"} provider-reply-received requires a Gmail hex messageId and its matching basis`);
    }
    if (event.type === "fee-quoted") {
      quotesById.set(event.id, event);
      latestQuote = event;
    }
    if (event.type === "payment-authorized") {
      const quote = quotesById.get(event.feeEventId);
      if (event.phrase !== `PAY ${request.id}`) issues.push(`event ${event.id} needs the exact PAY ${request.id} phrase`);
      if (!quote) issues.push(`event ${event.id} must reference a prior fee-quoted event`);
      else if (event.amount !== quote.amount || event.currency !== quote.currency) {
        issues.push(`event ${event.id} must approve exactly the quoted amount`);
      }
      paymentAuthorizedQuoteId = quote ? event.feeEventId : "";
    }
    if (event.type === "quote-accepted") {
      if (!paymentAuthorizedQuoteId) issues.push(`event ${event.id} requires a prior payment-authorized event`);
      else if (event.feeEventId !== paymentAuthorizedQuoteId) issues.push(`event ${event.id} must accept the approved quote`);
      else if (latestQuote && paymentAuthorizedQuoteId !== latestQuote.id) {
        issues.push(`event ${event.id} answers a superseded quote`);
      }
      if (event.phrase !== `PAY ${request.id}`) issues.push(`event ${event.id} needs the exact PAY ${request.id} phrase`);
      if (event.feeEventId) quoteAcceptedIds.add(event.feeEventId);
    }
    if (event.type === "payment-requested") {
      if (!paymentAuthorizedQuoteId) issues.push(`event ${event.id} requires a prior payment-authorized event`);
      else if (!quoteAcceptedIds.has(paymentAuthorizedQuoteId)) issues.push(`event ${event.id} requires the approved quote to be accepted first`);
      else if (latestQuote && paymentAuthorizedQuoteId !== latestQuote.id) {
        issues.push(`event ${event.id} answers a superseded quote`);
      }
    }
    if (["payment-started", "payment-retryable"].includes(event.type)
        && !(paid ? validAuthorizationSeen : paymentAuthorizedQuoteId)) {
      issues.push(`event ${event.id} requires a prior PAY authorization`);
    }
    if (event.type === "payment-submitted") {
      if (!paymentAuthorizedQuoteId) issues.push(`event ${event.id} requires a prior payment-authorized event`);
      else if (latestQuote && paymentAuthorizedQuoteId !== latestQuote.id) {
        issues.push(`event ${event.id} answers a superseded quote`);
      }
    }
    if (["submission-confirmed", "provider-acknowledged"].includes(event.type)) confirmedSubmissionSeen = true;
    if (event.type === "submission-voided") {
      if (!confirmedSubmissionSeen) issues.push(`event ${event.id} requires a prior confirmed submission`);
      if (!String(event.note || "").trim()) issues.push(`event ${event.id} must say why the confirmation was void`);
      confirmedSubmissionSeen = false;
      validAuthorizationSeen = false;
    }
    if (event.type === "provider-information-required") {
      if (!confirmedSubmissionSeen) issues.push(`event ${event.id} requires a prior confirmed submission`);
      informationOutstanding = true;
    }
    if (event.type === "provider-information-supplied") {
      if (!informationOutstanding) issues.push(`event ${event.id} requires prior provider-information-required`);
      if (!validAuthorizationSeen) issues.push(`event ${event.id} requires valid authorization`);
      if (event.phrase !== phrase) issues.push(`event ${event.id} has the wrong authorization phrase`);
      if (event.payloadSha256 !== expectedHash) issues.push(`event ${event.id} authorizes a different payload`);
      informationOutstanding = false;
    }
    if (event.type === "delivery-item-imported" && !itemIds.has(event.itemId)) {
      issues.push(`event ${event.id} references unknown item ${event.itemId}`);
    }
    if (event.type === "delivery-item-imported"
        && event.routeStatus
        && !completedItemRouteStatuses.has(event.routeStatus)) {
      issues.push(`event ${event.id} has invalid completed item routeStatus ${event.routeStatus}`);
    }
  }
  if (request.revision !== (request.events || []).length) issues.push("revision must equal event count");
  const complete = (request.events || []).some((event) => event.type === "delivery-complete");
  const imported = new Set((request.events || []).filter((event) => event.type === "delivery-item-imported").map((event) => event.itemId));
  if (complete) for (const item of request.items || []) {
    if (!imported.has(item.id)) issues.push(`delivery-complete is missing imported item ${item.id}`);
  }
  return issues;
}

export function appendExternalRequestEvent(request, event, { expectedRevision = request.revision } = {}) {
  if (expectedRevision !== request.revision) throw new Error(`${request.id} revision changed; reload before appending`);
  const withTime = {
    ...event,
    at: event.at || new Date().toISOString()
  };
  const normalized = { ...withTime, id: event.id || eventId(withTime) };
  if (!externalRequestEventTypes.has(normalized.type)) throw new Error(`unsupported request event: ${normalized.type}`);
  if ((request.events || []).some((existing) => existing.id === normalized.id)) return request;
  const updated = { ...request, revision: request.revision + 1, events: [...request.events, normalized] };
  const issues = validateExternalRequest(updated);
  if (issues.length) throw new Error(`${request.id}: ${issues.join("; ")}`);
  return updated;
}

export function projectExternalRequestOntoRoute(route, request) {
  const item = request.items?.find((candidate) => candidate.targetId === route.targetId && candidate.routeId === route.id);
  const derived = deriveExternalRequest(request, item?.id);
  // A paid request can remain access-confirmed after its source master has
  // already been captured. Keep the terminal acquisition status instead of
  // downgrading an acquired/published route back to ready-subscription-capture.
  const preserveCompleted = completedItemRouteStatuses.has(route.status)
    && !completedItemRouteStatuses.has(derived.routeStatus);
  // Publishing a preserved original is forward progress from "acquired".
  const preservePublished = route.status === "published" && derived.routeStatus === "acquired";
  route.status = preserveCompleted || preservePublished ? route.status : derived.routeStatus;
  route.requestProjection = {
    operationalState: derived.operationalState,
    revision: request.revision,
    classifiedRevision: externalRequestRevisionWindow(request).classifiedRevision,
    ...(derived.untriagedReplyIds?.length ? { untriagedReplyIds: [...derived.untriagedReplyIds] } : {}),
    ...(derived.fee ? {
      feeQuote: {
        amount: derived.fee.amount,
        currency: derived.fee.currency
      }
    } : {}),
    ...(derived.paymentAuthorization ? {
      approvedPayment: {
        amount: derived.paymentAuthorization.amount,
        currency: derived.paymentAuthorization.currency
      }
    } : {})
  };
  return derived;
}

function compareEvents(first, second) {
  return first.at.localeCompare(second.at) || first.id.localeCompare(second.id);
}

function state(operationalState, routeStatus, extra) {
  return { operationalState, routeStatus, ...extra };
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function eventId(event) {
  return `event-${crypto.createHash("sha256").update(stableJson(event)).digest("hex").slice(0, 16)}`;
}
