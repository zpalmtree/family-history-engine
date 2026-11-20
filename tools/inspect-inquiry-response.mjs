#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { deriveExternalRequest } from "./external-request-store.mjs";
import { openSharedChromeTask, sharedChromeEndpoint } from "./shared-chrome-task.mjs";
import { requireConsent } from "./consents.mjs";
requireConsent("mailbox-read");

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requestId = valueAfter("--request");
const endpoint = valueAfter("--endpoint") || sharedChromeEndpoint;
const affinitySlot = valueAfter("--affinity-slot") || "inquiry-response-inspect";
// Open one exact Gmail conversation by the hex message id a recorded
// fee-quoted or provider-acknowledged basis carries, instead of searching by
// the bound subject: a reply that a ticket system retitled, or a binding
// recorded before the reply arrived, is still reachable. Read-only like the
// subject search; the same sanitized excerpt is emitted.
const messageIdArg = valueAfter("--message-id");
if (messageIdArg && !/^[0-9a-f]{12,20}$/.test(messageIdArg)) {
  throw new Error("--message-id must be one Gmail hex message id.");
}

if (!requestId || !/^[a-z0-9][a-z0-9-]{0,127}$/.test(requestId)) {
  throw new Error("Pass one safe external request ID with --request.");
}
if (!process.argv.includes("--shared-window") || endpoint !== sharedChromeEndpoint) {
  throw new Error(`Response inspection must use the shared Windows Chrome wrapper at ${sharedChromeEndpoint}.`);
}

const requestFile = path.join(projectRoot, "evidence", "acquisition", "requests", `${requestId}.json`);
const request = JSON.parse(fs.readFileSync(requestFile, "utf8"));
const derived = deriveExternalRequest(request);
// Cart-style form submissions record only a summary, so fall back to the kind
// rather than refusing a request whose reply is sitting in the inbox.
const requestChannel = request.spec?.channel || (request.kind === "no-charge-form" ? "form" : "email");
if (!new Set(["no-charge-email", "no-charge-form", "paid-library-request"]).has(request.kind)
  || !new Set(["email", "form"]).has(requestChannel)) {
  throw new Error(`${requestId} is not a canonical email or form inquiry.`);
}
const canonicalSubjects = boundResponseSubjects(request);
const primarySubject = canonicalSubjects[0];
// Reinspection is read-only and must remain available after an acknowledgement
// returns a request to waiting-external. Otherwise a later reply in the same
// Gmail thread cannot be parsed until someone manually manufactures another
// delivery event—the exact orchestration loop this helper is meant to avoid.
if (!["waiting-external", "awaiting-payment-instructions", "delivery-reported", "information-required", "fee-quote-hold", "paid-followup-authorized", "complete"].includes(derived.operationalState)) {
  throw new Error(`${requestId} is ${derived.operationalState}; inspect only a canonically reported delivery.`);
}

