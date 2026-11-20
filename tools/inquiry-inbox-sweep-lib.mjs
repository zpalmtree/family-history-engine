// Pure helpers for the inquiry inbox sweep: which canonical requests to read,
// which provider messages in their bound threads are not yet on record, and the
// informational event that hands each new reply to the research loop. The
// browser part lives in inquiry-inbox-sweep.mjs.

import { deriveExternalRequest } from "./external-request-store.mjs";

export const sweepRequestKinds = new Set(["no-charge-email", "no-charge-form", "paid-library-request"]);

// States in which a provider may still write. Complete and cancelled requests
// are left alone, and delivery-reported ones are already in the queue.
export const sweepOperationalStates = new Set([
  "waiting-external",
  "awaiting-payment-instructions",
  "information-required",
  "fee-quote-hold",
  "paid-followup-authorized"
]);

export function requestChannel(request) {
  return request.spec?.channel || (request.kind === "no-charge-form" ? "form" : "email");
}

export function sweepEligible(request, { scope = "main" } = {}) {
  if (!sweepRequestKinds.has(request.kind)) return false;
  if (!["email", "form"].includes(requestChannel(request))) return false;
  if ((request.researchScope || "main") !== scope) return false;
  return sweepOperationalStates.has(deriveExternalRequest(request).operationalState);
}

// Every Gmail message id the request's events already cite: a classified
// reply names its message as `gmail-message-<id>` in a basis, and older
// events sometimes quote the id in their note.
export function recordedMessageIds(request) {
  const ids = new Set();
  for (const event of request.events || []) {
    if (event.messageId) ids.add(String(event.messageId).toLowerCase());
    for (const text of [event.basis, event.note]) {
      for (const match of String(text || "").matchAll(/gmail-message-([0-9a-f]{12,20})/gi)) ids.add(match[1].toLowerCase());
    }
  }
  return ids;
}

// A Gmail legacy message id is its send time in milliseconds shifted left by
// 20 bits, so the id alone dates the message without opening it.
export function gmailMessageTime(messageId) {
  if (!/^[0-9a-f]{12,20}$/i.test(messageId || "")) return null;
  return new Date(Number(BigInt(`0x${messageId}`) >> 20n));
}

// Events record a provider message at the minute Gmail displays, so a message
// up to two minutes after the latest classification is the one it classified.
export const classificationToleranceMs = 2 * 60 * 1000;
const replyNeutralTypes = new Set(["provider-reply-received", "reminder-sent", "payment-notice-sent", "provider-message-unavailable"]);

export function latestClassificationAt(request) {
  const times = (request.events || [])
    .filter((event) => !replyNeutralTypes.has(event.type))
    .map((event) => Date.parse(event.at))
    .filter(Number.isFinite);
  return times.length ? new Date(Math.max(...times)) : null;
}

// A reply is new when no event cites its Gmail id and it was sent after the
// request's latest classification event: anything older was read when that
// event was recorded, even if the event did not quote the id (older events
// often recorded a quote or acknowledgement without one).
export function newReplies(request, inspection) {
  const known = recordedMessageIds(request);
  const latest = latestClassificationAt(request);
  return (inspection?.replies || [])
    .filter((reply) => /^[0-9a-f]{12,20}$/i.test(reply.messageId || ""))
    .filter((reply) => !known.has(reply.messageId.toLowerCase()))
    .filter((reply) => !latest || gmailMessageTime(reply.messageId) > new Date(latest.getTime() + classificationToleranceMs));
}

// The event carries the sender's display name and the attachment file names,
// never the message body: the agent reads the thread itself when it triages.
export function replyReceivedEvent(reply, at) {
  const messageId = reply.messageId.toLowerCase();
  const sender = String(reply.senderName || "the provider").replace(/\s+/g, " ").trim().slice(0, 120);
  const labels = (reply.attachmentLabels || []).map((label) => String(label).slice(0, 120));
  const attachmentText = labels.length
    ? `${labels.length} attachment(s): ${labels.join("; ")}`
    : "no attachment";
  return {
    type: "provider-reply-received",
    at,
    messageId,
    basis: `gmail-message-${messageId}`,
    note: `${sender} replied in the bound thread (${attachmentText}); detected by the inbox sweep and not yet classified.`.slice(0, 1000)
  };
}

// Inbox standing for session status: when the sweep last ran (from the
// gitignored local state) and which requests hold untriaged replies.
export const inboxSweepStaleHours = 6;

export function inboxStatus({ requests, sweepState, scope = "main", now = new Date() }) {
  const lastSweptAt = sweepState?.lastSweptAt || null;
  const ageHours = lastSweptAt ? Math.round(((now - new Date(lastSweptAt)) / 36e5) * 10) / 10 : null;
  const untriaged = requests
    .filter((request) => (request.researchScope || "main") === scope)
    .map((request) => ({ requestId: request.id, messageIds: deriveExternalRequest(request).untriagedReplyIds || [] }))
    .filter((entry) => entry.messageIds.length);
  return {
    lastSweptAt,
    ageHours,
    stale: ageHours === null || ageHours > inboxSweepStaleHours,
    untriaged,
    command: "npm run requests:inbox:sweep"
  };
}
