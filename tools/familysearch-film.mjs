#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { chromium } from "playwright-core";
import { bridgeControl, connectSharedBrowser } from "./shared-browser-bridge-client.mjs";
import { assertOwnedPage, waitForOwnedPopup } from "./owned-browser-popup.mjs";
import { trySavedSignIn } from "./saved-signin.mjs";
import { distributionAttempt, distributionFailureMessage } from "./familysearch-distribution.mjs";

import { classifyAnnexYear, readCatalogAnnexPage } from "./familysearch-catalog-annex.mjs";
import { createBackgroundTarget } from "./cdp-background-target.mjs";
import { bookImageTemplate, bookItemId, bookPageImagePath, bookPageNumbers, bookViewerPageUrl } from "./familysearch-book-pages.mjs";

// Declared before any top-level code runs: the saved-credential retry can be
// reached during the first awaited action, long before this module's later
// declarations would otherwise be initialized.
let savedSignInAttempted = false;

const args = new Set(process.argv.slice(2));
const searchQuery = argumentValue("--query") || argumentValue("--global-query");
const contextQuery = argumentValue("--context");
const scanIndexCount = argumentValue("--scan-index");
const scanResultCount = argumentValue("--scan-results");
const scanTranscriptCount = argumentValue("--scan-transcripts");
const captureCount = argumentValue("--capture-count");
const captureImages = argumentValue("--capture-images");
const sourceItem = argumentValue("--source-item");
const sourceViewIndex = argumentValue("--source-view");
const sourceLink = argumentValue("--source-link");
const resultItem = argumentValue("--result-item");
const recordUrl = argumentValue("--record");
const memoryTitle = argumentValue("--memory-title");
const catalogUrl = argumentValue("--catalog-url");
const catalogSubject = argumentValue("--catalog-subject");
const catalogPage = argumentValue("--catalog-page");
const imageNumber = argumentValue("--image");
const sharedWindow = args.has("--shared-window");
const affinitySlot = argumentValue("--affinity-slot") || "familysearch";
const affinityPath = path.join(os.tmpdir(), `family-history-familysearch-affinity-${affinitySlot}.json`);
const mode = args.has("--catalog-annex-year") ? "catalog-annex-year" : args.has("--signin-saved") ? "signin-saved" : args.has("--signin") ? "signin" : args.has("--film") ? "film" : args.has("--inspect") ? "inspect" : args.has("--fulltext") ? "fulltext" : args.has("--query") ? "query" : args.has("--global-query") ? "global-query" : args.has("--source-item") ? "source-item" : args.has("--source-view") ? "source-view" : args.has("--source-link") ? "source-link" : args.has("--result-item") ? "result-item" : args.has("--download-record") ? "download-record" : args.has("--book-page") ? "book-page" : args.has("--capture") ? "capture" : args.has("--links") ? "links" : args.has("--scan-index") ? "scan-index" : args.has("--scan-results") ? "scan-results" : args.has("--scan-transcripts") ? "scan-transcripts" : args.has("--context") ? "context" : args.has("--record") ? "record" : args.has("--catalog-probate") ? "catalog-probate" : args.has("--catalog-subject") ? "catalog-subject" : args.has("--catalog-page") ? "catalog-page" : args.has("--image") ? "image" : args.has("--pan-image-right") ? "pan-image-right" : args.has("--pan-image-left") ? "pan-image-left" : args.has("--pan-image-up") ? "pan-image-up" : args.has("--pan-image-down") ? "pan-image-down" : args.has("--close-panel") ? "close-panel" : args.has("--dismiss") ? "dismiss" : args.has("--zoom") ? "zoom" : args.has("--reset") ? "reset" : args.has("--viewer") ? "viewer" : args.has("--close-affinity") ? "close-affinity" : args.has("--pause") ? "pause" : args.has("--stop") ? "stop" : args.has("--traffic") ? "traffic" : args.has("--status") ? "status" : null;
const endpoint = argumentValue("--endpoint") || "http://127.0.0.1:9226";
const filmUrl = "https://www.familysearch.org/search/film/004017209?cat=250982";
const signInUrl = "https://ident.familysearch.org/en/identity/login/?state=https%3A%2F%2Fwww.familysearch.org%2Fen%2Fsearch%2Frecord%2Fresults%3Fcount%3D1";
const hancockCatalogUrl = "https://www.familysearch.org/en/search/catalog/results?count=100&q.place=Hancock%2C%20Ohio%2C%20United%20States";

if (!mode) {
  console.error("Usage: invoke through tools/familysearch-windows.ps1 in the one shared Windows Chrome/CDP window.");
  process.exit(1);
}

if (process.platform !== "win32") {
  console.error("FamilySearch automation must run in Windows Chrome. Use tools/familysearch-windows.ps1.");
  process.exit(1);
}
if (!sharedWindow || endpoint !== "http://127.0.0.1:9226") {
  console.error("FamilySearch automation is restricted to the one shared localhost Windows Chrome/CDP endpoint. Use tools/familysearch-windows.ps1.");
  process.exit(1);
}

