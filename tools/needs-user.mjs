// Needs-user / waiting-external projection, shared by `research:status
// --needs-user` and the venue worklist. Extracted so the worklist is a genuine
// read-only projection of the same canonical targets rather than a second queue
// with its own drifting copy of the venue rules.

import {
  accessProviderLabel,
  routeAccessProvider,
  signInStatus,
  signInVenue,
  subscriptionStatus,
  subscriptionVenue
} from "./access-gates.mjs";
import { paymentCheckoutProfiles } from "./payment-policy.mjs";
import { bankTransferProfiles } from "./bank-transfer-policy.mjs";
import { isLiveResearchQuestion } from "./research-question-state.mjs";
import { isProofBlockingTarget } from "./research-target-state.mjs";

const legacyUserReasons = new Set([
  "request-conflict-hold",
  "needs-purchase-confirmation",
  "needs-submit-confirmation",
  "needs-requester-information",
  "needs-human-visual-review",
  "needs-familysearch-center",
  // A subscription wall is a user gate whether or not the route carries an
  // explicit gate object; check-main-frontier-v2 already counts it as one, so
  // a plain research:acquisition:attempt must project the same way.
  "needs-subscription-purchase"
]);

export function priorityRank(priority) {
  const value = Number(priority?.slice(1));
  return Number.isInteger(value) ? value : 99;
}

export function buildNeedsUserResult(allQuestions, targets, options = {}) {
  const questionById = new Map(allQuestions.map((question) => [question.id, question]));
  const attentionTargets = targets.map((target) => {
    const gate = structuredGateForTarget(target);
    const liveQuestionIds = [...new Set((target.questionIds || [])
      .filter((id) => isLiveResearchQuestion(questionById.get(id), options)))].sort();
    // Already-sent active requests remain visible even if their proof question
    // is later answered or the target is a control. Hiding them loses the
    // canonical do-not-duplicate warning. User gates remain proof-only.
    const questionIds = gate?.actor === "external"
      ? [...new Set((target.questionIds || []).filter((id) => questionById.has(id)))].sort()
      : liveQuestionIds;
    return { target, gate, questionIds, liveQuestionIds };
  }).filter(({ gate }) => gate && ["user", "external"].includes(gate.actor))
    .filter(({ target, gate, liveQuestionIds }) => gate.actor === "external"
      || (liveQuestionIds.length && isProofBlockingTarget(target, allQuestions, options)));
  const items = attentionTargets.map(({ target, gate, questionIds }) => {
    const waiting = gate.actor === "external";
    const relatedQuestions = questionIds.map((id) => questionById.get(id)).filter(Boolean);
    return {
      id: target.id,
      kind: waiting ? "waiting-external" : "needs-user",
      priority: target.priority,
      title: gate.title || `${target.provider}: ${target.id}`,
      blockedItem: target.reference,
      action: gate.action || (waiting ? externalDeliveryAction(target) : accessGateAction(target, gate)),
      venue: waiting ? gate.venue || externalVenue(target) : userGateVenue(target, gate),
      impact: gate.impact || (relatedQuestions.length
        ? relatedQuestions.map((question) => question.question).join(" ")
        : "This artifact route remains unavailable; unrelated research can continue."),
      resumeToken: gate.resumeToken || (waiting ? `RECEIVED ${target.id}` : targetResumeToken(target, gate)),
      retryWhen: gate.retryWhen || target.reconciliation.retryWhen,
      questionIds
    };
  });

  items.sort((first, second) => Number(first.kind === "waiting-external") - Number(second.kind === "waiting-external")
    || priorityRank(first.priority) - priorityRank(second.priority)
    || first.id.localeCompare(second.id));
  return {
    generatedFrom: "structured live user/external gates on canonical acquisition targets",
    needsUserCount: items.filter((item) => item.kind === "needs-user").length,
    waitingExternalCount: items.filter((item) => item.kind === "waiting-external").length,
    items
  };
}

