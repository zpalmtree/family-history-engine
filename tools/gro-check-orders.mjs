#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { openSharedChromeTask, sharedChromeEndpoint } from "./shared-chrome-task.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

await loadDotEnv(path.join(projectRoot, ".env"));
rejectRawPaymentEnv();

const argv = process.argv.slice(2);
const requestedTarget = argumentValue("--target");
if (!requestedTarget) throw new Error("Pass --target <slug or target JSON>; there is no default order.");
const target = await loadOrderTarget(requestedTarget);

const groLoginUrl = "https://www.gro.gov.uk/gro/content/certificates/login.asp";
const sharedWindow = argv.includes("--shared-window");
const endpoint = argumentValue("--endpoint") || sharedChromeEndpoint;
const affinitySlot = argumentValue("--affinity-slot") || "gro-orders";
const runId = new Date().toISOString().replaceAll(":", "-").replace(/\.\d{3}Z$/, "Z");
const evidenceRoot = path.join(projectRoot, "evidence", "gro", target.slug);
const screenshotsDir = path.join(evidenceRoot, "screenshots");
const runsDir = path.join(evidenceRoot, "runs");
const downloadsDir = path.join(evidenceRoot, "downloads");

if (process.platform !== "win32") {
  throw new Error("gro-check-orders must be run with Windows Node/Chrome. Use tools/gro-windows.ps1 -Mode check-orders.");
}
if (!sharedWindow || endpoint !== sharedChromeEndpoint) {
  throw new Error(
    `GRO order checks are restricted to a background task tab in the one shared Windows Chrome/CDP window at ${sharedChromeEndpoint}. ` +
    "Use tools/gro-windows.ps1; standalone profile and direct Chrome launches are disabled."
  );
}

const session = await openSharedChromeTask({
  chromium,
  endpoint,
  taskLabel: "GRO order check",
  affinitySlot
});

const run = {
  id: runId,
  mode: "check-orders",
  target,
  startedAt: new Date().toISOString(),
  steps: []
};

try {
  const page = session.page;
  page.setDefaultTimeout(8000);
  console.log(`Using a background GRO order-check tab in the one shared Windows Chrome window (affinity ${affinitySlot}).`);
  await page.goto(groLoginUrl, { waitUntil: "domcontentloaded" });
  await acceptCookieBanners(page);
  await screenshot(page, "check-orders-01-start");
  run.steps.push({ name: "opened-gro-login", ok: true, url: page.url() });

  const login = await tryLogin(page, session);
  run.steps.push({ name: "login", ...login, url: page.url() });

  const myOrders = await openMyOrders(page);
  run.steps.push({ name: "open-my-orders", ...myOrders, url: page.url() });

  const ordersSearch = await searchTargetOrder(page);
  run.steps.push({ name: "search-target-order", ...ordersSearch, url: page.url() });

  await page.waitForLoadState("domcontentloaded", { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(1500);
  await acceptCookieBanners(page);

  const text = await page.locator("body").innerText().catch(() => "");
  const shot = await screenshot(page, "check-orders-02-my-orders");
  const status = summarizeOrdersText(text);
  run.steps.push({
    name: "orders-status",
    ok: true,
    url: page.url(),
    screenshot: shot,
    status
  });

  const onlineView = await fetchOnlineView(page);
  run.steps.push({ name: "fetch-online-view", ...onlineView, url: page.url() });

  const runPath = await writeRun(run);
  console.log(JSON.stringify({
    ok: true,
    url: page.url(),
    screenshot: shot,
    runPath,
    status,
    onlineView
  }, null, 2));
} finally {
  await writeRun(run).catch(() => null);
  await session.close();
}

async function tryLogin(page, sharedSession) {
  const body = await page.locator("body").innerText().catch(() => "");
  if (!/register or login|e-mail address|password/i.test(body)) {
    return { ok: true, skipped: true, note: "Already past login page." };
  }

  const email = await page.locator("input[type='text'], input[type='email']").first().inputValue().catch(() => "");
  const password = await page.locator("input[type='password']").first().inputValue().catch(() => "");
  if (!email || !password) {
    await sharedSession.showForManualStep("manual GRO sign-in");
    console.log("GRO needs manual sign-in in the revealed tab. Waiting up to three minutes before continuing.");
    const signedIn = await waitForManualLogin(page, 180_000);
    return {
      ok: signedIn,
      manual: true,
      note: signedIn
        ? "Manual sign-in completed in the existing shared-window tab."
        : "Manual sign-in was not completed within three minutes."
    };
  }

  const clicked = await clickFirst(page, [
    page.locator("input[type='submit'][value='Login']").first(),
    page.getByRole("button", { name: /^login$/i }).first(),
    page.getByRole("link", { name: /^login$/i }).first()
  ]);

  if (!clicked) {
    return { ok: false, note: "Login fields were filled, but no Login submit control was found." };
  }

  await page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(1000);
  const after = await page.locator("body").innerText().catch(() => "");
  return {
    ok: !/register or login|password/i.test(after),
    note: "Login submitted using existing browser/password-manager field values."
  };
}

async function waitForManualLogin(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (page.isClosed()) return false;
    const body = await page.locator("body").innerText().catch(() => "");
    if (!/register or login|e-mail address|password/i.test(body)) return true;
    await page.waitForTimeout(1000);
  }
  return false;
}

async function openMyOrders(page) {
  const href = await page.getByRole("link", { name: /my orders/i }).first().getAttribute("href").catch(() => null);
  const clicked = await clickFirst(page, [
    page.getByRole("link", { name: /my orders/i }).first(),
    page.locator("a").filter({ hasText: /my orders/i }).first()
  ]);

  if (clicked) {
    await page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});
    return { ok: true, clicked: "My Orders", href };
  }

  return { ok: false, href, note: "No visible My Orders link found." };
}

