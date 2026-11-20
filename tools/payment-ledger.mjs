// Payment ledger: every canonical request that carries money, in one view.
//
// The NEEDS USER / WAITING EXTERNAL rollup answers "what blocks research?".
// It hides an authorized payment whenever its question is deferred, its
// target is recovery-only, or a provider-side hold is recorded, and it can
// only say "waiting" when a request waits on the provider even though the
// money is still owed by the project. This ledger answers a different
// question, "what money has the user approved that has not reached the
// provider, and who acts next?", straight from the request events, so nothing
// that was authorized can go quiet again. It is read-only and pure.
//
// Stages (one per request):
//   quoted                  the provider quoted; the user has not typed PAY
//   authorized              PAY recorded; nothing executed yet (agent runs it)
//   awaiting-instructions   quote accepted; the provider's payment instructions
//                           are not on record (payment-requested) yet
//   provider-processing     an explicit external hold on an authorized payment
//   in-flight               a pay click or order submit has no recorded result
//   retryable               the provider declined; the authorization is unspent
//   paid                    paid; the delivery is awaited
//   delivered               delivered (or access confirmed)
//   cancelled

import { deriveExternalRequest } from "./external-request-store.mjs";
import { paymentCheckoutProfiles, raisedOrderApproval } from "./payment-policy.mjs";
import { bankTransferProfiles } from "./bank-transfer-policy.mjs";
import { hasMailedCheckOrder } from "./mailed-check-policy.mjs";
import { njOrderSpecs } from "./nj-archives-order.mjs";
import { isLiveResearchQuestion } from "./research-question-state.mjs";
import { researchScopeOf } from "./research-scope.mjs";

export const paymentStages = Object.freeze([
  "quoted",
  "authorized",
  "awaiting-instructions",
  "provider-processing",
  "in-flight",
  "retryable",
  "paid",
  "delivered",
  "cancelled"
]);

// Stages where the project still owes the provider money or a decision.
export const openPaymentStages = Object.freeze([
  "quoted", "authorized", "awaiting-instructions", "provider-processing", "in-flight", "retryable", "paid"
]);

// Ages (whole days since the stage was entered) after which a stage is called
// out. An authorized payment is meant to be executed in the same session as
// the PAY phrase, so it is due the next day and stale after a week.
export const paymentAlarmDays = Object.freeze({
  authorized: 1,
  authorizedStale: 7,
  retryable: 1,
  inFlight: 0,
  awaitingInstructions: 14,
  providerProcessing: 7,
  quoted: 30,
  delivery: Object.freeze({
    default: 45,
    "General Register Office": 28,
    "General Register Office:online-view": 1,
    "The National Archives": 21,
    "Maryland State Archives": 45
  })
});

const dayMs = 24 * 60 * 60 * 1000;
const currencySymbols = { GBP: "£", USD: "$", EUR: "€" };

export function formatMoney(amount, currency) {
  if (!Number.isFinite(Number(amount)) || !currency) return "an unstated amount";
  return `${currencySymbols[currency] || `${currency} `}${Number(amount).toFixed(2)}`;
}

// --- channel -----------------------------------------------------------------

const channelHints = [
  ["pagopa", /\bpagopa\b/i],
  ["paypal", /\bpaypal\b/i],
  ["bank-transfer", /\b(?:bank transfer|bonifico|iban|wire transfer|bacs|sort code)\b/i],
  ["mail", /\b(?:cheque|check(?:s)? (?:payable|by (?:post|mail))|money order|mail(?:ed)? (?:a|the|your) (?:check|cheque|payment)|mailed (?:check|cheque)|send (?:us )?(?:a |the |your )?(?:blank |personal )?(?:check|cheque)|by (?:post|mail))\b/i],
  ["phone", /\b(?:by (?:tele)?phone|over the (?:tele)?phone|call (?:us|the office) (?:with|to pay))\b/i],
  ["web-link", /\b(?:payment link|card link|card-payment link|invoice link|pay online|online payment|credit card|debit card|checkout)\b/i]
];

function providerCardProfile(provider) {
  const entry = Object.entries(paymentCheckoutProfiles).find(([, profile]) => profile.provider === provider);
  return entry ? { id: entry[0], ...entry[1] } : null;
}

function providerBankProfile(provider) {
  const entry = Object.entries(bankTransferProfiles).find(([, profile]) => profile.provider === provider);
  return entry ? { id: entry[0], ...entry[1] } : null;
}

const cardDrivers = { ancestry: "-AncestryMembership", findAWill: "-FindAWillOrder", gro: "-GroOrder", msa: "-MsaOrder", scotlandspeople: "-ScotlandsPeopleCredits", tna: "-TnaPageCheck" };

// Where the money goes and whether a reviewed helper can take it there. The
// provider's own words (the recorded fee, approval and instruction notes) are
// the only source for an unreviewed channel; a reviewed profile always wins.
export function paymentChannel(request, routes = []) {
  const card = providerCardProfile(request.provider);
  if (card) {
    return {
      kind: "card-checkout",
      reviewed: true,
      profileId: card.id,
      driver: cardDrivers[card.id] || (card.linkHosts?.length ? "gmail-link" : "url")
    };
  }
  const bank = providerBankProfile(request.provider);
  if (bank) return { kind: "bank-transfer", reviewed: true, profileId: bank.id, driver: "wise" };
  // A reviewed order driver for this exact request (the New Jersey State
  // Archives cart). Its payment site joins the checkout profiles once observed.
  if (njOrderSpecs[request.id]) return { kind: "card-checkout", reviewed: false, profileId: "nj-archives", driver: "-NjArchivesOrder" };
  // A reviewed cheque order for this exact request: the helper posts it.
  if (hasMailedCheckOrder(request)) return { kind: "mail", reviewed: true, driver: "lob" };
  const text = [
    ...(request.events || [])
      .filter((event) => ["fee-quoted", "payment-authorized", "quote-accepted", "payment-requested", "provider-acknowledged"].includes(event.type))
      .map((event) => `${event.note || ""} ${event.basis || ""}`),
    ...routes.map((route) => `${route.note || ""} ${route.serviceOption || ""} ${route.route || ""}`),
    request.spec?.summary || "",
    request.spec?.serviceOption || ""
  ].join("\n");
  return { kind: classifyChannelText(text).kind, reviewed: false, driver: null };
}