const sharedConnection = await connectSharedBrowser({
  chromium,
  endpoint,
  taskLabel: `FamilySearch-${mode}`,
  namespace: "family-history",
  lifetime: "persistent",
  affinitySlot,
  provider: "FamilySearch"
});
const { browser } = sharedConnection;
const transientPages = new Set();
let sharedContext;
let sharedPersistentPage;
try {
  // Routine task cleanup must target only this exact affinity slot. Unlike the
  // broader pause/stop recovery modes, it neither scans for nor closes any
  // other FamilySearch tab in the shared profile.
  if (mode === "close-affinity") {
    const context = browser.contexts()[0];
    if (!context) throw new Error("No Windows Chrome context is available at the shared debugging endpoint.");
    const saved = readJson(affinityPath);
    if (!saved || saved.schemaVersion !== 1 || saved.affinitySlot !== affinitySlot || !saved.targetId) {
      fs.rmSync(affinityPath, { force: true });
      console.log(`No task tab is recorded for FamilySearch affinity slot ${affinitySlot}.`);
      await sharedConnection.release();
      await browser.close().catch(() => {});
      process.exit(0);
    }
    const inventory = await sharedPageInventory(context);
    const controlled = inventory.find((item) => item.targetId === saved.targetId);
    if (!controlled) {
      fs.rmSync(affinityPath, { force: true });
      console.log(`No open task tab remains for FamilySearch affinity slot ${affinitySlot}.`);
      await sharedConnection.release();
      await browser.close().catch(() => {});
      process.exit(0);
    }
    const safeRoute = controlled.page.url() === "about:blank" || controlled.page.url() === "chrome://newtab/"
      || isFamilySearchUrl(controlled.page.url());
    if (!safeRoute) {
      throw new Error(`Affinity slot ${affinitySlot} points to a non-FamilySearch tab; refusing to close it.`);
    }
    if (inventory.length <= 1) {
      throw new Error(`Affinity slot ${affinitySlot} is the final shared Chrome tab; refusing to close it.`);
    }
    await controlled.page.close({ runBeforeUnload: false });
    await sharedConnection.forgetTarget(controlled.targetId);
    fs.rmSync(affinityPath, { force: true });
    console.log(`Closed only the task tab for FamilySearch affinity slot ${affinitySlot}.`);
    await sharedConnection.release();
    await browser.close().catch(() => {});
    process.exit(0);
  }

  // Cleanup must remain available when an interrupted provider flow has left
  // FamilySearch tabs in more than one real Chrome window. Requiring the
  // single-window invariant before pause/stop would make the recovery command
  // incapable of restoring that invariant. Target only exact broker-owned or
  // affinity-recorded tabs; a FamilySearch URL alone never grants ownership.
  if (mode === "stop" || mode === "pause") {
    const context = browser.contexts()[0];
    if (!context) throw new Error("No Windows Chrome context is available at the shared debugging endpoint.");
    const leases = await bridgeControl("lease.list");
    const recordedTargetIds = new Set(readFamilySearchAffinityRecords().map((item) => item.targetId).filter(Boolean));
    const leasedTargetIds = new Set(leases
      .filter((lease) => lease.namespace === "family-history" && lease.provider === "FamilySearch" && ["active", "parked"].includes(lease.state))
      .flatMap((lease) => lease.descendants || []));
    const inventory = await sharedPageInventory(context);
    const pages = inventory
      .filter((item) => leasedTargetIds.has(item.targetId) ||
        (recordedTargetIds.has(item.targetId) && isFamilySearchUrl(item.page.url())))
      .map((item) => item.page);
    await Promise.all(pages.map((item) => item.close({ runBeforeUnload: false }).catch(() => {})));
    await Promise.all(inventory.filter((item) => pages.includes(item.page)).map((item) => sharedConnection.forgetTarget(item.targetId).catch(() => {})));
    await bridgeControl("lease.releaseMatching", { namespace: "family-history", provider: "FamilySearch" });
    clearFamilySearchAffinityRecords();
    const label = mode === "pause" ? "FamilySearch task tab(s)" : "FamilySearch tab(s)";
    console.log(`Closed ${pages.length} ${label} without stopping the shared Chrome process or touching other provider tabs.`);
    await browser.close().catch(() => {});
    process.exit(0);
  }

  const context = browser.contexts()[0];
  if (!context) throw new Error("No Windows Chrome context is available at the FamilySearch debugging endpoint.");
  if (sharedWindow) {
    sharedContext = context;
  }

  // A record-master download must own its tab. Reusing the last FamilySearch tab
  // is unsafe when another bounded research action has an image viewer open: the
  // later action can otherwise save the other record under this target's name.
  const isBlankPage = (item) => item.url() === "about:blank" || item.url() === "chrome://newtab/";
  const reusableBlankPage = () => context.pages()
    .filter(isBlankPage)
    .at(-1);
  let page;
  let selectedImageThumbnailUrl = "";
  let captureRangeCompleted = false;
  if (sharedWindow) {
    const controlled = await getOrCreateSharedAffinityPage(sharedConnection, context, affinityPath);
    page = controlled.page;
    sharedPersistentPage = page;
    console.log(`${controlled.reused ? "Reusing" : "Created"} the bridge-owned Windows Chrome background tab for affinity slot ${affinitySlot}.`);
    if (mode === "signin") {
      await page.bringToFront();
    }
  } else {
    page = mode === "download-record"
      ? await context.newPage()
      : context.pages().filter((item) => item.url().includes("familysearch.org")).at(-1) || reusableBlankPage();
    if (mode === "download-record") transientPages.add(page);
  }
  if (!page) page = await context.newPage();

  // A prior run (especially an older pause command or a blocked popup) can
  // leave spare blank tabs behind.  Keep the one selected for reuse, but
  // remove all other blanks at the start of an active research action so they
  // cannot accumulate as searches continue.  Status/traffic checks stay
  // strictly read-only, and pause has its own full compaction below.
  if (!sharedWindow && !new Set(["pause", "status", "traffic"]).has(mode)) {
    const staleBlankPages = context.pages().filter((item) => item !== page && isBlankPage(item));
    await Promise.all(staleBlankPages.map((item) => item.close().catch(() => {})));
    if (staleBlankPages.length) {
      console.log(`Closed ${staleBlankPages.length} stale about:blank/new-tab page(s) before this FamilySearch action.`);
    }
  }

  if (mode === "traffic") {
    const traffic = await page.evaluate(() => {
      const entries = performance.getEntriesByType("resource");
      const byType = {};
      let transferBytes = 0;
      let encodedBytes = 0;
      let decodedBytes = 0;
      for (const entry of entries) {
        const type = entry.initiatorType || "other";
        byType[type] = (byType[type] || 0) + (entry.transferSize || 0);
        transferBytes += entry.transferSize || 0;
        encodedBytes += entry.encodedBodySize || 0;
        decodedBytes += entry.decodedBodySize || 0;
      }
      return { resources: entries.length, transferBytes, encodedBytes, decodedBytes, byType };
    });
    console.log("Current FamilySearch page resource usage (navigation-to-now):");
    console.log(`  resources=${traffic.resources} transfer=${formatBytes(traffic.transferBytes)} encoded=${formatBytes(traffic.encodedBytes)} decoded=${formatBytes(traffic.decodedBytes)}`);
    for (const [type, bytes] of Object.entries(traffic.byType).sort((left, right) => right[1] - left[1])) {
      console.log(`  ${type}: ${formatBytes(bytes)}`);
    }
  }

  if (mode === "signin" || mode === "film") {
    await page.goto(mode === "signin" ? signInUrl : filmUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForTimeout(1_000);
  }

  if (mode === "signin-saved") {
    // Shared guarded helper: checks the home page first, submits only a form
    // Chrome has visibly autofilled, and reports MFA/CAPTCHA as a human step.
    const outcome = await trySavedSignIn(page, "familysearch", { log: (message) => console.log(message) });
    if (outcome.status === "needs-user") {
      console.log("FamilySearch still needs a human sign-in step; npm run providers:signin -- --providers familysearch reveals it in the shared window.");
      process.exitCode = 3;
    }
  }

  if (mode === "viewer") {
    const archivesExit = page.getByRole("button", { name: /^Go to the National Archives, London, England$/i });
    const originalDocumentButton = page.getByRole("button", { name: /View original document/i });
    const originalDocumentLink = page.getByRole("link", { name: /View original document/i });
    const viewImageButton = page.getByRole("button", { name: "View Image", exact: true });
    const closeIntro = page.getByRole("button", { name: "Close", exact: true }).first();
    if (await archivesExit.isVisible().catch(() => false)) {
      const recordPage = page;
      const recordAddress = new URL(recordPage.url());
      if (recordAddress.hostname !== "www.familysearch.org"
        || !/^\/ark:\/61903\/1:1:[A-Z0-9-]+$/i.test(recordAddress.pathname)
        || await archivesExit.count() !== 1) {
        throw new Error("The National Archives navigation requires one exact FamilySearch record and one visible confirmation.");
      }
      const popupPromise = waitForOwnedPopup(recordPage, sharedConnection);
      await archivesExit.click({ noWaitAfter: true, timeout: 20_000 });
      const popup = await popupPromise;
      const destinationPage = popup || recordPage;
      if (popup) transientPages.add(popup);
      try {
        await destinationPage.waitForLoadState("domcontentloaded", { timeout: 20_000 }).catch(() => {});
        await destinationPage.waitForTimeout(1_000);
        const destination = new URL(destinationPage.url());
        // Emit fixed classifications only: even URL path segments can contain
        // authentication material. Do not read redirected account-page content.
        const destinationLabel = destination.protocol === "https:"
          && ["www.findmypast.co.uk", "www.findmypast.com"].includes(destination.hostname)
          && destination.pathname === "/register"
          ? "Findmypast registration page"
          : destination.protocol === "https:"
            && ["discovery.nationalarchives.gov.uk", "www.nationalarchives.gov.uk"].includes(destination.hostname)
            ? "The National Archives website"
            : "unclassified external route";
        console.log(`FamilySearch external destination: ${destinationLabel}`);
      } finally {
        if (!popup && recordPage.url() !== recordAddress.href) {
          await recordPage.goto(recordAddress.href, { waitUntil: "domcontentloaded", timeout: 45_000 });
        }
      }
    } else if (await viewImageButton.isVisible().catch(() => false)) {
      const popupPromise = waitForOwnedPopup(page, sharedConnection, { timeoutMs: 10_000 });
      console.log("Opening the FamilySearch original image...");
      await viewImageButton.click({ noWaitAfter: true, timeout: 20_000 });
      const popup = await popupPromise;
      if (popup) {
        page = popup;
        await page.waitForLoadState("domcontentloaded", { timeout: 20_000 }).catch(() => {});
      }
      await page.waitForTimeout(1_000);
    } else if (await closeIntro.isVisible().catch(() => false)) {
      console.log("Closing the viewer introduction...");
      await closeIntro.click({ noWaitAfter: true, timeout: 20_000 });
      await page.waitForTimeout(500);
    } else if (await originalDocumentButton.isVisible().catch(() => false) || await originalDocumentLink.isVisible().catch(() => false)) {
      const popupPromise = waitForOwnedPopup(page, sharedConnection, { timeoutMs: 10_000 });
      console.log("Opening the FamilySearch original document viewer...");
      const originalDocument = await originalDocumentButton.isVisible().catch(() => false) ? originalDocumentButton : originalDocumentLink;
      await originalDocument.click({ noWaitAfter: true, timeout: 20_000 });
      const popup = await popupPromise;
      if (popup) {
        page = popup;
        await page.waitForLoadState("domcontentloaded", { timeout: 20_000 }).catch(() => {});
      }
      await page.waitForTimeout(1_000);
    } else {
    const viewButton = page.getByRole("button", { name: "View single image" });
    await viewButton.waitFor({ state: "visible", timeout: 20_000 });
    const popupPromise = waitForOwnedPopup(page, sharedConnection, { timeoutMs: 10_000 });
    console.log("Opening the FamilySearch image viewer...");
    await viewButton.click({ noWaitAfter: true, timeout: 20_000 });
    console.log("Viewer control activated.");
    const popup = await popupPromise;
    if (popup) {
      page = popup;
      await page.waitForLoadState("domcontentloaded", { timeout: 20_000 }).catch(() => {});
    }
    await page.waitForTimeout(1_000);
    }
  }

  if (mode === "fulltext") {
    const fullText = page.getByRole("link", { name: /This film is available in Full-Text Search/i });
    await fullText.waitFor({ state: "visible", timeout: 20_000 });
    const href = await fullText.getAttribute("href");
    if (!href) throw new Error("FamilySearch full-text-search link did not contain a destination URL.");
    await page.goto(new URL(href, page.url()).href, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForTimeout(1_000);
  }

  if (mode === "query") {
    if (!searchQuery) throw new Error("--query requires a search value.");
    const url = new URL("https://www.familysearch.org/en/search/full-text/results");
    url.searchParams.set("q.groupName", "004017209");
    url.searchParams.set("q.text", searchQuery);
    await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForTimeout(4_000);
  }

  if (mode === "global-query") {
    if (!searchQuery) throw new Error("--global-query requires a search value.");
    const url = new URL("https://www.familysearch.org/en/search/full-text/results");
    url.searchParams.set("q.text", searchQuery);
    await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForTimeout(4_000);
  }

  if (mode === "record") {
    if (!recordUrl) throw new Error("--record requires a FamilySearch record URL.");
    const target = new URL(recordUrl);
    if (target.protocol !== "https:" || target.hostname !== "www.familysearch.org") {
      throw new Error("--record accepts only https://www.familysearch.org record URLs.");
    }
    await page.goto(target.href, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForTimeout(4_000);
  }

  if (mode === "links" && recordUrl) {
    const target = new URL(recordUrl);
    if (target.protocol !== "https:" || target.hostname !== "www.familysearch.org") {
      throw new Error("--links --record accepts only https://www.familysearch.org URLs.");
    }
    await page.goto(target.href, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForTimeout(4_000);
  }

  if (mode === "scan-index") {
    const target = new URL(recordUrl || "");
    const imageCount = Number(scanIndexCount);
    const startImage = Number(imageNumber || "1");
    if (target.protocol !== "https:" || target.hostname !== "www.familysearch.org") {
      throw new Error("--scan-index accepts only https://www.familysearch.org viewer URLs.");
    }
    if (!Number.isInteger(imageCount) || imageCount < 1 || imageCount > 500) {
      throw new Error("--scan-index requires an image count from 1 through 500.");
    }
    if (!Number.isInteger(startImage) || startImage < 1) {
      throw new Error("--scan-index --image requires a positive starting image number.");
    }
    await page.goto(target.href, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForTimeout(8_000);
    await assertFamilySearchSignedIn(page);
    await assertViewerGroup(page, target.searchParams.get("groupId"));
    const endImage = startImage + imageCount - 1;
    console.log(`Scanning indexed records on images ${startImage} through ${endImage}.`);
    for (let image = startImage; image <= endImage; image += 1) {
      await navigateViewerToImage(page, String(image), { quiet: true });
      await assertViewerGroup(page, target.searchParams.get("groupId"));
      const records = await page.locator("a[href*='/ark:/61903/1:1:']").evaluateAll((nodes) => {
        const clean = (value) => (value || "").replace(/\s+/g, " ").trim();
        const rows = [];
        for (const node of nodes) {
          const href = node.getAttribute("href") || "";
          if (!href || rows.some((row) => row.href === href)) continue;
          let context = "";
          let container = node;
          for (let depth = 0; container && depth < 7; depth += 1, container = container.parentElement) {
            const candidate = clean(container.innerText);
            if (candidate.length >= 20 && candidate.length <= 700 && candidate.length > context.length) context = candidate;
          }
          rows.push({ href, label: clean(node.textContent), context: context.slice(0, 500) });
        }
        return rows;
      });
      console.log(`Indexed records on image ${image}:`);
      for (const record of records) console.log(`  ${record.href} | ${record.label}${record.context ? ` | ${record.context}` : ""}`);
    }
    console.log(`Completed indexed-record scan of images ${startImage} through ${endImage}.`);
  }

  if (mode === "scan-results") {
    const target = new URL(recordUrl || "");
    const pageCount = Number(scanResultCount);
    const filterTerms = (contextQuery || "").split("|").map((term) => term.replace(/\s+/g, " ").trim()).filter(Boolean);
    const filterPatterns = filterTerms.map((term) => new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "iu"));
    if (target.protocol !== "https:" || target.hostname !== "www.familysearch.org" || !/^\/en\/search\/record\/results\/?$/.test(target.pathname)) {
      throw new Error("--scan-results accepts only https://www.familysearch.org/en/search/record/results URLs.");
    }
    if (!Number.isInteger(pageCount) || pageCount < 1 || pageCount > 50 || filterTerms.length < 1) {
      throw new Error("--scan-results requires 1 through 50 pages and one or more pipe-separated filter terms.");
    }
    await page.goto(target.href, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForTimeout(4_000);
    await assertFamilySearchSignedIn(page);
    let totalRecords = 0;
    let totalMatches = 0;
    let effectivePages = 0;
    let repeatedBoundary = null;
    const seenRecords = new Set();
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      const records = await page.locator("a[href*='/ark:/61903/1:1:']").evaluateAll((nodes) => {
        const clean = (value) => (value || "").replace(/\s+/g, " ").trim();
        const rows = [];
        for (const node of nodes) {
          const match = (node.getAttribute("href") || "").match(/\/ark:\/61903\/1:1:[A-Z0-9-]+/i);
          const ark = match?.[0] || "";
          if (!ark || rows.some((row) => row.ark === ark)) continue;
          let context = "";
          for (let depth = 0, container = node; container && depth < 7; depth += 1, container = container.parentElement) {
            const candidate = clean(container.innerText);
            if (candidate.length >= 40 && candidate.length <= 1_500 && candidate.length > context.length) context = candidate;
          }
          rows.push({ ark, href: new URL(node.getAttribute("href"), location.href).href, context: context.slice(0, 1_200) });
        }
        return rows;
      });
      const newRecords = records.filter((record) => !seenRecords.has(record.ark));
      for (const record of newRecords) seenRecords.add(record.ark);
      if (newRecords.length === 0) {
        repeatedBoundary = pageNumber;
        console.log(`Stopped at provider repeat boundary: result page ${pageNumber} contained only previously scanned records.`);
        break;
      }
      effectivePages += 1;
      const matches = newRecords.filter((record) => filterPatterns.some((pattern) => pattern.test(record.context)));
      totalRecords += newRecords.length;
      totalMatches += matches.length;
      console.log(`Scanned result page ${pageNumber}: ${newRecords.length} new unique records; ${matches.length} filter matches.`);
      for (const match of matches) console.log(`  ${match.href} | ${match.context}`);
      if (pageNumber === pageCount) break;
      const next = page.getByRole("button", { name: /^Go to next Page\. Currently on Page /i });
      await next.waitFor({ state: "visible", timeout: 20_000 });
      if (await next.isDisabled()) throw new Error(`FamilySearch ended after ${pageNumber} result pages; ${pageCount} were requested.`);
      const previousLabel = await next.getAttribute("aria-label");
      const previousFirstArk = records[0]?.ark || "";
      await next.click({ timeout: 20_000 });
      await page.waitForFunction((label) => {
        const button = [...document.querySelectorAll("button")].find((item) => /^Go to next Page\. Currently on Page /i.test(item.getAttribute("aria-label") || ""));
        return button && button.getAttribute("aria-label") !== label;
      }, previousLabel, { timeout: 30_000 });
      await page.waitForFunction((ark) => {
        const node = document.querySelector("a[href*='/ark:/61903/1:1:']");
        const nextArk = (node?.getAttribute("href") || "").match(/\/ark:\/61903\/1:1:[A-Z0-9-]+/i)?.[0] || "";
        return nextArk && nextArk !== ark;
      }, previousFirstArk, { timeout: 30_000 });
      await page.waitForTimeout(250);
    }
    console.log(`Completed bounded result scan: ${effectivePages} effective pages, ${totalRecords} unique page records, ${totalMatches} filter matches${repeatedBoundary ? `; provider repeat boundary at page ${repeatedBoundary}` : ""}.`);
  }

  if (mode === "scan-transcripts") {
    const target = new URL(recordUrl || "");
    const startImage = Number(imageNumber);
    const imageCount = Number(scanTranscriptCount);
    const terms = (contextQuery || "").split("|").map((term) => term.replace(/\s+/g, " ").trim()).filter(Boolean);
    if (target.protocol !== "https:" || target.hostname !== "www.familysearch.org" || !/\/ark:\/61903\/3:1:/.test(target.pathname)) {
      throw new Error("--scan-transcripts accepts only https://www.familysearch.org original-image viewer URLs.");
    }
    if (!Number.isInteger(startImage) || startImage < 1 || !Number.isInteger(imageCount) || imageCount < 1 || imageCount > 200 || terms.length < 1) {
      throw new Error("--scan-transcripts requires a positive start image, 1 through 200 images, and one or more pipe-separated terms.");
    }
    await page.goto(target.href, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForTimeout(8_000);
    await assertFamilySearchSignedIn(page);
    let transcriptPages = 0;
    let matchedPages = 0;
    for (let image = startImage; image < startImage + imageCount; image += 1) {
      await navigateViewerToImage(page, String(image), { quiet: true });
      const transcript = await page.evaluate(() => {
        // The viewer renders the transcript in a sibling application panel,
        // outside <main>; body text is therefore the authoritative surface.
        const text = (document.body?.innerText || "").replace(/\s+/g, " ").trim();
        const transcriptAt = text.lastIndexOf("Transcript");
        return (transcriptAt >= 0 ? text.slice(transcriptAt + "Transcript".length) : "").slice(0, 30_000).trim();
      });
      if (!transcript) continue;
      transcriptPages += 1;
      const lower = transcript.toLocaleLowerCase();
      const matchedTerm = terms.find((term) => lower.includes(term.toLocaleLowerCase()));
      if (!matchedTerm) continue;
      matchedPages += 1;
      const at = lower.indexOf(matchedTerm.toLocaleLowerCase());
      const excerpt = transcript.slice(Math.max(0, at - 500), Math.min(transcript.length, at + matchedTerm.length + 2_500));
      // Emit the viewer's exact current ARK with each hit so a bounded scan can
      // be converted into a durable citation without a second broad search.
      console.log(`Transcript match on image ${image} for ${JSON.stringify(matchedTerm)} at ${page.url()}: ${excerpt}`);
    }
    console.log(`Scanned transcript images ${startImage}-${startImage + imageCount - 1}: ${transcriptPages} transcript page(s), ${matchedPages} matched page(s).`);
  }

  if (mode === "download-record") {
    assertOwnedPage(page, sharedConnection);
    if (!recordUrl) throw new Error("--download-record requires --record with a FamilySearch URL.");
    const target = new URL(recordUrl);
    if (target.protocol !== "https:" || target.hostname !== "www.familysearch.org") {
      throw new Error("--download-record accepts only https://www.familysearch.org record URLs.");
    }
    if (memoryTitle && (imageNumber || !isMemoryGallery(target))) {
      throw new Error("A titled Memory download requires the exact person Memories URL without a frame or URL parameters.");
    }
    const downloadPath = process.env.FAMILYSEARCH_DOWNLOAD_PATH;
    if (!downloadPath || !path.win32.isAbsolute(downloadPath)
      || path.win32.basename(path.win32.dirname(downloadPath)).toLocaleLowerCase() !== "familyhistorysourcemasters") {
      throw new Error("FAMILYSEARCH_DOWNLOAD_PATH must be an absolute file in FamilyHistorySourceMasters.");
    }
    if (memoryTitle && fs.existsSync(downloadPath)) {
      throw new Error("The Memory destination already exists in the source archive.");
    }
    console.log("Opening the requested FamilySearch record in the owned download tab.");
    await page.goto(target.href, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForTimeout(2_000);
    await assertFamilySearchSignedIn(page);
    const closeIntro = page.getByRole("button", { name: "Close", exact: true }).last();
    if (!memoryTitle && await closeIntro.isVisible().catch(() => false)) {
      await closeIntro.click({ force: true, noWaitAfter: true, timeout: 10_000 });
      await page.waitForTimeout(500);
    }
    // A numbered acquisition must bind to the exact requested film frame
    // before any distribution is saved.  Otherwise a viewer already showing
    // an adjacent frame can satisfy saveDeepZoomDistribution and silently
    // produce the wrong source master.
    let selectedDownloadThumbnailUrl = "";
    if (imageNumber) {
      selectedDownloadThumbnailUrl = await navigateViewerToImage(page, imageNumber);
    }
    let saved;
    if (memoryTitle) {
      await saveMemoryDownload(page, memoryTitle, downloadPath);
      saved = true;
    } else {
      saved = selectedDownloadThumbnailUrl
        ? await saveExactThumbnailDistribution(page, context, selectedDownloadThumbnailUrl, downloadPath)
          .then(() => true)
          .catch(() => false)
        : await saveDeepZoomDistribution(page, context, downloadPath);
    }
    if (!saved) {
      const checkImageAvailability = page.getByRole("button", { name: /^Check Image Availability$/i }).first();
      await checkImageAvailability.waitFor({ state: "visible", timeout: 8_000 }).catch(() => {});
      if (await checkImageAvailability.isVisible().catch(() => false)) {
        console.log("Checking FamilySearch image availability through the visible provider control.");
        const availabilityPopupPromise = waitForOwnedPopup(page, sharedConnection, { timeoutMs: 8_000 });
        await checkImageAvailability.click({ noWaitAfter: true, timeout: 20_000 });
        const availabilityPopup = await availabilityPopupPromise;
        if (availabilityPopup) {
          page = availabilityPopup;
          transientPages.add(page);
          await page.waitForLoadState("domcontentloaded", { timeout: 20_000 }).catch(() => {});
        }
        await page.waitForTimeout(2_000);
        await assertFamilySearchSignedIn(page);
      }
      const openOriginal = page.getByRole("button", { name: /^(?:View Image|View original document)$/i }).first();
      const openOriginalLink = page.getByRole("link", { name: /View original document/i }).first();
      const originalHref = await openOriginalLink.getAttribute("href").catch(() => "");
      if (originalHref) {
        const originalUrl = new URL(originalHref, page.url()).href;
        console.log("Navigating directly to the FamilySearch original-image URL.");
        await page.goto(originalUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
        await page.waitForTimeout(1_500);
        await assertFamilySearchSignedIn(page);
      } else if (await openOriginal.isVisible().catch(() => false)) {
        const popupPromise = waitForOwnedPopup(page, sharedConnection, { timeoutMs: 10_000 });
        await openOriginal.click({ noWaitAfter: true, timeout: 20_000 });
        const popup = await popupPromise;
        if (popup) {
          page = popup;
          transientPages.add(page);
        }
        await page.waitForLoadState("domcontentloaded", { timeout: 20_000 }).catch(() => {});
        await page.waitForTimeout(1_500);
      }
      if (imageNumber) {
        selectedDownloadThumbnailUrl = await navigateViewerToImage(page, imageNumber);
      }
      const originalHost = new URL(page.url()).hostname.toLocaleLowerCase();
      if (originalHost !== "www.familysearch.org" && !originalHost.endsWith(".familysearch.org")) {
        throw new Error(`FamilySearch delegates this original to ${originalHost}; no FamilySearch download is attempted from the external provider viewer.`);
      }
      console.log("Attempting FamilySearch's provider download or image-distribution endpoint.");
      saved = selectedDownloadThumbnailUrl
        ? await saveExactThumbnailDistribution(page, context, selectedDownloadThumbnailUrl, downloadPath)
          .then(() => true)
          .catch(() => false)
        : await saveDeepZoomDistribution(page, context, downloadPath);
      if (!saved) saved = await saveVisibleDownload(page, downloadPath, 8_000);
      if (!saved) saved = await saveDeepZoomDistribution(page, context, downloadPath);
      if (!saved) throw new Error("FamilySearch did not return a source image from its visible Download control.");
    }
    const contents = fs.readFileSync(downloadPath);
    const digest = createHash("sha256").update(contents).digest("hex");
    console.log(`Downloaded FamilySearch source master: ${path.win32.basename(downloadPath)} (${contents.length} bytes, sha256 ${digest})`);
  }

  if (mode === "inspect" && recordUrl) {
    const target = new URL(recordUrl);
    if (target.protocol !== "https:" || target.hostname !== "www.familysearch.org") {
      throw new Error("--inspect --record accepts only https://www.familysearch.org URLs.");
    }
    await page.goto(target.href, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForTimeout(8_000);
    await assertFamilySearchSignedIn(page);
    if (imageNumber) selectedImageThumbnailUrl = await navigateViewerToImage(page, imageNumber);
    if (/\/search\/film\//i.test(page.url())) {
      const currentImageInput = page.locator('input[aria-label*="Image" i], input[name*="image" i], input[type="number"]').first();
      const currentImageNumber = await currentImageInput.inputValue().catch(() => "");
      const selectedImage = page.getByRole("button", { name: `Go to image ${currentImageNumber}` });
      if (currentImageNumber && await selectedImage.isVisible().catch(() => false)) {
        await selectedImage.click({ noWaitAfter: true, timeout: 20_000 });
        await page.waitForTimeout(8_000);
      }
    }
  }

  if (mode === "context" && recordUrl) {
    const target = new URL(recordUrl);
    if (target.protocol !== "https:" || target.hostname !== "www.familysearch.org") {
      throw new Error("--context --record accepts only https://www.familysearch.org URLs.");
    }
    await page.goto(target.href, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForTimeout(8_000);
    await assertFamilySearchSignedIn(page);
    const exactContext = page.getByText(contextQuery, { exact: true }).first();
    const memoryTile = page.getByRole("button", { name: `Photo memory titled ${contextQuery}`, exact: true });
    const expandableContext = /\/tree\/person\/memories\//.test(target.pathname) && await memoryTile.count() === 1
      ? memoryTile
      : exactContext.locator("xpath=ancestor-or-self::*[self::button or @role='button'][1]");
    if (await expandableContext.isVisible().catch(() => false)) {
      await expandableContext.click({ timeout: 20_000 });
      await page.waitForTimeout(750);
    }
    const exactContextDetails = await exactContext.evaluate((node, term) => {
      const wanted = String(term).replace(/\s+/g, " ").trim().toLocaleLowerCase();
      let best = "";
      for (let depth = 0, container = node; container && depth < 10; depth += 1, container = container.parentElement) {
        const text = (container.innerText || container.textContent || "").replace(/\s+/g, " ").trim();
        if (!text.toLocaleLowerCase().includes(wanted) || text.length <= wanted.length) continue;
        if (!best || text.length < best.length) best = text;
      }
      return best.slice(0, 12_000);
    }, contextQuery).catch(() => "");
    if (exactContextDetails) console.log(`  Exact element context: ${exactContextDetails}`);
  }

  if (mode === "capture" && recordUrl) {
    const target = new URL(recordUrl);
    if (target.protocol !== "https:" || target.hostname !== "www.familysearch.org") {
      throw new Error("--capture --record accepts only https://www.familysearch.org URLs.");
    }
    if (memoryTitle && (!isMemoryGallery(target) || captureCount !== undefined || captureImages !== undefined || imageNumber)) {
      throw new Error("A titled Memory capture requires the exact person Memories URL without a frame, range or URL parameters.");
    }
    await page.goto(target.href, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForTimeout(8_000);
    await assertFamilySearchSignedIn(page);
    await assertViewerGroup(page, target.searchParams.get("groupId"));
    if (memoryTitle) {
      assertOwnedPage(page, sharedConnection);
      const capturePath = process.env.FAMILYSEARCH_CAPTURE_PATH;
      if (!capturePath || path.win32.dirname(capturePath).toLowerCase() !== os.tmpdir().toLowerCase()) {
        throw new Error("A Memory preview must be saved in the Windows temporary directory.");
      }
      await captureMemoryThumbnail(page, context, memoryTitle, capturePath);
      captureRangeCompleted = true;
    } else if (captureCount !== undefined || captureImages !== undefined) {
      let requestedImages;
      if (captureImages !== undefined) {
        requestedImages = captureImages.split(",").map(Number);
        if (requestedImages.length < 1 || requestedImages.length > 100
          || requestedImages.some((image) => !Number.isInteger(image) || image < 1)
          || new Set(requestedImages).size !== requestedImages.length) {
          throw new Error("--capture-images requires 1 through 100 unique comma-separated positive image numbers.");
        }
      } else {
        const count = Number(captureCount);
        const startImage = Number(imageNumber);
        if (!Number.isInteger(startImage) || startImage < 1 || !Number.isInteger(count) || count < 1 || count > 50) {
          throw new Error("--capture-count requires --image and a bounded count from 1 through 50.");
        }
        requestedImages = Array.from({ length: count }, (_, offset) => startImage + offset);
      }
      const capturePath = process.env.FAMILYSEARCH_CAPTURE_PATH;
      if (!capturePath) throw new Error("FAMILYSEARCH_CAPTURE_PATH must be set for a temporary viewer capture.");
      const captureJobs = [];
      for (const currentImage of requestedImages) {
        // Select every requested frame before binding its distribution. Merely
        // scrolling an exact grid card into view can leave React's recycled
        // <img> node on a prior thumbnail even though the card label and input
        // already show the requested number. The selected URL's zero-based `i`
        // value is independently checked by navigateViewerToImage.
        const thumbnailUrl = await navigateViewerToImage(page, String(currentImage), { quiet: true });
        await assertViewerGroup(page, target.searchParams.get("groupId"));
        const numberedPath = numberedCapturePath(capturePath, currentImage);
        if (!thumbnailUrl) {
          throw new Error(`FamilySearch did not return the exact image distribution for audit capture ${currentImage}.`);
        }
        captureJobs.push({ currentImage, thumbnailUrl, numberedPath });
      }
      const captureFailures = [];
      let nextCaptureJob = 0;
      const captureWorkerCount = Math.min(4, captureJobs.length);
      await Promise.all(Array.from({ length: captureWorkerCount }, async () => {
        while (nextCaptureJob < captureJobs.length) {
          const job = captureJobs[nextCaptureJob];
          nextCaptureJob += 1;
          try {
            await saveExactThumbnailDistribution(page, context, job.thumbnailUrl, job.numberedPath, { auditCapture: true });
            console.log(`Temporary exact image ${job.currentImage} capture: ${job.numberedPath}`);
          } catch (error) {
            captureFailures.push({ image: job.currentImage, message: error instanceof Error ? error.message : String(error) });
          }
        }
      }));
      if (captureFailures.length) {
        throw new Error(`FamilySearch audit capture failed for ${captureFailures.map((failure) => failure.image).join(", ")}: ${captureFailures[0].message}`);
      }
      captureRangeCompleted = true;
      console.log(`Completed bounded exact-image capture of ${requestedImages.length} requested image(s): ${requestedImages.join(",")}.`);
    } else {
      if (imageNumber) selectedImageThumbnailUrl = await navigateViewerToImage(page, imageNumber);
      await assertViewerGroup(page, target.searchParams.get("groupId"));
    }
  }

  if (mode === "book-page") {
    // Temporary reads of Digital Library book pages. The viewer draws each
    // page from IIIF tiles of one image per page sequence
    // (/library/books/i/?IIIF=<path>/<book>_<vol>_<seq>.tif/<region>/...).
    // Open the viewer once, learn that page-image identifier from the tiles
    // it requested, then fetch each requested sequence whole with the tab's
    // own session and write it to a numbered temporary file.
    const itemId = bookItemId(recordUrl);
    const pages = bookPageNumbers(captureImages);
    const capturePath = process.env.FAMILYSEARCH_CAPTURE_PATH;
    if (!capturePath) throw new Error("FAMILYSEARCH_CAPTURE_PATH must be set for a temporary book-page capture.");
    let template = null;
    let leftViewer = "";
    for (let visit = 0; visit < 3 && !template; visit += 1) {
      await page.goto(bookViewerPageUrl(itemId, 1), { waitUntil: "domcontentloaded", timeout: 45_000 });
      await assertFamilySearchSignedIn(page);
      for (let attempt = 0; attempt < 20 && !template; attempt += 1) {
        await page.waitForTimeout(1_000);
        const pathname = new URL(page.url()).pathname;
        if (!pathname.startsWith(`/library/books/viewer/${itemId}`)) {
          // The viewer sometimes bounces back to the item record page; reopen it.
          leftViewer = pathname;
          break;
        }
        const tilePaths = await page.evaluate(() => performance.getEntriesByType("resource")
          .map((entry) => { try { return new URL(entry.name).searchParams.get("IIIF") || ""; } catch { return ""; } })
          .filter(Boolean));
        template = bookImageTemplate(tilePaths);
      }
    }
    if (!template && leftViewer) {
      throw new Error(`The Digital Library viewer for item ${itemId} kept returning to ${leftViewer}; a human challenge or a changed viewer may be blocking it.`);
    }
    if (!template) throw new Error(`The Digital Library viewer loaded no IIIF page tiles for item ${itemId}.`);
    for (const bookPage of pages) {
      const source = `/library/books/i/?IIIF=${encodeURIComponent(bookPageImagePath(template, bookPage))}`;
      // Fetch through the tab's browser context so the session cookies apply
      // and a viewer bounce back to the item page cannot interrupt the read.
      const response = await page.context().request.get(`https://www.familysearch.org${source}`, { timeout: 60_000 });
      const bytes = Buffer.from(await response.body());
      const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
      if (response.status() !== 200 || !isJpeg || bytes.length < 10_000) {
        throw new Error(`Digital Library item ${itemId} sequence ${bookPage} returned HTTP ${response.status()} ${response.headers()["content-type"] || ""} (${bytes.length} bytes), not a page image.`);
      }
      const outputPath = numberedCapturePath(capturePath, bookPage);
      fs.writeFileSync(outputPath, bytes);
      console.log(`Temporary Digital Library item ${itemId} image sequence ${bookPage} capture (${bytes.length} bytes): ${outputPath}`);
    }
    console.log(`Completed bounded Digital Library capture of ${pages.length} image sequence(s): ${pages.join(",")}.`);
  }

  if (mode === "capture" && !recordUrl && imageNumber) {
    selectedImageThumbnailUrl = await navigateViewerToImage(page, imageNumber);
  }

  if (mode === "source-item") {
    if (!recordUrl || !sourceItem) throw new Error("--source-item requires --record and a source title.");
    const target = new URL(recordUrl);
    if (target.protocol !== "https:" || target.hostname !== "www.familysearch.org") {
      throw new Error("--source-item accepts only an https://www.familysearch.org source-list URL.");
    }
    await page.goto(target.href, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForTimeout(3_000);
    const wantedSource = sourceItem.replace(/\s+/g, " ").trim().toLocaleLowerCase();
    const candidates = page.getByRole("button").filter({ hasText: sourceItem });
    const candidateCount = await candidates.count();
    let source = null;
    let shortestMatch = Number.POSITIVE_INFINITY;
    for (let index = 0; index < candidateCount; index += 1) {
      const candidate = candidates.nth(index);
      const label = await candidate.evaluate((node) => (node.innerText || node.textContent || "").replace(/\s+/g, " ").trim()).catch(() => "");
      if (!label.toLocaleLowerCase().includes(wantedSource) || label.length >= shortestMatch) continue;
      source = candidate;
      shortestMatch = label.length;
    }
    if (!source) throw new Error(`No source card was found for: ${sourceItem}`);
    await source.scrollIntoViewIfNeeded();
    await source.click({ timeout: 20_000 });
    await page.waitForTimeout(500);
    let view = source
      .locator("xpath=ancestor::*[.//button[normalize-space(.)='View']][1]")
      .getByRole("button", { name: "View", exact: true })
      .first();
    if (!await view.isVisible().catch(() => false)) {
      const viewCandidates = page.getByRole("button", { name: "View", exact: true });
      const count = await viewCandidates.count();
      view = null;
      for (let index = 0; index < count; index += 1) {
        const candidate = viewCandidates.nth(index);
        const matches = await candidate.evaluate((node, query) => {
          const wanted = String(query).replace(/\s+/g, " ").trim().toLocaleLowerCase();
          let container = node.parentElement;
          for (let depth = 0; container && depth < 10; depth += 1, container = container.parentElement) {
            const text = (container.innerText || "").replace(/\s+/g, " ").trim().toLocaleLowerCase();
            if (text.includes(wanted)) return true;
          }
          return false;
        }, sourceItem).catch(() => false);
        if (matches) {
          view = candidate;
          break;
        }
      }
    }
    if (!view) throw new Error(`No View control was found for source card: ${sourceItem}`);
    const popupPromise = waitForOwnedPopup(page, sharedConnection, { timeoutMs: 10_000 });
    await view.click({ noWaitAfter: true, timeout: 20_000 });
    const popup = await popupPromise;
    if (popup) page = popup;
    await page.waitForLoadState("domcontentloaded", { timeout: 20_000 }).catch(() => {});
    await page.waitForTimeout(2_000);
  }

  if (mode === "source-view") {
    if (!recordUrl || !/^\d+$/.test(sourceViewIndex || "")) {
      throw new Error("--source-view requires a zero-based index and --record with a source-list URL.");
    }
    const target = new URL(recordUrl);
    if (target.protocol !== "https:" || target.hostname !== "www.familysearch.org") {
      throw new Error("--source-view accepts only an https://www.familysearch.org source-list URL.");
    }
    const current = new URL(page.url());
    if (current.hostname !== target.hostname || current.pathname !== target.pathname) {
      await page.goto(target.href, { waitUntil: "domcontentloaded", timeout: 45_000 });
      await page.waitForTimeout(3_000);
    }
    const index = Number(sourceViewIndex);
    const rows = page.getByRole("button").filter({ hasText: /^\s*\d{4}\s*\S/ });
    await rows.first().waitFor({ state: "visible", timeout: 20_000 });
    const count = await rows.count();
    if (index >= count) throw new Error(`Source row index ${index} is out of range; ${count} dated source rows were found.`);
    const row = rows.nth(index);
    await row.scrollIntoViewIfNeeded();
    await row.click({ timeout: 20_000 });
    const view = row
      .locator("xpath=ancestor::*[.//button[normalize-space(.)='View']][1]")
      .getByRole("button", { name: "View", exact: true })
      .first();
    await view.waitFor({ state: "visible", timeout: 20_000 });
    const popupPromise = waitForOwnedPopup(page, sharedConnection, { timeoutMs: 10_000 });
    await view.click({ noWaitAfter: true, timeout: 20_000 });
    const popup = await popupPromise;
    if (popup) page = popup;
    await page.waitForLoadState("domcontentloaded", { timeout: 20_000 }).catch(() => {});
    await page.waitForTimeout(2_000);
  }

  if (mode === "source-link") {
    if (!recordUrl || !sourceLink) throw new Error("--source-link requires --record and one exact attached source link.");
    const sourcePage = new URL(recordUrl);
    if (sourcePage.protocol !== "https:" || sourcePage.hostname !== "www.familysearch.org" || !/^\/en\/tree\/sources\/viewedit\/[A-Z0-9-]+$/i.test(sourcePage.pathname)) {
      throw new Error("--source-link requires an exact FamilySearch source-object URL.");
    }
    const expected = new URL(sourceLink);
    if (expected.protocol !== "https:" || !new Set(["www.findagrave.com", "images.findagrave.com"]).has(expected.hostname)) {
      throw new Error("--source-link currently permits only an exact attached Find a Grave source.");
    }
    await page.goto(sourcePage.href, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForTimeout(2_000);
    const exactLinks = page.locator("a[href]");
    const matchingHrefs = await exactLinks.evaluateAll((nodes, wanted) => nodes
      .map((node) => node.href)
      .filter((href) => href === wanted), expected.href);
    if (matchingHrefs.length !== 1) {
      throw new Error(`Expected exactly one attached source link, found ${matchingHrefs.length}.`);
    }
    await page.goto(expected.href, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForTimeout(3_000);
  }

  if (mode === "result-item") {
    if (!recordUrl || !resultItem) throw new Error("--result-item requires --record and an exact result title.");
    const target = new URL(recordUrl);
    if (target.protocol !== "https:" || target.hostname !== "www.familysearch.org" || !target.pathname.includes("/search/record/results")) {
      throw new Error("--result-item accepts only an https://www.familysearch.org search-results URL.");
    }
    await page.goto(target.href, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForTimeout(4_000);
    const result = page.getByText(resultItem, { exact: true }).first();
    await result.waitFor({ state: "visible", timeout: 20_000 });
    await result.click({ timeout: 20_000 });
    await page.waitForTimeout(2_000);
  }

  if (mode === "context" && !contextQuery) {
    throw new Error("--context requires a search value.");
  }

  if (mode === "catalog-probate") {
    await page.goto(hancockCatalogUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForTimeout(4_000);
    await dismissCatalogTourIfVisible(page);
    const probateFilter = page.getByText(/Probate records/i).first();
    await probateFilter.waitFor({ state: "visible", timeout: 20_000 });
    await probateFilter.click({ timeout: 20_000 });
    await page.waitForTimeout(2_000);
  }

  if (mode === "catalog-subject") {
    const target = new URL(catalogUrl || "");
    if (target.protocol !== "https:" || target.hostname !== "www.familysearch.org") {
      throw new Error("--catalog-url accepts only an https://www.familysearch.org catalog URL.");
    }
    await page.goto(target.href, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForTimeout(4_000);
    await dismissCatalogTourIfVisible(page);
    const subjectFilter = page.getByText(catalogSubject || "", { exact: false }).first();
    await subjectFilter.waitFor({ state: "visible", timeout: 20_000 });
    await subjectFilter.click({ timeout: 20_000 });
    await page.waitForTimeout(2_000);
  }

  if (mode === "catalog-page") {
    const target = new URL(catalogUrl || "");
    if (target.protocol !== "https:" || target.hostname !== "www.familysearch.org") {
      throw new Error("--catalog-url accepts only an https://www.familysearch.org catalog URL.");
    }
    const requestedPage = Number(catalogPage);
    if (!Number.isInteger(requestedPage) || requestedPage < 1) {
      throw new Error("--catalog-page requires a positive page number.");
    }
    await page.goto(target.href, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForTimeout(4_000);
    await dismissCatalogTourIfVisible(page);
    for (let currentPage = 1; currentPage < requestedPage; currentPage += 1) {
      await dismissCatalogTourIfVisible(page);
      const nextPage = page.getByRole("button", { name: /Go to next Page\./i });
      await nextPage.waitFor({ state: "visible", timeout: 20_000 });
      if (await nextPage.isDisabled()) {
        throw new Error(`Catalog has no page ${requestedPage}.`);
      }
      await nextPage.click({ timeout: 20_000 });
      await page.waitForTimeout(1_500);
      await dismissCatalogTourIfVisible(page);
    }
  }


  if (mode === "image") {
    await navigateViewerToImage(page, imageNumber);
  }

  if (mode === "pan-image-right") {
    const viewport = page.viewportSize();
    const y = Math.max(360, Math.round((viewport?.height || 900) * 0.58));
    await page.mouse.move(300, y);
    await page.mouse.down();
    await page.mouse.move(760, y, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(750);
    console.log("Panned the high-resolution image right.");
  }

  if (mode === "pan-image-left") {
    const viewport = page.viewportSize();
    const y = Math.max(360, Math.round((viewport?.height || 900) * 0.58));
    await page.mouse.move(760, y);
    await page.mouse.down();
    await page.mouse.move(300, y, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(750);
    console.log("Panned the high-resolution image left.");
  }

  if (mode === "pan-image-up" || mode === "pan-image-down") {
    const viewport = page.viewportSize();
    const x = Math.max(500, Math.round((viewport?.width || 1200) * 0.52));
    const startY = mode === "pan-image-up" ? 720 : 300;
    const endY = mode === "pan-image-up" ? 300 : 720;
    await page.mouse.move(x, startY);
    await page.mouse.down();
    await page.mouse.move(x, endY, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(750);
    console.log(`Panned the high-resolution image ${mode === "pan-image-up" ? "up" : "down"}.`);
  }

  if (mode === "capture" && !captureRangeCompleted) {
    const capturePath = process.env.FAMILYSEARCH_CAPTURE_PATH;
    if (!capturePath) throw new Error("FAMILYSEARCH_CAPTURE_PATH must be set for a temporary viewer capture.");
    const cancelLoad = page.getByRole("button", { name: "Cancel", exact: true });
    if (await cancelLoad.isVisible().catch(() => false)) {
      await cancelLoad.click({ timeout: 10_000 });
    }
    await page.waitForTimeout(8_000);
    const pageIdentity = `${page.url()} ${await page.title()}`;
    const fallbackImageArk = pageIdentity.match(/ark:\/61903\/3:1:([A-Z0-9-]+)/i)?.[1];
    const exactRecordPage = /\/ark:\/61903\/1:1:[A-Z0-9-]+/i.test(new URL(page.url()).pathname);
    const exactRecordImageSources = exactRecordPage
      ? await page.locator("img").evaluateAll((nodes) => [
          ...new Set(nodes
            .map((node) => node.currentSrc || node.src)
            .filter((source) => source.includes("/deepzoomcloud/dz/v1/")))
        ])
      : [];
    if (exactRecordPage && exactRecordImageSources.length !== 1) {
      throw new Error(`FamilySearch exposed ${exactRecordImageSources.length} exact record-page images; refusing an ambiguous source-master capture.`);
    }
    const captureUrls = [];
    if (selectedImageThumbnailUrl) {
      const selectedBase = new URL(selectedImageThumbnailUrl, page.url()).href.replace(/\/thumb_[^/]+$/i, "");
      captureUrls.push(`${selectedBase}/dist.jpg`, `${selectedBase}/thumb_p1000.jpg`, selectedImageThumbnailUrl);
    } else if (exactRecordImageSources.length === 1) {
      const exactRecordBase = new URL(exactRecordImageSources[0], page.url()).href.replace(/\/scale(?:\?.*)?$/i, "");
      captureUrls.push(`${exactRecordBase}/dist.jpg`, `${exactRecordBase}/thumb_p1000.jpg`);
    } else if (fallbackImageArk) {
      const fallbackBase = `https://www.familysearch.org/service/records/storage/deepzoomcloud/dz/v1/3:1:${fallbackImageArk}`;
      captureUrls.push(`${fallbackBase}/dist.jpg`, `${fallbackBase}/thumb_p200.jpg`);
    }
    let savedCapture = false;
    for (const captureUrl of captureUrls) {
      const capture = await context.request.get(captureUrl, {
        headers: { Referer: page.url() },
        timeout: 20_000
      }).catch(() => null);
      const contentType = capture?.headers()?.["content-type"] || "";
      if (!capture?.ok() || !/^image\//i.test(contentType)) continue;
      fs.writeFileSync(capturePath, await capture.body());
      savedCapture = true;
      break;
    }
    if (!savedCapture && imageNumber) savedCapture = await saveDeepZoomDistribution(page, context, capturePath);
    if (!savedCapture) await page.screenshot({ path: capturePath });
    console.log(`Temporary local viewer capture: ${capturePath}`);
  }

  if (mode === "close-panel") {
    const close = page.getByRole("button", { name: "Close", exact: true }).last();
    await close.waitFor({ state: "visible", timeout: 20_000 });
    await close.click({ force: true, timeout: 10_000 });
    await page.waitForTimeout(500);
    console.log("Closed the visible FamilySearch details panel.");
  }

  if (mode === "dismiss") {
    const cancel = page.getByRole("button", { name: "Cancel", exact: true }).last();
    if (await cancel.isVisible().catch(() => false)) {
      await cancel.click({ force: true, timeout: 10_000 });
      console.log("Dismissed the visible FamilySearch dialog.");
    } else {
      console.log("No dismissible FamilySearch dialog is visible.");
    }
  }

  if (mode === "zoom") {
    const zoomIn = page.getByRole("button", { name: "Zoom In", exact: true });
    await zoomIn.waitFor({ state: "visible", timeout: 20_000 });
    for (let index = 0; index < 3; index += 1) {
      await zoomIn.click({ noWaitAfter: true });
      await page.waitForTimeout(250);
    }
    console.log("Increased viewer zoom by three steps.");
  }

  if (mode === "reset") {
    const resetView = page.getByRole("button", { name: "Reset View", exact: true });
    await resetView.waitFor({ state: "visible", timeout: 20_000 });
    await resetView.click({ force: true, noWaitAfter: true, timeout: 20_000 });
    await page.waitForTimeout(750);
    console.log("Reset the image viewer position and zoom.");
  }

  if (mode === "catalog-annex-year") {
    const target = new URL(catalogUrl || "");
    const year = Number(argumentValue("--catalog-annex-year"));
    classifyAnnexYear("Allegati 1848", year);
    if (target.origin !== "https://www.familysearch.org" || !/^\/en\/search\/catalog\/(?:koha|olib):\d+$/.test(target.pathname) || target.search || target.hash) {
      throw new Error("Annex filtering requires one exact FamilySearch catalogue detail URL.");
    }
    assertOwnedPage(page, sharedConnection);
    await page.goto(target.href, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForTimeout(4_000);
    await dismissCatalogTourIfVisible(page);
    if (page.url() !== target.href) throw new Error("Catalogue detail redirected; no metadata emitted.");
    await page.locator("table tbody tr").first().waitFor({ state: "attached", timeout: 20_000 });
    const snapshot = await page.evaluate(`(${readCatalogAnnexPage.toString()})(${year}, ${classifyAnnexYear.toString()})`);
    console.log("Bounded catalogue annex metadata:");
    console.log(JSON.stringify(snapshot, null, 2));
  } else {
  // Excerpts around the searched names (FAMILYSEARCH_EXCERPT_TERMS, else
  // the query's words), or around years when there is neither.
  const excerptTerms = String(process.env.FAMILYSEARCH_EXCERPT_TERMS || searchQuery || "")
    .split(/[\s,]+/).map((term) => term.replace(/[^\p{L}'-]/gu, "")).filter((term) => term.length >= 3);
  assertOwnedPage(page, sharedConnection);
  const status = await page.evaluate(({ terms, suffix, flags }) => {
    const text = document.querySelector("main")?.innerText || document.body?.innerText || "";
    const excerpts = [];
    const escaped = terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const excerptPattern = new RegExp(escaped.length ? `(?:${escaped.join("|")})${suffix}` : "\\b1[5-9]\\d\\d\\b", flags.includes("g") ? flags : `${flags}g`);
    for (const match of text.matchAll(excerptPattern)) {
      const start = Math.max(0, match.index - 90);
      const end = Math.min(text.length, match.index + match[0].length + 180);
      const excerpt = text.slice(start, end).replace(/\s+/g, " ").trim();
      if (!excerpts.includes(excerpt)) excerpts.push(excerpt);
      if (excerpts.length === 25) break;
    }
    return {
      title: document.title,
      url: location.href,
      hasImageCue: /images?|view.*film|browse.*images?/i.test(text),
      hasSignInCue: /sign in|log in/i.test(text),
      hasRestrictionCue: /restricted|access.*denied|not available|unable to view/i.test(text),
      excerpts,
      household: (text.match(/Other People on This Record([\s\S]{0,1800}?)(?:Document Information|Collection Information|Cite This Record|About This Record)/i)?.[1] || "").replace(/\s+/g, " ").trim()
    };
  }, { terms: excerptTerms, suffix: "", flags: "gi" });

  console.log("FamilySearch page status:");
  console.log(`  Title: ${status.title}`);
  console.log(`  URL: ${status.url}`);
  console.log(`  Image cue: ${status.hasImageCue}`);
  console.log(`  Sign-in cue: ${status.hasSignInCue}`);
  console.log(`  Restriction cue: ${status.hasRestrictionCue}`);
  if (status.excerpts.length) {
    console.log("  Matched text excerpts:");
    for (const excerpt of status.excerpts) console.log(`    ${excerpt}`);
  }
  if (status.household) console.log(`  Other people on record: ${status.household}`);
  const structuredRecordFacts = await page.evaluate(() => {
    const clean = (value) => (value || "").replace(/\s+/g, " ").trim();
    const facts = [];
    for (const list of document.querySelectorAll("dl")) {
      const terms = [...list.querySelectorAll("dt")];
      for (const term of terms) {
        const detail = term.nextElementSibling;
        const label = clean(term.textContent);
        const value = clean(detail?.textContent);
        if (label && value && label.length <= 80 && value.length <= 300) {
          const fact = `${label}: ${value}`;
          if (!facts.includes(fact)) facts.push(fact);
        }
      }
    }
    for (const row of document.querySelectorAll("table tr")) {
      const cells = [...row.querySelectorAll("th, td")].map((cell) => clean(cell.textContent)).filter(Boolean);
      if (cells.length === 2 && cells[0].length <= 80 && cells[1].length <= 300) {
        const fact = `${cells[0]}: ${cells[1]}`;
        if (!facts.includes(fact)) facts.push(fact);
      }
    }
    return facts.slice(0, 30);
  });
  if (structuredRecordFacts.length) {
    console.log("  Structured record facts:");
    for (const fact of structuredRecordFacts) console.log(`    ${fact}`);
  }
  const catalogRows = await page.evaluate(() => {
    if (!/\/search\/catalog\//i.test(location.pathname)) return [];
    const clean = (value) => (value || "").replace(/\s+/g, " ").trim();
    return [...document.querySelectorAll("table tr")]
      .map((row) => {
        const cells = [...row.querySelectorAll("th, td")].map((cell) => clean(cell.textContent)).filter(Boolean);
        const links = [...row.querySelectorAll("a[href]")]
          .map((link) => link.href)
          .filter((href, index, values) => href && values.indexOf(href) === index);
        return { cells, links };
      })
      .filter(({ cells }) => cells.length >= 2)
      .map(({ cells, links }) => `${cells.join(" | ")}${links.length ? ` | ${links.join(" | ")}` : ""}`)
      .filter((value, index, values) => values.indexOf(value) === index)
      .slice(0, 60);
  });
  if (catalogRows.length) {
    console.log("  Catalog rows:");
    for (const row of catalogRows) console.log(`    ${row}`);
  }
  const fullTextResultSummary = await page.evaluate(() => {
    const text = (document.body?.innerText || "").replace(/\s+/g, " ").trim();
    const match = text.match(/Full-Text Search Results\s*\((\d+)\)/i)
      || text.match(/(?:Results|Matches)\s*\(?\s*(\d+)\s*\)?/i);
    return match ? match[1] : "";
  });
  if (fullTextResultSummary) {
    console.log(`  Full-text result count: ${fullTextResultSummary}`);
  }
  if (/\/ark:\/61903\/3:1:/.test(page.url()) && /[?&]view=fullText\b/i.test(page.url())) {
    const transcriptExcerpt = await page.evaluate(() => {
      const text = (document.body?.innerText || "").replace(/\s+/g, " ").trim();
      const transcriptAt = text.lastIndexOf("Transcript");
      return (transcriptAt >= 0 ? text.slice(transcriptAt + "Transcript".length) : text).slice(0, 4_000).trim();
    });
    if (transcriptExcerpt) console.log(`  Full-text transcript excerpt: ${transcriptExcerpt}`);
  }
  if (mode === "context") {
    const context = await page.evaluate((term) => {
      // Full-text viewer transcripts live outside <main> in a sibling panel.
      const text = (document.body?.innerText || "").replace(/\s+/g, " ").trim();
      const at = text.toLocaleLowerCase().indexOf(term.toLocaleLowerCase());
      if (at < 0) return "";
      return text.slice(Math.max(0, at - 500), Math.min(text.length, at + term.length + 12_000));
    }, contextQuery);
    console.log(context ? `  Context for ${JSON.stringify(contextQuery)}: ${context}` : `  No page text matched ${JSON.stringify(contextQuery)}.`);
  }
  if (mode === "links") {
    const links = await page.locator("a[href]").evaluateAll((nodes) => {
      const clean = (value) => (value || "").replace(/\s+/g, " ").trim();
      const rows = [];
      for (const node of nodes) {
        const href = node.href || "";
        if (!href || rows.some((row) => row.href === href)) continue;
        const label = clean(node.textContent)
          || clean(node.getAttribute("aria-label"))
          || clean(node.getAttribute("title"))
          || clean(node.querySelector("img")?.getAttribute("alt"));
        if ((!label && !/\/(?:ark:|search\/film\/)/.test(href)) || label.length > 300) continue;
        let container = node;
        let context = "";
        for (let depth = 0; container && depth < 7; depth += 1, container = container.parentElement) {
          const candidate = clean(container.innerText);
          if (candidate.length >= 80 && candidate.length <= 1_500) {
            context = candidate;
            break;
          }
        }
        rows.push({ href, label, context: context.slice(0, 700) });
      }
      return rows.slice(0, 300);
    });
    console.log("  Page links:");
    for (const link of links) console.log(`    ${link.href} | ${link.label}${link.context ? ` | ${link.context}` : ""}`);
    const controls = await page.locator("main button, [role=dialog] button:visible").evaluateAll((nodes) => nodes.map((node) => ({
      label: (node.getAttribute("aria-label") || node.textContent || "").replace(/\s+/g, " ").trim(),
      disabled: node.disabled,
      title: node.getAttribute("title") || ""
    })).filter((item) => item.label).slice(0, 200));
    if (controls.length) {
      console.log("  Page buttons:");
      for (const control of controls) console.log(`    ${control.label}${control.disabled ? " [disabled]" : ""}${control.title ? ` | ${control.title}` : ""}`);
    }
  }
  if (mode === "query" || mode === "global-query" || /\/search\/(?:record\/results|full-text\/results)/.test(page.url())) {
    const searchResults = await page.locator("a[href*='/ark:/61903/']").evaluateAll((nodes) => {
      const clean = (value) => (value || "").replace(/\s+/g, " ").trim();
      const rows = [];
      for (const node of nodes) {
        const href = node.href || "";
        if (!href || rows.some((row) => row.href === href)) continue;
        let container = node;
        let context = "";
        for (let depth = 0; container && depth < 7; depth += 1, container = container.parentElement) {
          const candidate = clean(container.innerText);
          if (candidate.length >= 40 && candidate.length <= 1_500 && candidate.length > context.length) context = candidate;
        }
        rows.push({ href, context: context.slice(0, 700) });
        if (rows.length === 12) break;
      }
      return rows;
    });
    if (searchResults.length) {
      console.log("  Search result links:");
      for (const result of searchResults) {
        console.log(`    ${result.href}${result.context ? ` | ${result.context}` : ""}`);
      }
    }
  }
  const currentImage = await page.locator("button").evaluateAll((nodes) => nodes
    .filter((node) => /^Go to image \d[\d,]*$/.test((node.getAttribute("aria-label") || "").trim()))
    .map((node) => ({
      label: node.getAttribute("aria-label"),
      current: node.getAttribute("aria-current") || "",
      pressed: node.getAttribute("aria-pressed") || "",
      className: node.className
    }))
    .filter((item) => item.current || item.pressed === "true" || /active|selected|current/i.test(item.className)));
  if (currentImage.length) {
    console.log(`  Current image control: ${currentImage.map((item) => item.label).join(", ")}`);
  }
  const gridThumbnails = await page.locator('button[aria-label^="Go to image "]').evaluateAll((nodes) => nodes
    .map((node) => ({
      label: node.getAttribute("aria-label") || "",
      source: node.querySelector("img")?.currentSrc || ""
    }))
    .filter((item) => item.source)
    .slice(0, 120));
  if (gridThumbnails.length) {
    console.log("  Loaded grid thumbnails:");
    for (const item of gridThumbnails) console.log(`    ${item.label} | ${item.source}`);
  }
  const viewerSurfaces = await page.evaluate(() => ({
    canvasCount: document.querySelectorAll("canvas").length,
    images: [...document.images].map((image) => ({
      alt: image.alt || "",
      label: image.closest("[aria-label]")?.getAttribute("aria-label") || "",
      context: (() => {
        let container = image.parentElement;
        for (let depth = 0; container && depth < 5; depth += 1, container = container.parentElement) {
          const value = (container.innerText || "").replace(/\s+/g, " ").trim();
          if (/^\d{1,4}$/.test(value)) return value;
        }
        return "";
      })(),
      width: image.naturalWidth,
      height: image.naturalHeight,
      displayedWidth: Math.round(image.getBoundingClientRect().width),
      displayedHeight: Math.round(image.getBoundingClientRect().height),
      sourceType: image.currentSrc.startsWith("blob:") ? "blob" : image.currentSrc ? "url" : "none",
      safeSource: (() => {
        if (!image.currentSrc || image.currentSrc.startsWith("blob:")) return "";
        try {
          const source = new URL(image.currentSrc);
          return `${source.origin}${source.pathname}${source.search ? `?${[...source.searchParams.keys()].join("&")}` : ""}`;
        } catch {
          return "unparseable";
        }
      })()
    })).filter((image) => image.width || image.height).slice(0, 12)
  }));
  console.log(`  Viewer surfaces: canvases=${viewerSurfaces.canvasCount}, loaded images=${viewerSurfaces.images.length}`);
  for (const image of viewerSurfaces.images) {
    console.log(
      `    image${image.context ? ` ${image.context}` : ""} ${image.width}x${image.height}, displayed ${image.displayedWidth}x${image.displayedHeight}, `
        + `source=${image.sourceType}${image.safeSource ? ` ${image.safeSource}` : ""}${image.label ? `, label=${image.label}` : ""}`
    );
  }
  const backgroundLayers = await page.evaluate(() => [...document.querySelectorAll("*")]
    .map((node) => {
      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return {
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        background: style.backgroundImage !== "none"
      };
    })
    .filter((item) => item.background && item.width >= 100 && item.height >= 100)
    .slice(0, 20));
  if (backgroundLayers.length) {
    console.log(`  Background image layers: ${backgroundLayers.map((item) => `${item.width}x${item.height}`).join(", ")}`);
  }
  console.log("Connected FamilySearch pages:");
  for (const item of sharedConnection.ownedPages().filter((item) => isFamilySearchUrl(item.url()))) {
    console.log(`  ${item.url()}`);
  }
  console.log(mode === "capture"
    ? "No cookies or credentials were read; the requested temporary capture was written outside Git."
    : mode === "download-record"
      ? "No cookies, credentials, or screenshots were read or written; the requested source master was saved only to the encrypted archive."
      : "No cookies, credentials, screenshots, or record images were read or written.");

  if (mode === "inspect") {
    const dialogs = await page.locator("[role='dialog'], [aria-modal='true'], .portalsCss_p1pr4d40").evaluateAll((nodes) => nodes
      .filter((node) => {
        const style = getComputedStyle(node);
        return style.visibility !== "hidden" && style.display !== "none";
      })
      .map((node) => (node.innerText || "").replace(/\s+/g, " ").trim().slice(0, 1_500))
      .filter(Boolean));
    if (dialogs.length) {
      console.log("Visible overlay text:");
      for (const text of dialogs) console.log(`  ${text}`);
    }

    const datedSourceRows = await page.getByRole("button").filter({ hasText: /^\s*\d{4}\s*\S/ })
      .evaluateAll((nodes) => nodes.map((node, index) => ({
        index,
        label: (node.innerText || node.textContent || "").replace(/\s+/g, " ").trim().slice(0, 500)
      })));
    if (datedSourceRows.length) {
      console.log("Dated source rows:");
      for (const row of datedSourceRows) console.log(`  source[${row.index}] | ${row.label}`);
    }

    const sourceViews = await page.locator("button").evaluateAll((nodes) => nodes
      .filter((node) => (node.innerText || node.textContent || "").replace(/\s+/g, " ").trim() === "View")
      .map((node, index) => {
      let container = node.parentElement;
      let context = "";
      for (let depth = 0; container && depth < 8; depth += 1, container = container.parentElement) {
        const candidate = (container.innerText || "").replace(/\s+/g, " ").trim();
        if (/\b(?:Census|Marriage|Birth|Death)\b/i.test(candidate) && candidate.length >= 20 && candidate.length <= 900) {
          context = candidate;
          break;
        }
      }
        return { index, context: context.slice(0, 700) };
      }));
    if (sourceViews.length) {
      console.log("Tree source cards:");
      for (const source of sourceViews) console.log(`  view[${source.index}] | ${source.context || "context unavailable"}`);
    }

    const overlayControls = await page.locator(".portalsCss_p1pr4d40 button, [role='dialog'] button, [aria-modal='true'] button").evaluateAll((nodes) => nodes
      .filter((node) => {
        const style = getComputedStyle(node);
        return style.visibility !== "hidden" && style.display !== "none";
      })
      .map((node) => (node.getAttribute("aria-label") || node.textContent || "").replace(/\s+/g, " ").trim())
      .filter(Boolean));
    if (overlayControls.length) {
      console.log("Visible overlay controls:");
      for (const control of overlayControls) console.log(`  ${control}`);
    }

    const downloadButtonDetails = await page.getByRole("button", { name: "Download", exact: true }).evaluateAll((nodes) => nodes.map((node) => {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      let parent = node.parentElement;
      let context = "";
      while (parent && !context) {
        const text = (parent.innerText || "").replace(/\s+/g, " ").trim();
        if (/customize your download option/i.test(text)) context = text.slice(0, 240);
        parent = parent.parentElement;
      }
      return {
        visible: style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0,
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        context
      };
    }));
    if (downloadButtonDetails.length) {
      console.log("Download button positions:");
      for (const detail of downloadButtonDetails) console.log(`  visible=${detail.visible} x=${detail.x} y=${detail.y} ${detail.width}x${detail.height} context=${detail.context || "viewer"}`);
    }

    const inputs = await page.locator("input, textarea").evaluateAll((nodes) => nodes
      .filter((node) => {
        const style = getComputedStyle(node);
        return style.visibility !== "hidden" && style.display !== "none";
      })
      .map((node) => ({
        tag: node.tagName.toLowerCase(),
        type: node.getAttribute("type") || "text",
        name: node.getAttribute("name") || "",
        value: node.getAttribute("value") || "",
        checked: node.checked || false,
        placeholder: node.getAttribute("placeholder") || "",
        label: node.getAttribute("aria-label") || "",
        context: node.parentElement?.parentElement?.innerText?.replace(/\s+/g, " ").trim() || ""
      })));
    if (inputs.length) {
      console.log("Visible search fields:");
      for (const input of inputs) console.log(`  ${input.tag} type=${input.type} name=${input.name} value=${input.value} checked=${input.checked} placeholder=${input.placeholder} label=${input.label} context=${input.context}`);
    }

    const controls = await page.locator("a, button, [role='button']").evaluateAll((nodes) => nodes
      .map((node) => ({
        tag: node.tagName.toLowerCase(),
        text: (node.textContent || "").replace(/\s+/g, " ").trim(),
        label: node.getAttribute("aria-label") || "",
        href: node.getAttribute("href") || "",
        disabled: node.getAttribute("aria-disabled") === "true" || node.hasAttribute("disabled")
      }))
      .filter((item) => /image|view|browse|camera|viewer|film|zoom|next|previous|download/i.test(`${item.text} ${item.label} ${item.href}`))
      .slice(0, 40));
    console.log("Relevant visible viewer controls:");
    for (const control of controls) {
      console.log(`  ${control.tag} | ${control.text || control.label || "(unlabelled)"} | ${control.href || "no href"} | disabled=${control.disabled}`);
    }

    const recordResults = await page.locator("a[href*='/ark:/61903/1:1:']").evaluateAll((nodes) => nodes.slice(0, 20).map((node) => {
      let container = node.parentElement;
      let text = "";
      for (let depth = 0; container && depth < 8; depth += 1, container = container.parentElement) {
        const candidate = (container.innerText || "").replace(/\s+/g, " ").trim();
        if (/\bPrincipal\b/.test(candidate) && candidate.length >= 40 && candidate.length <= 900) {
          text = candidate;
          break;
        }
        if (!text && candidate.length >= 40 && candidate.length <= 900) text = candidate;
      }
      return { href: node.getAttribute("href") || "", text: text.slice(0, 600) };
    }));
    if (recordResults.length) {
      console.log("Record-result summaries:");
      for (const result of recordResults) console.log(`  ${result.href} | ${result.text}`);
    }

  }
  } // Generic output is deliberately bypassed by bounded catalogue reads.
} catch (error) {
  console.error(`FamilySearch helper failed: ${error?.stack || error?.message || error}`);
  process.exitCode = 1;
} finally {
  for (const page of transientPages) {
    await page.close().catch(() => {});
  }
  if (sharedWindow && sharedContext && sharedPersistentPage) {
    const ownedTransientPages = sharedConnection.ownedPages().filter((item) => item !== sharedPersistentPage);
    await Promise.all(ownedTransientPages.map((item) => item.close({ runBeforeUnload: false }).catch(() => {})));
  }
  await sharedConnection.closeClient({ leaseAction: sharedPersistentPage ? "park" : "release" });
}

function argumentValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function saveMemoryDownload(page, title, downloadPath) {
  const tile = page.getByRole("button", { name: `Photo memory titled ${title}`, exact: true });
  await tile.click({ timeout: 15_000 });
  const dialog = page.getByRole("dialog").filter({ has: page.getByText(title, { exact: true }) });
  await dialog.getByRole("button", { name: "Download", exact: true }).waitFor({ timeout: 12_000 });
  if (!await saveVisibleDownload(page, downloadPath, 15_000, dialog)) {
    throw new Error("FamilySearch did not return the selected Memory photo from its Download control.");
  }
}

function isMemoryGallery(url) {
  return url.protocol === "https:" && url.hostname === "www.familysearch.org"
    && !url.search && !url.hash
    && /^\/(?:en\/)?tree\/person\/memories\/[A-Z0-9]{4}-[A-Z0-9]{3}\/?$/i.test(url.pathname);
}

async function captureMemoryThumbnail(page, context, title, capturePath) {
  const tile = page.getByRole("button", { name: `Photo memory titled ${title}`, exact: true });
  const thumbnail = tile.locator("img");
  await thumbnail.waitFor({ state: "visible", timeout: 10_000 });
  const image = await thumbnail.evaluate(element => ({
    url: element.currentSrc,
    width: element.naturalWidth,
    height: element.naturalHeight
  }));
  if (!image.width || !image.height || !image.url) throw new Error("The selected Memory thumbnail has not loaded.");
  const address = new URL(image.url);
  if (address.protocol !== "https:" || !address.hostname.endsWith(".familysearch.org")
    || !/^\/service\/records\/storage\/dascloud\/patron\/v2\/[^/]+\/thumbMobile\.jpg$/i.test(address.pathname)) {
    throw new Error("The selected Memory does not expose a recognized rendered gallery thumbnail.");
  }
  const response = await context.request.get(address.href, { timeout: 12_000, maxRedirects: 0, headers: { Referer: page.url() } });
  if (!response.ok() || !/^image\//i.test(response.headers()["content-type"] || "")) {
    throw new Error("FamilySearch did not provide the rendered Memory preview.");
  }
  fs.writeFileSync(capturePath, await response.body(), { flag: "wx" });
  console.log(`Temporary local Memory preview (${image.width}x${image.height}): ${capturePath}`);
}

async function saveVisibleDownload(page, downloadPath, timeout, container = page) {
  const buttons = await container.getByRole("button", { name: "Download", exact: true }).all();
  const links = await container.getByRole("link", { name: "Download", exact: true }).all();
  for (const control of [...buttons, ...links].reverse()) {
    if (!await control.isVisible().catch(() => false)) continue;
    const imageResponses = [];
    const collectResponse = (response) => {
      const headers = response.headers();
      const contentType = headers["content-type"] || "";
      const disposition = headers["content-disposition"] || "";
      if (response.status() === 200 && (/^image\//i.test(contentType)
        || /application\/octet-stream/i.test(contentType)
        || /attachment/i.test(disposition))) {
        imageResponses.push(response);
      }
    };
    page.on("response", collectResponse);
    const downloadPromise = page.waitForEvent("download", { timeout }).catch(() => null);
    await control.click({ noWaitAfter: true, timeout: 10_000 });
    const download = await downloadPromise;
    await page.waitForTimeout(1_000);
    page.off("response", collectResponse);
    if (download) {
      await download.saveAs(downloadPath);
      return true;
    }
    let largest = null;
    for (const response of imageResponses) {
      const body = await response.body().catch(() => null);
      if (body?.length > 100_000 && (!largest || body.length > largest.length)) largest = body;
    }
    if (largest) {
      fs.writeFileSync(downloadPath, largest, { mode: 0o600 });
      return true;
    }
  }
  return false;
}

function numberedCapturePath(basePath, image) {
  const extension = path.extname(basePath);
  const stem = path.basename(basePath, extension);
  return path.join(path.dirname(basePath), `${stem}-${image}${extension}`);
}

async function saveExactThumbnailDistribution(page, context, thumbnailUrl, capturePath, { auditCapture = false } = {}) {
  const selectedBase = new URL(thumbnailUrl, page.url()).href.replace(/\/thumb_[^/]+$/i, "");
  // Bounded multi-image captures are temporary visual-audit aids, not source
  // masters, but the visual review must still receive the provider's complete
  // source-resolution distribution. The caller bounds concurrent render
  // requests so a long audit remains practical without changing network state.
  const candidates = auditCapture
    ? [`${selectedBase}/dist.jpg`]
    : [`${selectedBase}/dist.jpg`, `${selectedBase}/thumb_p1000.jpg`];
  const attempts = [];
  for (const captureUrl of candidates) {
    let requestError;
    const capture = await context.request.get(captureUrl, {
      headers: { Referer: page.url() },
      timeout: auditCapture ? 60_000 : 20_000
    }).catch((error) => { requestError = error; return null; });
    const contentType = capture?.headers()?.["content-type"] || "";
    if (!capture?.ok() || !/^image\//i.test(contentType)) {
      attempts.push(distributionAttempt(captureUrl, capture, requestError));
      continue;
    }
    fs.writeFileSync(capturePath, await capture.body());
    return;
  }
  throw new Error(distributionFailureMessage(path.basename(capturePath), attempts));
}

async function saveDeepZoomDistribution(page, context, downloadPath) {
  if (/\/ark:\/61903\/1:1:[A-Z0-9-]+/i.test(new URL(page.url()).pathname)) {
    const recordSources = await page.locator("img").evaluateAll((nodes) => [
      ...new Set(nodes
        .map((node) => node.currentSrc || node.src)
        .filter((source) => source.includes("/deepzoomcloud/dz/v1/")))
    ]);
    if (recordSources.length !== 1) {
      throw new Error(`FamilySearch exposed ${recordSources.length} exact record-page images; refusing an ambiguous source-master download.`);
    }
    const recordBase = new URL(recordSources[0], page.url()).href.replace(/\/scale(?:\?.*)?$/i, "");
    for (const name of ["dist.jpg", "thumb_p1000.jpg"]) {
      const response = await context.request.get(`${recordBase}/${name}`, {
        headers: { Referer: page.url() },
        timeout: 10_000
      }).catch(() => null);
      const contentType = response?.headers()?.["content-type"] || "";
      if (!response?.ok() || !/^image\//i.test(contentType)) continue;
      fs.writeFileSync(downloadPath, await response.body());
      return true;
    }
    return false;
  }
  const tileSource = await page.locator('img[src*="/image_files/"]').first().getAttribute("src").catch(() => "");
  if (!tileSource || !tileSource.includes("/image_files/")) return false;
  const base = new URL(tileSource, page.url()).href.split("/image_files/", 1)[0];
  for (const name of ["dist.jpg"]) {
    const response = await context.request.get(`${base}/${name}`, {
      headers: { Referer: page.url() },
      timeout: 10_000
    }).catch(() => null);
    if (!response?.ok()) continue;
    const contentType = response.headers()["content-type"] || "";
    const body = await response.body();
    if (/^image\//i.test(contentType) && body.length > 100_000) {
      fs.writeFileSync(downloadPath, body, { mode: 0o600 });
      return true;
    }
  }
  return false;
}

function formatBytes(value) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / 1024 / 1024).toFixed(1)} MiB`;
}

function isFamilySearchUrl(rawUrl) {
  try {
    const host = new URL(rawUrl).hostname.toLocaleLowerCase();
    return host === "familysearch.org" || host.endsWith(".familysearch.org");
  } catch {
    return false;
  }
}

async function dismissCatalogTourIfVisible(page) {
  const tour = page.locator(".portalsCss_p1pr4d40, [role='dialog'], [aria-modal='true']")
    .filter({ hasText: /Finding catalog results just got easier|Search for records using full-text search while in catalog/i })
    .last();
  if (!await tour.isVisible().catch(() => false)) return;
  const close = tour.getByRole("button", { name: "Close", exact: true }).last();
  await close.waitFor({ state: "visible", timeout: 5_000 });
  await close.click({ force: true, noWaitAfter: true, timeout: 10_000 });
  await tour.waitFor({ state: "hidden", timeout: 10_000 }).catch(() => {});
  console.log("Closed the FamilySearch catalog tour overlay.");
}

async function navigateViewerToImage(page, requestedImage, { quiet = false, select = true } = {}) {
  const requestedImageText = String(requestedImage ?? "").trim();
  if (!/^\d+$/.test(requestedImageText)) {
    throw new Error("--image requires a positive image number.");
  }
  const requestedImageNumber = Number(requestedImageText);
  if (!Number.isSafeInteger(requestedImageNumber) || requestedImageNumber < 1) {
    throw new Error("--image requires a positive image number.");
  }
  const normalizedRequestedImage = String(requestedImageNumber);
  const formattedRequestedImage = requestedImageNumber.toLocaleString("en-US");
  let imageInput = page
    .locator('input[aria-label*="Image" i], input[name*="image" i]')
    .or(page.getByRole("spinbutton", { name: "Enter Image number", exact: true }))
    .first();
  if (!await imageInput.isVisible().catch(() => false)) {
    const singleImageView = page.getByRole("button", { name: "View single image", exact: true }).first();
    if (await singleImageView.isVisible().catch(() => false)) {
      await singleImageView.click({ force: true, noWaitAfter: true, timeout: 20_000 });
      await page.waitForTimeout(1_000);
      imageInput = page
        .locator('input[aria-label*="Image" i], input[name*="image" i]')
        .or(page.getByRole("spinbutton", { name: "Enter Image number", exact: true }))
        .first();
    }
  }
  if (!await imageInput.isVisible().catch(() => false)) {
    const firstGridImage = page.locator('[aria-label^="Image "]').first();
    if (await firstGridImage.isVisible().catch(() => false)) {
      await firstGridImage.click({ force: true, noWaitAfter: true, timeout: 20_000 });
      await page.waitForTimeout(2_500);
      imageInput = page
        .locator('input[aria-label*="Image" i], input[name*="image" i]')
        .or(page.getByRole("spinbutton", { name: "Enter Image number", exact: true }))
        .first();
    }
  }
  await imageInput.waitFor({ state: "visible", timeout: 20_000 });
  await imageInput.fill(normalizedRequestedImage);
  await imageInput.press("Enter");
  await page.waitForTimeout(2_000);
  const imageButton = page
    .getByRole("button", { name: `Go to image ${formattedRequestedImage}`, exact: true })
    .or(page.getByRole("button", { name: `Go to image ${normalizedRequestedImage}`, exact: true }))
    .first();
  let thumbnailUrl = "";
  // FamilySearch can accept the number and update the URL/filmstrip while the
  // single-image canvas remains on the prior frame.  Always select the exact
  // visible thumbnail when it is available so a later source-master download
  // cannot silently retain the stale frame.
  await imageButton.waitFor({ state: "attached", timeout: select ? 8_000 : 500 }).catch(() => {});
  let exactControl = imageButton;
  let exactImage = imageButton.locator("img").first();
  if (!await imageButton.count()) {
    // The packet-viewer grid variant renders numbered thumbnail cards as
    // clickable divs without button semantics or numbered image alt text.
    // It is the common audit path, so bind its exact visible number before
    // waiting on semantic variants that this viewer does not render.
    const numberedGridItems = page.locator('[class*="gridItem"]');
    let numberedGridItem = null;
    // The packet viewer virtualizes its numbered grid after Enter.  A distant
    // jump can update the number field before the exact card is attached, so
    // give that card the same bounded lazy-render allowance as its image URL.
    for (let attempt = 0; attempt < 80 && !numberedGridItem; attempt += 1) {
      const numberedGridIndex = await numberedGridItems.evaluateAll((items, wanted) => items.findIndex((item) => (
        item.getClientRects().length > 0
        && String(item.innerText || item.textContent || "").replace(/,/g, "").trim() === wanted
      )), normalizedRequestedImage).catch(() => -1);
      if (numberedGridIndex >= 0) {
        // A virtualized grid can reorder between discovery and the click.
        // Re-resolve the visible number instead of retaining its DOM position.
        numberedGridItem = numberedGridItems
          .filter({ hasText: new RegExp(`^\\s*(?:${normalizedRequestedImage}|${formattedRequestedImage})\\s*$`) })
          .filter({ visible: true })
          .first();
        break;
      }
      await page.waitForTimeout(100);
    }
    if (numberedGridItem) {
      exactControl = numberedGridItem;
      exactImage = numberedGridItem.locator('img[src*="thumb_p200"]').first();
    } else {
      const gridControl = page
        .locator(`[aria-label^="Image ${formattedRequestedImage} of "]`)
        .or(page.locator(`[aria-label^="Image ${normalizedRequestedImage} of "]`))
        .first();
      await gridControl.waitFor({ state: "attached", timeout: select ? 20_000 : 2_000 }).catch(() => {});
      if (await gridControl.count()) {
        exactControl = gridControl;
        exactImage = gridControl.locator("img").first();
      }
    }
    if (!await exactControl.count()) {
      const gridImage = page
        .locator(`img[alt^="Image ${formattedRequestedImage} "], img[aria-label^="Image ${formattedRequestedImage} "]`)
        .or(page.locator(`img[alt^="Image ${normalizedRequestedImage} "], img[aria-label^="Image ${normalizedRequestedImage} "]`))
        .first();
      if (await gridImage.count()) {
        const clickableGridAncestor = gridImage.locator("xpath=ancestor::*[self::button or self::a or @role='button'][1]");
        exactControl = await clickableGridAncestor.count() ? clickableGridAncestor : gridImage;
        exactImage = gridImage;
      }
    }
  }
  if (!await exactControl.count()) {
    throw new Error(`FamilySearch did not expose an exact thumbnail for requested image ${requestedImage}; refusing a possibly stale frame.`);
  }
  await exactControl.scrollIntoViewIfNeeded().catch(() => {});
  thumbnailUrl = await exactImage.evaluate((image) => image.currentSrc || image.src || image.getAttribute("data-src") || "").catch(() => "");
  if (!thumbnailUrl) {
    thumbnailUrl = await exactControl.evaluate(async (control) => {
      for (let attempt = 0; attempt < 80; attempt += 1) {
        const candidates = [];
        const add = (value) => {
          if (typeof value !== "string") return;
          const normalized = value.trim();
          if (normalized && !candidates.includes(normalized)) candidates.push(normalized);
        };
        for (const node of [control, ...control.querySelectorAll("*")]) {
          add(node.currentSrc);
          add(node.src);
          add(node.getAttribute?.("data-src"));
          const background = getComputedStyle(node).backgroundImage || "";
          for (const match of background.matchAll(/url\(["']?([^"')]+)["']?\)/g)) add(match[1]);
        }
        const deepZoomSource = candidates.find((value) => /\/deepzoomcloud\/dz\/v1\//i.test(value));
        if (deepZoomSource) return deepZoomSource;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return "";
    }).catch(() => "");
  }
  const selectedImageValue = String(await page
    .locator('input[aria-label*="Image" i], input[name*="image" i]')
    .or(page.getByRole("spinbutton", { name: "Enter Image number", exact: true }))
    .first()
    .inputValue()
    .catch(() => "")).replace(/,/g, "").trim();
  if (/^\d+$/.test(selectedImageValue) && selectedImageValue !== normalizedRequestedImage) {
    throw new Error(`FamilySearch selected image ${selectedImageValue} after requesting ${requestedImage}; refusing a stale or mismatched frame.`);
  }
  if (!thumbnailUrl) {
    // A few virtualized cards expose their exact ARK and film index in the
    // viewer URL but never lazy-load an img element.  That pair is still an
    // exact binding: derive only the normal thumbnail distribution for the
    // same ARK, and let the guarded downloader verify its image response.
    const viewerUrl = new URL(page.url());
    const arkMatch = viewerUrl.pathname.match(/\/ark:\/61903\/(3:1:[A-Z0-9-]+)$/i);
    const selectedIndex = viewerUrl.searchParams.get("i");
    if (arkMatch && /^\d+$/.test(selectedIndex || "") && Number(selectedIndex) + 1 === requestedImageNumber) {
      thumbnailUrl = `https://sg30p0.familysearch.org/service/records/storage/deepzoomcloud/dz/v1/${arkMatch[1]}/thumb_p200.jpg`;
    }
  }
  if (!select) {
    if (!thumbnailUrl) {
      throw new Error(`FamilySearch exposed no exact thumbnail URL for requested audit image ${requestedImage}; refusing a possibly stale frame.`);
    }
    if (!quiet) console.log(`Bound exact thumbnail for image ${requestedImage}.`);
    return thumbnailUrl;
  }
  // Enter may finish changing the grid into a single-image filmstrip while
  // its thumbnail loads. Keep the click bound to the requested label across
  // that transition; neither a former grid index nor an adjacent card is safe.
  const exactNamedImage = page
    .locator(`img[alt^="Image ${formattedRequestedImage} "], img[aria-label^="Image ${formattedRequestedImage} "]`)
    .or(page.locator(`img[alt^="Image ${normalizedRequestedImage} "], img[aria-label^="Image ${normalizedRequestedImage} "]`));
  const stableExactControl = imageButton
    .or(page.locator('[class*="gridItem"]').filter({
      hasText: new RegExp(`^\\s*(?:${normalizedRequestedImage}|${formattedRequestedImage})\\s*$`)
    }))
    .or(page.locator(`[aria-label^="Image ${formattedRequestedImage} of "]`))
    .or(page.locator(`[aria-label^="Image ${normalizedRequestedImage} of "]`))
    .or(exactNamedImage)
    .filter({ visible: true })
    .first();
  await stableExactControl.click({ force: true, noWaitAfter: true, timeout: 20_000 });
  await page.waitForTimeout(2_500);
  const clickedImageValue = String(await page
    .locator('input[aria-label*="Image" i], input[name*="image" i]')
    .or(page.getByRole("spinbutton", { name: "Enter Image number", exact: true }))
    .first()
    .inputValue()
    .catch(() => "")).replace(/,/g, "").trim();
  if (/^\d+$/.test(clickedImageValue) && clickedImageValue !== normalizedRequestedImage) {
    throw new Error(`FamilySearch selected image ${clickedImageValue} after requesting ${requestedImage}; refusing a stale or mismatched frame.`);
  }
  const selectedViewerUrl = new URL(page.url());
  const selectedIndex = selectedViewerUrl.searchParams.get("i");
  if (/^\d+$/.test(selectedIndex || "") && Number(selectedIndex) + 1 !== requestedImageNumber) {
    throw new Error(`FamilySearch selected film index ${selectedIndex} after requesting image ${requestedImage}; refusing a stale or mismatched frame.`);
  }
  const selectedArk = selectedViewerUrl.pathname.match(/\/ark:\/61903\/(3:1:[A-Z0-9-]+)$/i)?.[1] || "";
  if (selectedArk && /^\d+$/.test(selectedIndex || "") && Number(selectedIndex) + 1 === requestedImageNumber) {
    // The packet viewer recycles thumbnail <img> nodes while jumping through
    // the grid, so a URL read before the click can still identify the prior
    // frame. The post-click ARK plus exact zero-based film index is the stable
    // provider binding; derive its normal distribution from that exact ARK.
    thumbnailUrl = `https://sg30p0.familysearch.org/service/records/storage/deepzoomcloud/dz/v1/${selectedArk}/thumb_p200.jpg`;
  }
  if (!thumbnailUrl) {
    if (!/^\d+$/.test(selectedIndex || "") || Number(selectedIndex) + 1 !== requestedImageNumber) {
      throw new Error(`FamilySearch exposed no thumbnail URL or exact film index for requested image ${requestedImage}; refusing a possibly stale frame.`);
    }
  }
  if (!quiet) console.log(`Navigated to image ${requestedImage} and bound its exact thumbnail.`);
  return thumbnailUrl;
}

async function assertViewerGroup(page, expectedGroupId) {
  if (!expectedGroupId) return;
  const currentGroupId = new URL(page.url()).searchParams.get("groupId");
  if (currentGroupId !== expectedGroupId) {
    throw new Error(`FamilySearch changed viewer group from ${expectedGroupId} to ${currentGroupId || "none"}; refusing cross-group evidence.`);
  }
}

async function getOrCreateSharedAffinityPage(connection, context, recordPath) {
  const browserSession = await connection.browser.newBrowserCDPSession();
  try {
    const existing = await sharedPageInventory(context);
    const saved = readJson(recordPath);
    if (saved?.schemaVersion === 1 && saved.affinitySlot === affinitySlot && saved.targetId) {
      const controlled = existing.find((item) => item.targetId === saved.targetId);
      if (controlled) {
        const windowId = await windowIdForTarget(browserSession, controlled.targetId);
        const safeRoute = controlled.page.url() === "about:blank" || controlled.page.url() === "chrome://newtab/"
          || isFamilySearchUrl(controlled.page.url());
        const savedWindowMatches = !Number.isInteger(saved.windowId) || saved.windowId === windowId;
        if (windowId !== null && savedWindowMatches && safeRoute) {
          const identity = await connection.adoptPage(controlled.page, { root: true });
          if (identity.targetId !== controlled.targetId || identity.windowId !== windowId) {
            throw new Error("The bridge returned a mismatched identity for the recorded FamilySearch affinity tab.");
          }
          return { page: controlled.page, targetId: controlled.targetId, windowId, reused: true };
        }
      }
      fs.rmSync(recordPath, { force: true });
    }
    const created = await createBackgroundTarget(browserSession, "about:blank");
    const deadline = Date.now() + 10_000;
    let page;
    while (Date.now() < deadline && !page) {
      const inventory = await sharedPageInventory(context);
      page = inventory.find((item) => item.targetId === created.targetId)?.page;
      if (!page) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!page) throw new Error("Chrome created no observable background tab for FamilySearch.");
    const identity = await connection.adoptPage(page, { root: true });
    if (identity.targetId !== created.targetId || !Number.isFinite(identity.windowId)) {
      await browserSession.send("Target.closeTarget", { targetId: created.targetId }).catch(() => {});
      throw new Error("The bridge could not bind the FamilySearch affinity tab to an exact window-backed target.");
    }
    const windowId = identity.windowId;
    writeJsonAtomic(recordPath, {
      schemaVersion: 1,
      affinitySlot,
      targetId: created.targetId,
      windowId,
      updatedAt: new Date().toISOString()
    });
    return { page, targetId: created.targetId, windowId, reused: false };
  } finally {
    await browserSession.detach().catch(() => {});
  }
}

async function windowIdForTarget(browserSession, targetId) {
  try {
    const result = await browserSession.send("Browser.getWindowForTarget", { targetId });
    const windowId = Number(result.windowId);
    return Number.isFinite(windowId) ? windowId : null;
  } catch (error) {
    if (/window not found/i.test(String(error?.message || error))) return null;
    throw error;
  }
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function writeJsonAtomic(filePath, value) {
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, filePath);
}

function clearFamilySearchAffinityRecords() {
  for (const record of readFamilySearchAffinityRecords()) {
    fs.rmSync(record.path, { force: true });
  }
}

function readFamilySearchAffinityRecords() {
  const prefix = "family-history-familysearch-affinity-";
  const records = [];
  for (const entry of fs.readdirSync(os.tmpdir())) {
    if (!entry.startsWith(prefix) || !entry.endsWith(".json")) continue;
    const recordPath = path.join(os.tmpdir(), entry);
    const value = readJson(recordPath);
    records.push({ path: recordPath, targetId: value?.targetId || "" });
  }
  return records;
}

async function sharedPageInventory(context) {
  const inventory = [];
  for (const page of context.pages()) {
    if (page.isClosed()) continue;
    const session = await context.newCDPSession(page);
    try {
      const { targetInfo } = await session.send("Target.getTargetInfo");
      inventory.push({ page, targetId: targetInfo.targetId });
    } finally {
      await session.detach().catch(() => {});
    }
  }
  return inventory;
}

async function familySearchSignInRequired(page) {
  const url = new URL(page.url());
  const signInRoute = url.hostname === "ident.familysearch.org"
    || /\/(?:sign-in|identity\/login)(?:\/|$)/i.test(url.pathname);
  const signInForm = await page.locator('input[type="password"], form[action*="login" i]').first().isVisible().catch(() => false);
  return signInRoute || signInForm;
}

// A lapsed FamilySearch session used to stop every action until someone
// signed in by hand. Try Chrome's saved credentials once per run, return to
// the requested page, and only then report a human step.
async function assertFamilySearchSignedIn(page) {
  if (!(await familySearchSignInRequired(page))) return;
  const returnUrl = familySearchReturnUrl(page.url());
  if (!savedSignInAttempted) {
    savedSignInAttempted = true;
    const outcome = await trySavedSignIn(page, "familysearch", { log: (message) => console.log(message) }).catch((error) => ({ status: "error", reason: error.message }));
    if (["signed-in", "already-signed-in"].includes(outcome.status)) {
      if (!returnUrl) throw new Error("FamilySearch sign-in was restored automatically from Chrome's saved credentials; rerun this action.");
      await page.goto(returnUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
      await page.waitForTimeout(1_500);
      if (!(await familySearchSignInRequired(page))) return;
    }
  }
  throw new Error("FamilySearch needs a human sign-in step in the shared Chrome profile (no saved password, MFA, or CAPTCHA). Run npm run providers:signin -- --providers familysearch, finish the step it leaves open, then retry this record.");
}

function familySearchReturnUrl(value) {
  try {
    const state = new URL(value).searchParams.get("state");
    const target = state ? new URL(state) : null;
    return target && target.protocol === "https:" && /(^|\.)familysearch\.org$/i.test(target.hostname) && target.hostname !== "ident.familysearch.org"
      ? target.href : null;
  } catch {
    return null;
  }
}