const session = await openSharedChromeTask({
  chromium,
  endpoint,
  taskLabel: "inquiry response inspection",
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
  let search = page.locator('input[aria-label="Search mail"], input[placeholder="Search mail"]').first();
  if (!await search.isVisible().catch(() => false)) {
    console.log(JSON.stringify({ requestId, state: "manual-signin-required" }));
    process.exitCode = 2;
  } else {
    const canonicalOutboundText = request.spec.body || "";
    const canonicalBodyPrefix = normalize(canonicalOutboundText).slice(0, 240);
    const messageEntries = [];
    let matchedSubjects = 0;
    const openedThreadIds = [];
    let requesterEmail = await currentAccountEmail(page);
    // The rendered message container is the only reliable signal that a
    // conversation opened: Gmail thread ids are not a fixed charset, so
    // matching the URL misreads an open thread as a closed one.
    const threadOpened = async () =>
      await page.locator("div.adn.ads").first().isVisible().catch(() => false);
    // Reads every message of the conversation on screen into messageEntries.
    const collectOpenThread = async (canonicalSubject) => {
      const expandAll = await firstVisible(page.locator('[aria-label*="Expand all"], [data-tooltip*="Expand all"]'));
      if (expandAll) {
        await expandAll.click();
        await page.waitForTimeout(1_500);
      }
      const messages = page.locator("div.adn.ads");
      for (let index = 0; index < await messages.count(); index += 1) {
        const message = messages.nth(index);
        await expandClippedMessage(message);
        const bodyNode = message.locator("div.a3s.aiL").first();
        const body = await bodyNode.innerText().catch(() => "");
        const senderEmail = await messageSenderEmail(message);
        const senderName = await messageSenderName(message);
        const canonicalOutbound = Boolean(canonicalBodyPrefix && body
          && normalize(body).startsWith(canonicalBodyPrefix));
        if (canonicalOutbound && senderEmail) requesterEmail = senderEmail;
        const messageId = await messageDiscriminator(message);
        const filenameNodes = await visibleLocators(message.locator("span.aV3"));
        const gmailAttachmentLabels = (await Promise.all(filenameNodes.map((node) => node.innerText().catch(() => ""))))
          .map(sanitizeLabel)
          .filter(safeAttachmentLabel);
        const linkedAttachmentLabels = await exactLinkedAttachmentLabels(message);
        messageEntries.push({
          body,
          senderEmail,
          senderName,
          canonicalOutbound,
          messageId,
          subjectBinding: canonicalSubject,
          attachmentLabels: [...new Set([...gmailAttachmentLabels, ...linkedAttachmentLabels])]
        });
      }
    };
    if (messageIdArg) {
      await page.goto(`https://mail.google.com/mail/u/0/#all/${messageIdArg}`, {
        waitUntil: "domcontentloaded",
        timeout: 45_000
      });
      await page.locator("div.adn.ads").first().waitFor({ state: "visible", timeout: 20_000 }).catch(() => {});
      if (!await threadOpened()) {
        throw new Error(`Gmail message ${messageIdArg} did not open as a conversation; no reply metadata was emitted.`);
      }
      await collectOpenThread(`gmail-message-${messageIdArg}`);
    }
    for (let subjectIndex = 0; subjectIndex < (messageIdArg ? 0 : canonicalSubjects.length); subjectIndex += 1) {
      const canonicalSubject = canonicalSubjects[subjectIndex];
      // Search the complete mailbox so separately titled provider replies and
      // scanner deliveries remain inspectable after archiving. Ticket systems
      // may replace the subject with a generic alias; aliases are searched only
      // with request-specific terms so two unrelated tickets cannot be merged.
      // Gmail can split one correspondence into several conversations under
      // the same exact subject (the archive answers the original send in one
      // and a later reply in another). Every exact match is the request's own
      // mail, so each conversation is read; picking one missed Hunts Archives'
      // 19 Nov 2026 delivery in the original thread. The search is rerun for
      // each conversation and its own row (by Gmail thread id) is clicked.
      let threadIds = [];
      let threadQuery = "";
      for (const query of responseSubjectQueries(request, canonicalSubject, primarySubject)) {
        threadIds = await searchForCanonicalThreads(page, search, query, canonicalSubject);
        threadQuery = query;
        if (threadIds.length) break;
      }
      // An alias is an alternative title a ticket system might apply, not a
      // second thread that must also exist. Only the complete absence of every
      // bound subject is a failure.
      if (!threadIds.length) {
        if (subjectIndex < canonicalSubjects.length - 1 || matchedSubjects) continue;
        throw new Error(`The exact bound response thread is absent for subject ${canonicalSubject}.`);
      }
      matchedSubjects += 1;
      for (const [threadIndex, threadId] of threadIds.entries()) {
        if (threadIndex > 0) {
          // Gmail swaps conversations in place, so leave the open one and wait
          // for it to close before searching again, or it is read twice.
          await page.goto("https://mail.google.com/mail/u/0/#inbox", { waitUntil: "domcontentloaded", timeout: 45_000 });
          await page.locator("div.adn.ads").first().waitFor({ state: "hidden", timeout: 20_000 });
          search = page.locator('input[aria-label="Search mail"], input[placeholder="Search mail"]').first();
          await search.waitFor({ state: "visible", timeout: 20_000 });
          const again = await searchForCanonicalThreads(page, search, threadQuery, canonicalSubject);
          if (!again.includes(threadId)) throw new Error("An exact canonical response thread left the search results; no reply metadata was emitted.");
        }
        const threadRow = page.locator("tr.zA:visible", { has: page.locator(`[data-legacy-thread-id="${threadId}"]`) }).first();
        // Gmail re-renders result rows while the list settles, so a click can be
        // swallowed and leave the list on screen. Confirm the conversation view
        // actually opened instead of reporting an unopened thread as empty.
        // A result row that carries inline attachment chips is taller than its
        // subject line, so clicking the row centre lands on a chip and opens an
        // attachment preview instead of the conversation. Click the subject span
        // itself, and dismiss any preview a previous attempt opened.
        const subjectCell = threadRow.locator("span.bog").first();
        for (let attempt = 0; attempt < 3 && !await threadOpened(); attempt += 1) {
          if (attempt > 0) {
            await page.keyboard.press("Escape").catch(() => {});
            await page.waitForTimeout(500);
          }
          const clickable = await subjectCell.isVisible().catch(() => false) ? subjectCell : threadRow;
          await clickable.click({ timeout: 10_000 }).catch(() => {});
          await page.locator("div.adn.ads").first()
            .waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
        }
        if (!await threadOpened()) {
          throw new Error(`The bound response thread for subject ${canonicalSubject} did not open; no reply metadata was emitted.`);
        }
        openedThreadIds.push(threadId);
        await collectOpenThread(canonicalSubject);
      }
      if (subjectIndex < canonicalSubjects.length - 1) {
        await page.goto("https://mail.google.com/mail/u/0/#inbox", {
          waitUntil: "domcontentloaded",
          timeout: 45_000
        });
        await page.waitForTimeout(2_000);
        search = page.locator('input[aria-label="Search mail"], input[placeholder="Search mail"]').first();
        if (!await search.isVisible().catch(() => false)) throw new Error("Gmail search became unavailable between bound response threads.");
      }
    }
    if (!requesterEmail) throw new Error("The original canonical outbound message could not be bound to its requester account.");
    const uniqueEntries = [...new Map(messageEntries.map((entry) => [
      entry.messageId || `${entry.senderEmail}\n${normalize(entry.body)}`,
      entry
    ])).values()];
    const replies = [];
    for (const entry of uniqueEntries) {
      const { body, senderEmail, senderName, canonicalOutbound, messageId, attachmentLabels, subjectBinding } = entry;
      if (!body || canonicalOutbound || !senderEmail || senderEmail === requesterEmail) continue;
      if (!messageId) throw new Error("A provider reply lacks a stable Gmail message discriminator; no reply metadata was emitted.");
      replies.push({
        ordinal: replies.length + 1,
        messageId,
        senderName,
        subjectBinding,
        embeddedForwardCount: countEmbeddedForwards(body),
        attachmentCount: attachmentLabels.length,
        attachmentLabels,
        responseExcerpt: sanitizeResponse(body)
      });
    }
    const attachmentLabels = replies.flatMap((reply) => reply.attachmentLabels);
    const embeddedForwardCount = replies.reduce((sum, reply) => sum + reply.embeddedForwardCount, 0);
    const requesterMessageCount = uniqueEntries.filter((entry) => entry.senderEmail === requesterEmail).length;
    console.log(JSON.stringify({
      requestId,
      state: "response-inspected",
      threadIds: openedThreadIds,
      messageCount: uniqueEntries.length,
      requesterMessageCount,
      replyCount: replies.length,
      embeddedForwardCount,
      attachmentCount: attachmentLabels.length,
      attachmentLabels,
      replies
    }, null, 2));
  }
} finally {
  await session.close();
}

async function visibleLocators(locator) {
  const result = [];
  for (let index = 0; index < await locator.count(); index += 1) {
    const candidate = locator.nth(index);
    if (await candidate.isVisible().catch(() => false)) result.push(candidate);
  }
  return result;
}

// Gmail collapses long provider replies behind a visible "View entire
// message"/"Show trimmed content" control.  Expand that control inside the
// bound message before reading its body so a later reply in the same thread is
// not reduced to a misleading clipped excerpt.  The helper is deliberately
// text-bound and read-only: it never navigates away from the exact canonical
// thread or clicks account/attachment controls.
async function expandClippedMessage(message) {
  const explicitControls = message.locator('a.ajT, a:has-text("View entire message"), a:has-text("Show trimmed content"), [aria-label="View entire message"], [aria-label="Show trimmed content"]');
  for (let index = 0; index < await explicitControls.count(); index += 1) {
    const control = explicitControls.nth(index);
    if (!await control.isVisible().catch(() => false)) continue;
    await control.click().catch(() => {});
    await message.page().waitForTimeout(400);
    return;
  }
  const textControls = message.getByText(/view entire message|show trimmed content/i);
  for (let index = 0; index < await textControls.count(); index += 1) {
    const control = textControls.nth(index);
    if (!await control.isVisible().catch(() => false)) continue;
    await control.click().catch(() => {});
    await message.page().waitForTimeout(400);
    return;
  }
  const controls = message.locator('a, button, div[role="button"], span[role="button"]');
  for (let index = 0; index < await controls.count(); index += 1) {
    const control = controls.nth(index);
    if (!await control.isVisible().catch(() => false)) continue;
    const label = normalize(await control.innerText().catch(() => ""));
    if (!/^(view entire message|show trimmed content)$/i.test(label)) continue;
    await control.click().catch(() => {});
    await message.page().waitForTimeout(250);
    break;
  }
}

async function exactLinkedAttachmentLabels(message) {
  const anchors = await visibleLocators(message.locator("a[href]"));
  const labels = [];
  for (const anchor of anchors) {
    const label = sanitizeLabel(await anchor.innerText().catch(() => ""));
    if (!safeAttachmentLabel(label)) continue;
    const href = await anchor.getAttribute("href").catch(() => "") || "";
    let parsed;
    try { parsed = new URL(href); } catch { continue; }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) continue;
    labels.push(label);
  }
  return [...new Set(labels)];
}