async function searchTargetOrder(page) {
  const body = await page.locator("body").innerText().catch(() => "");
  if (!/start date|end date|col number/i.test(body)) {
    return { ok: true, skipped: true, note: "No order-history search form detected." };
  }

  // GRO's search form takes the bare number and year; queue entries record the
  // reference as GRO prints it ("COL123456/2026"), so drop the prefix.
  const colParts = String(target.colNumber || "").trim().replace(/^COL\s*/i, "").split("/");
  const { start, end } = recentDateRange();
  const inputs = page.locator("input:visible").filter({ hasNot: page.locator("[type='hidden']") });
  const count = await inputs.count().catch(() => 0);

  const filled = [];
  if (colParts.length === 2 && count >= 2) {
    await inputs.nth(0).fill(colParts[0]).catch(() => null);
    await inputs.nth(1).fill(colParts[1]).catch(() => null);
    filled.push({ index: 0, field: "col-number", value: colParts[0] });
    filled.push({ index: 1, field: "col-year", value: colParts[1] });
  }

  for (let index = 0; index < count; index += 1) {
    const input = inputs.nth(index);
    const meta = [
      await input.getAttribute("name").catch(() => ""),
      await input.getAttribute("id").catch(() => ""),
      await input.getAttribute("aria-label").catch(() => "")
    ].join(" ");
    const type = (await input.getAttribute("type").catch(() => "")) || "";
    if (/submit|button|hidden|password/i.test(type)) continue;

    if (/start/i.test(meta) && !target.colNumber) {
      await input.fill(start);
      filled.push({ index, field: "start", value: start });
    } else if (/end/i.test(meta) && !target.colNumber) {
      await input.fill(end);
      filled.push({ index, field: "end", value: end });
    }
  }

  if (!target.colNumber && filled.length < 2 && count >= 4) {
    await inputs.nth(2).fill(start).catch(() => null);
    await inputs.nth(3).fill(end).catch(() => null);
    filled.push({ index: 2, field: "start", value: start, fallback: true });
    filled.push({ index: 3, field: "end", value: end, fallback: true });
  }

  const clicked = await clickFirst(page, [
    page.locator("input[type='submit'][value='Search']").first(),
    page.getByRole("button", { name: /search/i }).first(),
    page.getByRole("link", { name: /search/i }).first()
  ]);

  if (!clicked) {
    return { ok: false, filled, note: "Filled date range, but no Search control was found." };
  }

  await page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(1500);
  return { ok: true, filled, clicked: "Search" };
}