export function structuredGateForTarget(target = {}) {
  const routes = target.routes || [];
  const selectedRoute = routes.find((item) => item.id === target.reconciliation?.routeId);
  const orderedRoutes = [selectedRoute, ...routes.filter((route) => route !== selectedRoute)].filter(Boolean);
  const explicitCandidates = [
    ...[target.gate, target.reconciliation?.gate, ...(target.gates || [])]
      .filter(Boolean).map((gate) => ({ gate })),
    ...orderedRoutes.flatMap((route) => [route.gate, ...(route.gates || [])]
      .filter(Boolean).map((gate) => ({ gate, routeId: route.id })))
  ].filter(({ gate }) => !["resolved", "closed", "retired", "consumed"].includes(gate.state));
  // A sent request must remain visible even when an alternate route is also
  // runnable. User gates likewise remain visible as parallel proof paths.
  // Reconciliation still chooses the autonomous route for queue execution;
  // this projection inventories independently authoritative route gates.
  const explicitExternal = explicitCandidates.find(({ gate }) => gate.actor === "external");
  if (explicitExternal) return {
    ...explicitExternal.gate,
    ...(explicitExternal.routeId ? { routeId: explicitExternal.routeId } : {}),
    retryWhen: explicitExternal.gate.retryWhen || target.reconciliation?.retryWhen
  };

  const externalRoute = orderedRoutes.find((route) => route.status === "pending-external-delivery");
  if (externalRoute) {
    // An accepted quote whose payment instructions are not yet recorded waits
    // on the provider's reply like a delivery, but the project still owes the
    // money: say so, and name the agent's step, so it never reads as "the
    // provider will send something".
    const awaitingInstructions = externalRoute.requestProjection?.operationalState === "awaiting-payment-instructions";
    return {
      actor: "external",
      type: awaitingInstructions ? "payment-instructions" : "delivery",
      state: "active",
      routeId: externalRoute.id,
      ...(awaitingInstructions ? {
        title: `${target.provider}: approved ${formattedFeeQuote(externalRoute.requestProjection.approvedPayment)} quote accepted; the payment is still owed and its instructions are not recorded`,
        action: paymentInstructionsAction(target, externalRoute)
      } : {}),
      resumeToken: `RECEIVED ${target.id}`,
      retryWhen: awaitingInstructions ? "provider-payment-instructions-recorded" : "delivery-arrives",
      compatibility: "schema-v1-derived"
    };
  }

  const explicitUser = explicitCandidates.find(({ gate }) => gate.actor === "user");
  if (explicitUser) return {
    ...explicitUser.gate,
    ...(explicitUser.routeId ? { routeId: explicitUser.routeId } : {}),
    retryWhen: explicitUser.gate.retryWhen || target.reconciliation?.retryWhen
  };

  const feeQuoteRoute = orderedRoutes.find((route) =>
    route.requestProjection?.operationalState === "fee-quote-hold");
  if (feeQuoteRoute) return legacyUserGate(target, "fee-quote-payment", feeQuoteRoute);
  const paidFollowupRoute = orderedRoutes.find((route) =>
    route.requestProjection?.operationalState === "paid-followup-authorized");
  if (paidFollowupRoute) return legacyUserGate(target, "authorized-payment-followup", paidFollowupRoute);
  const interactiveRoute = orderedRoutes.find((route) =>
    ["needs-interactive-sign-in", "needs-interactive-payment"].includes(route.status));
  if (interactiveRoute) return legacyUserGate(target,
    interactiveRoute.status === "needs-interactive-sign-in" ? "interactive-sign-in" : "interactive-payment",
    interactiveRoute);
  const legacyUserRoute = orderedRoutes.find((route) => legacyUserReasons.has(route.status));
  if (legacyUserRoute) return legacyUserGate(target, legacyUserRoute.status, legacyUserRoute);

  // Schema-v1 adapter: only well-defined human/external states become gates.
  // Missing route support and alternate-provider discovery are system work.
  if (target.status === "pending-external") {
    return {
      actor: "external",
      type: "delivery",
      state: "active",
      resumeToken: `RECEIVED ${target.id}`,
      retryWhen: target.reconciliation?.retryWhen
    };
  }
  if (target.status === "needs-interactive-sign-in") {
    return legacyUserGate(target, "interactive-sign-in", selectedRoute);
  }
  if (target.status === "needs-interactive-payment") {
    return legacyUserGate(target, "interactive-payment", selectedRoute);
  }
  if (target.reconciliation?.state === "blocked"
    && legacyUserReasons.has(target.reconciliation?.reasonCode)) {
    return legacyUserGate(target, target.reconciliation.reasonCode, selectedRoute);
  }
  const explicitSystem = explicitCandidates.find(({ gate }) => gate.actor === "system");
  return explicitSystem ? {
    ...explicitSystem.gate,
    ...(explicitSystem.routeId ? { routeId: explicitSystem.routeId } : {}),
    retryWhen: explicitSystem.gate.retryWhen || target.reconciliation?.retryWhen
  } : null;
}