async function firstVisible(locator) {
  const items = await visibleLocators(locator);
  return items[0] || null;
}

async function messageSenderEmail(message) {
  const sender = message.locator('.gE .gD[email], span.gD[email]').first();
  return String(await sender.getAttribute("email").catch(() => "") || "").trim().toLocaleLowerCase();
}

async function messageSenderName(message) {
  const sender = message.locator('.gE .gD, span.gD').first();
  const name = await sender.getAttribute("name").catch(() => "")
    || await sender.innerText().catch(() => "");
  return sanitizeLabel(name);
}

async function currentAccountEmail(page) {
  const account = page.locator('[aria-label^="Google Account"], [aria-label*="Google Account:"]').first();
  const label = await account.getAttribute("aria-label").catch(() => "");
  const match = String(label || "").match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match ? match[0].toLocaleLowerCase() : "";
}

async function messageDiscriminator(message) {
  for (const attribute of ["data-legacy-message-id", "data-message-id"]) {
    const direct = await message.getAttribute(attribute).catch(() => "");
    if (safeMessageId(direct)) return direct;
    const nested = message.locator(`[${attribute}]`).first();
    const value = await nested.getAttribute(attribute).catch(() => "");
    if (safeMessageId(value)) return value;
  }
  return "";
}

function safeMessageId(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{6,128}$/.test(value);
}

