#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createInterface } from "node:readline";
import { openSharedChromeTask, sharedChromeEndpoint } from "./shared-chrome-task.mjs";
import { foreignHoldingClaims, outboundVerificationIssues } from "./holding-claims.mjs";
import { appendExternalRequestEvent, deriveExternalRequest, outstandingQuestionMessageId } from "./external-request-store.mjs";
import { paymentNoticeSentEvent, planPaymentNotice, planPaymentReminder, planQuoteAcceptance, quoteAcceptedEvent, reminderSentEvent } from "./quote-acceptance.mjs";
import { bankTransferProfileFor } from "./bank-transfer-policy.mjs";
import { requireConsent } from "./consents.mjs";
import { ownerName } from "./tree-config.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const targetId = valueAfter("--target");
const confirmation = valueAfter("--confirmation");
const endpoint = valueAfter("--endpoint") || sharedChromeEndpoint;
const affinitySlot = valueAfter("--affinity-slot") || "archive-inquiry";
const sharedWindow = process.argv.includes("--shared-window");
const informationReply = process.argv.includes("--information-reply-stdin");
const clarificationReply = process.argv.includes("--clarification-reply-stdin");
const acceptQuote = process.argv.includes("--accept-quote");
// A reminder for an accepted quote's payment instructions, bound like the
// acceptance by the exact PAY phrase; the payment ledger asks for it after
// two silent weeks.
const paymentReminder = process.argv.includes("--payment-reminder");
// A note that a requested payment was made, bound by the exact SUBMIT phrase.
const paymentNotice = process.argv.includes("--payment-notice");

if (!targetId || !/^[a-z0-9][a-z0-9-]{0,127}$/.test(targetId)) {
  throw new Error("Pass one safe acquisition target ID with --target.");
}
if (!sharedWindow || endpoint !== sharedChromeEndpoint) {
  throw new Error(`Email inquiries must use the shared Windows Chrome wrapper at ${sharedChromeEndpoint}.`);
}
requireConsent("email-enquiry");

const targetFile = path.join(projectRoot, "evidence", "acquisition", "targets", `${targetId}.json`);
const target = JSON.parse(fs.readFileSync(targetFile, "utf8"));
// A quote acceptance is bound by its PAY phrase to one exact request, which
// may own a route other than the target's original inquiry.
const acceptedRequestId = acceptQuote || paymentReminder ? (/^PAY ([a-z0-9][a-z0-9-]*)$/.exec(confirmation) || [])[1] : "";
if ((acceptQuote || paymentReminder) && !acceptedRequestId) throw new Error("Accepting or reminding about a quote requires an exact PAY <request-id> phrase.");
const route = acceptQuote || paymentReminder
  ? target.routes?.find((candidate) => candidate.requestId === acceptedRequestId)
  : target.routes?.find((candidate) => candidate.confirmationPhrase === confirmation)
    || target.routes?.find((candidate) => candidate.id === `${targetId}-inquiry`);
if (!route?.requestId) throw new Error(`${targetId} has no canonical external request.`);
const requestFile = path.join(projectRoot, "evidence", "acquisition", "requests", `${route.requestId}.json`);
let requestRecord = JSON.parse(fs.readFileSync(requestFile, "utf8"));
const request = requestRecord.spec;