// The channel a provider's own words describe, with the phrase that matched,
// so a dispatcher can say why it read a reply as cheque-by-post or a card link.
export function classifyChannelText(text) {
  for (const [kind, pattern] of channelHints) {
    const match = pattern.exec(String(text || ""));
    if (match) return { kind, match: match[0] };
  }
  return { kind: "unknown", match: null };
}

// --- stage -------------------------------------------------------------------

function sortedEvents(request) {
  return [...(request.events || [])].sort((first, second) =>
    first.at.localeCompare(second.at) || String(first.id).localeCompare(String(second.id)));
}

function lastOfType(events, ...types) {
  return [...events].reverse().find((event) => types.includes(event.type)) || null;
}

function involvesMoney(request) {
  return request.kind?.startsWith("paid-") || (request.events || []).some((event) => event.type === "fee-quoted");
}

// The approved sum and the share of it already submitted (one approval may be
// spent across several provider checkouts).
function amounts(request, derived, events) {
  if (request.kind?.startsWith("paid-")) {
    const submitted = events.filter((event) => event.type === "payment-submitted")
      .reduce((total, event) => total + (Number(event.amount) || 0), 0);
    return {
      // A higher total the user later approved replaces the order's original maximum.
      amount: raisedOrderApproval(request)?.amount ?? request.guard?.maxAmount ?? null,
      currency: request.guard?.currency || null,
      amountIsMaximum: true,
      submittedAmount: submitted || null
    };
  }
  const approval = derived.paymentAuthorization;
  const fee = derived.fee;
  const basis = approval || fee;
  const approvalIndex = approval ? events.findIndex((event) => event.id === approval.id) : -1;
  const submitted = approval
    ? events.slice(approvalIndex + 1).filter((event) => event.type === "payment-submitted")
      .reduce((total, event) => total + (Number(event.amount) || approval.amount), 0)
    : 0;
  return {
    amount: basis?.amount ?? null,
    currency: basis?.currency || null,
    amountIsMaximum: false,
    submittedAmount: submitted || null
  };
}

function stageFor(request, derived, events, routes) {
  const paidKind = request.kind?.startsWith("paid-");
  const state = derived.operationalState;
  const externalHold = routes.some((route) => route.gate?.actor === "external" && route.gate?.state === "active");
  const payStarted = lastOfType(events, "payment-started", "payment-submitted", "payment-retryable");
  const startedUnresolved = payStarted?.type === "payment-started";
  if (state === "cancelled") return { stage: "cancelled", anchor: lastOfType(events, "cancelled") };
  if (["complete", "delivery-reported", "access-confirmed"].includes(state)) {
    return { stage: "delivered", anchor: lastOfType(events, "delivery-complete", "delivery-reported", "access-confirmed") };
  }
  if (state === "conflict-hold") {
    if (startedUnresolved) return { stage: "in-flight", anchor: payStarted };
    const submission = lastOfType(events, "submission-started", "submission-confirmed", "submission-retryable");
    if (paidKind && submission?.type === "submission-started") return { stage: "in-flight", anchor: submission };
    return { stage: "in-flight", anchor: lastOfType(events, "conflict-detected", "submission-uncertain") || events.at(-1) };
  }
  if (state === "fee-quote-hold" || state === "fee-approval-required") {
    return { stage: "quoted", anchor: derived.fee || lastOfType(events, "fee-quoted") };
  }
  if (state === "awaiting-payment-instructions") {
    // Each reminder re-arms the chase clock.
    return { stage: "awaiting-instructions", anchor: lastOfType(events, "quote-accepted", "reminder-sent") };
  }
  if (state === "information-required" && (derived.paymentAuthorization || paidKind)) {
    // The provider asked something before invoicing (Norris, 28 Oct 2026).
    return { stage: "awaiting-instructions", anchor: lastOfType(events, "provider-information-required"), blocker: "provider-information-required" };
  }
  if (state === "paid-followup-authorized") {
    const retry = lastOfType(events, "payment-retryable", "payment-submitted", "payment-started");
    if (retry?.type === "payment-retryable") return { stage: "retryable", anchor: retry };
    if (externalHold) return { stage: "provider-processing", anchor: events.at(-1) };
    return {
      stage: "authorized",
      anchor: lastOfType(events, "payment-requested", "quote-accepted", "payment-authorized")
    };
  }
  if (paidKind && state === "authorized") {
    const retry = lastOfType(events, "submission-retryable", "submission-confirmed", "submission-started", "submission-voided");
    if (retry?.type === "submission-retryable") return { stage: "retryable", anchor: retry };
    if (externalHold) return { stage: "provider-processing", anchor: events.at(-1) };
    return { stage: "authorized", anchor: lastOfType(events, "authorization-confirmed") };
  }
  if (paidKind && state === "authorization-required") {
    return { stage: "quoted", anchor: events.at(-1) || null };
  }
  if (state === "waiting-external") {
    const paidEvent = paidKind
      ? lastOfType(events, "submission-confirmed", "provider-acknowledged")
      : lastOfType(events, "payment-submitted");
    if (paidEvent) return { stage: "paid", anchor: paidEvent };
    return null;
  }
  return null;
}