function boundResponseSubjects(request) {
  const primary = request.spec?.subject || request.responseBinding?.subject;
  const aliases = request.responseBinding?.subjectAliases || [];
  if (!Array.isArray(aliases) || aliases.length > 5) {
    throw new Error(`${requestId} has invalid response subject aliases.`);
  }
  const subjects = [...new Set([primary, ...aliases])];
  if (!subjects.length || subjects.some((subject) => typeof subject !== "string"
    || !subject || /[\r\n]/.test(subject) || subject.length > 240)) {
    throw new Error(`${requestId} has no safe canonical response subject binding.`);
  }
  return subjects;
}

// -in:drafts: a compose that stopped before sending leaves an auto-saved draft with the
// same subject (15 Nov 2026), which must not count as a second canonical thread.
function responseSubjectQueries(request, subject, primarySubject) {
  const exactQuery = `in:anywhere -in:drafts subject:"${subject.replaceAll('"', "")}"`;
  if (canonicalizeSubject(subject) !== canonicalizeSubject(primarySubject)) {
    const terms = responseMatchTerms(request);
    if (!terms.length) throw new Error(`${requestId} has an alias without request-specific match terms.`);
    return [`${exactQuery} ${terms.map((term) => `"${term.replaceAll('"', "")}"`).join(" ")}`];
  }
  return [exactQuery, `in:anywhere -in:drafts ${subjectSearchTerms(subject)}`];
}

function responseMatchTerms(request) {
  const terms = request.responseBinding?.matchTerms || [];
  if (!Array.isArray(terms) || terms.length > 8 || terms.some((term) => typeof term !== "string"
    || !term.trim() || /[\r\n]/.test(term) || term.length > 120)) {
    throw new Error(`${requestId} has invalid response match terms.`);
  }
  return [...new Set(terms.map((term) => term.trim()))];
}

function sanitizeLabel(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 240);
}