if (!route) throw new Error(`${targetId} has no matching inquiry route.`);
if ([informationReply, clarificationReply, acceptQuote, paymentReminder, paymentNotice].filter(Boolean).length > 1) {
  throw new Error("Choose at most one reply mode.");
}
const replyOnly = informationReply || clarificationReply || acceptQuote || paymentReminder || paymentNotice;
if (!request || (request.channel !== "email" && !((clarificationReply || acceptQuote || paymentReminder) && request.channel === "form"))) {
  throw new Error(`${targetId} has no canonical email request.`);
}
const quoteAcceptance = acceptQuote ? planQuoteAcceptance(requestRecord, confirmation) : null;
const reminder = paymentReminder ? planPaymentReminder(requestRecord, confirmation) : null;
const notice = paymentNotice ? (() => {
  const profile = bankTransferProfileFor(requestRecord);
  return planPaymentNotice(requestRecord, confirmation, { beneficiary: profile.beneficiaryName, reference: profile.reference });
})() : null;
if (!acceptQuote && !paymentReminder && (confirmation !== requestRecord.guard.requiredPhrase || confirmation !== route.confirmationPhrase)) {
  throw new Error(`Final submission requires the exact confirmation phrase: ${requestRecord.guard.requiredPhrase}`);
}
let requestState = deriveExternalRequest(requestRecord);
if (!informationReply && !acceptQuote && !paymentReminder && !paymentNotice && requestState.operationalState === "authorization-required") {
  persistEvent({
    type: "authorization-confirmed",
    phrase: confirmation,
    payloadSha256: requestRecord.payloadSha256,
    basis: "exact-helper-confirmation"
  });
  requestState = deriveExternalRequest(requestRecord);
}
if (informationReply && requestState.operationalState !== "information-required") {
  throw new Error(`${route.requestId} is ${requestState.operationalState}; requester information may only be supplied to an information-required request.`);
}
if (clarificationReply) {
  const events = requestRecord.events || [];
  const asked = events.findLastIndex((event) => event.type === "provider-information-required");
  const answered = events.findLastIndex((event) => event.type === "provider-information-supplied");
  if (asked < 0 || answered > asked) {
    throw new Error(`${route.requestId} has no outstanding provider question; no clarification was sent.`);
  }
}
if (!replyOnly && requestState.operationalState !== "authorized") {
  throw new Error(`${route.requestId} is ${requestState.operationalState}; refusing a duplicate or unsafe submission.`);
}
// Validation catches a mis-addressed request at check time, but the send is
// where a real person's time gets spent, so refuse here too. A route citing
// another repository's own collection must record item-level proof that this
// provider holds it.
// Scoped to new outbound requests. A reply answers a message the provider
// already sent us and asks nobody to pull anything, so it must stay possible
// precisely when the citation was wrong -- that is when an apology is owed.
// Both halves of the request must be verified before a real institution is
// contacted: that this provider holds the item, and that the address is theirs.
for (const problem of (replyOnly ? [] : outboundVerificationIssues(target, route, requestRecord))) {
  throw new Error(`${targetId}/${route.id} is not verified for sending: ${problem}`);
}
const foreignHoldings = replyOnly ? [] : foreignHoldingClaims(target, route, { requireOutboundStatus: false });
if (foreignHoldings.length) {
  throw new Error(`${targetId}/${route.id} cites a holding that names another repository; record item-level holdingVerification for ${route.provider} before contacting them.`);
}
const approvedProviderRecipients = [
  /^info@norrismuseum\.org\.uk$/i,
  /^[A-Za-z0-9._%+-]+@cambridgeshire\.gov\.uk$/i,
  /^racine_reference@racinelibrary\.info$/i,
  /^cac@libanswers\.bgsu\.edu$/i,
  /^watervillehistory@outlook\.com$/i,
  /^Kuester\.Grimme@gmail\.com$/i,
  /^info@lucasprobate\.org$/i,
  /^office@stpaulstoledo\.org$/i,
  /^Wolfenbuettel@nla\.niedersachsen\.de$/i,
  /^hstastuttgart@la-bw\.de$/i,
  /^staffordshire\.record\.office@staffordshire\.gov\.uk$/i,
  // Record Office for Leicestershire, Leicester and Rutland; verified on its official contact page 15 Nov 2026.
  /^recordoffice@leics\.gov\.uk$/i,
  // Cumbria Archives, Whitehaven Archive and Local Studies Centre; verified on its official centre page 18 Nov 2026.
  /^whitehaven\.archives@cumberland\.gov\.uk$/i,
  // Dover Museum (Index of Freemen); verified on its official Contact Us page 18 Nov 2026.
  /^museumenquiries@dover\.gov\.uk$/i,
  // Lancashire Archives copy service; verified on its official digitisation-service page 18 Nov 2026.
  /^archivecopies@lancashire\.gov\.uk$/i,
  /^genealogy@slcl\.org$/i,
  /^recordscenter@co\.delaware\.oh\.us$/i,
  /^paula@walkerfuneralhomes\.com$/i,
  /^archive@cuyahogacounty\.gov$/i,
  /^norwalk@norwalk\.lib\.oh\.us$/i,
  /^archives@uwp\.edu$/i,
  /^clerk@villageofgreenup\.com$/i,
  /^archiviomonreale@archiviomonreale\.sicilia\.it$/i,
  /^refdesk@history\.pcusa\.org$/i,
  /^eamspacker@mifflincountypa\.gov$/i,
  /^msa\.helpdesk@maryland\.gov$/i,
  /^bn-pz\.prestito@cultura\.gov\.it$/i,
  /^as-cs@cultura\.gov\.it$/i,
  /^archiviostorico@diocesisanmarcoscalea\.it$/i,
  /^finedonchurcharchivist@outlook\.com$/i,
  /^stadtarchiv@stadt\.wuppertal\.de$/i,
  /^stpetritoledo1@gmail\.com$/i
];
if (!replyOnly && !approvedProviderRecipients.some((pattern) => pattern.test(request.recipient || ""))) {
  throw new Error("The canonical recipient is not an approved provider address.");
}
// Compose fields only matter when a new message is being written. A reply
// carries the thread's own subject and a body supplied on standard input.
for (const [name, value, max] of replyOnly ? [] : [
  ["subject", request.subject, 200],
  ["body", request.body, 5000]
]) {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new Error(`The canonical inquiry ${name} is missing or too long.`);
  }
}

