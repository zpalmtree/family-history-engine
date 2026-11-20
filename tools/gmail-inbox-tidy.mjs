#!/usr/bin/env node
// Inbox tidy for the shared Gmail account, at the user's request of 18 Nov
// 2026 (archive or delete research/payment mail that has been processed).
//
// list: sender, subject, date and legacy thread id of every inbox row (no
//       bodies), paging with Gmail's own "Older" control.
// act:  for each "<threadId>" in --archive / --trash, selects that exact
//       inbox row (one row only) and presses the list toolbar's Archive or
//       Delete control. A thread that is no longer on the first inbox page, or
//       whose subject differs from the one listed (--expect file), is skipped.
//       Delete moves to Bin (30 days). The run waits out Gmail's Undo window
//       before closing, or the last action is dropped.
// archived-unread: the same row fields for unread threads outside the inbox
//       (last 60 days, not spam or bin), so mail archived before the tidy
//       marked it read can be found (20 Nov 2026).
// markread: for each "<threadId>" in --markread, selects that exact row in
//       the archived-unread search and presses Mark as read. Nothing moves.
// Archived threads stay reachable: the inbox sweep and response inspector
// search in:anywhere.
import fs from "node:fs";
import { chromium } from "playwright-core";
import { openSharedChromeTask, sharedChromeEndpoint } from "./shared-chrome-task.mjs";
import { requireConsent } from "./consents.mjs";

const valueAfter = (flag) => { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : undefined; };
const endpoint = valueAfter("--endpoint") || sharedChromeEndpoint;
const mode = valueAfter("--mode") || "list";
requireConsent(["act", "markread"].includes(mode) ? "inbox-tidy" : "mailbox-read");
const archivedUnreadUrl = "https://mail.google.com/mail/u/0/#search/-in%3Ainbox+is%3Aunread+-in%3Aspam+-in%3Atrash+newer_than%3A60d";
const affinitySlot = valueAfter("--affinity-slot") || "gmail-inbox-tidy";
if (!process.argv.includes("--shared-window") || endpoint !== sharedChromeEndpoint) {
  throw new Error(`Gmail tidy must use the shared Windows Chrome wrapper at ${sharedChromeEndpoint}.`);
}
const ids = (flag) => String(valueAfter(flag) || "").split(",").map((s) => s.trim()).filter((s) => /^[0-9a-f]{12,20}$/.test(s));
const expect = valueAfter("--expect") ? JSON.parse(fs.readFileSync(valueAfter("--expect"), "utf8")) : {};
const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();

async function listRows(page) {
  return page.$$eval("tr.zA", (rows) => rows.filter((row) => row.offsetParent !== null).map((row) => {
    const idNode = row.querySelector("[data-legacy-thread-id]");
    const senderNode = row.querySelector(".yX.xY span[email]");
    const dateNode = row.querySelector("td.xW span[title]");
    return {
      threadId: idNode?.getAttribute("data-legacy-thread-id") || "",
      sender: senderNode?.getAttribute("name") || row.querySelector(".yX.xY")?.innerText || "",
      senderEmail: senderNode?.getAttribute("email") || "",
      subject: row.querySelector(".bog")?.innerText || "",
      date: dateNode?.getAttribute("title") || "",
      unread: row.classList.contains("zE"),
    };
  }));
}