function legacyUserGate(target, type, route) {
  return {
    actor: "user",
    type,
    state: "active",
    ...(route?.id ? { routeId: route.id } : {}),
    ...(route?.status ? { reasonCode: route.status } : {}),
    resumeToken: targetResumeToken(target, { type, routeId: route?.id, reasonCode: route?.status }),
    retryWhen: target.reconciliation?.retryWhen,
    compatibility: "schema-v1-derived"
  };
}

// Provider-account gates group by provider, not by collection: one sign-in or
// one subscription change clears every item behind that account, whatever
// venue label the individual gate was recorded with.
function userGateVenue(target, gate) {
  const route = gateRoute(target, gate);
  const reason = gate.reasonCode || route?.status;
  if (gate.type === "interactive-sign-in" || reason === signInStatus) {
    return signInVenue(routeAccessProvider(route, target), route?.provider || target.provider);
  }
  if (reason === subscriptionStatus) {
    return subscriptionVenue(routeAccessProvider(route, target), route?.provider || target.provider);
  }
  return gate.venue || accessGateVenue(target, gate);
}

export function accessGateAction(target, gate = {}) {
  const reason = gate.reasonCode || target.reconciliation.reasonCode;
  const route = gateRoute(target, gate);
  if (route?.requestProjection?.operationalState === "fee-quote-hold") {
    return `The provider quoted ${formattedFeeQuote(route.requestProjection.feeQuote)}. Reply PAY ${route.requestId || route.authorizationTargetId || target.id} to authorize a guarded paid follow-up at that quoted amount; payment does not occur automatically and any later additional charge requires a new decision.`;
  }
  if (route?.requestProjection?.operationalState === "paid-followup-authorized") {
    const provider = route?.provider || target.provider;
    const amount = formattedFeeQuote(route.requestProjection.approvedPayment);
    const requestId = route.requestId || target.id;
    if (hasReviewedBankTransfer(provider)) {
      return `Payment of ${amount} is already authorized and ${provider} takes bank transfer. The agent prepares the Wise transfer from the provider's own instructions (npm run payments:run -- --execute --id ${requestId}); when you are at the computer reply PAYMENT READY ${target.id}, then press Send now in the revealed Wise tab. A larger or later quote returns here for a new decision.`;
    }
    if (hasAllowlistedCheckout(provider)) {
      return `Payment of ${amount} is already authorized for this quote. The agent runs the guarded checkout (npm run payments:run -- --execute --id ${requestId}) while you are at the computer: reply PAYMENT READY ${target.id} when you are, and type only the card's security code in the revealed tab. A larger or later quote returns here for a new decision.`;
    }
    return `Payment of ${amount} is already authorized, but no reviewed guarded route exists for ${provider} yet. The agent first reads the provider's own reply for how it takes payment (npm run payments:run lists the exact step) and either reviews that route into the helpers or gives you the provider's instructions. Only if ${provider} takes a mailed cheque or a phone payment do you pay directly and reply PAID ${target.id}; nothing larger or later is covered.`;
  }
  if (reason === "request-conflict-hold") {
    return "Do not submit or retry this request. Resolve the conflicting external submission evidence, then record a conflict-resolved request event.";
  }
  if (gate.type === "interactive-sign-in" || target.status === "needs-interactive-sign-in") {
    const providerId = routeAccessProvider(route, target);
    const label = accessProviderLabel(providerId, route?.provider || target.provider);
    return `Agents first try Chrome's saved ${label} credentials automatically (npm run providers:signin). If that still needs you (no saved password, MFA, CAPTCHA, or account choice), sign in to ${label} once in the shared Chrome profile and reply READY sign-in-${providerId}; npm run research:gates:refresh -- --signed-in ${providerId} then reopens every ${label} sign-in item at once.`;
  }
  if (gate.type === "interactive-payment" || target.status === "needs-interactive-payment") {
    const provider = route?.provider || target.provider;
    const requestId = route?.requestId || target.id;
    if (hasAllowlistedCheckout(provider) || hasReviewedBankTransfer(provider)) {
      return `Your PAY phrase is recorded; nothing is paid until the agent runs the guarded ${route?.serviceOption || "purchase"} at no more than ${formattedCost(route)} (npm run payments:run -- --execute --id ${requestId}) while you are at the computer. Reply PAYMENT READY ${target.id} when you are; the agent reveals only the existing shared-window tab and you complete only the security-code or final-send step. No payment data is read or stored.`;
    }
    return `Your PAY phrase is recorded, but no guarded checkout exists for ${provider}. The agent first identifies how the provider takes payment from its own order page or reply (npm run payments:run lists the step) and either reviews that route into the helpers or gives you the exact instructions; if ${provider} takes only a mailed cheque or a phone payment, pay at most ${formattedCost(route)} directly and reply PAID ${target.id}.`;
  }
  if (reason === "needs-purchase-confirmation") {
    return `Authorize the ${route?.serviceOption || "document"} at the estimated ${formattedCost(route)} cost by replying ${route?.confirmationPhrase}; the final visible amount remains guarded.`;
  }
  if (reason === "needs-submit-confirmation" && route?.requestProjection?.operationalState === "authorized") {
    return `Authorization is already recorded. When available for any required visible contact fields or CAPTCHA, reply READY ${target.id}; the agent will resume the exact guarded form without requesting another SUBMIT token.`;
  }
  if (reason === "needs-submit-confirmation" && route?.confirmationPhrase) {
    return `Authorize the documented no-charge submission by replying ${route.confirmationPhrase}.`;
  }
  if (reason === "needs-requester-information") {
    // Providers ask for different things (a postal address, a yes to free
    // photographs, a clarification); the exact question is the latest
    // provider-information-required note on the request, not this text.
    const requestId = route?.requestId || target.id;
    return `Answer the provider's question recorded on request ${requestId} in its existing email thread, keeping any personal details out of chat and repository files, then reply READY ${target.id} so the request returns to waiting-external. A reply that carries no personal details can be sent by the agent instead once you type that request's exact SUBMIT phrase.`;
  }
  if (reason === "needs-human-visual-review") {
    return `Complete the bounded human visual review described by this route, report every hit, near match, and unreadable region, then reply READY ${target.id}.`;
  }
  if (reason === "needs-familysearch-center") {
    return `Make FamilySearch Center or affiliate-library access available for this route, then reply READY ${target.id}.`;
  }
  if (reason === "needs-alternate-route") {
    return `Provide an authorized accessible copy or a new provider route, then reply READY ${target.id}.`;
  }
  if (reason === subscriptionStatus) {
    const providerId = routeAccessProvider(route, target);
    const label = accessProviderLabel(providerId, route?.provider || target.provider);
    return `Change the ${label} subscription so this record opens, or supply the original; nothing is purchased automatically. Then reply READY subscription-${providerId}; npm run research:gates:refresh -- --entitlement ${providerId} reopens every ${label} subscription item at once.`;
  }
  return `Provide an accessible equivalent record or report that provider access has changed, then reply READY ${target.id}.`;
}