function summarizeOrdersText(text) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const targetTerms = [
    target.person,
    target.colNumber,
    target.paymentProviderReference,
    target.event,
    target.district,
    target.year
  ].filter(Boolean).flatMap((value) => String(value).split(/\s+/)).filter((value) => value.length > 2);
  const targetPattern = targetTerms.length
    ? new RegExp(targetTerms.map(escapeRegExp).join("|"), "i")
    : /$a/;
  const statusPattern = /order|ordered|complete|completed|pending|processing|dispatch|certificate|view|download|failure|cancel|error/i;
  const interesting = lines.filter((line) => targetPattern.test(line) || statusPattern.test(line));
  const personTerms = String(target.person || "").split(/\s+/).filter((value) => value.length > 1);

  return {
    hasTargetName: personTerms.length > 0 && personTerms.every((term) => new RegExp(escapeRegExp(term), "i").test(text)),
    hasColNumber: Boolean(target.colNumber) && text.includes(target.colNumber),
    hasWorldpayReference: Boolean(target.paymentProviderReference) && text.includes(target.paymentProviderReference),
    hasOnlineView: /online view|digital image|view image|download/i.test(text),
    hasPaymentFailure: /payment failure|transaction failed|declined|unsuccessful|transstatus=failure|transstatus=cancel|cancelled|canceled/i.test(text),
    interestingLines: interesting.slice(0, 80)
  };
}

async function fetchOnlineView(page) {
  const result = {
    ok: false,
    clicked: [],
    controls: [],
    savedAs: null,
    sha256: null,
    screenshot: null,
    imageSources: [],
    note: null
  };

  if (/standard(?:\s|-)*certificate/i.test(String(target.serviceOption || ""))) {
    result.note = "Standard-certificate target: no Online View control was inspected or clicked.";
    result.skipped = true;
    return result;
  }

  result.controls = await visibleControls(page);

  const details = await clickLabeledControl(page, /view details/i, result);
  if (details.clicked) {
    await page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(1500);
    await screenshot(page, "check-orders-03-view-details");
    result.controls = await visibleControls(page);
  }

  const candidates = page.getByRole("link").or(page.getByRole("button")).filter({
    hasText: /view image online|view online|online view|view image|digital image|view digital image/i
  });
  const count = await candidates.count().catch(() => 0);
  if (!count) {
    result.note = "No visible online-view control found after order search.";
    result.screenshot = await screenshot(page, "check-orders-03-no-online-view-control");
    return result;
  }

  const view = candidates.first();
  const label = await view.innerText().catch(() => "online-view-control");
  const href = await view.getAttribute("href").catch(() => "");
  result.clicked.push(label.trim());
  const firstDownload = page.waitForEvent("download", { timeout: 8000 }).catch(() => null);
  const popupPromise = page.waitForEvent("popup", { timeout: 5000 }).catch(() => null);
  let viewPage = page;

  if (/^https?:\/\/www\.gro\.gov\.uk\/gro\/content\/certificates\/view_image\.asp/i.test(href || "")) {
    result.clicked.push(`direct:${href}`);
    await page.goto(href, { waitUntil: "domcontentloaded" }).catch((error) => {
      result.note = `Online-view direct navigation failed: ${error.message || error}`;
    });
  } else {
    await view.click().catch((error) => {
      result.note = `Online-view click failed: ${error.message || error}`;
    });
    const popup = await popupPromise;
    if (popup) viewPage = popup;
  }

  await viewPage.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});
  await viewPage.waitForTimeout(2500);

  let download = await firstDownload;
  if (!download) {
    download = await clickDownloadControl(viewPage, result);
  }

  if (download) {
    await fs.mkdir(downloadsDir, { recursive: true });
    const suggested = sanitizeFilename(download.suggestedFilename() || `${target.slug}-gro-online-view`);
    const savePath = path.join(downloadsDir, suggested);
    await download.saveAs(savePath);
    result.savedAs = savePath;
    result.sha256 = await sha256File(savePath);
    result.ok = true;
  }

  result.url = viewPage.url();
  result.imageSources = await visibleImageSources(viewPage);
  if (!result.savedAs && result.imageSources.length) {
    const imageSave = await saveImageFromBrowserPage(viewPage, result.imageSources[0].src);
    if (imageSave.savedAs) {
      result.savedAs = imageSave.savedAs;
      result.sha256 = imageSave.sha256;
      result.ok = true;
      result.clicked.push("browser-fetch-image-source");
    } else if (imageSave.note) {
      result.note = imageSave.note;
    }
  }
  result.screenshot = await screenshot(viewPage, result.savedAs ? "check-orders-04-online-view-downloaded" : "check-orders-04-online-view");
  result.note = result.savedAs
    ? "Online view downloaded."
    : "Online view opened, but no browser download event was captured. Screenshot saved for inspection.";
  result.ok = result.ok || result.imageSources.length > 0;
  return result;
}