function daysBetween(fromIso, now) {
  const from = Date.parse(fromIso || "");
  if (!Number.isFinite(from)) return null;
  return Math.max(0, Math.floor((now - from) / dayMs));
}

function deliveryAlarmDays(request, routes) {
  const service = `${request.spec?.serviceOption || ""} ${routes.map((route) => route.serviceOption || "").join(" ")}`;
  if (request.provider === "General Register Office" && /online view|digital image/i.test(service)) {
    return paymentAlarmDays.delivery["General Register Office:online-view"];
  }
  return paymentAlarmDays.delivery[request.provider] ?? paymentAlarmDays.delivery.default;
}

// Whether the provider's own thread is the only place the next step can be
// read from: a reviewed helper pays without it, and a pagoPA hold is re-checked
// on the provider's portal.
function threadIsTheRoute(entry) {
  return !entry.channel?.reviewed && entry.channel?.kind !== "pagopa";
}

export function paymentAlarm(entry) {
  const age = entry.ageDays ?? 0;
  let alarm = null;
  switch (entry.stage) {
    case "authorized":
      alarm = age >= paymentAlarmDays.authorizedStale ? "STALE" : "DUE";
      break;
    case "retryable":
      alarm = "RETRY";
      break;
    case "in-flight":
      alarm = "RECONCILE";
      break;
    case "awaiting-instructions":
      alarm = age >= paymentAlarmDays.awaitingInstructions ? "CHASE" : null;
      break;
    case "provider-processing":
      alarm = age >= paymentAlarmDays.providerProcessing ? "RECHECK" : null;
      break;
    case "quoted":
      alarm = age >= paymentAlarmDays.quoted ? "DECIDE" : null;
      break;
    case "paid":
      alarm = entry.deliveryAlarmDays !== null && age >= entry.deliveryAlarmDays ? "OVERDUE" : null;
      break;
    default:
      alarm = null;
  }
  // The provider's recorded message is gone from the shared mailbox and the
  // thread was the route: nothing the agent runs can read it, so the step is
  // the user's until a newer provider message is recorded (a paid delivery
  // only once it is overdue).
  if (entry.providerReplyUnavailable && threadIsTheRoute(entry)
      && (["authorized", "retryable", "awaiting-instructions", "provider-processing"].includes(entry.stage) || alarm === "OVERDUE")) {
    return "LOCATE";
  }
  return alarm;
}

// --- next step -----------------------------------------------------------------

function quote(value) {
  return JSON.stringify(String(value));
}

// Who acts next and exactly how. "agent" steps are commands the session runs
// itself; a "user" step is the smallest human action the AGENTS.md rules
// leave to the user (a security code, a Wise send, a PAY token). Every agent
// step names the command, so a session never has to rediscover the route.
// The Gmail hex ids that recorded bases and notes name for the provider's
// quote or payment messages, newest first, so the inspector can open the
// exact conversation instead of searching by a subject that may have changed.
export function providerMessageIds(request) {
  const ids = [];
  const pattern = /(?:gmail-message-|gmail (?:message|reply|receipt) |message id |message )([0-9a-f]{16})\b/gi;
  for (const event of [...(request.events || [])].reverse()) {
    if (!["fee-quoted", "payment-requested", "provider-acknowledged", "payment-authorized", "quote-accepted", "delivery-reported"].includes(event.type)) continue;
    for (const text of [event.basis, event.note]) {
      for (const match of String(text || "").matchAll(pattern)) if (!ids.includes(match[1])) ids.push(match[1]);
    }
  }
  return ids;
}

// Event types that record a new message from the provider's side.
const providerMessageEventTypes = ["fee-quoted", "payment-requested", "provider-acknowledged", "delivery-reported", "provider-information-required"];

// The latest provider-message-unavailable event, when no newer provider
// message has been recorded since: the thread the agent would read is gone
// from the shared mailbox, so the next step is the user's.
export function providerReplyUnavailable(request) {
  const events = sortedEvents(request);
  const index = events.map((event) => event.type).lastIndexOf("provider-message-unavailable");
  if (index < 0) return null;
  if (events.slice(index + 1).some((event) => providerMessageEventTypes.includes(event.type))) return null;
  const event = events[index];
  return { at: event.at, basis: event.basis || "", note: event.note || "" };
}