export function accessGateVenue(target, gate = {}) {
  // Mirror accessGateAction's branch order so each venue names the single
  // real-world user action that clears every item grouped under it.
  const reason = gate.reasonCode || target.reconciliation.reasonCode;
  const route = gateRoute(target, gate);
  if (route?.requestProjection?.operationalState === "fee-quote-hold"
    || route?.requestProjection?.operationalState === "paid-followup-authorized"
    || gate.type === "interactive-payment"
    || target.status === "needs-interactive-payment"
    || reason === "needs-purchase-confirmation") {
    return { id: "payment-decision", label: "payment or purchase decision" };
  }
  if (reason === "request-conflict-hold") return { id: "conflict-adjudication", label: "conflicting-evidence adjudication" };
  if (gate.type === "interactive-sign-in" || target.status === "needs-interactive-sign-in") {
    return signInVenue(routeAccessProvider(route, target), route?.provider || target.provider);
  }
  if (reason === "needs-submit-confirmation") return { id: "submission-approval", label: "no-charge submission approval" };
  if (reason === "needs-requester-information") return { id: "correspondence-reply", label: "email reply with requester information" };
  if (reason === "needs-human-visual-review") return { id: "human-visual-review", label: "bounded human visual review" };
  if (reason === "needs-familysearch-center") {
    return { id: "familysearch-center-visit", label: "FamilySearch center or affiliate-library visit" };
  }
  if (reason === "needs-alternate-route") return { id: "alternate-route", label: "authorized copy or new provider route" };
  if (reason === subscriptionStatus) return subscriptionVenue(routeAccessProvider(route, target), route?.provider || target.provider);
  return { id: "access-change", label: "changed provider access or equivalent record" };
}

