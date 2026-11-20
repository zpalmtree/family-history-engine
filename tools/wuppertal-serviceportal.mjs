#!/usr/bin/env node
// Wuppertal Service Portal helper, exploration layer. Runs only in the one
// shared Windows Chrome profile through tools/wuppertal-serviceportal-windows.ps1.
//
//   --mode inspect --url <portal url>   open the URL and report structure
//   --mode click --text "<exact text>"  follow one navigation link/button in
//                                        the helper's own tab, then report
//   --mode status                       report the helper tab's current page
//   --mode close                        close the helper's tab
//   --mode cleanup                      close every tab leased to this helper
//   --mode signin --url <service page>  follow the page's "ZUR ANMELDUNG" link,
//                                        reveal the tab for the user's sign-in and
//                                        wait (up to --wait-seconds) until signed in
//
// It never reads or prints field values, never types, and refuses any control
// that would submit, order, pay, or touch the account (sign-in stays human).

import { chromium } from "playwright-core";
import { openSharedChromeTask, sharedChromeEndpoint, sharedPageInventory } from "./shared-chrome-task.mjs";
import { bridgeControl, connectSharedBrowser } from "./shared-browser-bridge-client.mjs";
import { assertPortalUrl, describeField, explorationClickRefusal } from "./wuppertal-serviceportal-policy.mjs";

const args = process.argv.slice(2);
const valueAfter = (flag) => {
  const index = args.indexOf(flag);
  return index < 0 ? "" : args[index + 1] || "";
};
const mode = valueAfter("--mode");
const endpoint = valueAfter("--endpoint") || sharedChromeEndpoint;
const affinitySlot = valueAfter("--affinity-slot") || "wuppertal-serviceportal";
if (!["inspect", "click", "status", "close", "cleanup", "signin"].includes(mode)) throw new Error("Mode must be inspect, click, status, close, cleanup or signin.");
const waitSeconds = Math.min(1800, Math.max(60, Number(valueAfter("--wait-seconds")) || 900));
if (!args.includes("--shared-window") || endpoint !== sharedChromeEndpoint) {
  throw new Error(`The portal helper must use the shared Windows Chrome wrapper at ${sharedChromeEndpoint}.`);
}
const startUrl = ["inspect", "signin"].includes(mode) ? assertPortalUrl(valueAfter("--url")).href : "";
const clickText = mode === "click" ? valueAfter("--text") : "";
if (mode === "click") {
  const refusal = explorationClickRefusal(clickText);
  if (refusal) throw new Error(refusal);
}

