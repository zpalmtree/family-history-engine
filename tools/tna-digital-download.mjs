#!/usr/bin/env node

// Free digital download of one catalogued National Archives document.
//
//   npm run tna:download:win -- -Target <target-id> [-Explore]
//
// Opens the exact Discovery details page named by the canonical target's TNA
// route in a leased task tab of the shared Chrome profile (signed in through
// `npm run providers:signin -- --providers tna`). Unless Your orders already
// lists the record, it places Discovery's free (£0.00) digital-download order,
// then fetches the PDF from the exact Your-orders link and saves it into
// Downloads\FamilyHistoryResearch for archive-subscription-download-windows.ps1
// to archive and register. Nothing is bought: a price, a second basket item, an
// unexpected input or any other record stops the run before Submit order.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DETAILS_URL = /^https:\/\/discovery\.nationalarchives\.gov\.uk\/details\/r\/[A-Z0-9]{2,20}$/;
const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,127}$/;

export function tnaRoute(target) {
  if (target?.provider !== "The National Archives") throw new Error(`${target?.id} is not a National Archives target.`);
  const route = (target.routes || []).find((candidate) => candidate.provider === "The National Archives"
    && DETAILS_URL.test(candidate.sourceUrl || ""));
  if (!route) throw new Error(`${target.id} has no exact Discovery details URL.`);
  return route;
}

export function downloadFileName(targetId) {
  if (!SAFE_ID.test(targetId || "")) throw new Error("Target id is not a safe slug.");
  return `${targetId}.pdf`;
}

export function isPdf(bytes) {
  return bytes.length > 1024 && bytes.subarray(0, 5).toString("latin1") === "%PDF-";
}

const ORDERS_URL = "https://discovery.nationalarchives.gov.uk/account/yourorders";
const ZERO = /^£\s?0(?:\.00)?$/;

// The order summary must hold exactly this one record, every amount must be
// £0.00, and the only inputs may be the terms checkbox and the submit control.
export function orderSummaryProblem({ url, text, prices, fields }, reference) {
  if (!/^https:\/\/discovery\.nationalarchives\.gov\.uk\/checkout\/ordersummary$/.test(url || "")) return `unexpected page ${url}`;
  const references = [...(text || "").matchAll(/Catalogue reference:\s*([^\n]+)/g)].map((match) => match[1].replace(/\s+/g, " ").trim());
  if (references.length !== 1) return `the basket holds ${references.length} items, not exactly this one`;
  if (!reference || references[0] !== reference) return `the basket item is ${references[0]}, not ${reference}`;
  if (!prices?.length || prices.some((price) => !ZERO.test(price))) return `amounts other than £0.00 (${(prices || []).join(", ")})`;
  if (!/Total:\s*£0\.00/.test(text)) return "no £0.00 total";
  const unexpected = (fields || []).filter((field) => !/^input termsAndConditionsAccepted \(checkbox\)$|^input\s+\S*\s*\(submit\)$/.test(field));
  if (unexpected.length) return `unexpected inputs ${unexpected.join(", ")}`;
  return "";
}

