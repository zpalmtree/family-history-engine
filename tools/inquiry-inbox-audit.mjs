#!/usr/bin/env node

import { chromium } from "playwright-core";
import { openSharedChromeTask, sharedChromeEndpoint } from "./shared-chrome-task.mjs";
import { requireConsent } from "./consents.mjs";
requireConsent("mailbox-read");

const endpoint = valueAfter("--endpoint") || sharedChromeEndpoint;
const affinitySlot = valueAfter("--affinity-slot") || "inquiry-inbox-audit";
const queryText = valueAfter("--query");
const scope = valueAfter("--scope") || "inbox";
const includeReplies = process.argv.includes("--include-replies");

if (!process.argv.includes("--shared-window") || endpoint !== sharedChromeEndpoint) {
  throw new Error(`Inbox audits must use the shared Windows Chrome wrapper at ${sharedChromeEndpoint}.`);
}
if (!queryText || queryText.length > 80 || /[\r\n]/.test(queryText)) {
  throw new Error("Pass one bounded Gmail search term of at most 80 characters with --query.");
}
if (!new Set(["inbox", "anywhere"]).has(scope)) throw new Error("--scope must be inbox or anywhere.");

const session = await openSharedChromeTask({
  chromium,
  endpoint,
  taskLabel: "inquiry inbox sender audit",
  affinitySlot,
  timeoutMs: 20_000,
});

try {
  const page = session.page;
  page.setDefaultTimeout(15_000);
  await page.goto("https://mail.google.com/mail/u/0/#inbox", {
    waitUntil: "domcontentloaded",
    timeout: 45_000,
  });
  await page.waitForTimeout(2_000);
  const search = page.locator('input[aria-label="Search mail"], input[placeholder="Search mail"]').first();
  if (!await search.isVisible().catch(() => false)) {
    console.log(JSON.stringify({ state: "manual-signin-required", query: queryText, threads: [] }));
    process.exitCode = 2;
  } else {
    const query = `in:${scope} ${queryText}`;
    await search.fill(query);
    await search.press("Enter");
    await page.waitForTimeout(3_000);
    const rowCount = Math.min(await page.locator("tr.zA:visible").count(), 20);
    const threads = [];
    for (let index = 0; index < rowCount; index += 1) {
      const rows = page.locator("tr.zA:visible");
      const row = rows.nth(index);
      const sender = clean(await row.locator(".yX.xY span[email], .yX.xY span[name]").first().getAttribute("name").catch(() => "")
        || await row.locator(".yX.xY").first().innerText().catch(() => ""));
      const senderEmail = clean(await row.locator(".yX.xY span[email]").first().getAttribute("email").catch(() => ""));
      const subject = clean(await row.locator(".bog, .bqe").first().innerText().catch(() => ""));
      const received = clean(await row.locator("td.xW span[title], td.xW span").first().getAttribute("title").catch(() => "")
        || await row.locator("td.xW").first().innerText().catch(() => ""));
      if (subject) {
        const thread = { sender, senderEmail, subject, received };
        if (includeReplies) {
          thread.replies = await inspectThread(page, row);
          if (thread.replies.diagnostic) thread.replyDiagnostic = thread.replies.diagnostic;
        }
        threads.push(thread);
      }
      if (includeReplies && index < 19) {
        await page.goto("https://mail.google.com/mail/u/0/#inbox", { waitUntil: "domcontentloaded", timeout: 45_000 });
        await page.waitForTimeout(1_000);
        const refreshedSearch = page.locator('input[aria-label="Search mail"], input[placeholder="Search mail"]').first();
        await refreshedSearch.fill(query);
        await refreshedSearch.press("Enter");
        await page.waitForTimeout(2_000);
      }
    }
    console.log(JSON.stringify({ state: "inbox-audited", query, threadCount: threads.length, threads }, null, 2));
  }
} finally {
  await session.close();
}

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  return index < 0 ? "" : process.argv[index + 1] || "";
}

function clean(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 240);
}

