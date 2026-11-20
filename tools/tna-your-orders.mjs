#!/usr/bin/env node
// Read-only view of The National Archives Discovery "Your orders" page: the
// text block of one order (page check, record copying or digital download),
// found by an order or page-check number, so a reply such as "Page check
// RC... successful" can be triaged into its copy quote. Never clicks an order,
// basket or payment control. Sign-in uses the guarded saved-credential helper.
import { chromium } from "playwright-core";
import { openSharedChromeTask, sharedChromeEndpoint } from "./shared-chrome-task.mjs";
import { isLoginUrl, trySavedSignIn } from "./saved-signin.mjs";

const valueAfter = (flag) => { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : undefined; };
const endpoint = valueAfter("--endpoint") || sharedChromeEndpoint;
const needles = String(valueAfter("--find") || "").split(",").map((s) => s.trim()).filter((s) => /^[A-Za-z0-9 /.-]{3,40}$/.test(s));
if (!process.argv.includes("--shared-window") || endpoint !== sharedChromeEndpoint) throw new Error("Use the shared Windows Chrome wrapper.");
const copyOrder = valueAfter("--copy-order") || "";
if (copyOrder && !/^RC\d{5,10}$/.test(copyOrder)) throw new Error("--copy-order takes one RC page-check number.");
if (!needles.length && !copyOrder) throw new Error("Pass --find <order or page-check number>[,...] or --copy-order RC<number>.");
const ORDERS_URL = "https://discovery.nationalarchives.gov.uk/account/yourorders";

const session = await openSharedChromeTask({ chromium, endpoint, taskLabel: "tna your orders", affinitySlot: valueAfter("--affinity-slot") || "tna-your-orders", timeoutMs: 20_000 });
try {
  const page = session.page;
  page.setDefaultTimeout(20_000);
  await page.goto(ORDERS_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(2_500);
  if (isLoginUrl("tna", page.url())) {
    await trySavedSignIn(page, "tna").catch(() => null);
    await page.waitForTimeout(4_000);
    if (!page.url().startsWith(ORDERS_URL)) await page.goto(ORDERS_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(2_500);
  }
  if (isLoginUrl("tna", page.url())) { console.log(JSON.stringify({ state: "signin-required", url: page.url() })); process.exitCode = 2; }
  else {
    if (copyOrder) {
      // Read the copy-order options page only; no control on it is touched.
      await page.goto(`https://discovery.nationalarchives.gov.uk/account/copyorder/${copyOrder}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.waitForTimeout(2_000);
      const text = (await page.locator("main, #page_wrap, body").first().innerText()).replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n");
      const controls = await page.$$eval("input, select, label, button", (nodes) => nodes.filter((n) => n.offsetParent !== null).map((n) => `${n.tagName.toLowerCase()}${n.type ? ":" + n.type : ""} ${n.name || ""} ${(n.innerText || n.value || "").trim().slice(0, 80)}`).slice(0, 60));
      console.log(JSON.stringify({ state: "copy-order-read", url: page.url(), text: text.slice(0, 6000), controls }));
    } else {
    const blocks = [];
    let links = [];
    let pages = 0;
    for (let n = 1; n <= 12 && !blocks.length; n += 1) {
      if (n > 1) {
        const next = page.locator('a:text-is("Next")').first();
        if (!await next.count()) break;
        await page.goto(await next.getAttribute("href").then((h) => new URL(h, page.url()).href), { waitUntil: "domcontentloaded", timeout: 60_000 });
        await page.waitForTimeout(1_500);
      }
      pages = n;
      const body = (await page.locator("body").innerText()).replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n");
      for (const needle of needles) {
        let at = body.indexOf(needle);
        while (at >= 0 && blocks.length < 6) { blocks.push({ page: n, needle, text: body.slice(Math.max(0, at - 700), at + 1500) }); at = body.indexOf(needle, at + 1500); }
      }
      if (blocks.length) links = await page.$$eval("a[href]", (as) => as.map((a) => ({ text: a.innerText.trim().slice(0, 60), href: a.href })).filter((l) => /order|copy|pagecheck|record-?copying/i.test(l.href) && !/download\?/.test(l.href)).slice(0, 30));
    }
    console.log(JSON.stringify({ state: "read", url: page.url(), pages, found: blocks.length, blocks, links }));
    }
  }
} finally {
  await session.close();
}
