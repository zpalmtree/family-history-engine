// Pure rules for archiving processed research mail (user request, 18 Nov 2026:
// "make our harness delete/archive emails after ingesting and processing so
// our inbox doesn't get bloated"). The browser and IMAP parts live in
// inbox-tidy.mjs; nothing here reads a message body.
//
// A message is archived only when it is research mail that is fully on record:
//   - it belongs to a main-scope canonical request (its subject, stripped of
//     reply/forward/auto-reply prefixes, is the request's subject),
//   - that request has no untriaged reply and is not waiting on a decision by
//     the user (information-required, a fee quote, a conflict, a SUBMIT), and
//   - the message is not newer than the request's latest recorded event, so a
//     reply nobody has classified yet always stays in the inbox; or
//   - it is a payment or free-download receipt that matches a payment already
//     recorded on a canonical request.
// Everything else (all non-research mail included) is left exactly where it is.

import { deriveExternalRequest, untriagedReplyIds } from "./external-request-store.mjs";

// Request states in which the user still has something to decide or answer:
// the provider's message stays in the inbox as the reminder.
export const userDecisionStates = new Set([
  "information-required",
  "fee-quote-hold",
  "fee-approval-required",
  "conflict-hold",
  "authorization-required",
]);

// Events that note a message without recording what it said.
const unsettlingEventTypes = new Set(["provider-reply-received", "provider-message-unavailable"]);

const subjectPrefix = /^\s*(?:(?:re|aw|sv|fw|fwd|wg|antw|automatic reply|automatische antwort|out of office|\[extern\]|\[external\])\s*:?\s*)+/i;

export function canonicalSubject(subject) {
  let value = String(subject || "").normalize("NFKC").replace(/\s+/g, " ").trim();
  for (let i = 0; i < 6; i += 1) {
    const next = value.replace(subjectPrefix, "").trim();
    if (next === value) break;
    value = next;
  }
  return value.replace(/[‐-―]/g, "-").replace(/["'‘’“”]/g, "").toLocaleLowerCase();
}

export function requestSubjects(request) {
  const subjects = [request.spec?.subject, request.responseBinding?.subject, ...(request.responseBinding?.aliases || [])]
    .filter(Boolean).map(canonicalSubject).filter((subject) => subject.length >= 12);
  return [...new Set(subjects)];
}

// Whether a request's mail may be archived, and the time up to which its mail
// is on record.
export function requestTidyStatus(request) {
  if ((request.researchScope || "main") !== "main") return { archivable: false, reason: "not main scope" };
  let state = "";
  try { state = deriveExternalRequest(request).operationalState; } catch { return { archivable: false, reason: "unreadable request state" }; }
  if (untriagedReplyIds(request).length) return { archivable: false, reason: "untriaged provider reply", state };
  if (userDecisionStates.has(state)) return { archivable: false, reason: `waiting on the user (${state})`, state };
  const settledAt = Math.max(0, ...(request.events || [])
    .filter((event) => !unsettlingEventTypes.has(event.type))
    .map((event) => Date.parse(event.at || "") || 0));
  return { archivable: settledAt > 0, reason: settledAt > 0 ? "on record" : "no recorded event", state, settledAt };
}

const recordedPaymentTypes = new Set(["submission-confirmed", "payment-submitted"]);
const dayMs = 24 * 60 * 60 * 1000;

// Receipts the payment helpers and the TNA download tool cause. Each is
// archived only once the payment (or free order) it reports is on record.
export const receiptRules = Object.freeze([
  { id: "worldpay-receipt", sender: /@worldpay\.com$/i, subject: /card transaction confirmation/i, needsPaymentWithin: 2 * dayMs },
  { id: "tna-copy-order-confirmation", sender: /^recordcopying@nationalarchives\.gov\.uk$/i, subject: /^confirmation: copy order /i, needsPaymentWithin: 2 * dayMs },
  // Discovery's free digital downloads are fetched from "Your orders" in the
  // same run that places them; the email is only the receipt.
  { id: "tna-digital-download-receipt", sender: /^digitaldownloads@nationalarchives\.gov\.uk$/i, subject: /^your order from the national archives/i, olderThan: 60 * 60 * 1000 },
]);

function paymentTimes(requests) {
  const times = [];
  for (const request of requests) {
    if ((request.researchScope || "main") !== "main") continue;
    for (const event of request.events || []) {
      if (recordedPaymentTypes.has(event.type)) times.push(Date.parse(event.at || "") || 0);
    }
  }
  return times.filter(Boolean);
}

// messages: [{ id, subject, senderEmail, dateMs }]. Returns the ids to archive
// and the research messages kept, each with its reason.
export function planInboxTidy({ messages, requests, now = Date.now() }) {
  const byRequestSubject = new Map();
  for (const request of requests) {
    for (const subject of requestSubjects(request)) {
      if (!byRequestSubject.has(subject)) byRequestSubject.set(subject, []);
      byRequestSubject.get(subject).push(request);
    }
  }
  const payments = paymentTimes(requests);
  const archive = [];
  const keep = [];
  for (const message of messages) {
    const subject = canonicalSubject(message.subject);
    const matched = byRequestSubject.get(subject) || [];
    if (matched.length) {
      const statuses = matched.map((request) => ({ request, ...requestTidyStatus(request) }));
      const blocked = statuses.find((status) => !status.archivable);
      if (blocked) {
        keep.push({ ...message, requestId: blocked.request.id, reason: blocked.reason });
        continue;
      }
      const settledAt = Math.max(...statuses.map((status) => status.settledAt));
      if (!Number.isFinite(message.dateMs) || message.dateMs > settledAt) {
        keep.push({ ...message, requestId: statuses[0].request.id, reason: "newer than the request's last recorded event" });
        continue;
      }
      archive.push({ ...message, requestId: statuses[0].request.id, rule: "request-on-record" });
      continue;
    }
    const rule = receiptRules.find((candidate) => candidate.sender.test(message.senderEmail || "") && candidate.subject.test(message.subject || ""));
    if (!rule) continue;
    if (!Number.isFinite(message.dateMs)) { keep.push({ ...message, rule: rule.id, reason: "undated receipt" }); continue; }
    if (rule.olderThan && now - message.dateMs >= rule.olderThan) {
      archive.push({ ...message, rule: rule.id });
    } else if (rule.needsPaymentWithin && payments.some((at) => Math.abs(at - message.dateMs) <= rule.needsPaymentWithin)) {
      archive.push({ ...message, rule: rule.id });
    } else {
      keep.push({ ...message, rule: rule.id, reason: "no matching recorded payment yet" });
    }
  }
  return { archive, keep };
}

export function senderAddress(from) {
  const text = String(from || "");
  return (/<([^>]+)>/.exec(text)?.[1] || /[^\s<>"]+@[^\s<>"]+/.exec(text)?.[0] || "").trim().toLowerCase();
}