async function inspectThread(page, row) {
  // Open the conversation by its thread id rather than by clicking: rows with
  // attachments put the attachment chip where a click lands, which opens the
  // preview (projector) instead of the conversation.
  const threadId = await row.locator("[data-legacy-thread-id]").first().getAttribute("data-legacy-thread-id").catch(() => "");
  const threadAttributes = await row.evaluate((element) => [...element.querySelectorAll("[data-thread-id],[data-legacy-thread-id],[data-thread-perm-id]")]
    .slice(0, 3).map((node) => Object.fromEntries([...node.attributes].filter((a) => a.name.startsWith("data-")).map((a) => [a.name, a.value.slice(0, 40)])))).catch(() => []);
  // The sender cell carries no attachment chip, so a click there opens the
  // conversation itself.
  const senderCell = row.locator(".yX.xY").first();
  if (await senderCell.isVisible().catch(() => false)) await senderCell.click();
  else await row.click();
  await page.waitForTimeout(1_500);
  if (/projector=/.test(page.url())) await page.keyboard.press("Escape").catch(() => {});
  const opened = await page.locator("h2.hP").first().isVisible().catch(() => false);
  if (!opened && /^[0-9a-f]{8,32}$/i.test(threadId || "")) {
    // Hash navigation alone is ignored by the single-page app; load the
    // conversation route as a full page.
    await page.goto(`https://mail.google.com/mail/u/0/#all/${threadId}`, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.reload({ waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => {});
  }
  await page.locator("h2.hP").first().waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(1_000);
  const expandAll = page.locator('[aria-label*="Expand all"], [data-tooltip*="Expand all"]').first();
  if (await expandAll.isVisible().catch(() => false)) await expandAll.click().catch(() => {});
  await page.waitForTimeout(1_000);
  // Gmail renders each expanded message as div.adn (with or without .ads);
  // its body is div.a3s (the .aiL modifier is not always present).
  const messages = page.locator("div.adn");
  const replies = [];
  for (let index = 0; index < await messages.count(); index += 1) {
    const message = messages.nth(index);
    const body = await message.locator("div.a3s").first().innerText().catch(() => "");
    const senderEmail = await message.locator("[email]").first().getAttribute("email").catch(() => "") || "";
    const attachmentNames = await message.locator("span.aV3").allInnerTexts().catch(() => []);
    if (body) {
      replies.push({
        senderEmail: redact(senderEmail),
        excerpt: redact(body),
        ...(attachmentNames.length ? { attachments: attachmentNames.map((name) => clean(name)).filter(Boolean).slice(0, 10) } : {})
      });
    }
  }
  if (!replies.length) {
    // Fallback for markup drift: read the conversation pane's text (redacted
    // like every excerpt) so a provider reply is never silently missed.
    await page.waitForTimeout(3_000);
    const mainText = await page.locator("[role='main']").first().innerText().catch(() => "");
    if (/\S/.test(mainText)) replies.push({ senderEmail: "", excerpt: redact(mainText), source: "conversation-pane-fallback" });
  }
  if (!replies.length || replies[0].source === "conversation-pane-fallback") {
    // Record what the opened view exposed so a selector drift is diagnosable.
    replies.diagnostic = {
      heading: clean(await page.locator("h2.hP").first().innerText().catch(() => "")),
      messageContainers: await page.locator("div.adn").count().catch(() => -1),
      bodies: await page.locator("div.a3s").count().catch(() => -1),
      listItems: await page.locator("[role='listitem']").count().catch(() => -1),
      messageIds: await page.locator("[data-message-id]").count().catch(() => -1),
      hash: new URL(page.url()).hash.slice(0, 60),
      threadAttributes
    };
  }
  return replies;
}

function redact(value) {
  const lines = String(value || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines
    // Postal addresses are short lines; a long prose line (a fee or access
    // paragraph) that happens to hold a number and "way" or "court" is not one.
    .map((line) => line.length <= 100 && (/\b\d{1,6}\s+[^\n]{1,80}\s+(?:street|st|road|rd|avenue|ave|trail|trl|lane|ln|drive|dr|court|ct|boulevard|blvd|way|place|pl)\b/i.test(line)
      || /\b\d{5}(?:-\d{4})?\b/.test(line)) ? "[postal address redacted]" : line)
    .join("\n")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email redacted]")
    .replace(/\b(?:\+?\d[\d ()./-]{7,}\d)\b/g, "[phone redacted]")
    .slice(0, 1800);
}