const session = await openSharedChromeTask({
  chromium,
  endpoint,
  taskLabel: "authorized archive email inquiry",
  affinitySlot,
  timeoutMs: 20_000
});

try {
  const page = session.page;
  page.setDefaultTimeout(15_000);
  await page.goto("https://mail.google.com/mail/u/0/#inbox", {
    waitUntil: "domcontentloaded",
    timeout: 45_000
  });
  await page.waitForTimeout(2_000);

  let compose = page.getByRole("button", { name: /compose/i }).first();
  if (!await compose.isVisible().catch(() => false)) {
    await session.showForManualStep("Gmail sign-in required for the authorized archive inquiry");
    console.log("Gmail needs manual sign-in in the revealed shared-window tab. Waiting up to three minutes.");
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      await page.waitForTimeout(1_000);
      compose = page.getByRole("button", { name: /compose/i }).first();
      if (await compose.isVisible().catch(() => false)) break;
    }
  }
  if (!await compose.isVisible().catch(() => false)) {
    throw new Error("Gmail is not signed in; no inquiry was sent.");
  }

  if (acceptQuote) {
    await replyInBoundThread(page, requestRecord, quoteAcceptance.body, { messageId: quoteAcceptance.messageId });
    persistEvent(quoteAcceptedEvent(quoteAcceptance.fee, confirmation));
    console.log(JSON.stringify({ requestId: route.requestId, state: "quote-accepted" }));
  } else if (paymentReminder) {
    await replyInBoundThread(page, requestRecord, reminder.body, { messageId: reminder.messageId });
    persistEvent(reminderSentEvent(reminder.fee, confirmation));
    console.log(JSON.stringify({ requestId: route.requestId, state: "payment-reminder-sent", daysSinceLastAsked: reminder.daysSince }));
  } else if (paymentNotice) {
    await replyInBoundThread(page, requestRecord, notice.body, { messageId: notice.messageId });
    persistEvent(paymentNoticeSentEvent(notice, confirmation));
    console.log(JSON.stringify({ requestId: route.requestId, state: "payment-notice-sent", date: notice.date }));
  } else if (clarificationReply) {
    const clarification = await readReplyBodyFromStdin();
    await replyInBoundThread(page, requestRecord, clarification, { messageId: outstandingQuestionMessageId(requestRecord) });
    persistEvent({
      type: "provider-information-supplied",
      phrase: confirmation,
      payloadSha256: requestRecord.payloadSha256,
      basis: "verified-Gmail-thread-clarification-reply"
    });
    console.log(JSON.stringify({ requestId: route.requestId, state: "clarification-sent" }));
  } else if (informationReply) {
    const requesterInformation = await readRequesterInformation();
    await replyWithRequesterInformation(page, request, requesterInformation);
    persistEvent({
      type: "provider-information-supplied",
      phrase: confirmation,
      payloadSha256: requestRecord.payloadSha256,
      basis: "verified-Gmail-thread-reply"
    });
    console.log(JSON.stringify({
      targetId,
      outcome: "waiting-external",
      sentAt: new Date().toISOString(),
      recipient: request.recipient
    }));
    process.exitCode = 0;
  } else {

  const composeUrl = new URL("https://mail.google.com/mail/u/0/");
  composeUrl.searchParams.set("view", "cm");
  composeUrl.searchParams.set("fs", "1");
  composeUrl.searchParams.set("tf", "1");
  composeUrl.searchParams.set("to", request.recipient);
  composeUrl.searchParams.set("su", request.subject);
  composeUrl.searchParams.set("body", request.body);
  await page.goto(composeUrl.href, { waitUntil: "domcontentloaded", timeout: 45_000 });
  const subject = page.locator('input[name="subjectbox"]:visible').last();
  await subject.waitFor({ state: "visible" });
  const composeDialog = subject.locator("xpath=ancestor::*[@role='dialog'][1]");
  const scope = await composeDialog.count() ? composeDialog : page;
  const body = scope.locator('[role="textbox"][aria-label*="Message Body"]:visible').first();
  await body.waitFor({ state: "visible" });

  const exactRecipient = cssEscape(request.recipient);
  const recipientChip = scope.locator([
    `[email="${exactRecipient}"]`,
    `[data-hovercard-id="${exactRecipient}"]`,
    `[data-email="${exactRecipient}"]`
  ].join(", "));
  const recipientText = scope.getByText(request.recipient, { exact: true });
  if (!await recipientChip.count() && !await recipientText.count()) {
    throw new Error("Gmail did not resolve the exact canonical recipient; no inquiry was sent.");
  }
  if (await subject.inputValue() !== request.subject) throw new Error("Gmail subject verification failed; no inquiry was sent.");
  if (normalizedVerificationText(await body.innerText()) !== normalizedVerificationText(request.body)) {
    throw new Error("Gmail body verification failed; no inquiry was sent.");
  }

  const send = scope.getByRole("button", { name: /^send/i }).last();
  await send.waitFor({ state: "visible" });
  persistEvent({ type: "submission-started", basis: "verified-Gmail-compose" });
  await send.click();
  await page.getByRole("alert").filter({ hasText: /message sent/i }).waitFor({ state: "visible", timeout: 20_000 });
  persistEvent({ type: "submission-confirmed", basis: "Gmail-message-sent-alert" });

  console.log(JSON.stringify({
    targetId,
    outcome: "waiting-external",
    sentAt: new Date().toISOString(),
    recipient: request.recipient
  }));
  }
} finally {
  await session.close();
  execFileSync(process.execPath, ["tools/sync-external-request-projections.mjs"], { cwd: projectRoot, stdio: "inherit" });
}

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  return index < 0 ? "" : process.argv[index + 1] || "";
}