async function describe(page) {
  return page.evaluate(() => {
    const visible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const text = (element) => (element.innerText || element.value || element.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim().slice(0, 100);
    const controls = [...document.querySelectorAll("a, button, input[type=submit], input[type=button]")]
      .filter(visible)
      .filter((element) => /download|basket|sign|free|pdf|format|order|£|checkout|continue|proceed|confirm|place|remove|delete|agree|accept|submit/i.test(text(element)))
      .map((element, index) => ({ index, tag: element.tagName.toLowerCase(), text: text(element), href: element.href || "" }))
      .slice(0, 30);
    const body = document.body.innerText;
    return {
      url: `${location.origin}${location.pathname}`,
      title: document.title,
      headings: [...document.querySelectorAll("h1, h2")].filter(visible).map(text).slice(0, 6),
      signedIn: /sign out|my account/i.test(body),
      reference: (body.match(/Reference:\s*([A-Z]+\s*\d+\/\d+(?:\/\d+)?)/) || [])[1] || "",
      prices: (body.match(/£\s?\d+(?:\.\d{2})?/g) || []).slice(0, 6),
      freeText: (body.match(/[^.\n]{0,80}free[^.\n]{0,80}/gi) || []).slice(0, 4),
      options: (body.match(/Ordering and viewing options[\s\S]{0,700}/) || [""])[0].replace(/\s+/g, " "),
      viewer: (body.match(/Image viewer[\s\S]{0,400}/) || [""])[0].replace(/\s+/g, " "),
      frames: [...document.querySelectorAll("iframe, img[src*='image' i], [data-manifest], a[href*='iiif' i], a[href*='viewer' i]")]
        .map((element) => element.src || element.href || element.getAttribute("data-manifest") || "").filter(Boolean).slice(0, 8),
      fields: [...document.querySelectorAll("input:not([type=hidden]), select, textarea")]
        .filter(visible).map((element) => `${element.tagName.toLowerCase()} ${element.name || element.id} (${element.type || ""})`).slice(0, 20),
      controls
    };
  });
}

async function main() {
  const targetId = valueAfter("--target");
  const explore = process.argv.includes("--explore");
  const fileName = downloadFileName(targetId);
  const target = JSON.parse(fs.readFileSync(path.join(projectRoot, "evidence", "acquisition", "targets", `${targetId}.json`), "utf8"));
  const route = tnaRoute(target);
  const reference = (route.reference || "").replace(/\s+/g, " ").trim();

  const { chromium } = await import("playwright-core");
  const { openSharedChromeTask, sharedChromeEndpoint } = await import("./shared-chrome-task.mjs");
  const task = await openSharedChromeTask({ chromium, endpoint: sharedChromeEndpoint, taskLabel: `tna-download-${targetId}`, affinitySlot: "tna-download", timeoutMs: 20_000 });
  try {
    const page = task.page;
    await page.goto(route.sourceUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(2_000);
    const state = await describe(page);
    if (explore) {
      console.log(JSON.stringify(state, null, 2));
      await page.goto(ORDERS_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.waitForTimeout(2_000);
      console.log(JSON.stringify(await describe(page), null, 2));
      console.log((await page.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 1500));
      return;
    }
    if (reference && state.reference.replace(/\s+/g, " ") !== reference) {
      throw new Error(`Discovery shows reference "${state.reference}", not ${reference}; nothing ordered.`);
    }
    if (!state.signedIn) throw new Error("Discovery is not signed in; run npm run providers:signin -- --providers tna first.");
    if (state.prices.some((price) => !ZERO.test(price))) throw new Error(`The record shows a price (${state.prices.join(", ")}); this tool takes free downloads only.`);

    const documentId = route.sourceUrl.split("/").pop();
    let link = await orderedDownloadLink(page, documentId, reference);
    if (!link) {
      if (!/Added to basket/i.test(state.options)) {
        const add = state.controls.find((control) => control.text === "Add to basket"
          && control.href === `https://discovery.nationalarchives.gov.uk/details/addtobasket/${documentId}`);
        if (!add) throw new Error("No exact free Add to basket link for this record.");
        await page.goto(add.href, { waitUntil: "domcontentloaded", timeout: 60_000 });
        await page.waitForTimeout(1_500);
      }
      await page.goto("https://discovery.nationalarchives.gov.uk/basket", { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.waitForTimeout(1_500);
      await page.locator("input[type=submit][value='Checkout']").click();
      await page.waitForLoadState("domcontentloaded");
      await page.waitForTimeout(2_500);

      const summary = await describe(page);
      const summaryText = await page.locator("body").innerText();
      const problem = orderSummaryProblem({ url: summary.url, text: summaryText, prices: summary.prices, fields: summary.fields }, reference);
      if (problem) throw new Error(`Order summary refused: ${problem}`);
      await page.locator("input[type=checkbox][name=termsAndConditionsAccepted]").check();
      await page.locator("input[type=submit][value='Submit order']").click();
      await page.waitForLoadState("domcontentloaded");
      await page.waitForTimeout(3_000);

      link = await orderedDownloadLink(page, documentId, reference);
    }
    if (!link) throw new Error("The free order was submitted but Your orders lists no download for it.");
    const outDir = path.join(os.homedir(), "Downloads", "FamilyHistoryResearch");
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, fileName);
    const bytes = await fetchPdf(page, link);
    if (!isPdf(bytes)) throw new Error("Discovery returned something other than a PDF; nothing saved.");
    fs.writeFileSync(outPath, bytes);
    const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
    console.log(JSON.stringify({ status: "downloaded", targetId, reference, file: outPath, bytes: bytes.length, sha256 }));
  } finally {
    await task.close().catch(() => {});
  }
}

export function downloadLinkFor(controls, documentId, reference) {
  return controls.map((control) => control.href).find((href) => {
    try {
      const url = new URL(href);
      return url.origin === "https://discovery.nationalarchives.gov.uk"
        && url.pathname === "/account/yourorders/download"
        && url.searchParams.get("iaid") === documentId
        && url.searchParams.get("reference") === reference;
    } catch { return false; }
  }) || "";
}

async function orderedDownloadLink(page, documentId, reference) {
  await page.goto(ORDERS_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(1_500);
  return downloadLinkFor((await describe(page)).controls, documentId, reference);
}

// Fetched with the signed-in context's own cookies through Playwright's request
// client (the link redirects off-origin, which an in-page fetch cannot follow),
// so Chrome's own download handling is never involved.
async function fetchPdf(page, url) {
  const response = await page.context().request.get(url, { maxRedirects: 5, timeout: 120_000 });
  const finalHost = new URL(response.url()).hostname;
  if (!response.ok()) throw new Error(`Discovery download returned HTTP ${response.status()} from ${finalHost}.`);
  return response.body();
}

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  const value = index >= 0 ? process.argv[index + 1] : "";
  if (!value || value.startsWith("--")) throw new Error(`${flag} is required.`);
  return value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
