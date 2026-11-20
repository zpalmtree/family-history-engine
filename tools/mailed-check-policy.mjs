// What the guarded mailed-cheque helper may send, to whom, and for how much.
//
// AGENTS.md (19 Nov 2026) lets tools/guarded-mailed-check.mjs have a cheque
// printed and posted through Lob for a request whose provider takes payment
// only by post. These are the pure checks behind that rule. A payee joins
// the payees, and a request joins the orders, in tree/mailed-check.json only as a
// reviewed change made from the provider's own page or message. Nothing
// here holds the user's name, address, email, bank account or the API key:
// the Windows bridge adds the sender and the account from its own encrypted
// settings, and they never reach Node, the repository, a log or the chat.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { authorizedPayment } from "./payment-policy.mjs";

// The reviewed payees and per-request orders are this tree's data, in
// tree/mailed-check.json ({ payees, orders }). Without it no cheque can be sent.
function deepFreeze(value) {
  if (value && typeof value === "object") {
    for (const entry of Object.values(value)) deepFreeze(entry);
    Object.freeze(value);
  }
  return value;
}
const mailedCheckFile = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "tree", "mailed-check.json");
const mailedCheckData = fs.existsSync(mailedCheckFile) ? JSON.parse(fs.readFileSync(mailedCheckFile, "utf8")) : {};
export const mailedCheckPayees = deepFreeze(mailedCheckData.payees || {});
export const mailedCheckOrders = deepFreeze(mailedCheckData.orders || {});

const LOB_LIMITS = Object.freeze({ name: 40, line: 50, memo: 40, message: 400, description: 255 });

export function mailedCheckOrderFor(request) {
  const order = mailedCheckOrders[request?.id];
  if (!order) throw new Error(`${request?.id || "This request"} has no reviewed mailed-cheque order.`);
  const payee = mailedCheckPayees[order.payee];
  if (!payee) throw new Error(`${request.id} names an unreviewed payee.`);
  if (payee.provider !== request.provider) {
    throw new Error(`${request.id} is a ${request.provider} request, but its cheque order pays ${payee.provider}; nothing was sent.`);
  }
  return { ...order, payeeId: order.payee, payee };
}

// Whether a reviewed cheque order exists for this request (the ledger's question).
export function hasMailedCheckOrder(request) {
  try {
    mailedCheckOrderFor(request);
    return true;
  } catch {
    return false;
  }
}

// The exact sum the cheque is written for: the user's unused approval, in US
// dollars. A cheque is never written for less or more than what was approved.
export function authorizedCheck(request) {
  const authorization = authorizedPayment(request);
  if (authorization.currency !== "USD") throw new Error(`${request.id} is approved in ${authorization.currency}; a US cheque needs a USD approval.`);
  if (!(authorization.amount > 0) || Math.abs(Math.round(authorization.amount * 100) - authorization.amount * 100) > 1e-6) {
    throw new Error(`${request.id} has no whole-cent amount to write a cheque for.`);
  }
  // The approval this cheque spends. One approval can back one cheque only: the
  // key is what makes a retry return the first cheque instead of a second.
  const approvalType = authorization.mode === "quote" ? "payment-authorized" : "authorization-confirmed";
  const approval = [...(request.events || [])].reverse().find((event) => event.type === approvalType);
  if (!approval?.id) throw new Error(`${request.id} has no recorded approval event.`);
  return { ...authorization, approvalEventId: approval.id };
}