function externalVenue(target) {
  return { id: `external-${target.provider}`, label: `${target.provider} response delivery` };
}

function formattedCost(route) {
  if (Number.isFinite(route?.estimatedCostGbp)) return `£${Number(route.estimatedCostGbp).toFixed(2)}`;
  const symbols = { USD: "$", EUR: "€", GBP: "£" };
  const currency = route?.estimatedCost?.currency;
  const amount = Number(route?.estimatedCost?.amount);
  if (!Number.isFinite(amount) || !currency) return "documented provider";
  return `${symbols[currency] || `${currency} `}${amount.toFixed(2)}`;
}

function formattedFeeQuote(fee) {
  const symbols = { USD: "$", EUR: "€", GBP: "£" };
  const amount = Number(fee?.amount);
  const currency = fee?.currency;
  if (!Number.isFinite(amount) || !currency) return "an unstructured fee";
  return `${symbols[currency] || `${currency} `}${amount.toFixed(2)}`;
}

export function targetResumeToken(target, gate = {}) {
  const route = gateRoute(target, gate);
  const reason = gate.reasonCode || target.reconciliation?.reasonCode;
  if (reason === "needs-requester-information") return `READY ${target.id}`;
  if (route?.requestProjection?.operationalState === "fee-quote-hold") return `PAY ${route.requestId || route.authorizationTargetId || target.id}`;
  if (route?.requestProjection?.operationalState === "paid-followup-authorized") {
    const provider = route?.provider || target.provider;
    return hasAllowlistedCheckout(provider) || hasReviewedBankTransfer(provider) ? `PAYMENT READY ${target.id}` : `PAID ${target.id}`;
  }
  if (reason === "request-conflict-hold") return `RESOLVE ${route?.requestId || target.id}`;
  if (gate.type === "interactive-sign-in" || target.status === "needs-interactive-sign-in") {
    return `READY sign-in-${routeAccessProvider(route, target)}`;
  }
  if (gate.type === "interactive-payment" || target.status === "needs-interactive-payment") return `PAYMENT READY ${target.id}`;
  if (route?.requestProjection?.operationalState === "authorized") return `READY ${target.id}`;
  if (reason === subscriptionStatus) return `READY subscription-${routeAccessProvider(route, target)}`;
  return route?.confirmationPhrase || `READY ${target.id}`;
}

function gateRoute(target, gate = {}) {
  const routeId = gate.routeId || target.reconciliation?.routeId;
  return (target.routes || []).find((item) => item.id === routeId);
}

function externalDeliveryAction(target) {
  if (target.provider === "General Register Office") {
    return `When the physical certificate arrives, make it available to the project and reply RECEIVED ${target.id}; do not submit a duplicate order.`;
  }
  return `When the response arrives, make it available to the project and reply RECEIVED ${target.id}; do not submit a duplicate request.`;
}

// A provider joins the guarded saved-card helper only as a reviewed checkout
// profile, and the guarded Wise helper only as a reviewed beneficiary. A
// provider with neither gets its payment channel identified by the agent
// first; only a cheque or phone payment is the user's to make.
function hasAllowlistedCheckout(provider) {
  return Object.values(paymentCheckoutProfiles).some((profile) => profile.provider === provider);
}

function hasReviewedBankTransfer(provider) {
  return Object.values(bankTransferProfiles).some((profile) => profile.provider === provider);
}

// The external gate text for an accepted quote whose payment instructions
// are not yet recorded: the agent's step, not the user's.
function paymentInstructionsAction(target, route) {
  const amount = formattedFeeQuote(route.requestProjection?.approvedPayment);
  const requestId = route.requestId || target.id;
  return `You approved ${amount} and the agent accepted the provider's quote, but the money has not been sent: the provider's payment instructions are not recorded on request ${requestId}. The agent checks the provider's thread (npm run archive:win:inspect-response -- -Request ${requestId}; the quote itself may carry the bank details or link), records payment-requested, and then prepares the guarded payment, leaving you only the final send step. If the provider's instructions reach you directly, reply RECEIVED ${target.id}. Do not pay by hand; nothing larger or later is covered.`;
}