function safeAttachmentLabel(value) {
  if (typeof value !== "string"
    || !/^[^\\/\r\n]{1,220}\.(?:jpe?g|png|tiff?|pdf)$/i.test(value)) return false;
  // Gmail's attachment-preview anchor can repeat the accessible filename in
  // one long label ("Preview attachment x.jpg ... x.jpg"). The actual card
  // is already counted via span.aV3, so accept only one media-extension token
  // here and never manufacture duplicate delivery artifacts from preview UI.
  return (value.match(/\.(?:jpe?g|png|tiff?|pdf)\b/gi) || []).length === 1;
}

function sanitizeResponse(value) {
  const sourceLines = String(value || "").split(/\r?\n/).map((line) => line.trim());
  const signatureIndex = sourceLines.findIndex((line) => /^(please contact|best(?: regards)?|kind regards|sincerely|mit freundlichen gr[uü]ßen|freundliche gr[uü]ße|caution external email|disclaimer notice)/i.test(line));
  const lines = (signatureIndex >= 0 ? sourceLines.slice(0, signatureIndex) : sourceLines)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => postalAddressLine(line) ? "[postal address redacted]" : line)
    .filter((line) => !/^(from|sent|to|subject):/i.test(line))
    .filter((line) => !/^(p|e|tel|telefon|fax):/i.test(line));
  return lines.join("\n")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email redacted]")
    .replace(/\b(?:\+?\d[\d ()./-]{7,}\d)\b/g, "[phone redacted]")
    .replace(/(?:\[postal address redacted\]\n?){2,}/g, "[postal address redacted]\n")
    .slice(0, 5000);
}

function countEmbeddedForwards(value) {
  return (String(value || "").match(/^-{2,}\s*Forwarded Message\s*-{2,}$|^Begin forwarded message:\s*$/gim) || []).length;
}

function postalAddressLine(value) {
  return /\b\d{1,6}\s+[\p{L}0-9.'’-]+(?:\s+[\p{L}0-9.'’-]+){0,6}\s+(?:street|st|road|rd|avenue|ave|trail|trl|lane|ln|drive|dr|court|ct|boulevard|blvd|way|place|pl)\b/iu.test(value)
    || /\b\d{5}(?:-\d{4})?\b/.test(value);
}

function normalize(value) {
  return String(value || "").replace(/\s+/g, " ").trim().toLocaleLowerCase();
}

// Returns the Gmail thread id of every result row whose subject is exactly the
// bound canonical subject (ignoring Re:/Fw: prefixes). A matching row without a
// thread id is a failure, so no exact conversation is silently skipped.
async function searchForCanonicalThreads(page, search, query, canonicalSubject) {
  await search.fill(query);
  await search.press("Enter");
  await page.waitForTimeout(3_000);
  const rows = page.locator("tr.zA:visible");
  const threadIds = [];
  for (let index = 0; index < await rows.count(); index += 1) {
    const row = rows.nth(index);
    const subject = await row.locator(".bog, .bqe").first().innerText().catch(() => "");
    if (canonicalizeSubject(subject) !== canonicalizeSubject(canonicalSubject)) continue;
    const threadId = await row.locator("[data-legacy-thread-id]").first()
      .getAttribute("data-legacy-thread-id").catch(() => "");
    if (!/^[0-9a-f]{12,20}$/.test(threadId || "")) {
      throw new Error("An exact canonical response thread has no Gmail thread id; no thread was opened.");
    }
    threadIds.push(threadId);
  }
  if (threadIds.length > 12) throw new Error("More than twelve exact canonical response threads matched; no thread was opened.");
  return [...new Set(threadIds)];
}

function canonicalizeSubject(value) {
  return normalize(value)
    .replace(/^(?:(?:re|fw|fwd)\s*:\s*)+/i, "")
    .normalize("NFKC");
}

function subjectSearchTerms(value) {
  const words = canonicalizeSubject(value)
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(/\s+/)
    .filter((word) => word.length >= 3)
    .slice(0, 8);
  if (!words.length) throw new Error("The canonical subject has no safe fallback search terms.");
  return words.join(" ");
}

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  return index < 0 ? "" : process.argv[index + 1] || "";
}