const escapeHtml = (value) => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// The covering letter, one US Letter page. {{sender_*}} are filled in by Lob
// from merge variables the bridge supplies; nothing personal is written here.
export function letterHtml(order, authorization) {
  const paragraphs = order.letter.map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`).join("\n");
  return `<html><head><meta charset="utf-8"><style>
body { width: 8.5in; height: 11in; margin: 0; padding: 1in; box-sizing: border-box; font-family: Georgia, serif; font-size: 12pt; line-height: 1.45; color: #000; }
p { margin: 0 0 0.16in 0; }
.sender, .date { margin-bottom: 0.3in; }
.subject { font-weight: bold; }
</style></head><body>
<p class="sender">{{sender_name}}<br>{{sender_address}}<br>{{sender_email}}</p>
<p class="date">{{letter_date}}</p>
<p class="subject">${escapeHtml(order.subject)} (cheque enclosed: $${authorization.amount.toFixed(2)})</p>
${paragraphs}
<p>Yours faithfully,</p>
<p>{{sender_name}}<br>{{sender_email}}</p>
</body></html>`;
}

// The request the bridge sends to Lob, without the sender or the bank account.
export function lobCheckRequest(request) {
  const order = mailedCheckOrderFor(request);
  const authorization = authorizedCheck(request);
  const check = {
    description: `${request.id}`.slice(0, LOB_LIMITS.description),
    to: { ...order.payee.to, address_country: "US" },
    amount: authorization.amount,
    memo: order.memo,
    message: `${order.subject}. Covering letter enclosed.`,
    attachment: letterHtml(order, authorization),
    mail_type: "usps_first_class",
    use_type: "operational",
    metadata: { request: request.id.slice(0, 500), approval: authorization.approvalEventId }
  };
  const problems = lobLimitProblems(check);
  if (problems.length) throw new Error(`The cheque for ${request.id} does not fit Lob's limits: ${problems.join("; ")}.`);
  return {
    requestId: request.id,
    payeeId: order.payeeId,
    authorization,
    idempotencyKey: `family-history-cheque/${request.id}/${authorization.approvalEventId}`,
    check
  };
}

export function lobLimitProblems(check) {
  const problems = [];
  const to = check.to || {};
  if (!to.name || to.name.length > LOB_LIMITS.name) problems.push(`payee name must be 1-${LOB_LIMITS.name} characters`);
  if (!to.address_line1) problems.push("the payee needs a street address");
  if (`${to.address_line1 || ""}${to.address_line2 || ""}`.length > LOB_LIMITS.line) problems.push(`the two address lines together exceed ${LOB_LIMITS.line} characters`);
  if (!/^[A-Z]{2}$/.test(to.address_state || "")) problems.push("the state must be two letters");
  if (!/^\d{5}(-\d{4})?$/.test(to.address_zip || "")) problems.push("the ZIP code is not valid");
  if (to.address_country !== "US") problems.push("Lob posts cheques to US addresses only");
  if (!check.memo || check.memo.length > LOB_LIMITS.memo) problems.push(`the memo must be 1-${LOB_LIMITS.memo} characters`);
  if (!check.message || check.message.length > LOB_LIMITS.message) problems.push(`the message must be 1-${LOB_LIMITS.message} characters`);
  if (!(check.amount > 0) || check.amount > 500) problems.push("the amount must be above zero and no more than $500");
  if (check.mail_type !== "usps_first_class" || check.use_type !== "operational") problems.push("only an operational first-class cheque is sent");
  return problems;
}

// What the bridge reported, reduced to what may be recorded and printed. A
// cheque counts as sent only when Lob returned its id in the live environment
// for exactly the approved amount and payee.
export function classifyBridgeResult(result, prepared) {
  if (!result || typeof result !== "object") return { status: "uncertain", reason: "the bridge returned nothing readable" };
  if (result.error) {
    // Lob refused the request before creating anything: nothing was posted.
    const refused = Number(result.httpStatus) >= 400 && Number(result.httpStatus) < 500;
    return { status: refused ? "refused" : "uncertain", reason: `${result.error}${result.httpStatus ? ` (HTTP ${result.httpStatus})` : ""}` };
  }
  if (!/^chk_[A-Za-z0-9]+$/.test(result.id || "")) return { status: "uncertain", reason: "Lob returned no cheque id" };
  if (Number(result.amount) !== prepared.authorization.amount) return { status: "uncertain", reason: `Lob reports ${result.amount}, not the approved ${prepared.authorization.amount}` };
  // Lob prints and returns names in capitals (seen in the first rehearsal against
  // its test environment, 19 Nov 2026), so the payee is compared without case.
  const sameName = (first, second) => String(first || "").replace(/\s+/g, " ").trim().toUpperCase() === String(second || "").replace(/\s+/g, " ").trim().toUpperCase();
  if (!sameName(result.toName, prepared.check.to.name)) return { status: "uncertain", reason: "Lob reports a different payee" };
  const summary = {
    checkId: result.id,
    checkNumber: result.checkNumber ?? null,
    expectedDelivery: /^\d{4}-\d{2}-\d{2}$/.test(result.expectedDeliveryDate || "") ? result.expectedDeliveryDate : null,
    environment: result.environment
  };
  if (result.environment !== "live") return { status: "rehearsed", ...summary };
  return { status: "sent", ...summary };
}
