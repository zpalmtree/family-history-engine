#!/usr/bin/env node

import { chromium } from "playwright-core";
import { openSharedChromeTask, sharedChromeEndpoint } from "./shared-chrome-task.mjs";

const query = valueAfter("--query");
const startDate = valueAfter("--start");
const endDate = valueAfter("--end");
const affinitySlot = valueAfter("--affinity-slot") || "tuscarawas-deeds";
const endpoint = valueAfter("--endpoint") || sharedChromeEndpoint;

if (!process.argv.includes("--shared-window") || endpoint !== sharedChromeEndpoint) {
  throw new Error(`Tuscarawas deed search must use the shared Windows Chrome wrapper at ${sharedChromeEndpoint}.`);
}
if (!/^[A-Za-z][A-Za-z .'-]{0,79}$/.test(query || "")) throw new Error("Pass one bounded surname or party-name query.");
if (!/^\d{8}$/.test(startDate || "") || !/^\d{8}$/.test(endDate || "") || startDate > endDate) {
  throw new Error("Pass valid YYYYMMDD --start and --end dates.");
}

const url = new URL("https://tuscarawas.oh.publicsearch.us/results");
url.searchParams.set("department", "RP");
url.searchParams.set("searchType", "quickSearch");
url.searchParams.set("searchValue", query);
url.searchParams.set("searchOcrText", "false");
url.searchParams.set("keywordSearch", "false");
url.searchParams.set("recordedDateRange", `${startDate},${endDate}`);

const task = await openSharedChromeTask({ chromium, endpoint, taskLabel: "tuscarawas-deeds", affinitySlot });
try {
  const page = task.page;
  await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page.locator("body").waitFor({ state: "visible", timeout: 15_000 });
  await page.waitForLoadState("networkidle", { timeout: 25_000 }).catch(() => {});
  await page.waitForFunction(() => {
    const text = (document.body?.innerText || "").replace(/\s+/g, " ");
    return !/Loading (?:search )?results/i.test(text)
      && (/returned no results/i.test(text) || /No Results Found/i.test(text) || document.querySelector('[data-testid="result-card"], [data-tourid="searchResults"]'));
  }, { timeout: 35_000 }).catch(() => {});
  await page.waitForTimeout(2_000);

  const result = await page.evaluate((wanted) => {
    const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const body = clean(document.body?.innerText).slice(0, 24_000);
    const candidates = [...document.querySelectorAll('[data-testid="result-card"], [data-tourid="searchResults"] article, main article, main tbody tr')];
    const rows = candidates.map((node) => clean(node.innerText)).filter((text) => text && text.toLocaleLowerCase().includes(wanted.toLocaleLowerCase()));
    const links = [...document.querySelectorAll('main a[href]')].map((link) => ({
      text: clean(link.innerText || link.getAttribute("aria-label")),
      href: new URL(link.getAttribute("href"), location.href).href,
    })).filter((link) => link.text && /tuscarawas\.oh\.publicsearch\.us$/i.test(new URL(link.href).hostname));
    return { body, rows: [...new Set(rows)].slice(0, 100), links: links.slice(0, 100) };
  }, query);

  console.log(JSON.stringify({
    query,
    startDate,
    endDate,
    title: await page.title(),
    url: page.url(),
    ...result,
  }, null, 2));
} finally {
  await task.close();
}

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