// What the dispatcher does when the inspector cannot open the recorded
// message: bounded Gmail searches of every folder for the provider's name (and
// its first two words when the name is longer), and, when all of them are
// empty, the exact informational event that hands the step to the user. The
// queries name the provider only, never the user's details.
export function providerReplyLookup(entry) {
  const name = String(entry.provider || "").replace(/^the\s+/i, "").replace(/[^\p{L}\p{N} .'-]/gu, " ").replace(/\s+/g, " ").trim();
  const words = name.split(" ").filter(Boolean);
  const queries = [...new Set([name, words.length > 2 ? words.slice(0, 2).join(" ") : null]
    .filter((query) => query && query.length <= 80))];
  const messageId = entry.providerMessageIds?.[0] || null;
  return {
    queries,
    event: (checkedAt = new Date().toISOString()) => ({
      type: "provider-message-unavailable",
      basis: `${messageId ? `gmail-message-${messageId}` : "the bound provider thread"} not in the shared mailbox on ${String(checkedAt).slice(0, 10)}; in:anywhere ${queries.map((query) => JSON.stringify(query)).join(", ")} matched 0 threads`,
      note: `${entry.provider}'s message could not be opened or found in any folder of the shared Gmail account, so its payment or delivery terms cannot be read from it; the user forwards a copy, states the channel, or authorizes a fresh enquiry.`
    })
  };
}

export function paymentNextStep(entry) {
  const id = entry.requestId;
  const target = entry.targetIds.length ? entry.targetIds.join(" / ") : id;
  const money = formatMoney(entry.amount, entry.currency);
  const channel = entry.channel;
  const inspect = `npm run archive:win:inspect-response -- -Request ${id}${entry.providerMessageIds?.[0] ? ` -MessageId ${entry.providerMessageIds[0]}` : ""}`;
  const cardUserStep = "type the card's security code in the revealed checkout tab (Chrome fills the saved card; the helper never reads it)";
  // The provider's message is gone from the shared mailbox (recorded by the
  // dispatcher after a whole-mailbox search), so no command can read it: the
  // user supplies a copy, the channel, or the go-ahead for a fresh enquiry.
  if (entry.alarm === "LOCATE") {
    const messageId = entry.providerMessageIds?.[0] || null;
    const checked = String(entry.providerReplyUnavailable?.at || "").slice(0, 10);
    const reply = `${entry.provider}'s reply${messageId ? ` (Gmail message ${messageId})` : ""} is no longer in the shared mailbox (checked ${checked}: not in any folder, spam or bin)`;
    if (entry.stage === "paid") {
      return {
        actor: "user",
        token: `RECEIVED ${target}`,
        userStep: `say whether the paid ${money} delivery arrived (RECEIVED ${target}), or forward the provider's latest message to the shared Gmail account`,
        text: `${reply}, so the agent cannot see whether the paid delivery was sent. Reply RECEIVED ${target} if it reached you, forward your own copy of the provider's message to the shared account, or say "re-ask" and the agent prepares a chase enquiry for your SUBMIT confirmation.`
      };
    }
    return {
      actor: "user",
      token: null,
      userStep: `forward the provider's reply${messageId ? ` (Gmail ${messageId})` : ""} to the shared Gmail account, state how ${entry.provider} takes payment, or say "re-ask" for a fresh enquiry`,
      text: `${reply}, so the agent cannot read how it takes payment and the ${entry.stage === "awaiting-instructions" ? "accepted" : "authorized"} ${money} cannot move. Forward your own copy to the shared account and say so, tell the agent the payment channel, or say "re-ask" and the agent prepares a new enquiry for your SUBMIT confirmation.`
    };
  }
  // A paid library or archive order that was authorized but never sent has no
  // provider thread to read yet: its channel comes from the provider's own
  // order page, and the order itself is still to be placed.
  if (["authorized", "retryable"].includes(entry.stage) && !entry.submitted && channel.kind === "unknown") {
    return {
      actor: "agent",
      command: `Read ${entry.orderUrl || "the provider's own order page"} read-only in the shared Windows Chrome for how ${entry.provider} takes payment, then place the authorized order`,
      userStep: null,
      text: `The authorized ${money} order has never been placed and ${entry.provider}'s payment channel is not on record; learn it from the provider's own order page, then place the order through the matching guarded route (card: pay:win -Url after a reviewed profile; cheque or phone: hand the user the exact PAID step).`
    };
  }
  switch (entry.stage) {
    case "quoted":
      return {
        actor: "user",
        token: `PAY ${id}`,
        text: `Decide on the ${money} quote: reply PAY ${id} to authorize exactly that amount, or say it should stay unpaid.`
      };
    case "authorized":
    case "retryable": {
      if (channel.kind === "card-checkout" && channel.driver && channel.driver !== "url" && channel.driver !== "gmail-link") {
        return {
          actor: "agent",
          command: `npm run pay:win -- -Request ${id} ${channel.driver}`,
          userStep: entry.channel.profileId === "msa"
            ? "type the card's security code and click Submit Order in the revealed tab"
            : entry.channel.profileId === "findAWill"
              ? "type the card's security code and click Pay Now in the revealed tab"
            : entry.channel.profileId === "nj-archives"
              ? "complete the contact form in the revealed tab and click Continue Checkout (Chrome offers your saved address), then type the card's security code"
            : entry.channel.profileId === "ancestry"
              ? "none unless the card stored on the Ancestry account is declined or the bank asks for verification"
              : cardUserStep,
          text: entry.channel.profileId === "ancestry"
            ? "Run the guarded Ancestry membership order now (it charges the card stored on the Ancestry account)."
            : entry.channel.profileId === "nj-archives"
              ? `Run the guarded ${entry.provider} cart order (${money} by card): the user completes the contact form, the first run observes the State's payment site for review into the checkout profiles, and the next run pays.`
            : `Run the guarded ${entry.provider} checkout now (the user only ${entry.channel.profileId === "msa" ? "types the security code and submits" : "types the security code"}).`
        };
      }
      if (channel.kind === "card-checkout" && channel.driver === "gmail-link") {
        return {
          actor: "agent",
          command: `npm run pay:win -- -Request ${id} -GmailQuery "<exact subject/from search for the provider's invoice email>" -LinkText "<visible link label>"`,
          userStep: cardUserStep,
          text: `Follow the provider's invoice link from its own Gmail message with the guarded card helper (list the labels first with -ListLinks).`
        };
      }
      if (channel.kind === "card-checkout") {
        return {
          actor: "agent",
          command: `npm run pay:win -- -Request ${id} -Url <the provider's HTTPS checkout page>`,
          userStep: cardUserStep,
          text: `Open the provider's checkout with the guarded card helper (add -Inspect first if the page has not been observed).`
        };
      }
      if (channel.kind === "bank-transfer" && channel.reviewed && entry.instructionsRecorded) {
        return {
          actor: "agent",
          command: `npm run transfer:win -- -Request ${id}`,
          userStep: "press Send now in the revealed Wise tab and complete any 2FA or funding step",
          text: "Prepare the Wise transfer from the provider's own instructions; the user presses Send now."
        };
      }
      if (channel.kind === "bank-transfer" && channel.reviewed) {
        return {
          actor: "agent",
          command: `${inspect}  # confirm the provider's payment instructions message, then: npm run research:requests:event -- --request ${id} --type payment-requested --expected-revision ${entry.revision} --basis "<Gmail message id>"`,
          userStep: "press Send now in Wise once the transfer is prepared",
          text: "Record the provider's payment instructions (payment-requested) from its own message, then run the guarded Wise transfer."
        };
      }
      if (channel.kind === "bank-transfer") {
        return {
          actor: "agent",
          command: `${inspect}  # read the beneficiary, bank and reference from the provider's own message; add a reviewed profile to tools/bank-transfer-policy.mjs (code change with tests); record payment-requested; then npm run transfer:win -- -Request ${id}`,
          userStep: "press Send now in Wise once the transfer is prepared",
          text: `${entry.provider} takes bank transfer; no reviewed beneficiary exists yet. Add one from the provider's instructions, record payment-requested, then prepare the Wise transfer.`
        };
      }
      if (["pagopa", "paypal", "web-link"].includes(channel.kind)) {
        return {
          actor: "agent",
          command: `npm run pay:win -- -Request ${id} -Url <the provider's HTTPS payment page> -Inspect  # observe the payment host, add a reviewed checkout profile to tools/payment-policy.mjs, then pay without -Inspect`,
          userStep: cardUserStep,
          text: `${entry.provider} is paid through a web checkout (${channel.kind}); observe its host with -Inspect, review it into the checkout profiles, then pay with the guarded helper.`
        };
      }
      if (channel.kind === "mail" && channel.reviewed) {
        return {
          actor: "agent",
          command: `npm run cheque:win -- --request ${id}`,
          text: `Post the approved ${money} cheque to ${entry.provider} through the guarded mailed-cheque helper (it adds the reviewed covering letter; no hand-written cheque).`
        };
      }
      if (channel.kind === "mail" || channel.kind === "phone") {
        return {
          actor: "user",
          token: `PAID ${target}`,
          text: `${entry.provider} takes payment only by ${channel.kind === "mail" ? "post (cheque or money order)" : "telephone"}; pay ${money} following its own instructions and reply PAID ${target}.`
        };
      }
      return {
        actor: "agent",
        command: `${inspect}  # read the provider's reply for how it takes payment (link, bank details, cheque, phone); then follow the matching route above`,
        userStep: null,
        text: `The payment channel for ${entry.provider} is not on record: read the provider's own reply and order page, classify the channel, then run the matching guarded route or hand the user an exact PAID step.`
      };
    }
    case "awaiting-instructions": {
      if (entry.blocker === "provider-information-required") {
        return {
          actor: "agent",
          command: `${inspect}  # answer the provider's question in its thread (archive:win:submit-inquiry -Target ${target} -Confirmation "SUBMIT ${id}" -InformationReply), then wait for its invoice`,
          userStep: null,
          text: "The provider asked a question before invoicing; answer it in the thread, then record the invoice as payment-requested."
        };
      }
      const remind = `npm run archive:win:submit-inquiry -- -Target ${entry.targetIds[0] || id} -Confirmation "PAY ${id}" -PaymentReminder`;
      if (entry.alarm === "CHASE") {
        return {
          actor: "agent",
          command: remind,
          userStep: null,
          text: `The quote was accepted ${entry.ageDays} days ago and the provider has sent no payment instructions: remind it in its own thread (the reminder is generated from the recorded quote and asks only for the instructions); when they arrive, record payment-requested and pay.`
        };
      }
      return {
        actor: "agent",
        command: `${inspect}  # if the message already carries payment instructions (bank details, invoice, link): npm run research:requests:event -- --request ${id} --type payment-requested --expected-revision ${entry.revision} --basis "<Gmail message id>"; after two silent weeks: ${remind}`,
        userStep: null,
        text: "The quote is accepted but no payment instructions are recorded; check the provider's thread (the quote itself may carry them), record payment-requested, then pay."
      };
    }
    case "provider-processing":
      return {
        actor: "agent",
        command: entry.channel.kind === "pagopa"
          ? "Re-check the pagoPA purchase history read-only in the shared Windows Chrome"
          : `${inspect}  # re-check the provider's own status for this payment`,
        userStep: null,
        text: `A provider-side payment hold is recorded; re-check its final status${entry.alarm === "RECHECK" ? " now (it has held for more than a week)" : ""}: record payment-submitted with the receipt if it completed, or clear the hold and retry the guarded payment if it expired.`
      };
    case "in-flight":
      return {
        actor: "agent",
        command: entry.provider === "General Register Office"
          ? "npm run gro:win:check-orders  # GRO My Orders is the authority: record submission-confirmed or submission-retryable from it"
          : `${inspect}  # verify on the provider's own confirmation or order history, then record payment-submitted / payment-retryable (or submission-confirmed / submission-retryable)`,
        userStep: null,
        text: "A payment or order was started without a recorded result; verify it on the provider's side before anything is retried, so nothing pays twice."
      };
    case "paid": {
      const gro = entry.provider === "General Register Office";
      // A GRO certificate is a paper document posted to the user, and GRO's
      // order history lists an order only for a limited time: once it is gone,
      // only the user can say whether the post arrived.
      const posted = gro && entry.deliveryAlarmDays !== paymentAlarmDays.delivery["General Register Office:online-view"];
      let text;
      if (entry.alarm === "OVERDUE" && posted) {
        text = `Paid ${entry.ageDays} days ago; the paper certificate is posted to the user, and GRO's order history lists an order only for a limited time. Check the history (automated); if the order is no longer listed, only the user can say whether it arrived: RECEIVED ${target}, or "not arrived", and the agent then asks GRO customer services with the order date and reference.`;
      } else if (entry.alarm === "OVERDUE") {
        text = `Paid ${entry.ageDays} days ago with no delivery recorded: chase it now (check the order history or thread, then ask the provider).`;
      } else {
        text = `Paid; the delivery is awaited (chase after ${entry.deliveryAlarmDays} days)${posted ? "; the paper certificate is posted to the user" : ""}. When it arrives, archive it and record it, or the user replies RECEIVED ${target}.`;
      }
      // A web order (paid-order) has no bound email inquiry, so the thread
      // inspector refuses it; its delivery shows in the provider's own account.
      const webOrder = !gro && entry.kind?.startsWith("paid-");
      return {
        actor: "provider",
        command: gro
          ? "npm run gro:win:check-orders  # order history shows despatch; an Online View image downloads from there"
          : entry.channel.profileId === "findAWill"
            ? `npm run pay:win -- -Request ${id} -FindAWillOrder -Orders  # the account's My Orders page shows "Documents pending" until the copy can be downloaded there`
          : webOrder
            ? `Check ${entry.provider}'s own account order history read-only in the shared Windows Chrome for this order's status and delivery (a web order has no email inquiry for archive:win:inspect-response)`
            : `${inspect}  # check the provider's thread for the delivery`,
        token: `RECEIVED ${target}`,
        text
      };
    }
    default:
      return { actor: "none", text: "" };
  }
}

// --- ledger ----------------------------------------------------------------------

export function buildPaymentLedger({ externalRequests = [], acquisitionTargets = [], questions = [] } = {}, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.parse(options.now || "") || Date.now();
  const questionById = new Map(questions.map((question) => [question.id, question]));
  const routesByRequest = new Map();
  for (const target of acquisitionTargets) {
    for (const route of target.routes || []) {
      if (!route.requestId) continue;
      if (!routesByRequest.has(route.requestId)) routesByRequest.set(route.requestId, []);
      routesByRequest.get(route.requestId).push({ route, target });
    }
  }
  const entries = [];
  for (const request of externalRequests) {
    if (!involvesMoney(request)) continue;
    const derived = deriveExternalRequest(request);
    const events = sortedEvents(request);
    const owners = routesByRequest.get(request.id) || [];
    const routes = owners.map(({ route }) => route);
    const targets = [...new Map(owners.map(({ target }) => [target.id, target])).values()];
    const staged = stageFor(request, derived, events, routes);
    if (!staged) continue;
    const questionIds = [...new Set(targets.flatMap((target) => target.questionIds || []))].sort();
    const liveQuestionIds = questionIds.filter((id) => isLiveResearchQuestion(questionById.get(id), options));
    const scope = targets.length ? researchScopeOf(targets[0]) : "main";
    const money = amounts(request, derived, events);
    const anchorAt = staged.anchor?.at || events.at(-1)?.at || null;
    const entry = {
      requestId: request.id,
      provider: request.provider,
      kind: request.kind,
      scope,
      targetIds: targets.map((target) => target.id),
      routeIds: routes.map((route) => route.id),
      questionIds,
      liveQuestionIds,
      questionState: !questionIds.length ? "none" : liveQuestionIds.length ? "live" : "deferred-or-closed",
      researchRoles: [...new Set(targets.map((target) => target.researchRole || "unstated"))],
      operationalState: derived.operationalState,
      routeStatuses: [...new Set(routes.map((route) => route.status))],
      stage: staged.stage,
      ...(staged.blocker ? { blocker: staged.blocker } : {}),
      ...money,
      channel: paymentChannel(request, routes),
      authorizedAt: (lastOfType(events, "payment-authorized") || (request.kind?.startsWith("paid-") ? lastOfType(events, "authorization-confirmed") : null))?.at || null,
      quoteAccepted: Boolean(derived.quoteAccepted),
      instructionsRecorded: Boolean(derived.paymentRequested),
      submitted: events.slice(events.findLastIndex((event) => event.type === "submission-voided") + 1)
        .some((event) => ["submission-confirmed", "provider-acknowledged"].includes(event.type)),
      orderUrl: typeof request.spec?.url === "string" && /^https:\/\//.test(request.spec.url) ? request.spec.url : null,
      providerMessageIds: providerMessageIds(request),
      providerReplyUnavailable: providerReplyUnavailable(request),
      stageEnteredAt: anchorAt,
      stageEvent: staged.anchor?.type || null,
      ageDays: daysBetween(anchorAt, now),
      revision: request.revision,
      deliveryAlarmDays: staged.stage === "paid" ? deliveryAlarmDays(request, routes) : null,
      hiddenFromRollup: []
    };
    if (questionIds.length && !liveQuestionIds.length) entry.hiddenFromRollup.push("no live question (deferred or closed)");
    if (targets.length && targets.every((target) => target.researchRole && target.researchRole !== "proof-blocking")) {
      entry.hiddenFromRollup.push(`target role ${entry.researchRoles.join("/")}`);
    }
    if (routes.some((route) => route.gate?.actor === "external" && route.gate?.state === "active")) {
      entry.hiddenFromRollup.push("explicit external hold");
    }
    entry.alarm = paymentAlarm(entry);
    entry.next = paymentNextStep(entry);
    entries.push(entry);
  }
  entries.sort(compareEntries);
  return {
    generatedAt: new Date(now).toISOString(),
    generatedFrom: "canonical external requests (evidence/acquisition/requests) with their acquisition routes",
    entries,
    summary: summarizeLedger(entries)
  };
}

const stageOrder = new Map(["in-flight", "retryable", "authorized", "awaiting-instructions", "provider-processing", "quoted", "paid", "delivered", "cancelled"]
  .map((stage, index) => [stage, index]));

function compareEntries(first, second) {
  return (stageOrder.get(first.stage) ?? 99) - (stageOrder.get(second.stage) ?? 99)
    || (second.ageDays ?? 0) - (first.ageDays ?? 0)
    || first.requestId.localeCompare(second.requestId);
}

export function summarizeLedger(entries) {
  const open = entries.filter((entry) => openPaymentStages.includes(entry.stage));
  const byStage = Object.fromEntries(paymentStages.map((stage) => [stage, entries.filter((entry) => entry.stage === stage).length]));
  const due = open.filter((entry) => ["authorized", "retryable", "in-flight"].includes(entry.stage));
  const overdue = open.filter((entry) => entry.alarm === "OVERDUE");
  const agentNext = open.filter((entry) => entry.next.actor === "agent");
  const userNext = open.filter((entry) => entry.next.actor === "user");
  const oldest = (list) => list.reduce((max, entry) => Math.max(max, entry.ageDays ?? 0), 0);
  return {
    openCount: open.length,
    byStage,
    dueCount: due.length,
    oldestDueDays: due.length ? oldest(due) : null,
    awaitingInstructionsCount: byStage["awaiting-instructions"],
    providerProcessingCount: byStage["provider-processing"],
    quotedCount: byStage.quoted,
    paidAwaitingDeliveryCount: byStage.paid,
    overdueDeliveryCount: overdue.length,
    locateCount: open.filter((entry) => entry.alarm === "LOCATE").length,
    agentActionCount: agentNext.length,
    userActionCount: userNext.length,
    hiddenFromRollupCount: open.filter((entry) => entry.hiddenFromRollup.length).length,
    alarms: open.filter((entry) => entry.alarm).map((entry) => ({ id: entry.requestId, stage: entry.stage, alarm: entry.alarm, ageDays: entry.ageDays }))
  };
}

// One line per open entry, and one headline, for the status printers.
export function formatLedgerHeadline(summary) {
  if (!summary.openCount) return "Payments: nothing authorized, quoted or paid is outstanding.";
  const parts = [];
  if (summary.dueCount) parts.push(`${summary.dueCount} authorized but not executed (oldest ${summary.oldestDueDays} d)`);
  if (summary.awaitingInstructionsCount) parts.push(`${summary.awaitingInstructionsCount} accepted quote(s) awaiting payment instructions`);
  if (summary.providerProcessingCount) parts.push(`${summary.providerProcessingCount} on a provider-side hold`);
  if (summary.quotedCount) parts.push(`${summary.quotedCount} quote(s) awaiting the user's PAY decision`);
  if (summary.paidAwaitingDeliveryCount) {
    parts.push(`${summary.paidAwaitingDeliveryCount} paid awaiting delivery${summary.overdueDeliveryCount ? ` (${summary.overdueDeliveryCount} overdue)` : ""}`);
  }
  if (summary.locateCount) {
    parts.push(`${summary.locateCount} provider ${summary.locateCount === 1 ? "reply" : "replies"} missing from the shared mailbox (the user locates ${summary.locateCount === 1 ? "it" : "them"})`);
  }
  return `Payments: ${parts.join("; ")}. Agent acts next on ${summary.agentActionCount}; user on ${summary.userActionCount}.`;
}

export function formatEntryMoney(entry) {
  const approved = `${entry.amountIsMaximum ? "up to " : ""}${formatMoney(entry.amount, entry.currency)}`;
  if (entry.stage === "paid" && Number.isFinite(entry.submittedAmount) && entry.submittedAmount !== entry.amount) {
    return `${formatMoney(entry.submittedAmount, entry.currency)} paid of ${approved} approved`;
  }
  return approved;
}

export function formatLedgerEntry(entry, { verbose = false } = {}) {
  const money = formatEntryMoney(entry);
  const age = entry.ageDays === null ? "" : ` ${String(entry.ageDays).padStart(3)} d`;
  const alarm = entry.alarm ? ` ${entry.alarm}` : "";
  const stage = entry.stage.toUpperCase().padEnd(22);
  const lines = [
    `PAYMENT ${stage}${alarm.padEnd(10)}${age}  ${entry.requestId} — ${entry.provider}, ${money}${entry.stageEvent ? ` (${entry.stageEvent} ${String(entry.stageEnteredAt).slice(0, 10)})` : ""}`
  ];
  const next = entry.next;
  const who = next.actor === "agent" ? "agent" : next.actor === "user" ? "USER" : "provider";
  lines.push(`    next (${who}): ${next.text}`);
  if (next.command) lines.push(`    run: ${next.command}`);
  if (next.userStep) lines.push(`    user step: ${next.userStep}`);
  if (next.token && next.actor !== "agent") lines.push(`    token: ${next.token}`);
  if (verbose || entry.hiddenFromRollup.length) {
    const notes = [];
    if (entry.hiddenFromRollup.length) notes.push(`not in the needs-user rollup: ${entry.hiddenFromRollup.join("; ")}`);
    if (verbose) notes.push(`channel ${entry.channel.kind}${entry.channel.reviewed ? " (reviewed)" : ""}; state ${entry.operationalState}; routes ${entry.routeStatuses.join(", ") || "none"}; questions ${entry.questionIds.join(", ") || "none"}`);
    for (const note of notes) lines.push(`    note: ${note}`);
  }
  return lines.join("\n");
}

export function formatPaymentLedger(ledger, { verbose = false, includeClosed = false } = {}) {
  const shown = ledger.entries.filter((entry) => includeClosed || openPaymentStages.includes(entry.stage));
  const lines = [formatLedgerHeadline(ledger.summary)];
  for (const entry of shown) lines.push(formatLedgerEntry(entry, { verbose }));
  if (!shown.length && includeClosed) lines.push("No payment-bearing requests.");
  return lines.join("\n");
}

// The exact npm invocation for an entry whose next step is fully automated,
// or null. Placeholders in angle brackets mean a person still has to choose
// something (a URL, a Gmail query), so they never execute; a user step never
// executes either. The read-only GRO order-history check counts as automated
// for a started or overdue GRO order.
export function automatedInvocation(entry) {
  // The part before "  #" is the command; the comment after it may carry
  // placeholders for the agent's later, judged steps.
  const command = String(entry.next?.command || "").split("  #")[0].trim();
  if (entry.next?.actor === "user" || /<[^>]+>/.test(command)) return null;
  const pay = /^npm run pay:win -- -Request ([a-z0-9-]+) (-AncestryMembership|-FindAWillOrder|-GroOrder|-MsaOrder|-NjArchivesOrder|-ScotlandsPeopleCredits|-TnaPageCheck)$/.exec(command);
  if (pay) return { label: command, npmArgs: ["run", "pay:win", "--", "-Request", pay[1], pay[2]] };
  const transfer = /^npm run transfer:win -- -Request ([a-z0-9-]+)$/.exec(command);
  if (transfer) return { label: command, npmArgs: ["run", "transfer:win", "--", "-Request", transfer[1]] };
  const cheque = /^npm run cheque:win -- --request ([a-z0-9-]+)$/.exec(command);
  if (cheque) return { label: command, npmArgs: ["run", "cheque:win", "--", "--request", cheque[1]] };
  const remind = /^npm run archive:win:submit-inquiry -- -Target ([a-z0-9-]+) -Confirmation "(PAY [a-z0-9-]+)" -PaymentReminder$/.exec(command);
  if (remind && entry.alarm === "CHASE") {
    return { label: command, npmArgs: ["run", "archive:win:submit-inquiry", "--", "-Target", remind[1], "-Confirmation", remind[2], "-PaymentReminder"] };
  }
  if (/^npm run gro:win:check-orders\b/.test(command)
      && (entry.stage === "in-flight" || (entry.stage === "paid" && entry.alarm === "OVERDUE"))) {
    // A started order whose result was never seen is reconciled from GRO's own
    // order history for this request; an overdue delivery reads this request's
    // order too (without -Target the helper opens only its default order).
    return entry.stage === "in-flight"
      ? { label: `npm run gro:win:check-orders -- -Target ${entry.requestId}`, npmArgs: ["run", "gro:win:check-orders", "--", "-Target", entry.requestId], readOnly: true, kind: "gro-reconcile" }
      : { label: `npm run gro:win:check-orders -- -Target ${entry.requestId}`, npmArgs: ["run", "gro:win:check-orders", "--", "-Target", entry.requestId], readOnly: true };
  }
  // Reading the provider's own thread is read-only, so it runs wherever that
  // thread is the route: a submitted request whose channel is unknown, an
  // accepted quote awaiting instructions before its chase alarm, a payment
  // without a recorded result, a provider-side hold, an overdue delivery. The
  // lookup is what the dispatcher does when the recorded message cannot be
  // opened: search the whole mailbox, then record provider-message-unavailable.
  const inspectThread = /^npm run archive:win:inspect-response -- -Request ([a-z0-9-]+)(?: -MessageId ([0-9a-f]{12,20}))?$/.exec(command);
  if (inspectThread && entry.next.actor === "agent" && (entry.stage !== "paid" || entry.alarm === "OVERDUE")) {
    return {
      label: command,
      npmArgs: ["run", "archive:win:inspect-response", "--", "-Request", inspectThread[1], ...(inspectThread[2] ? ["-MessageId", inspectThread[2]] : [])],
      readOnly: true,
      kind: "inspect",
      lookup: providerReplyLookup(entry)
    };
  }
  return null;
}

// The entries a session must act on or report: everything due plus every alarm.
export function paymentAttentionEntries(ledger) {
  return ledger.entries.filter((entry) => openPaymentStages.includes(entry.stage)
    && (["authorized", "retryable", "in-flight"].includes(entry.stage) || entry.alarm));
}

export function formatAttentionLine(entry) {
  const who = entry.next.actor === "user"
    ? `USER: ${entry.next.token || entry.next.userStep}`
    : `agent: ${entry.next.command ? entry.next.command.split("  #")[0] : entry.next.text}`;
  return `PAYMENT ${entry.alarm || entry.stage.toUpperCase()} ${entry.ageDays ?? "?"} d ${entry.requestId} — ${entry.provider} ${formatEntryMoney(entry)} — ${who}`;
}

// The compact block that research:status --needs-user and the session status
// print above the rollup: the headline plus every entry that is due or alarmed,
// so an authorized payment is impossible to miss even when the gate rollup is
// unchanged or hides it.
export function formatPaymentAttention(ledger) {
  const urgent = paymentAttentionEntries(ledger);
  const lines = [formatLedgerHeadline(ledger.summary)];
  for (const entry of urgent) lines.push(`  ${formatAttentionLine(entry)}`);
  if (ledger.summary.openCount) lines.push("  Full ledger: npm run payments:status (add --all for delivered items; --json for the data).");
  return lines.join("\n");
}