const session = await openSharedChromeTask({ chromium, endpoint, taskLabel: "gmail inbox tidy", affinitySlot, timeoutMs: 20_000 });
try {
  const page = session.page;
  page.setDefaultTimeout(15_000);
  await page.goto("https://mail.google.com/mail/u/0/#inbox", { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page.waitForSelector("tr.zA, td.TC", { timeout: 30_000 }).catch(() => {});
  await page.waitForTimeout(1_500);
  const account = clean(await page.title());
  if (mode === "list") {
    const all = [];
    for (let pageNo = 0; pageNo < 20; pageNo += 1) {
      const rows = await listRows(page);
      // Gmail's date titles are in this machine's local time, which Node parses here.
      all.push(...rows.map((row) => ({ ...row, sender: clean(row.sender), subject: clean(row.subject), dateMs: Date.parse(row.date) || null })));
      const older = page.locator('div[aria-label="Older"]:visible').first();
      if (!await older.count() || (await older.getAttribute("aria-disabled")) === "true") break;
      const first = rows[0]?.threadId;
      await older.click();
      await page.waitForFunction((id) => { const n = document.querySelector("tr.zA [data-legacy-thread-id]"); return n && n.getAttribute("data-legacy-thread-id") !== id; }, first, { timeout: 15_000 }).catch(() => {});
      await page.waitForTimeout(800);
    }
    console.log(JSON.stringify({ mode, account, count: all.length, rows: all }));
  } else if (mode === "act") {
    const done = [];
    const skipped = [];
    for (const [action, list] of [["archive", ids("--archive")], ["trash", ids("--trash")]]) {
      for (const threadId of list) {
        // List-view route: the thread-view toolbar does not render in a
        // background task tab. Select this exact inbox row by its legacy
        // thread id, check its subject, then use the list toolbar control.
        await page.goto("https://mail.google.com/mail/u/0/#inbox", { waitUntil: "domcontentloaded" });
        await page.waitForSelector("tr.zA", { timeout: 20_000 }).catch(() => {});
        await page.waitForTimeout(800);
        const row = page.locator("tr.zA:visible", { has: page.locator(`[data-legacy-thread-id="${threadId}"]`) }).first();
        if (!await row.count()) { skipped.push({ threadId, reason: "not on the first inbox page" }); continue; }
        const subject = clean(await row.locator(".bog").first().innerText().catch(() => ""));
        if (expect[threadId] && clean(expect[threadId]) !== subject) { skipped.push({ threadId, reason: `subject differs: ${subject.slice(0, 80)}` }); continue; }
        const selected = await page.locator("tr.zA:visible [role=checkbox][aria-checked=true]").count();
        if (selected) { skipped.push({ threadId, reason: "another row was already selected" }); continue; }
        await row.locator("[role=checkbox]").first().click();
        if (await page.locator("tr.zA:visible [role=checkbox][aria-checked=true]").count() !== 1) {
          skipped.push({ threadId, reason: "selection is not exactly this one row" });
          continue;
        }
        // Mark processed mail read before it leaves the inbox (user request,
        // 20 Nov 2026): the list toolbar's "Mark as read" (act 1) acts on the
        // one selected row, which stays selected for the archive click.
        let markedRead = !(await row.getAttribute("class") || "").split(/\s+/).includes("zE");
        if (!markedRead) {
          const markRead = page.locator('div[role="button"][act="1"]:visible').first();
          if (await markRead.count()) {
            await markRead.click();
            await page.waitForFunction((id) => {
              const node = document.querySelector(`tr.zA [data-legacy-thread-id="${id}"]`)?.closest("tr.zA");
              return node && !node.classList.contains("zE");
            }, threadId, { timeout: 10_000 }).catch(() => {});
            markedRead = !(await row.getAttribute("class") || "").split(/\s+/).includes("zE");
          }
          if (await page.locator("tr.zA:visible [role=checkbox][aria-checked=true]").count() !== 1) {
            skipped.push({ threadId, reason: "selection changed after marking read" });
            continue;
          }
        }
        const act = action === "archive" ? "7" : "10";
        const button = page.locator(`div[role="button"][act="${act}"]:visible`).first();
        if (!await button.count()) { skipped.push({ threadId, reason: `no visible ${action} control` }); continue; }
        await button.click();
        await page.locator(`tr.zA [data-legacy-thread-id="${threadId}"]`).first().waitFor({ state: "detached", timeout: 15_000 }).catch(() => {});
        await page.waitForTimeout(700);
        const gone = !await page.locator(`tr.zA:visible [data-legacy-thread-id="${threadId}"]`).count();
        (gone ? done : skipped).push(gone ? { threadId, action, markedRead, subject: subject.slice(0, 100) } : { threadId, reason: "row still in inbox after the click" });
      }
    }
    // Gmail sends a list action to the server only after its Undo window;
    // closing the tab sooner silently drops the last action.
    if (done.length) await page.waitForTimeout(10_000);
    console.log(JSON.stringify({ mode, account, done, skipped }));
  } else if (mode === "archived-unread") {
    await page.goto(archivedUnreadUrl, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("tr.zA, td.TC", { timeout: 20_000 }).catch(() => {});
    await page.waitForTimeout(1_500);
    const rows = (await listRows(page)).map((row) => ({ ...row, sender: clean(row.sender), subject: clean(row.subject), dateMs: Date.parse(row.date) || null }));
    console.log(JSON.stringify({ mode, account, count: rows.length, rows }));
  } else if (mode === "markread") {
    const done = [];
    const skipped = [];
    for (const threadId of ids("--markread")) {
      // Gmail keeps a row selection when the same search hash is loaded again,
      // so leave through the inbox first to start each thread unselected.
      await page.goto("https://mail.google.com/mail/u/0/#inbox", { waitUntil: "domcontentloaded" });
      await page.waitForSelector("tr.zA, td.TC", { timeout: 20_000 }).catch(() => {});
      await page.goto(archivedUnreadUrl, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("tr.zA", { timeout: 20_000 }).catch(() => {});
      await page.waitForTimeout(1_000);
      const row = page.locator("tr.zA:visible", { has: page.locator(`[data-legacy-thread-id="${threadId}"]`) }).first();
      if (!await row.count()) { skipped.push({ threadId, reason: "not among unread archived threads" }); continue; }
      const subject = clean(await row.locator(".bog").first().innerText().catch(() => ""));
      if (expect[threadId] && clean(expect[threadId]) !== subject) { skipped.push({ threadId, reason: `subject differs: ${subject.slice(0, 80)}` }); continue; }
      if (await page.locator("tr.zA:visible [role=checkbox][aria-checked=true]").count()) { skipped.push({ threadId, reason: "another row was already selected" }); continue; }
      await row.locator("[role=checkbox]").first().click();
      if (await page.locator("tr.zA:visible [role=checkbox][aria-checked=true]").count() !== 1) { skipped.push({ threadId, reason: "selection is not exactly this one row" }); continue; }
      const markRead = page.locator('div[role="button"][act="1"]:visible').first();
      if (!await markRead.count()) { skipped.push({ threadId, reason: "no visible Mark as read control" }); continue; }
      await markRead.click();
      await page.waitForFunction((id) => {
        const node = document.querySelector(`tr.zA [data-legacy-thread-id="${id}"]`)?.closest("tr.zA");
        return !node || !node.classList.contains("zE");
      }, threadId, { timeout: 10_000 }).catch(() => {});
      const node = page.locator(`tr.zA:visible [data-legacy-thread-id="${threadId}"]`);
      const stillUnread = await node.count() && (await row.getAttribute("class") || "").split(/\s+/).includes("zE");
      (stillUnread ? skipped : done).push(stillUnread ? { threadId, reason: "still unread after the click" } : { threadId, subject: subject.slice(0, 100) });
    }
    if (done.length) await page.waitForTimeout(10_000);
    console.log(JSON.stringify({ mode, account, done, skipped }));
  } else {
    throw new Error("--mode must be list, act, archived-unread or markread");
  }
} finally {
  await session.close();
}