async function clickLabeledControl(page, pattern, result) {
  const controls = page.getByRole("link").or(page.getByRole("button")).filter({ hasText: pattern });
  const count = await controls.count().catch(() => 0);
  for (let index = 0; index < Math.min(count, 5); index += 1) {
    const control = controls.nth(index);
    if (!(await control.isVisible().catch(() => false))) continue;
    const label = await control.innerText().catch(() => pattern.toString());
    result.clicked.push(label.trim());
    await control.click().catch(() => null);
    return { clicked: label.trim() || pattern.toString() };
  }
  return { clicked: null };
}

async function clickDownloadControl(page, result) {
  const controls = page.locator("a, button, input[type='button'], input[type='submit']");
  const count = await controls.count().catch(() => 0);
  for (let index = 0; index < Math.min(count, 50); index += 1) {
    const control = controls.nth(index);
    if (!(await control.isVisible().catch(() => false))) continue;
    const label = [
      await control.innerText().catch(() => ""),
      await control.getAttribute("value").catch(() => ""),
      await control.getAttribute("title").catch(() => ""),
      await control.getAttribute("aria-label").catch(() => "")
    ].join(" ").trim();
    if (!/download|save|image|jpeg|jpg|pdf/i.test(label)) continue;
    result.clicked.push(label || `download-control-${index}`);
    const downloadPromise = page.waitForEvent("download", { timeout: 8000 }).catch(() => null);
    await control.click().catch(() => null);
    const download = await downloadPromise;
    if (download) return download;
  }
  return null;
}

async function visibleControls(page) {
  return page.locator("a, button, input[type='button'], input[type='submit']").evaluateAll((controls) =>
    controls
      .filter((control) => {
        const rect = control.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      })
      .map((control) => ({
        tag: control.tagName.toLowerCase(),
        text: (control.innerText || control.value || "").trim().replace(/\s+/g, " ").slice(0, 120),
        href: control.href || "",
        value: control.value || "",
        title: control.title || "",
        ariaLabel: control.getAttribute("aria-label") || ""
      }))
      .filter((control) => control.text || control.href || control.value || control.title || control.ariaLabel)
  ).catch(() => []);
}

async function visibleImageSources(page) {
  return page.locator("img:visible").evaluateAll((images) =>
    images.map((image) => ({
      src: image.currentSrc || image.src || "",
      width: image.naturalWidth || image.width,
      height: image.naturalHeight || image.height,
      alt: image.alt || ""
    })).filter((image) => image.src && image.width > 100 && image.height > 100)
  ).catch(() => []);
}

async function saveImageFromBrowserPage(page, src) {
  if (!src) return { savedAs: null, sha256: null, note: "No image src supplied." };
  const response = await page.evaluate(async (url) => {
    const res = await fetch(url, { credentials: "include" });
    if (!res.ok) return { ok: false, status: res.status, statusText: res.statusText };
    const contentType = res.headers.get("content-type") || "";
    const buffer = await res.arrayBuffer();
    let binary = "";
    const bytes = new Uint8Array(buffer);
    for (let index = 0; index < bytes.length; index += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    }
    return { ok: true, contentType, base64: btoa(binary) };
  }, src).catch((error) => ({ ok: false, error: error.message || String(error) }));

  if (!response.ok) {
    return {
      savedAs: null,
      sha256: null,
      note: `Browser image fetch failed: ${response.error || `${response.status} ${response.statusText || ""}`.trim()}`
    };
  }

  await fs.mkdir(downloadsDir, { recursive: true });
  const ext = response.contentType.includes("png") ? "png" : "jpg";
  const filename = sanitizeFilename(`${target.slug}-gro-online-view-${runId}.${ext}`);
  const savePath = path.join(downloadsDir, filename);
  await fs.writeFile(savePath, Buffer.from(response.base64, "base64"));
  return {
    savedAs: savePath,
    sha256: await sha256File(savePath),
    contentType: response.contentType
  };
}

