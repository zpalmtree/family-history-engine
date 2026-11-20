#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright-core";
import { openSharedChromeTask } from "./shared-chrome-task.mjs";
import {
  assertArchionCatalogObjectUrl,
  assertArchionCatalogParishUrl,
} from "./archion-catalog-policy.mjs";
import { batchFingerprint, normalizedBatchResult, sanitizeUrl, validateResearchBatchPlan } from "./research-browser-batch-lib.mjs";
import { savedSignInProviderIds, trySavedSignIn } from "./saved-signin.mjs";
import { readNewspaperSearchState } from "./findmypast-newspaper-state.mjs";
import { readFamilySearchViewerMetadata, waitForFamilySearchViewerMetadata } from "./familysearch-viewer-metadata.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAX_ARTIFACT_RESULTS = 1_000;

function optionValue(args, flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

export async function runResearchBrowserBatch(plan, { endpoint = "http://127.0.0.1:9226", tempRoot = os.tmpdir() } = {}) {
  const startedAtMs = Date.now();
  const fingerprint = batchFingerprint(plan);
  const artifactDir = path.join(tempRoot, "ZacharyPalmerFamilyHistory", "ResearchBatches");
  fs.mkdirSync(artifactDir, { recursive: true, mode: 0o700 });
  const artifactPath = path.join(artifactDir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${fingerprint}.json`);
  const artifact = {
    schemaVersion: 1,
    fingerprint,
    provider: plan.provider,
    affinitySlot: plan.affinitySlot,
    research: plan.research,
    startedAt: new Date(startedAtMs).toISOString(),
    steps: [],
  };
  let task;
  let blocked = false;
  let metadataFailed = false;
  let savedSignInAttempted = false;
  emit({
    type: "batch-start",
    fingerprint,
    provider: plan.provider,
    stepCount: plan.steps.length,
    wrapperTimingsMs: {
      validation: numericEnvironment("RESEARCH_BATCH_VALIDATION_MS"),
      endpointReady: numericEnvironment("RESEARCH_BATCH_ENDPOINT_READY_MS"),
      mutexWait: numericEnvironment("RESEARCH_BATCH_MUTEX_WAIT_MS"),
    },
  });
  try {
    task = await openSharedChromeTask({
      chromium,
      endpoint,
      taskLabel: `research-${plan.provider}`,
      affinitySlot: plan.affinitySlot,
      reconnectExisting: true,
    });
    for (const step of plan.steps) {
      if (blocked || metadataFailed) {
        const skipped = { id: step.id, operation: step.operation, status: blocked ? "skipped-after-needs-user" : "skipped-after-metadata-failure" };
        artifact.steps.push(skipped);
        emit({ type: "step", ...skipped });
        continue;
      }
      const attemptStep = () => runStep(task.page, plan.provider, step).catch((error) => ({
        id: step.id,
        operation: step.operation,
        status: "failed",
        error: safeError(error),
        ...(error.viewerMetadata ? { incompleteViewerMetadata: error.viewerMetadata } : {}),
        timingsMs: {},
        results: [],
        visibleCount: 0,
        returnedCount: 0,
        truncated: false,
      }));
      let result = await attemptStep();
      if (shouldTrySavedSignIn(result, plan.provider, savedSignInAttempted)) {
        // A lapsed session used to stop the whole batch for a human. Submit
        // Chrome's saved credentials once (guarded helper), then retry.
        savedSignInAttempted = true;
        const signIn = await trySavedSignIn(task.page, plan.provider)
          .catch((error) => ({ provider: plan.provider, status: "error", reason: safeError(error) }));
        emit({ type: "saved-sign-in", provider: plan.provider, status: signIn.status, reason: signIn.reason || null });
        artifact.savedSignIn = { status: signIn.status, reason: signIn.reason || null };
        if (["signed-in", "already-signed-in"].includes(signIn.status)) result = await attemptStep();
      }
      artifact.steps.push({ ...result, results: result.allResults?.slice(0, MAX_ARTIFACT_RESULTS) || result.results });
      delete artifact.steps.at(-1).allResults;
      emit(stepSummary(result));
      if (step.operation === "viewer-metadata" && result.status === "failed") metadataFailed = true;
      if (result.status === "needs-user") {
        blocked = true;
        await task.showForManualStep(`${plan.provider} access verification`);
      }
    }
  } finally {
    if (task) {
      if (blocked) await task.leaveOpen();
      else await task.close();
    }
    artifact.completedAt = new Date().toISOString();
    artifact.elapsedMs = Date.now() - startedAtMs;
    fs.writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, { mode: 0o600 });
  }
  const failedCount = artifact.steps.filter((step) => step.status === "failed").length;
  const needsUserCount = artifact.steps.filter((step) => step.status === "needs-user").length;
  emit({ type: "batch-end", fingerprint, status: needsUserCount ? "needs-user" : failedCount ? "completed-with-errors" : "completed", elapsedMs: Date.now() - startedAtMs, failedCount, needsUserCount, artifactPath });
  return { artifactPath, artifact };
}

export function shouldTrySavedSignIn(result, provider, alreadyAttempted) {
  return result.status === "needs-user" && !alreadyAttempted
    && savedSignInProviderIds.includes(provider)
    && result.reason !== "visible-security-verification-challenge";
}

export async function runStep(page, provider, step) {
  const stepStarted = Date.now();
  const navigationStarted = Date.now();
  const navigationResponse = await page.goto(step.url, { waitUntil: "domcontentloaded", timeout: 45_000 });
  if (provider === "findmypast" && step.operation === "findmypast-row" &&
      (navigationResponse?.status() === 404 || navigationResponse?.status() >= 500)) {
    throw new Error(`Findmypast result navigation returned HTTP ${navigationResponse.status()}; no search conclusion is available.`);
  }
  const navigationMs = Date.now() - navigationStarted;
  const readinessStarted = Date.now();
  await page.locator("body").waitFor({ state: "visible", timeout: 15_000 });
  await waitForStableReadSurface(page);
  const readSurface = await waitForProviderReadSurface(page, provider, step.operation, step);
  const readinessMs = Date.now() - readinessStarted;
  const gate = await detectAccessGate(page, provider);
  if (gate) {
    return needsUserResult(step, page, provider, gate, {
      navigation: navigationMs,
      readiness: readinessMs,
      extraction: 0,
      total: Date.now() - stepStarted,
    });
  }
  if (provider === "archion") {
    const requested = assertArchionCatalogParishUrl(step.url);
    const landed = assertArchionCatalogParishUrl(page.url());
    if (landed.parishId !== requested.parishId || landed.url !== requested.url) {
      throw new Error(`Archion catalogue navigation left the exact ${requested.parishId} parish route.`);
    }
  }
  const extractionStarted = Date.now();
  const extracted = await extractOperation(page, provider, step.operation, step, readSurface);
  const values = Array.isArray(extracted) ? extracted : extracted.values;
  const declaredCount = Array.isArray(extracted) ? null : extracted.declaredCount ?? null;
  const extractionMs = Date.now() - extractionStarted;
  const postExtractionGate = await detectAccessGate(page, provider);
  if (postExtractionGate) {
    return needsUserResult(step, page, provider, postExtractionGate, {
      navigation: navigationMs,
      readiness: readinessMs,
      extraction: extractionMs,
      total: Date.now() - stepStarted,
    });
  }
  const bounded = normalizedBatchResult(values, step);
  return {
    id: step.id,
    operation: step.operation,
    status: "completed",
    url: sanitizeUrl(page.url()),
    timingsMs: { navigation: navigationMs, readiness: readinessMs, extraction: extractionMs, total: Date.now() - stepStarted },
    results: bounded.returned,
    allResults: bounded.all,
    visibleCount: bounded.visibleCount,
    returnedCount: bounded.returnedCount,
    // A provider-declared total above the visible results means unread pages,
    // so the step is incomplete even when the return limit was not reached.
    truncated: bounded.truncated || (declaredCount !== null && declaredCount > bounded.visibleCount) || Boolean(extracted.searchSummary?.hasNextPage),
    ...(declaredCount !== null ? { declaredCount } : {}),
    ...(!Array.isArray(extracted) && extracted.searchSummary ? { searchSummary: extracted.searchSummary } : {}),
  };
}

async function detectAccessGate(page, provider) {
  const route = page.url().toLocaleLowerCase();
  if (/captcha|challenge|signin|sign-in|login/.test(route)) return "sign-in-or-challenge-route";
  return page.evaluate(({ providerName, phrases }) => {
    const visible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const gateSelector = providerName === "ava"
      ? 'input[type="password"]'
      : 'input[type="password"], iframe[src*="captcha" i], [class*="captcha" i]';
    const gateControls = [...document.querySelectorAll(gateSelector)].filter((element) => {
      // Antenati renders Google's size=invisible attribution badge on every
      // readable register page. It is not an interactive challenge. A real
      // challenge uses a separate iframe/control and remains detectable here
      // or through the explicit challenge text below.
      if (providerName !== "antenati") return true;
      return !element.closest(".grecaptcha-badge")
        && !element.matches('iframe[src*="size=invisible" i]');
    });
    if (gateControls.some(visible)) {
      return "visible-sign-in-or-captcha-control";
    }
    const text = (document.body?.innerText || "").slice(0, 5_000).toLocaleLowerCase();
    if (document.querySelector("#challenge-error-text")) return "visible-security-verification-challenge";
    return phrases.some((phrase) => text.includes(phrase)) ? "visible-sign-in-or-challenge-message" : "";
  }, { providerName: provider, phrases: accessGatePhrases(provider) });
}

export function accessGatePhrases(provider) {
  const securityVerification = [
    "checking if the site connection is secure",
    "needs to review the security of your connection",
    "enable javascript and cookies to continue",
  ];
  if (provider === "familysearch") return ["sign in to familysearch", "verify you are human", ...securityVerification];
  if (provider === "pcusa") return ["verify you are human", "attention required", "sorry, you have been blocked", ...securityVerification];
  return ["sign in to your account", "verify you are human", ...securityVerification];
}

function needsUserResult(step, page, provider, reason, timingsMs) {
  return {
    id: step.id,
    operation: step.operation,
    status: "needs-user",
    needsUserId: `provider-access-${provider}`,
    reason,
    url: sanitizeUrl(page.url()),
    timingsMs,
    results: [], allResults: [], visibleCount: 0, returnedCount: 0, truncated: false,
  };
}

async function extractOperation(page, provider, operation, step, readSurface) {
  if (provider === "familysearch" && operation === "viewer-metadata") {
    const snapshot = await readFamilySearchViewerMetadata(page, step.url);
    if (snapshot.gate) return [];
    if (JSON.stringify(snapshot) !== JSON.stringify(readSurface)) {
      throw new Error("FamilySearch viewer metadata changed after settling; no sequence conclusion is available.");
    }
    return [{ text: JSON.stringify(snapshot) }];
  }
  if (provider === "antenati" && operation === "registry-context") {
    await page.waitForTimeout(3_000);
    return extractAntenatiRegistryContext(page);
  }
  if (provider === "ancestry" && operation === "search-results") {
    return extractLinks(page, 'a[href*="/search/collections/"][href*="/records/"]', 500);
  }
  if (provider === "ancestry" && operation === "public-tree-results") {
    return extractAncestryPublicTreeResults(page, 500);
  }
  if (provider === "ancestry" && operation === "public-tree-person") {
    return extractAncestryPublicTreePerson(page, 500);
  }
  if (provider === "findmypast" && operation === "findmypast-newspaper-results") {
    return extractFindmypastNewspaperResults(page, 500, step.url);
  }
  if (provider === "findmypast" && operation === "findmypast-row") {
    const snapshot = await readFindmypastRecordResults(page);
    assertUnchangedFindmypastRecordResults(readSurface, snapshot);
    const state = classifyFindmypastRecordResults(snapshot, { settled: true });
    if (!["ready", "zero"].includes(state)) throw new Error(`Findmypast result extraction is ${state}; no search conclusion is available.`);
    const { rows, ...searchSummary } = snapshot;
    if (step?.openRowTerms?.length) {
      const opened = await openFindmypastResultRow(page, rows, step.openRowTerms, step.openRowOrdinal);
      return { values: [opened], declaredCount: snapshot.declaredCount, searchSummary };
    }
    return { values: rows, declaredCount: snapshot.declaredCount, searchSummary };
  }
  if (provider === "familysearch" && operation === "fulltext-search") {
    return extractFamilySearchFullTextLinks(page, 500);
  }
  if (operation === "record-facts") {
    return extractText(page, "main h1, main h2, main h3, main table tr, main dl dt, main dl dd, main [data-testid*='field']", 500);
  }
  if (provider === "findmypast" && operation === "findmypast-transcript") {
    let text = (await extractText(page, "main h1, main h2, main h3, main table tr, main dl dt, main dl dd, main p", 500))
      .filter((value) => value.text);
    // Findmypast transcript pages can render without a <main> landmark; fall
    // back to the same structural elements anywhere in the document.
    if (!text.length) {
      text = (await extractText(page, "h1, h2, h3, table tr, dl dt, dl dd", 500)).filter((value) => value.text);
    }
    // The image route for a transcript: its image link (record?id=…) or an
    // image control, reported so an image capture can be bound exactly.
    const imageLinks = await extractLinks(page, 'main a[href*="/record?id="], main a[href*="image" i]', 20);
    const imageControls = await page.locator("main button").evaluateAll((buttons) => buttons
      .map((button) => (button.getAttribute("aria-label") || button.innerText || "").replace(/\s+/g, " ").trim())
      .filter((label) => /image|view original|original record/i.test(label))
      .slice(0, 20)
      .map((label) => ({ text: `image control: ${label}`, label })));
    return [...text, ...imageLinks.map((link) => ({ ...link, text: `image link: ${link.label || link.href}` })), ...imageControls];
  }
  if (provider === "familysearch" && operation === "page-links") return extractFamilySearchPageLinks(page, 500);
  if (provider === "familysearch" && operation === "page-context") {
    return extractFamilySearchPageContext(page, 500);
  }
  if (provider === "pcusa" && operation === "catalog-results") {
    return extractPcusaCatalogResults(page, 500);
  }
  if (provider === "pcusa" && operation === "catalog-detail") {
    return extractPcusaCatalogDetail(page, 500);
  }
  if (provider === "pcusa" && operation === "catalog-marc") {
    return extractPcusaCatalogMarc(page, 500);
  }
  if (provider === "pcusa" && operation === "digital-context") {
    return extractPcusaDigitalContext(page, 500);
  }
  if (provider === "ava" && operation === "document-search") {
    return extractAvaDocumentSearch(page, 500);
  }
  if (provider === "ava" && operation === "document-image-context") {
    return extractAvaDocumentImageContext(page, step, 500);
  }
  if (provider === "archion" && operation === "catalog-results") {
    return extractArchionCatalogResults(page, step);
  }
  throw new Error(`Unsupported read-only operation: ${provider}/${operation}.`);
}

async function extractArchionCatalogResults(page, step) {
  const parish = assertArchionCatalogParishUrl(step.url);
  const pathname = new URL(parish.url).pathname;
  const values = await page.locator("a[href]").evaluateAll((anchors, expectedPath) => anchors.map((anchor) => {
    let parsed;
    try { parsed = new URL(anchor.href, location.href); } catch { return null; }
    const normalizedPath = parsed.pathname.replace(/\/+$/, "");
    const match = normalizedPath.match(new RegExp(`^${expectedPath.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}/([1-9]\\d*)$`));
    if (parsed.protocol !== "https:" || parsed.hostname !== "www.archion.de" || !match || parsed.search || parsed.hash) return null;
    const container = anchor.closest("tr, li, article, [class*='record'], [class*='book'], [class*='kirchenbuch'], .card, .row") || anchor.parentElement;
    const anchorText = (anchor.innerText || anchor.textContent || "").replace(/\s+/g, " ").trim();
    const context = (container?.innerText || container?.textContent || anchorText).replace(/\s+/g, " ").trim();
    return {
      href: parsed.href,
      label: `Archion object ${match[1]}`,
      text: context || anchorText || `Archion object ${match[1]}`,
    };
  }), pathname);
  const output = [];
  for (const value of values.filter(Boolean)) {
    const classified = assertArchionCatalogObjectUrl(value.href, parish.parishId);
    output.push({
      href: classified.url,
      label: `Archion object ${classified.objectId}`,
      text: String(value.text || "").slice(0, 3_000),
    });
  }
  if (!output.length) {
    throw new Error(`Archion ${parish.parishId} catalogue exposed no exact numeric object links; discovery remains incomplete.`);
  }
  return output;
}

async function extractAvaDocumentImageContext(page, step, limit) {
  const requested = new URL(step.url).hash.match(/[?&]docname=((?:GE|GR)1801-99-[A-Z]{3}-[A-Z]{3})$/i)?.[1] || "";
  if (!requested) throw new Error("AVA image inspection lacks one exact validated document name.");
  const imageButton = page.getByRole("button", { name: requested, exact: true }).first();
  if (!await imageButton.isVisible().catch(() => false)) {
    throw new Error(`Fairfield County AVA exposed no exact image button for ${requested}.`);
  }
  // AVA overlays its result-summary panel on the exact image button, so a
  // pointer click is intercepted even though the button is visible. Invoke
  // that one exact, validated public-record button through the DOM instead of
  // using coordinates, force-clicking, or foreground activation.
  const firstImageResponse = page.waitForResponse((response) => /\/breeze\/ViewImages(?:[?#]|$)/i.test(response.url())
    && response.request().method() === "POST", { timeout: 15_000 });
  await imageButton.evaluate((button) => button.click());
  const opened = await page.waitForURL(/#\/image(?:[?#]|$)/i, { timeout: 5_000 }).then(() => true).catch(() => false);
  if (!opened) throw new Error(`Fairfield County AVA did not open the exact ${requested} image from its one-result document page.`);
  let imagePayload = await firstImageResponse.then((response) => response.json());
  await page.locator("canvas").first().waitFor({ state: "visible", timeout: 15_000 });
  await page.waitForTimeout(2_000);
  const bodyText = await page.locator("body").innerText().catch(() => "");
  if (/credit card|payment|purchase|insufficient funds/i.test(bodyText)) {
    throw new Error("Fairfield County AVA presented a payment gate; no purchase or payment action was attempted.");
  }
  const imageDirectory = path.join(os.tmpdir(), "ZacharyPalmerFamilyHistory", "AvaInspection");
  fs.mkdirSync(imageDirectory, { recursive: true, mode: 0o700 });
  const totalPages = Math.min(10, Number(bodyText.match(/\b1\s+of\s+(\d+)\b/i)?.[1] || 1));
  const inspectionPaths = [];
  const tileLayouts = [];
  for (let pageNumber = 1; pageNumber <= totalPages; pageNumber += 1) {
    if (pageNumber > 1) {
      const pageInput = page.locator('input[placeholder="Go To Page"], input[aria-label*="Go To Page" i]').first();
      await pageInput.fill(String(pageNumber));
      const nextImageResponse = page.waitForResponse((response) => /\/breeze\/ViewImages(?:[?#]|$)/i.test(response.url())
        && response.request().method() === "POST", { timeout: 15_000 });
      const clickedGo = await page.evaluate(() => {
        const normalize = (value) => (value || "").replace(/\s+/g, " ").trim().toLocaleUpperCase();
        const control = [...document.querySelectorAll("button, input[type='button'], input[type='submit']")]
          .find((element) => normalize(element.innerText || element.textContent || element.value) === "GO");
        if (!control) return false;
        control.click();
        return true;
      });
      if (!clickedGo) throw new Error("Fairfield County AVA exposed no exact GO control for page navigation.");
      imagePayload = await nextImageResponse.then((response) => response.json());
      await page.waitForFunction((expected) => new RegExp(`\\b${expected}\\s+of\\s+\\d+\\b`, "i").test(document.body?.innerText || ""), pageNumber, { timeout: 10_000 });
      await page.waitForTimeout(2_000);
      const laterBodyText = await page.locator("body").innerText().catch(() => "");
      if (/credit card|payment|purchase|insufficient funds/i.test(laterBodyText)) {
        throw new Error("Fairfield County AVA presented a payment gate; no purchase or payment action was attempted.");
      }
    }
    const screenshotPath = path.join(imageDirectory, `${requested}-p${pageNumber}-${Date.now()}.png`);
    tileLayouts.push({
      pageNumber,
      tiles: (imagePayload?.Images || []).map((tile) => Object.fromEntries(Object.entries(tile)
        .filter(([key]) => !/path|url|token|code/i.test(key)))),
    });
    const canvasData = await renderAvaImagePayload(page, imagePayload);
    if (!/^data:image\/png;base64,/.test(canvasData)) throw new Error("Fairfield County AVA exposed no readable document canvas.");
    fs.writeFileSync(screenshotPath, Buffer.from(canvasData.replace(/^data:image\/png;base64,/, ""), "base64"), { mode: 0o600 });
    inspectionPaths.push(screenshotPath);
  }
  const values = await page.evaluate(({ documentName, paths, layouts, max }) => {
    const clean = (value) => (value || "").replace(/\s+/g, " ").trim();
    const output = [
      { text: `${documentName} image viewer: ${clean(document.body?.innerText || "").slice(0, 4_000)}` },
      ...paths.map((inspectionPath, index) => ({ text: `Inspection-only AVA rendered page ${index + 1}: ${inspectionPath}` })),
      ...layouts.map((layout) => ({ text: `AVA tile layout page ${layout.pageNumber}: ${JSON.stringify(layout.tiles)}` })),
    ];
    for (const entry of performance.getEntriesByType("resource")) {
      if (output.length >= max) break;
      const href = String(entry.name || "");
      if (!/ScrapRelay\.WebService\.Ava\/(?:breeze\/)?ViewImages|\/Image(?:s)?\//i.test(href)) continue;
      output.push({
        href: href.replace(/[?#].*$/, ""),
        label: "Fairfield County AVA image resource",
        text: href.replace(/[?#].*$/, ""),
      });
    }
    return output;
  }, { documentName: requested, paths: inspectionPaths, layouts: tileLayouts, max: limit });
  return values;
}

async function renderAvaImagePayload(page, payload) {
  const images = Array.isArray(payload?.Images) ? payload.Images : [];
  if (!images.length) throw new Error("Fairfield County AVA image response contained no document tiles.");
  return page.evaluate(async ({ sourceImages, declaredWidth, declaredHeight }) => {
    const base = "https://ava.fidlar.com/OHFairfield/ScrapRelay.WebService.Ava/";
    const loaded = await Promise.all(sourceImages.map((source) => new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve({ image, source });
      image.onerror = () => reject(new Error("AVA document tile failed to load."));
      image.src = new URL(source.ImagePath || source.imagePath || "", base).href;
    })));
    const xFor = (image, source) => Number(source.GridPosX || source.gridPosX || 0) * image.naturalWidth;
    const yFor = (image, source) => Number(source.GridPosY || source.gridPosY || 0) * image.naturalHeight;
    const width = Number(declaredWidth) || Math.max(...loaded.map(({ image, source }) => xFor(image, source) + image.naturalWidth));
    const height = Number(declaredHeight) || Math.max(...loaded.map(({ image, source }) => yFor(image, source) + image.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    context.fillStyle = "white";
    context.fillRect(0, 0, width, height);
    for (const { image, source } of loaded) {
      context.drawImage(image, xFor(image, source), yFor(image, source));
    }
    return canvas.toDataURL("image/png");
  }, {
    sourceImages: images,
    declaredWidth: payload?.ImageWidth,
    declaredHeight: payload?.ImageHeight,
  });
}

async function extractAvaDocumentSearch(page, limit) {
  return page.locator("body").first().evaluate((body, max) => {
    const clean = (value) => (value || "").replace(/\s+/g, " ").trim();
    const values = [];
    const seen = new Set();
    const add = (value) => {
      const text = clean(value).slice(0, 12_000);
      if (!text || seen.has(text) || values.length >= max) return;
      seen.add(text);
      values.push({ text });
    };
    add(body.innerText || body.textContent);
    for (const element of document.querySelectorAll("app-searchresults table tr, app-search-results table tr, table tr, mat-card, [role='row']")) {
      add(element.innerText || element.textContent);
    }
    for (const element of document.querySelectorAll("button, a[href], [role='button']")) {
      const label = clean(element.getAttribute("aria-label") || element.getAttribute("title") || element.innerText || element.textContent);
      add(`CONTROL ${element.tagName.toLocaleLowerCase()} role=${element.getAttribute("role") || ""} class=${element.className || ""} label=${label}`);
    }
    for (const entry of performance.getEntriesByType("resource")) {
      const href = String(entry.name || "");
      if (!/ScrapRelay\.WebService\.Ava\/(?:breeze\/)?(?:Search|ViewImages)|\/AvaWeb\/appConfig\.json/i.test(href)) continue;
      const safeHref = href.replace(/[?#].*$/, "");
      if (seen.has(safeHref) || values.length >= max) continue;
      seen.add(safeHref);
      values.push({ href: safeHref, label: "Fairfield County AVA resource", text: safeHref });
    }
    return values;
  }, limit);
}

async function extractAntenatiRegistryContext(page) {
  return page.evaluate(async () => {
    const normalize = (value) => (value || "").replace(/\s+/g, " ").trim();
    const values = [{ text: normalize(document.body?.innerText || document.body?.textContent) }];
    const seen = new Set();
    let manifestUrl = "";
    for (const entry of performance.getEntriesByType("resource")) {
      const href = String(entry.name || "");
      if (!/(dam-antenati|iiif-antenati|\/manifest(?:$|[?#])|\/ark:\/12657\/)/i.test(href) || seen.has(href)) continue;
      seen.add(href);
      values.push({ href, label: "Antenati viewer resource", text: href });
      if (/\/manifest(?:$|[?#])/i.test(href)) manifestUrl = href;
    }
    for (const link of document.querySelectorAll('a[href*="dam-antenati" i], a[href*="iiif-antenati" i], a[href*="/manifest" i]')) {
      const href = link.href;
      if (!href || seen.has(href)) continue;
      seen.add(href);
      values.push({ href, label: normalize(link.innerText || link.getAttribute("aria-label")), text: normalize(link.parentElement?.innerText || href) });
    }
    if (manifestUrl) {
      try {
        const manifest = await fetch(manifestUrl).then((response) => {
          if (!response.ok) throw new Error(`manifest HTTP ${response.status}`);
          return response.json();
        });
        const canvases = manifest?.sequences?.[0]?.canvases || manifest?.items || [];
        canvases.forEach((canvas, index) => {
          const image = canvas?.images?.[0]?.resource?.service?.["@id"]
            || canvas?.images?.[0]?.resource?.["@id"]
            || canvas?.items?.[0]?.items?.[0]?.body?.service?.[0]?.id
            || canvas?.items?.[0]?.items?.[0]?.body?.id
            || "";
          const href = image && !/\/info\.json(?:$|[?#])/i.test(image) ? `${image.replace(/\/$/, "")}/info.json` : image;
          const label = normalize(typeof canvas?.label === "string" ? canvas.label : canvas?.label?.it?.[0] || canvas?.label?.en?.[0] || `canvas ${index + 1}`);
          if (!href || seen.has(href)) return;
          seen.add(href);
          values.push({ href, label, text: `${index + 1} ${label} ${href}` });
        });
      } catch (error) {
        values.push({ text: `Antenati manifest read failed: ${String(error?.message || error)}` });
      }
    }
    return values;
  });
}

async function extractLinks(page, selector, limit) {
  return page.locator(selector).evaluateAll((links, max) => {
    const values = [];
    for (const link of links) {
      if (values.length >= max) break;
      const container = link.closest('tr, [role="row"], li, article, section') || link.parentElement;
      values.push({
        href: link.href,
        label: (link.getAttribute("aria-label") || link.innerText || "").replace(/\s+/g, " ").trim(),
        text: (container?.innerText || link.innerText || "").replace(/\s+/g, " ").trim(),
      });
    }
    return values;
  }, limit);
}

async function extractFamilySearchFullTextLinks(page, limit) {
  return page.locator('a[href*="/ark:/61903/3:1:"], a[href*="/record/"]').evaluateAll((links, max) => {
    const clean = (value) => (value || "").replace(/\s+/g, " ").trim();
    const values = [];
    for (const link of links) {
      if (values.length >= max) break;
      let container = link;
      let context = "";
      for (let depth = 0; container && depth < 7; depth += 1, container = container.parentElement) {
        // Stop at the first ancestor that also holds another result: beyond
        // it the text belongs to the shared result list, not this row.
        const resultHrefs = new Set([...container.querySelectorAll('a[href*="/ark:/61903/3:1:"], a[href*="/record/"]')]
          .map((anchor) => anchor.href));
        if (resultHrefs.size > 1) break;
        const candidate = clean(container.innerText);
        if (candidate.length >= 40 && candidate.length <= 1_500 && candidate.length > context.length) context = candidate;
      }
      values.push({
        href: link.href,
        label: clean(link.getAttribute("aria-label") || link.innerText),
        text: context || clean(link.innerText),
      });
    }
    return values;
  }, limit);
}

async function extractFamilySearchPageLinks(page, limit) {
  const currentUrl = new URL(page.url());
  const pathname = currentUrl.pathname;
  if (currentUrl.hostname === "api.familysearch.org") {
    return page.locator("a[href]").evaluateAll((anchors, max) => anchors.slice(0, max).map((anchor) => {
      const href = new URL(anchor.getAttribute("href") || "", location.href).href;
      const label = (anchor.innerText || anchor.textContent || anchor.getAttribute("href") || "").replace(/\s+/g, " ").trim();
      return { href, label, text: label || href };
    }), limit);
  }
  const selector = /\/search\/record\/results\/?$/i.test(pathname)
    ? 'a[href*="/ark:/61903/1:1:"], a[href*="/record/"]'
    : "main a[href]";
  return extractLinks(page, selector, limit);
}

async function extractFamilySearchPageContext(page, limit) {
  const currentUrl = new URL(page.url());
  const pathname = currentUrl.pathname;
  const fullTextImage = /\/ark:\/61903\/3:1:/i.test(pathname) && currentUrl.searchParams.get("view") === "fullText";
  if (fullTextImage) {
    const transcriptButton = page.getByRole("button", { name: "Transcript", exact: true }).first();
    if (await transcriptButton.isVisible().catch(() => false)) {
      await transcriptButton.click({ force: true, noWaitAfter: true, timeout: 10_000 }).catch(() => {});
    }
    await page.waitForFunction(() => {
      const text = (document.body?.innerText || "").replace(/\s+/g, " ").trim();
      return /\bTranscript\b/i.test(text) && text.length > 500;
    }, { timeout: 8_000 }).catch(() => {});
  }
  if (/\/search\/catalog\/results\/?$/i.test(pathname)) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(750);
    const expanders = page.getByRole("button", { name: "Expand this section", exact: true });
    const count = Math.min(await expanders.count(), 20);
    for (let index = 0; index < count; index += 1) {
      const expander = expanders.nth(index);
      if (!await expander.isVisible().catch(() => false)) continue;
      // Catalog results group exact place/subject matches behind disclosure
      // controls. Open those validated read-only controls in the background
      // transaction so the record links are available for extraction.
      await expander.evaluate((button) => button.click());
    }
    if (count) await page.waitForTimeout(750);
  }
  if (/\/(?:en\/)?tree\/person\/(?:details|vitals|sources)\/[A-Z0-9-]+\/?$/i.test(pathname)) {
    for (let pass = 0; pass < 3; pass += 1) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(500);
    }
  }
  const main = page.locator("main").first();
  const hasMain = await main.count() > 0;
  const catalogItemRows = /\/service\/search\/catalog\/item\//i.test(pathname)
    ? await page.locator("film_note, note").evaluateAll((elements, max) => elements.slice(0, max).map((element) => ({
      text: (element.innerText || element.textContent || "").replace(/\s+/g, " ").trim(),
    })), limit)
    : [];
  const structured = hasMain ? await extractText(page, "main h1, main h2, main h3, main p, main li, main table tr", limit) : [];
  const controls = hasMain ? await page.locator('main button, main [role="button"], main [role="link"], main [tabindex="0"]').evaluateAll((elements, max) => elements.slice(0, max).map((element) => {
    const label = (element.getAttribute("aria-label") || element.innerText || element.textContent || "").replace(/\s+/g, " ").trim();
    const testId = (element.getAttribute("data-testid") || "").replace(/\s+/g, " ").trim();
    const descriptor = [element.tagName.toLocaleLowerCase(), testId].filter(Boolean).join(";");
    return { text: descriptor ? `${label} [${descriptor}]` : label };
  }), limit) : [];
  const resources = await page.evaluate(() => {
    const values = [];
    const seen = new Set();
    for (const entry of performance.getEntriesByType("resource")) {
      let parsed;
      try { parsed = new URL(String(entry.name || "")); } catch { continue; }
      if (!/(^|\.)familysearch\.org$/i.test(parsed.hostname) || !/(catalog|search|graphql|author)/i.test(parsed.pathname)) continue;
      const safe = new URL(`${parsed.origin}${parsed.pathname}`);
      for (const [key, value] of parsed.searchParams) {
        if (/^(q|count|start|page|rows|author|lang|locale|facet|filter|groupBy|offset|m\.)/i.test(key) && value.length <= 500) {
          safe.searchParams.append(key, value);
        }
      }
      const href = safe.toString();
      if (seen.has(href)) continue;
      seen.add(href);
      const queryKeys = [...new Set([...parsed.searchParams.keys()].filter((key) => !/(password|passphrase|pin|cvv|cvc|card|cookie|authorization|secret|token|credential|email|phone|address)/i.test(key)))];
      values.push({ href, label: "FamilySearch page resource", text: queryKeys.length ? `${href} query keys: ${queryKeys.join(", ")}` : href });
    }
    return values;
  });
  const mainText = hasMain ? await main.evaluate((mainElement) => ({
    text: (mainElement.innerText || mainElement.textContent || "").replace(/\s+/g, " ").trim(),
  })) : null;
  const bodyText = fullTextImage || !mainText?.text ? await page.locator("body").first().evaluate((body) => ({
    text: (body.innerText || body.textContent || "").replace(/\s+/g, " ").trim(),
  })).catch(() => null) : null;
  const imagePosition = fullTextImage ? await page.evaluate(() => {
    const value = String(document.querySelector('input[aria-label*="Image" i], input[name*="image" i]')?.value || "").trim();
    const text = (document.body?.innerText || "").replace(/\s+/g, " ");
    const total = text.match(/\bof\s+(\d+)\b/i)?.[1] || "";
    return value ? { text: `Image ${value}${total ? ` of ${total}` : ""}` } : null;
  }).catch(() => null) : null;
  if (fullTextImage) {
    return [imagePosition, bodyText, ...structured, ...controls, ...resources].filter((value) => value?.text);
  }
  return mainText?.text
    ? [...catalogItemRows, mainText, ...structured, ...controls, ...resources]
    : [...catalogItemRows, bodyText, ...structured, ...controls, ...resources].filter((value) => value?.text);
}

async function extractAncestryPublicTreeResults(page, limit) {
  const selector = [
    'main a[href*="/family-tree/person/tree/"]',
    'main a[href*="/discoveryui-content/view/1030:"]',
    'main a[href*="/search/collections/1030/records/"]',
  ].join(", ");
  return page.locator(selector).evaluateAll((links, max) => {
    const normalize = (value) => (value || "").replace(/\s+/g, " ").trim();
    const resultText = (link) => {
      const label = normalize(link.getAttribute("aria-label") || link.innerText || link.textContent);
      let current = link.parentElement;
      let best = label;
      for (let depth = 0; current && depth < 8 && current.tagName !== "MAIN"; depth += 1, current = current.parentElement) {
        const text = normalize(current.innerText || current.textContent);
        if (text.length < label.length || text.length > 2_500) continue;
        if (text.length > best.length) best = text;
        if (/\b(birth|born|death|died|spouse|father|mother|family tree|\d+ trees?)\b/i.test(text)) return text;
      }
      return best;
    };
    return links.slice(0, max).map((link) => ({
      href: link.href,
      label: normalize(link.getAttribute("aria-label") || link.innerText || link.textContent),
      text: resultText(link),
    }));
  }, limit);
}

async function extractAncestryPublicTreePerson(page, limit) {
  return page.locator("main").evaluate((main, max) => {
    const normalize = (value) => (value || "").replace(/\s+/g, " ").trim();
    const values = [{ text: normalize(main.innerText || main.textContent) }];
    for (const link of main.querySelectorAll('a[href]')) {
      if (values.length >= max) break;
      const label = normalize(link.getAttribute("aria-label") || link.innerText || link.textContent);
      if (!/visit source|record|source/i.test(label) && !/\/search\/collections\/\d+\/records\/\d+/i.test(link.pathname)) continue;
      const container = link.closest('li, article, section, [role="row"]') || link.parentElement;
      values.push({ href: link.href, label, text: normalize(container?.innerText || label) });
    }
    return values;
  }, limit);
}

async function extractText(page, selector, limit) {
  return page.locator(selector).evaluateAll((elements, max) => elements.slice(0, max).map((element) => ({
    text: (element.innerText || element.textContent || "").replace(/\s+/g, " ").trim(),
  })), limit);
}

async function extractPcusaCatalogResults(page, limit) {
  const values = await extractLinks(page, 'a[href*="/cgi-bin/koha/opac-detail.pl?biblionumber="]', limit);
  const main = page.locator("main, #userresults, #maincontent").first();
  const text = await main.evaluate((element) => ({
    text: (element.innerText || element.textContent || "").replace(/\s+/g, " ").trim(),
  })).catch(() => null);
  return [text, ...values].filter((value) => value?.text || value?.href);
}

async function extractPcusaCatalogDetail(page, limit) {
  const main = page.locator("main, #catalogue_detail_biblio, #maincontent").first();
  const text = await main.evaluate((element) => ({
    text: (element.innerText || element.textContent || "").replace(/\s+/g, " ").trim(),
  })).catch(() => null);
  const fields = await extractText(page, "main h1, main h2, main h3, main table tr, main dl dt, main dl dd, #catalogue_detail_biblio h1, #catalogue_detail_biblio table tr, #catalogue_detail_biblio li", limit);
  // Koha renders MARC, ISBD, export, and related-record navigation as relative
  // links. DOM `link.href` resolves them to absolute URLs before the normal
  // result sanitizer runs, so retain those links instead of silently losing
  // the most useful catalog routes.
  const links = await extractLinks(page, "main a[href], #catalogue_detail_biblio a[href]", limit);
  return [text, ...fields, ...links].filter((value) => value?.text || value?.href);
}

async function extractPcusaDigitalContext(page, limit) {
  const main = page.locator("main, #main, #content").first();
  const text = await main.evaluate((element) => ({
    text: (element.innerText || element.textContent || "").replace(/\s+/g, " ").trim(),
  })).catch(() => null);
  const links = await extractLinks(page, 'main a[href*="digital.history.pcusa.org"], main a[href*="/islandora/"], #main a[href*="/islandora/"], #content a[href*="/islandora/"]', limit);
  return [text, ...links].filter((value) => value?.text || value?.href);
}

async function extractPcusaCatalogMarc(page, limit) {
  const main = page.locator("main, #marc, #maincontent").first();
  const text = await main.evaluate((element) => ({
    text: (element.innerText || element.textContent || "").replace(/\s+/g, " ").trim(),
  })).catch(() => null);
  const fields = await extractText(page, "main table tr, #marc table tr, #maincontent table tr", limit);
  const links = await extractLinks(page, "main a[href], #marc a[href], #maincontent a[href]", limit);
  return [text, ...fields, ...links].filter((value) => value?.text || value?.href);
}

function rowValues(rows, max) {
  return rows.slice(0, max).map((row) => {
    const action = row.querySelector('a[href*="transcript" i], a[href*="record" i], a[href*="image" i], a[href]');
    return {
      text: (row.innerText || "").replace(/\s+/g, " ").trim(),
      href: action?.href || "",
      label: (action?.getAttribute("aria-label") || action?.innerText || "").replace(/\s+/g, " ").trim(),
    };
  });
}

function stepSummary(result) {
  const summary = { type: "step", id: result.id, operation: result.operation, status: result.status, timingsMs: result.timingsMs, visibleCount: result.visibleCount, returnedCount: result.returnedCount, truncated: result.truncated };
  if (result.declaredCount !== undefined) summary.declaredCount = result.declaredCount;
  if (result.searchSummary) summary.searchSummary = result.searchSummary;
  if (result.needsUserId) Object.assign(summary, { needsUserId: result.needsUserId, reason: result.reason });
  if (result.error) summary.error = result.error;
  if (result.results?.length) summary.results = result.results;
  return summary;
}

function safeError(error) {
  return String(error instanceof Error ? error.message : error).replace(/[\r\n]+/g, " ").slice(0, 1_000);
}

async function waitForStableReadSurface(page) {
  let previous = "";
  let stable = 0;
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const signature = await page.locator("main, body").first().evaluate((element) => {
      const text = (element.innerText || "").replace(/\s+/g, " ").trim();
      return `${text.length}:${text.slice(-160)}`;
    }).catch(() => "");
    if (signature && signature === previous) stable += 1;
    else stable = 0;
    if (stable >= 2) return;
    previous = signature;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export async function waitForProviderReadSurface(page, provider, operation, step) {
  if (provider === "familysearch" && operation === "viewer-metadata") {
    if (await detectAccessGate(page, provider)) return;
    try {
      return await waitForFamilySearchViewerMetadata(page, step.url);
    } catch (error) {
      // Preserve the existing guarded sign-in flow if a session expires while
      // the viewer is settling. The exact-ARK reader itself never reads it.
      if (await detectAccessGate(page, provider)) return;
      throw error;
    }
  }
  if (provider === "findmypast" && operation === "findmypast-row") {
    const started = Date.now();
    let previous = "";
    let stable = 0;
    while (Date.now() - started < 20_000) {
      if (await detectAccessGate(page, provider)) return;
      const snapshot = await readFindmypastRecordResults(page);
      const signature = JSON.stringify(snapshot);
      stable = signature === previous ? stable + 1 : 0;
      previous = signature;
      const state = classifyFindmypastRecordResults(snapshot, { settled: stable >= 2 && Date.now() - started >= 3_000 });
      if (["ready", "zero"].includes(state)) return snapshot;
      if (["error", "conflict"].includes(state)) throw new Error(`Findmypast search surface is ${state}; no search conclusion is available.`);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    let last = {};
    try { last = JSON.parse(previous || "{}"); } catch {}
    throw new Error(`Findmypast exposed neither stable record rows nor an explicit zero; no search conclusion is available. ${describeFindmypastSnapshot(last)}`);
  }
  if (provider === "archion") {
    await waitForArchionCatalogSurface(page, operation, step);
    return;
  }
  if (provider === "ava") {
    await waitForAvaReadSurface(page, operation);
    return;
  }
  if (provider === "pcusa") {
    await waitForPcusaReadSurface(page, operation);
    return;
  }
  if (provider === "findmypast" && operation === "findmypast-newspaper-results") {
    await waitForFindmypastNewspaperSurface(page);
    return;
  }
  if (provider !== "familysearch") return;
  const pathname = new URL(page.url()).pathname;
  const recordResults = ["page-links", "page-context"].includes(operation)
    && /\/search\/record\/results\/?$/i.test(pathname);
  const recordFacts = operation === "record-facts" && /\/ark:\/61903\/1:1:[A-Z0-9-]+\/?$/i.test(pathname);
  const treeContext = operation === "page-context" && /^\/(?:en\/)?tree\/person\/(?:details|vitals|sources)\/[A-Z0-9-]+\/?$/i.test(pathname);
  const treeSources = treeContext && /\/sources\//i.test(pathname);
  if (operation !== "fulltext-search" && !recordResults && !recordFacts && !treeContext) return;
  const startedAt = Date.now();
  const deadline = startedAt + 10_000;
  const zeroSettleAt = startedAt + 3_000;
  while (Date.now() < deadline) {
    const state = await page.evaluate(({ isRecordResults, isRecordFacts, isTreeContext, isTreeSources }) => {
      const text = (document.body?.innerText || "").replace(/\s+/g, " ");
      const rawCount = isRecordResults
        ? text.match(/(?:Search|Record) Results\s*\(([\d,]+)\)/i)?.[1] || ""
        : text.match(/Full-Text Search Results\s*\(([\d,]+)\)/i)?.[1] || "";
      const declaredCount = rawCount ? Number(rawCount.replaceAll(",", "")) : null;
      const resultLinkCount = isRecordFacts ? 0 : document.querySelectorAll(isRecordResults
        ? 'a[href*="/ark:/61903/1:1:"], a[href*="/record/"]'
        : 'a[href*="/ark:/61903/3:1:"], a[href*="/record/"]').length;
      const recordFactsReady = isRecordFacts
        && /\bDocument Information\b/i.test(text)
        && document.querySelectorAll("main h1, main table tr, main dl dt, main [data-testid*='field']").length > 0;
      const mainText = (document.querySelector("main")?.innerText || "").replace(/\s+/g, " ").trim();
      const treeContextReady = isTreeContext
        && (isTreeSources
          ? mainText.length > 150 && /\bSources \(\d+\).*\bDate\s+Title\s+Created\b/i.test(mainText)
          : mainText.length > 400 && /\b(?:Birth|Death|Spouses and Children|Parents and Siblings)\b/i.test(mainText))
        && !/^\s*(?:Vitals Detail View|Sources Detail View)\s*$/i.test(mainText);
      const explicitZero = isRecordResults
        ? /(?:no records found|no results found|we found 0 results)/i.test(text)
        : isRecordFacts
          ? /(?:record (?:is )?not found|this record is no longer available|unable to find this record)/i.test(text)
          : declaredCount === 0;
      const busy = [...document.querySelectorAll('[aria-busy="true"], [role="progressbar"]')].some((element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      });
      return { declaredCount, resultLinkCount, recordFactsReady, treeContextReady, explicitZero, busy };
    }, { isRecordResults: recordResults, isRecordFacts: recordFacts, isTreeContext: treeContext, isTreeSources: treeSources })
      .catch(() => ({ declaredCount: null, resultLinkCount: 0, recordFactsReady: false, treeContextReady: false, explicitZero: false, busy: true }));
    if (state.recordFactsReady) return;
    if (state.treeContextReady) return;
    if (state.resultLinkCount > 0 && (recordResults || state.declaredCount > 0)) return;
    if (Date.now() >= zeroSettleAt && state.explicitZero && !state.busy) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  if (recordResults) throw new Error("FamilySearch record search did not expose results or an explicit zero-result state before timeout.");
  if (recordFacts) throw new Error("FamilySearch record page did not expose record facts or an explicit unavailable-record state before timeout.");
  if (treeContext) throw new Error("FamilySearch tree page did not expose person details before timeout.");
}

// Selects the single row whose text contains every term (case-insensitive).
// Zero or several matches stop the step rather than guessing a record.
export function selectFindmypastRowToOpen(rows = [], terms = [], ordinal = undefined) {
  const wanted = terms.map((term) => String(term).toLowerCase());
  const all = rows.map((row, index) => ({ row, index }))
    .filter(({ row }) => wanted.every((term) => String(row.text || "").toLowerCase().includes(term)));
  if (ordinal !== undefined) {
    // An explicit ordinal opens the Nth matching row in page order, counting
    // identical-text rows separately (they can be distinct packet documents).
    if (!Number.isInteger(ordinal) || ordinal < 1 || ordinal > all.length) {
      throw new Error(`Findmypast openRowOrdinal ${ordinal} is outside the ${all.length} matching result rows; no record was opened.`);
    }
    const chosen = all[ordinal - 1];
    const occurrence = all.slice(0, ordinal - 1).filter(({ row }) => row.text === chosen.row.text).length;
    return { ...chosen, occurrence };
  }
  // The same row can be rendered twice (responsive layouts); identical text
  // is one record, different text is a real ambiguity.
  const matches = all.filter(({ row }, position, list) => list.findIndex((other) => other.row.text === row.text) === position);
  if (matches.length !== 1) {
    throw new Error(`Findmypast openRowTerms matched ${matches.length} result rows; exactly one is required to open a record.`);
  }
  return { ...matches[0], occurrence: 0 };
}

// Opens one result row through its own View button and returns the record
// URL reached. The click stays inside the leased task tab: a new tab or a
// non-Findmypast destination is refused.
async function openFindmypastResultRow(page, rows, terms, ordinal) {
  const { row, index, occurrence } = selectFindmypastRowToOpen(rows, terms, ordinal);
  const before = page.url();
  const clicked = await page.evaluate(({ index, expected, occurrence }) => {
    const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const visible = (element) => {
      const style = getComputedStyle(element);
      const bounds = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && bounds.width > 0 && bounds.height > 0;
    };
    const buttons = [...document.querySelectorAll("main button")].filter(visible)
      .filter((button) => /\bView\b/i.test(clean(button.getAttribute("aria-label") || button.innerText)));
    const sameText = buttons.filter((candidate) => {
      let node = candidate;
      for (let depth = 0; node && depth < 8; depth += 1, node = node.parentElement) {
        if (clean(node.innerText) === expected) return true;
      }
      return false;
    });
    const button = sameText[occurrence] || (occurrence === 0 ? buttons[index] : null);
    if (!button) return false;
    button.click();
    return true;
  }, { index, expected: row.text, occurrence });
  if (!clicked) throw new Error("Findmypast result row's View button was not found; no record was opened.");
  await page.waitForURL((url) => url.href !== before, { timeout: 20_000 }).catch(() => {});
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  const reached = new URL(page.url());
  if (reached.href === before) throw new Error("Findmypast View did not navigate to a record page.");
  if (!/(^|\.)findmypast\.(com|co\.uk)$/i.test(reached.hostname)) {
    throw new Error(`Findmypast View navigated off the provider (${reached.hostname}); refused.`);
  }
  return { text: row.text, href: reached.href, label: "opened-row" };
}

async function readFindmypastRecordResults(page) {
  return page.evaluate(() => {
    const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const visible = (element) => {
      const style = getComputedStyle(element);
      const bounds = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && bounds.width > 0 && bounds.height > 0;
    };
    const main = document.querySelector("main");
    const text = clean(main?.innerText);
    const headings = clean(`${document.title} ${[...document.querySelectorAll("h1,h2")].map((element) => element.innerText).join(" ")}`);
    const viewButtons = [...document.querySelectorAll("main button")].filter(visible)
      .filter((button) => /\bView\b/i.test(clean(button.getAttribute("aria-label") || button.innerText)));
    const isViewButton = (element) => viewButtons.includes(element);
    const linkedBoundaries = [...document.querySelectorAll('main tr, main [role="row"], main article, main li')]
      .filter(visible).filter((row) => row.querySelector('a[href*="/transcript"], a[href*="/record"]'));
    // Findmypast's current results list renders each row around a "View"
    // button with no record link; fall back to the nearest row container of
    // each such button so declared results are not misread as an empty page.
    const buttonBoundaries = linkedBoundaries.length ? [] : viewButtons.map((button) => {
      const container = button.closest('tr, [role="row"], article, li');
      if (container) return container;
      let node = button.parentElement;
      while (node && node.parentElement && node.parentElement !== main
        && [...node.parentElement.querySelectorAll("button")].filter(isViewButton).length === 1) node = node.parentElement;
      return node;
    }).filter(Boolean);
    const boundaries = linkedBoundaries.length ? linkedBoundaries : [...new Set(buttonBoundaries)];
    const rows = boundaries.filter((row) => !boundaries.some((child) => child !== row && row.contains(child))).slice(0, 500).map((row) => {
      const action = row.querySelector('a[href*="/transcript"], a[href*="/record"]');
      const button = action ? null : [...row.querySelectorAll("button")].find(isViewButton);
      return { text: clean(row.innerText), href: action ? action.href : null, label: clean(action ? (action.innerText || action.getAttribute("aria-label")) : (button?.getAttribute("aria-label") || button?.innerText)) };
    });
    const viewCount = viewButtons.length;
    const count = text.match(/\b([\d,]+)\s+(?:search\s+)?results?\b/i);
    const filters = [...document.querySelectorAll("main input, main select")].filter(visible)
      .filter((element) => !["password", "email", "hidden"].includes(element.type))
      .flatMap((element) => {
        const label = clean(element.getAttribute("aria-label") || [...(element.labels || [])].map((label) => label.innerText).join(" "));
        if (!/^(?:First name\(s\)|Last name|Baptism year|Give or take|Year range|Father.s first name\(s\)|Mother.s first name\(s\)|Name variants)$/i.test(label)) return [];
        return [{ label, value: element.type === "checkbox" ? element.checked : element.value }];
      });
    const placeChips = [...document.querySelectorAll("main button")].filter(visible)
      .map((element) => clean(element.getAttribute("aria-label") || element.innerText)).filter((label) => /^Remove /i.test(label)).slice(0, 40);
    const hasNextPage = [...document.querySelectorAll('main nav a, main nav button, main [aria-label*="pagination" i] a, main [aria-label*="pagination" i] button')]
      .filter(visible).some((element) => !element.disabled && element.getAttribute("aria-disabled") !== "true" &&
        /\bnext\b/i.test(clean(element.getAttribute("aria-label") || element.innerText)));
    return {
      error: /\b404\b|page not found|something went wrong|service unavailable/i.test(headings),
      busy: [...document.querySelectorAll('[aria-busy="true"], [role="progressbar"]')].some(visible),
      resultHeading: /\bResults for\b/i.test(headings),
      explicitZero: /\b0\s+(?:search\s+)?results?\b|\bno (?:matching )?(?:results|records)(?: were)? found\b/i.test(text),
      declaredCount: count ? Number(count[1].replaceAll(",", "")) : null,
      headings: headings.slice(0, 2000), filters, placeChips, hasNextPage,
      rows, viewCount,
    };
  });
}

// A bounded, value-free summary of the last results surface, so a timeout is
// diagnosable without logging row contents.
export function describeFindmypastSnapshot(snapshot = {}) {
  const parts = [
    `resultHeading=${Boolean(snapshot.resultHeading)}`,
    `explicitZero=${Boolean(snapshot.explicitZero)}`,
    `busy=${Boolean(snapshot.busy)}`,
    `declaredCount=${snapshot.declaredCount ?? "none"}`,
    `rows=${Array.isArray(snapshot.rows) ? snapshot.rows.length : 0}`,
    `viewButtons=${snapshot.viewCount ?? 0}`,
    `heading="${String(snapshot.headings || "").slice(0, 120)}"`
  ];
  return `Last surface: ${parts.join(", ")}.`;
}

export function classifyFindmypastRecordResults(snapshot, { settled = false } = {}) {
  if (snapshot.error) return "error";
  if (snapshot.busy) return "pending";
  if (snapshot.explicitZero && (snapshot.rows.length || snapshot.viewCount || snapshot.declaredCount > 0)) return "conflict";
  if (!settled || !snapshot.resultHeading) return "pending";
  if (snapshot.explicitZero) return "zero";
  if (snapshot.rows.length) return "ready";
  return "pending";
}

export function assertUnchangedFindmypastRecordResults(settled, current) {
  if (!settled || JSON.stringify(settled) !== JSON.stringify(current)) {
    throw new Error("Findmypast result surface changed after settling; no search conclusion is available.");
  }
}

async function waitForArchionCatalogSurface(page, operation, step) {
  if (operation !== "catalog-results") return;
  const requested = assertArchionCatalogParishUrl(step.url);
  const expectedPath = new URL(requested.url).pathname;
  const startedAt = Date.now();
  const deadline = startedAt + 15_000;
  const incompleteSettleAt = startedAt + 4_000;
  let lastSnapshot = null;
  while (Date.now() < deadline) {
    const snapshot = await page.evaluate((parishPath) => {
      const text = (document.body?.innerText || "").replace(/\s+/g, " ").trim();
      const busy = [...document.querySelectorAll('[aria-busy="true"], [role="progressbar"]')].some((element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      });
      const objectLinkCount = [...document.querySelectorAll("a[href]")].filter((anchor) => {
        try {
          const parsed = new URL(anchor.href, location.href);
          return parsed.protocol === "https:"
            && parsed.hostname === "www.archion.de"
            && new RegExp(`^${parishPath.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}/[1-9]\\d*/?$`).test(parsed.pathname)
            && !parsed.search
            && !parsed.hash;
        } catch { return false; }
      }).length;
      const routePath = location.pathname.replace(/\/+$/, "");
      const expected = parishPath.replace(/\/+$/, "");
      return {
        routeReady: location.protocol === "https:" && location.hostname === "www.archion.de" && routePath === expected,
        objectLinkCount,
        textReady: /Kirchenb(?:u|\u00fc)cher|Landeskirchliches Archiv|Braunschweig/i.test(text) && text.length > 120,
        explicitEmpty: /keine (?:Kirchenb(?:u|\u00fc)cher|Digitalisate|Eintr(?:a|\u00e4)ge) (?:vorhanden|gefunden|verf(?:u|\u00fc)gbar)/i.test(text),
        challenge: location.hostname !== "www.archion.de"
          || /\/(?:login|signin|sign-in|konto|zugang-kaufen|checkout|shop|payment)(?:\/|$)/i.test(location.pathname)
          || /verify you are human|captcha|attention required|sorry, you have been blocked/i.test(text),
        busy,
      };
    }, expectedPath).catch(() => ({ routeReady: false, objectLinkCount: 0, textReady: false, explicitEmpty: false, challenge: false, busy: true }));
    lastSnapshot = snapshot;
    const state = classifyArchionCatalogSurface(snapshot, Date.now() >= incompleteSettleAt);
    if (state === "ready" || state === "challenge") return;
    if (state === "incomplete") {
      throw new Error(`Archion ${requested.parishId} catalogue explicitly exposed no object results; discovery remains incomplete.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Archion ${requested.parishId} catalogue did not expose numeric object links before timeout${lastSnapshot?.routeReady ? " on the expected route" : ""}.`);
}

export function classifyArchionCatalogSurface(snapshot, settled = false) {
  if (snapshot?.challenge) return "challenge";
  if (snapshot?.busy) return "pending";
  if (snapshot?.routeReady && snapshot?.textReady && snapshot?.objectLinkCount > 0) return "ready";
  if (settled && snapshot?.routeReady && snapshot?.explicitEmpty) return "incomplete";
  return "pending";
}

async function waitForAvaReadSurface(page, operation) {
  if (!new Set(["document-search", "document-image-context"]).has(operation)) return;
  const startedAt = Date.now();
  const deadline = startedAt + 20_000;
  const zeroSettleAt = startedAt + 5_000;
  let lastSnapshot = null;
  while (Date.now() < deadline) {
    const snapshot = await page.evaluate(() => {
      const text = (document.body?.innerText || "").replace(/\s+/g, " ").trim();
      const busy = [...document.querySelectorAll('[aria-busy="true"], [role="progressbar"], mat-spinner, mat-progress-bar')].some((element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      });
      return {
        routeReady: /#\/searchresults(?:[?#]|$)/i.test(location.href),
        resultTextReady: /\b(?:Search )?Results:\s*\d+\b/i.test(text) && /\b(?:Document No|Document Name|Document Number|Book|Page|Recorded Date|Recording Date)\b/i.test(text),
        explicitZero: /\b(?:no results|no records|no documents) (?:were )?(?:found|available)\b/i.test(text),
        challenge: /verify you are human|captcha|attention required|sorry, you have been blocked/i.test(text),
        busy,
        route: `${location.pathname}${location.hash}`.slice(0, 240),
        textSample: text.slice(0, 500),
      };
    }).catch(() => ({ routeReady: false, resultTextReady: false, explicitZero: false, challenge: false, busy: true, route: "unavailable", textSample: "" }));
    lastSnapshot = snapshot;
    const state = classifyAvaReadSurface(snapshot, Date.now() >= zeroSettleAt);
    if (state === "ready" || state === "zero") return;
    if (state === "challenge") return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  const context = lastSnapshot
    ? ` Last route: ${lastSnapshot.route}; visible text: ${lastSnapshot.textSample || "(empty)"}`
    : "";
  throw new Error(`Fairfield County AVA document search did not expose results or an explicit zero-result state before timeout.${context}`);
}

export function classifyAvaReadSurface(snapshot, settled = true) {
  if (snapshot?.challenge) return "challenge";
  if (snapshot?.busy) return "pending";
  if (snapshot?.routeReady && snapshot?.resultTextReady) return "ready";
  if (settled && snapshot?.explicitZero) return "zero";
  return "pending";
}

async function waitForPcusaReadSurface(page, operation) {
  const startedAt = Date.now();
  const deadline = startedAt + 10_000;
  const zeroSettleAt = startedAt + 3_000;
  while (Date.now() < deadline) {
    const snapshot = await page.evaluate(() => {
      const text = (document.body?.innerText || "").replace(/\s+/g, " ").trim();
      const main = document.querySelector("main, #userresults, #catalogue_detail_biblio, #marc, #maincontent, #main, #content");
      const mainText = (main?.innerText || main?.textContent || "").replace(/\s+/g, " ").trim();
      const busy = [...document.querySelectorAll('[aria-busy="true"], [role="progressbar"]')].some((element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      });
      return {
        challenge: /verify you are human|attention required|sorry, you have been blocked/i.test(text),
        busy,
        explicitZero: /no (?:results|records|titles|items) (?:found|available)|your search returned no results|record not found/i.test(text),
        resultLinkCount: document.querySelectorAll('a[href*="/cgi-bin/koha/opac-detail.pl?biblionumber="]').length,
        detailFieldCount: document.querySelectorAll("#catalogue_detail_biblio h1, #catalogue_detail_biblio table tr, #catalogue_detail_biblio dl dt, main h1, main table tr, main dl dt").length,
        detailTextReady: /(?:details for|holdings|item type|material type|publication details|physical description)/i.test(mainText),
        marcRowCount: document.querySelectorAll("#marc table tr, #maincontent table tr, main table tr").length,
        marcTextReady: /(?:marc view|marc details|leader|fixed-length data|^|\s)(?:000|001|008|100|245|260|264|300|610|650|710)(?:\s|$)/i.test(mainText),
        digitalLinkCount: document.querySelectorAll('a[href*="digital.history.pcusa.org"], a[href*="/islandora/"]').length,
        digitalTextLength: mainText.length,
        digitalTextReady: Boolean(main) && /(?:presbyterian historical society|digital collections|islandora|search results|collection|object)/i.test(mainText),
      };
    }).catch(() => ({ busy: true }));
    const state = classifyPcusaReadSurface(snapshot, operation, Date.now() >= zeroSettleAt);
    // A challenge is a terminal read surface for readiness purposes; the
    // existing access-gate classifier immediately converts it to NEEDS USER.
    if (state === "ready" || state === "zero" || state === "challenge") return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`PHS ${operation} page did not expose its expected catalog structure, an explicit zero-result state, or an access challenge before timeout.`);
}

// Findmypast renders newspaper hits asynchronously as links whose accessible
// name carries "Added on <date>". The generic row reader saw only the filter
// chips, so a known article returned nothing and every zero was ambiguous.
// This reader waits for stable article links or an explicit zero, and fails
// closed otherwise so an unloaded page can never become a bounded negative.
const FINDMYPAST_NEWSPAPER_ARTICLE = String.raw`Added on[\s\S]*\b(?:18|19|20)\d{2}\b`;
const FINDMYPAST_NEWSPAPER_ZERO = String.raw`\b(?:no results|0 results|we couldn['’]t find|did not match any|no matches)\b`;

async function readFindmypastNewspaperSnapshot(page) {
  return page.evaluate(({ articlePattern, zeroPattern }) => {
    const article = new RegExp(articlePattern, "i");
    const visible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const labelOf = (element) => (element.getAttribute("aria-label") || element.innerText || element.textContent || "")
      .replace(/\s+/g, " ").trim();
    const articles = [...document.querySelectorAll('a[href], [role="link"]')]
      .filter((element) => visible(element) && article.test(labelOf(element)));
    const main = document.querySelector("main") || document.body;
    const mainText = (main?.innerText || "").replace(/\s+/g, " ").trim();
    const rawCount = mainText.match(/\b([\d,]+)\s+results?\b/i)?.[1] || "";
    const busy = [...document.querySelectorAll('[aria-busy="true"], [role="progressbar"]')].some(visible);
    return {
      busy,
      challenge: /verify you are human|checking if the site connection is secure/i.test(mainText),
      articleCount: articles.length,
      articleSignature: articles.slice(0, 50).map(labelOf).join("\u0000").slice(0, 20_000),
      declaredCount: rawCount ? Number(rawCount.replaceAll(",", "")) : null,
      explicitZero: new RegExp(zeroPattern, "i").test(mainText),
      mainSample: mainText.slice(0, 300),
    };
  }, { articlePattern: FINDMYPAST_NEWSPAPER_ARTICLE, zeroPattern: FINDMYPAST_NEWSPAPER_ZERO });
}

async function waitForFindmypastNewspaperSurface(page) {
  const startedAt = Date.now();
  const deadline = startedAt + 20_000;
  const zeroSettleAt = startedAt + 4_000;
  let previousSignature = "";
  let stableSamples = 0;
  let last = {};
  while (Date.now() < deadline) {
    last = await readFindmypastNewspaperSnapshot(page).catch(() => ({ busy: true }));
    if (last.articleSignature && last.articleSignature === previousSignature) stableSamples += 1;
    else stableSamples = last.articleSignature ? 1 : 0;
    previousSignature = last.articleSignature || "";
    const state = classifyFindmypastNewspaperSurface(last, { stableSamples, zeroSettled: Date.now() >= zeroSettleAt });
    if (state === "ready" || state === "zero" || state === "challenge") return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Findmypast newspaper results exposed neither stable article links nor an explicit zero before timeout; `
    + `this is not a negative. Observed ${last.articleCount ?? 0} article links, declared count ${last.declaredCount ?? "none"}; `
    + `page text: ${String(last.mainSample || "").slice(0, 300)}`);
}

export function classifyFindmypastNewspaperSurface(snapshot, { stableSamples = 0, zeroSettled = false } = {}) {
  if (snapshot?.challenge) return "challenge";
  if (snapshot?.busy) return "pending";
  if (snapshot?.articleCount > 0) return stableSamples >= 3 ? "ready" : "pending";
  if (zeroSettled && (snapshot?.explicitZero || snapshot?.declaredCount === 0)) return "zero";
  return "pending";
}

async function extractFindmypastNewspaperResults(page, limit, expectedUrl) {
  const snapshot = await readFindmypastNewspaperSnapshot(page);
  const values = await page.locator('a[href], [role="link"]').evaluateAll((elements, { articlePattern, max }) => {
    const article = new RegExp(articlePattern, "i");
    return elements.map((element) => {
      const label = (element.getAttribute("aria-label") || element.innerText || element.textContent || "")
        .replace(/\s+/g, " ").trim();
      return article.test(label) ? { text: label.slice(0, 3_000), href: element.href || "" } : null;
    }).filter(Boolean).slice(0, max);
  }, { articlePattern: FINDMYPAST_NEWSPAPER_ARTICLE, max: limit });
  return { values, declaredCount: snapshot.declaredCount, searchSummary: await readNewspaperSearchState(page, expectedUrl) };
}

export function classifyPcusaReadSurface(snapshot, operation, zeroSettled = false) {
  if (snapshot?.challenge) return "challenge";
  if (snapshot?.busy) return "pending";
  if (zeroSettled && snapshot?.explicitZero) return "zero";
  if (operation === "catalog-results" && snapshot?.resultLinkCount > 0) return "ready";
  if (operation === "catalog-detail" && snapshot?.detailFieldCount > 0 && snapshot?.detailTextReady) return "ready";
  if (operation === "catalog-marc" && snapshot?.marcRowCount > 0 && snapshot?.marcTextReady) return "ready";
  if (operation === "digital-context"
      && snapshot?.digitalTextReady
      && (snapshot?.digitalLinkCount > 0 || snapshot?.digitalTextLength > 200)) return "ready";
  return "pending";
}

function numericEnvironment(name) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
}

function emit(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }

async function main() {
  const args = process.argv.slice(2);
  const planFile = optionValue(args, "--plan-file");
  if (!planFile) throw new Error("--plan-file is required.");
  const input = JSON.parse(fs.readFileSync(planFile, "utf8"));
  const plan = validateResearchBatchPlan(input, { projectRoot: PROJECT_ROOT });
  if (args.includes("--validate-only")) {
    emit({ type: "validation", status: "valid", provider: plan.provider, stepCount: plan.steps.length });
    return;
  }
  await runResearchBrowserBatch(plan);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    emit({ type: "fatal", status: "failed", error: safeError(error) });
    process.exitCode = 1;
  });
}