function cssEscape(value) {
  return String(value).replace(/(["\\#.;:[\],>+~*^$|=! ])/g, "\\$1");
}

function normalizedVerificationText(value) {
  return String(value).replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

async function readRequesterInformation() {
  console.log("Awaiting requester information on standard input; its value will not be logged.");
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    lines.close();
    const value = String(line || "").trim();
    if (value.length < 10 || value.length > 500 || !/\d/.test(value)) {
      throw new Error("Requester information must be one non-empty postal-address line of 10-500 characters.");
    }
    return value;
  }
  throw new Error("No requester information was provided on standard input.");
}

async function replyWithRequesterInformation(page, request, requesterInformation) {
  const search = page.locator('input[aria-label="Search mail"], input[placeholder="Search mail"]').first();
  await search.waitFor({ state: "visible" });
  const query = `in:anywhere -in:drafts subject:"${request.subject.replaceAll('"', "")}"`;
  await search.fill(query);
  await search.press("Enter");
  await page.waitForTimeout(3_000);
  const subjectMatches = await visibleLocators(page.getByText(request.subject, { exact: false }));
  if (!subjectMatches.length) throw new Error("The exact canonical response thread is absent from the Inbox; no reply was sent.");
  await subjectMatches[0].click();
  await page.waitForTimeout(2_000);
  const expandAll = (await visibleLocators(page.locator('[aria-label*="Expand all"], [data-tooltip*="Expand all"]')))[0];
  if (expandAll) {
    await expandAll.click();
    await page.waitForTimeout(1_000);
  }

  const accountEmail = await currentAccountEmail(page);
  if (!accountEmail) throw new Error("The Gmail account identity could not be verified; no reply was sent.");
  const messages = page.locator("div.adn.ads");
  let providerMessage = null;
  for (let index = 0; index < await messages.count(); index += 1) {
    const message = messages.nth(index);
    const senderEmail = await messageSenderEmail(message);
    const messageBody = await message.locator("div.a3s.aiL").first().innerText().catch(() => "");
    if (senderEmail && senderEmail !== accountEmail && /postal(?:ische)?\s+(?:address|adresse)|full postal address/i.test(messageBody)) {
      providerMessage = message;
    }
  }
  if (!providerMessage) throw new Error("No provider message requesting a postal address was found in the exact thread; no reply was sent.");

  const replyControls = await visibleLocators(providerMessage.locator([
    '[aria-label="Reply"]',
    '[data-tooltip="Reply"]',
    '[role="button"][aria-label*="Reply" i]'
  ].join(", ")));
  if (!replyControls.length) throw new Error("The exact provider message has no visible Reply control; no reply was sent.");
  await replyControls.at(-1).click();

  const body = page.locator('[role="textbox"][aria-label*="Message Body"]:visible, div[contenteditable="true"][aria-label*="Message Body"]:visible').last();
  await body.waitFor({ state: "visible" });
  const replyText = `Thank you for your reply. My full postal address is:\n\n${requesterInformation}\n\nKind regards,\n${ownerName()}`;
  await body.fill(replyText);
  if (normalizedVerificationText(await body.innerText()) !== normalizedVerificationText(replyText)) {
    throw new Error("Gmail reply-body verification failed; no reply was sent.");
  }
  const sendControls = await visibleLocators(page.getByRole("button", { name: /^send/i }));
  if (!sendControls.length) throw new Error("The Gmail reply has no visible Send control; no reply was sent.");
  await sendControls.at(-1).click();
  await page.getByRole("alert").filter({ hasText: /message sent/i }).waitFor({ state: "visible", timeout: 20_000 });
}

// The bound subject can live on the spec (an inquiry we sent) or on the
// response binding (a form submission the provider answered by email).
function boundReplySubject(record) {
  const subject = record.spec?.subject || record.responseBinding?.subject;
  if (typeof subject !== "string" || !subject || /[\r\n]/.test(subject) || subject.length > 240) {
    throw new Error("The request has no safe canonical response subject binding; no reply was sent.");
  }
  return subject;
}

async function readReplyBodyFromStdin() {
  const lines = [];
  const reader = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of reader) lines.push(line);
  const body = lines.join("\n").trim();
  if (!body || body.length > 4_000) throw new Error("Provide the reply body on standard input, at most 4000 characters.");
  return body;
}

// Replies inside the exact bound thread. No address is ever typed or stored:
// the thread subject and a provider-sent message are the whole binding.
async function replyInBoundThread(page, record, replyText, { messageId = "" } = {}) {
  const openedById = messageId ? await openThreadByMessageId(page, messageId).then(() => true, () => false) : false;
  if (!openedById) {
    if (messageId) await page.goto("https://mail.google.com/mail/u/0/#inbox", { waitUntil: "domcontentloaded", timeout: 45_000 });
    await openThreadBySubject(page, boundReplySubject(record));
  }
  await replyToLatestProviderMessage(page, replyText, { messageId });
}

async function openThreadByMessageId(page, messageId) {
  if (!/^[0-9a-f]{16}$/.test(messageId)) throw new Error("Unsafe Gmail message ID; no reply was sent.");
  await page.goto(`https://mail.google.com/mail/u/0/#all/${messageId}`, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page.locator("div.adn.ads").first().waitFor({ state: "visible", timeout: 20_000 })
    .catch(() => { throw new Error(`Gmail message ${messageId} did not open; no reply was sent.`); });
}

async function openThreadBySubject(page, subject) {
  const search = page.locator('input[aria-label="Search mail"], input[placeholder="Search mail"]').first();
  await search.waitFor({ state: "visible" });
  await search.fill(`in:anywhere -in:drafts subject:"${subject.replaceAll('"', "")}"`);
  await search.press("Enter");
  await page.waitForTimeout(3_000);
  const rows = page.locator("tr.zA:visible");
  const matches = [];
  for (let index = 0; index < await rows.count(); index += 1) {
    const row = rows.nth(index);
    const rowSubject = await row.locator(".bog, .bqe").first().innerText().catch(() => "");
    const canonical = (value) => String(value || "").replace(/\s+/g, " ").trim()
      .replace(/^(?:(?:re|fw|fwd)\s*:\s*)+/i, "").toLocaleLowerCase();
    if (canonical(rowSubject) === canonical(subject)) {
      matches.push({ row, inbound: /^(?:(?:re|fw|fwd)\s*:\s*)+/i.test(String(rowSubject).trim()) });
    }
  }
  // As in inspect-inquiry-response: our own outbound enquiry can sit beside
  // the provider's reply thread, so a single "Re:" thread is the binding.
  const inbound = matches.filter((match) => match.inbound);
  const chosen = inbound.length === 1 ? inbound[0] : matches.length === 1 ? matches[0] : null;
  if (!chosen) throw new Error(`Expected exactly one bound thread for ${subject}; no reply was sent.`);
  // A row with inline attachment chips swallows a centre click, so open by subject.
  const subjectCell = chosen.row.locator("span.bog").first();
  const clickable = await subjectCell.isVisible().catch(() => false) ? subjectCell : chosen.row;
  await clickable.click();
  await page.locator("div.adn.ads").first().waitFor({ state: "visible", timeout: 20_000 });
}

// Replies to the exact quoted message when its ID is known and present,
// otherwise to the thread's latest provider message.
async function replyToLatestProviderMessage(page, replyText, { messageId = "" } = {}) {
  const accountEmail = await currentAccountEmail(page);
  if (!accountEmail) throw new Error("The Gmail account identity could not be verified; no reply was sent.");
  const messages = page.locator("div.adn.ads");
  let providerMessage = null;
  let exactMessage = null;
  for (let index = 0; index < await messages.count(); index += 1) {
    const message = messages.nth(index);
    const senderEmail = await messageSenderEmail(message);
    if (!senderEmail || senderEmail === accountEmail) continue;
    providerMessage = message;
    if (messageId && await messageCarriesId(message, messageId)) exactMessage = message;
  }
  providerMessage = exactMessage || providerMessage;
  if (!providerMessage) throw new Error("The bound thread holds no provider message; no reply was sent.");

  const replyControls = await visibleLocators(providerMessage.locator([
    '[aria-label="Reply"]',
    '[data-tooltip="Reply"]',
    '[role="button"][aria-label*="Reply" i]'
  ].join(", ")));
  if (!replyControls.length) throw new Error("The provider message has no visible Reply control; no reply was sent.");
  await replyControls.at(-1).click();

  const body = page.locator('[role="textbox"][aria-label*="Message Body"]:visible, div[contenteditable="true"][aria-label*="Message Body"]:visible').last();
  await body.waitFor({ state: "visible" });
  await body.fill(replyText);
  if (normalizedVerificationText(await body.innerText()) !== normalizedVerificationText(replyText)) {
    throw new Error("Gmail reply-body verification failed; no reply was sent.");
  }
  const sendControls = await visibleLocators(page.getByRole("button", { name: /^send/i }));
  if (!sendControls.length) throw new Error("The Gmail reply has no visible Send control; no reply was sent.");
  await sendControls.at(-1).click();
  await page.getByRole("alert").filter({ hasText: /message sent/i }).waitFor({ state: "visible", timeout: 20_000 });
}

async function visibleLocators(locator) {
  const result = [];
  for (let index = 0; index < await locator.count(); index += 1) {
    const candidate = locator.nth(index);
    if (await candidate.isVisible().catch(() => false)) result.push(candidate);
  }
  return result;
}

async function messageCarriesId(message, messageId) {
  for (const attribute of ["data-legacy-message-id", "data-message-id"]) {
    if (await message.getAttribute(attribute).catch(() => "") === messageId) return true;
    if (await message.locator(`[${attribute}="${messageId}"]`).count().catch(() => 0)) return true;
  }
  return false;
}

async function messageSenderEmail(message) {
  const sender = message.locator('.gE .gD[email], span.gD[email]').first();
  return String(await sender.getAttribute("email").catch(() => "") || "").trim().toLocaleLowerCase();
}

async function currentAccountEmail(page) {
  const account = page.locator('[aria-label^="Google Account"], [aria-label*="Google Account:"]').first();
  const label = await account.getAttribute("aria-label").catch(() => "");
  const match = String(label || "").match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match ? match[0].toLocaleLowerCase() : "";
}

function persistEvent(event) {
  requestRecord = appendExternalRequestEvent(requestRecord, event, { expectedRevision: requestRecord.revision });
  const temporary = `${requestFile}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(requestRecord, null, 2)}\n`, { flag: "wx" });
  fs.renameSync(temporary, requestFile);
  execFileSync(process.execPath, ["tools/sync-external-request-projections.mjs"], { cwd: projectRoot, stdio: "inherit" });
}