function recentDateRange() {
  // GRO records orders on its UK service date and rejects an end date in the
  // future, so the range ends on today's calendar date in London (which can be
  // a day ahead of the American workstation clock) and starts 14 days earlier.
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date()).filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
  const end = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 14);
  return {
    start: formatGroDate(start),
    end: formatGroDate(end)
  };
}

function formatGroDate(date) {
  const day = String(date.getUTCDate()).padStart(2, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${day}/${month}/${date.getUTCFullYear()}`;
}

async function clickFirst(page, locators) {
  for (const locator of locators) {
    if (!(await locator.count().catch(() => 0))) continue;
    if (!(await locator.isVisible().catch(() => false))) continue;
    await Promise.all([
      page.waitForLoadState("domcontentloaded").catch(() => {}),
      locator.click()
    ]);
    return true;
  }
  return false;
}

async function acceptCookieBanners(page) {
  await clickFirst(page, [
    page.getByRole("button", { name: /allow cookies/i }).first(),
    page.getByRole("button", { name: /accept cookies/i }).first(),
    page.getByRole("button", { name: /accept additional cookies/i }).first(),
    page.getByRole("button", { name: /hide cookie message/i }).first()
  ]).catch(() => false);
}

async function screenshot(page, name) {
  await fs.mkdir(screenshotsDir, { recursive: true });
  const file = path.join(screenshotsDir, `${runId}-${sanitizeFilename(name)}.png`);
  await page.screenshot({ path: file, fullPage: true }).catch(() => null);
  return file;
}

async function writeRun(data) {
  await fs.mkdir(runsDir, { recursive: true });
  const file = path.join(runsDir, `${runId}-check-orders.json`);
  await fs.writeFile(file, `${JSON.stringify({
    ...data,
    updatedAt: new Date().toISOString()
  }, null, 2)}\n`);
  return file;
}

async function loadDotEnv(file) {
  const raw = await fs.readFile(file, "utf8").catch(() => null);
  if (!raw) return;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] != null) continue;
    process.env[key] = rawValue.replace(/^['"]|['"]$/g, "");
  }
}

function rejectRawPaymentEnv() {
  const forbidden = Object.keys(process.env).filter((key) => /CARD|CVV|CVC|PAN|PAYMENT/i.test(key));
  const unsafe = forbidden.filter((key) => !/^MAX_ORDER_COST_GBP$/.test(key));
  if (unsafe.length) {
    throw new Error(
      `Refusing to run with raw payment-looking env var(s): ${unsafe.join(", ")}.\n` +
      "Use Chrome, Google Pay, or a password manager for card autofill. Do not put card details in .env."
    );
  }
}

function argumentValue(name) {
  const index = argv.indexOf(name);
  if (index === -1) return null;
  return argv[index + 1] && !argv[index + 1].startsWith("--") ? argv[index + 1] : null;
}

async function loadOrderTarget(slug) {
  if (!/^gro-[a-z0-9-]+$/.test(slug)) throw new Error(`Invalid GRO target slug: ${slug}`);
  const queue = JSON.parse(await fs.readFile(path.join(projectRoot, "evidence", "gro", "order-queue.json"), "utf8"));
  const matched = (queue.targets || []).find((candidate) => candidate.slug === slug);
  if (!matched) throw new Error(`Unknown GRO order target: ${slug}`);
  return matched;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sanitizeFilename(value) {
  return String(value).replace(/[^a-z0-9_.-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 120);
}

async function sha256File(file) {
  const buffer = await fs.readFile(file);
  return createHash("sha256").update(buffer).digest("hex");
}