if (mode === "cleanup") {
  // Close only targets leased to this helper's provider label, then release
  // those leases. Other tasks' tabs are never touched.
  const leases = (await bridgeControl("lease.list"))
    .filter((lease) => lease.namespace === "family-history" && lease.provider === "wuppertal service portal" && ["active", "parked"].includes(lease.state));
  const owned = new Set(leases.flatMap((lease) => [lease.rootTargetId, ...(lease.descendants || [])]).filter(Boolean));
  const connection = await connectSharedBrowser({ chromium, endpoint, taskLabel: "wuppertal service portal cleanup", namespace: "family-history", lifetime: "session" });
  let closed = 0;
  let unleasedPortalTabs = 0;
  try {
    for (const item of await sharedPageInventory(connection.context)) {
      if (!owned.has(item.targetId)) {
        if (/^https:\/\/serviceportal\.wuppertal\.de\//.test(item.page.url())) unleasedPortalTabs += 1;
        continue;
      }
      await item.page.close({ runBeforeUnload: false }).catch(() => {});
      closed += 1;
    }
  } finally {
    for (const lease of leases) await bridgeControl("lease.release", { leaseId: lease.leaseId }).catch(() => {});
    await connection.closeClient({ leaseAction: "release" }).catch(() => {});
  }
  console.log(JSON.stringify({ mode, leases: leases.length, closedTabs: closed, unleasedPortalTabs }));
  process.exit(0);
}

const session = await openSharedChromeTask({
  chromium,
  endpoint,
  taskLabel: "wuppertal service portal",
  affinitySlot,
  reconnectExisting: true,
  timeoutMs: 20_000
});

let keep = mode !== "close";
try {
  const page = session.page;
  page.setDefaultTimeout(15_000);
  if (mode === "inspect") {
    await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
  } else if (mode === "signin") {
    await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
    if (!await signedIn(page)) {
      const toLogin = page.getByRole("link", { name: /^zur anmeldung$/i });
      if (await toLogin.count() === 1) await toLogin.click({ timeout: 15_000 });
      else await page.goto("https://serviceportal.wuppertal.de/login", { waitUntil: "domcontentloaded", timeout: 45_000 });
      await session.showForManualStep("Wuppertal Service Portal sign-in (username and password, or BundID)");
      console.log(`Sign in to the Wuppertal Service Portal in the revealed Chrome tab; waiting up to ${waitSeconds} seconds.`);
      const deadline = Date.now() + waitSeconds * 1_000;
      while (Date.now() < deadline && !await signedIn(page)) await page.waitForTimeout(3_000);
      if (!await signedIn(page)) {
        console.log(JSON.stringify({ mode, signedIn: false, waitedSeconds: waitSeconds }));
        process.exitCode = 3;
      }
    }
  } else if (mode === "click") {
    assertPortalUrl(page.url());
    const candidates = page.getByRole("link", { name: clickText, exact: true })
      .or(page.getByRole("button", { name: clickText, exact: true }));
    const visible = [];
    for (let index = 0; index < await candidates.count(); index += 1) {
      const candidate = candidates.nth(index);
      if (await candidate.isVisible().catch(() => false)) visible.push(candidate);
    }
    if (visible.length !== 1) throw new Error(`Expected exactly one visible control named "${clickText}"; found ${visible.length}.`);
    await visible[0].click({ timeout: 15_000 });
  }
  if (mode !== "close") {
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    await page.waitForTimeout(2_500);
    const finalUrl = page.url();
    try {
      assertPortalUrl(finalUrl);
    } catch {
      console.log(JSON.stringify({ mode, leftPortal: true, host: new URL(finalUrl).hostname }));
      keep = true;
      process.exitCode = 0;
    }
    console.log(JSON.stringify({ signedIn: await signedIn(page), ...await snapshot(page) }, null, 1));
  }
} finally {
  if (keep) await session.leaveOpen().catch(() => {});
  else await session.close().catch(() => {});
}

// Signed in when the portal shows a logout control on its own host. Reads
// only link names, never form fields.
async function signedIn(page) {
  try { assertPortalUrl(page.url()); } catch { return false; }
  const logout = page.getByRole("link", { name: /^(abmelden|logout)$/i }).or(page.getByRole("button", { name: /^(abmelden|logout)$/i }));
  for (let index = 0; index < await logout.count().catch(() => 0); index += 1) {
    if (await logout.nth(index).isVisible().catch(() => false)) return true;
  }
  return false;
}

async function snapshot(page) {
  const data = await page.evaluate(() => {
    const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const visible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    };
    const labelFor = (element) => {
      if (element.id) {
        const label = document.querySelector(`label[for="${CSS.escape(element.id)}"]`);
        if (label) return clean(label.innerText);
      }
      const wrapping = element.closest("label");
      if (wrapping) return clean(wrapping.innerText);
      return clean(element.getAttribute("aria-label") || element.getAttribute("placeholder") || element.getAttribute("title"));
    };
    const headings = [...document.querySelectorAll("h1,h2,h3")].filter(visible).map((h) => clean(h.innerText)).filter(Boolean).slice(0, 40);
    const links = [...document.querySelectorAll("a[href]")].filter(visible)
      .map((a) => ({ text: clean(a.innerText || a.getAttribute("aria-label")), href: a.href }))
      .filter((link) => link.text).slice(0, 120);
    const buttons = [...document.querySelectorAll("button,input[type=submit],input[type=button],[role=button]")].filter(visible)
      .map((b) => clean(b.innerText || b.value || b.getAttribute("aria-label"))).filter(Boolean).slice(0, 60);
    const fields = [...document.querySelectorAll("input,select,textarea")].filter((f) => visible(f) && !["hidden", "submit", "button"].includes(f.type))
      .map((f) => ({
        tag: f.tagName.toLowerCase(), type: f.type, name: f.name, label: labelFor(f), required: f.required || f.getAttribute("aria-required") === "true",
        options: f.tagName === "SELECT" ? [...f.options].map((o) => clean(o.textContent)) : undefined
      })).slice(0, 80);
    const bodyText = clean(document.body?.innerText).slice(0, 8000);
    return { title: document.title, headings, links, buttons, fields, bodyText };
  });
  return {
    url: page.url(),
    title: data.title,
    headings: data.headings,
    links: data.links,
    buttons: data.buttons,
    fields: data.fields.map(describeField),
    textExcerpt: data.bodyText
  };
}
