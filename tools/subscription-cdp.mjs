#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright-core";
import { loadResearchStore } from "./research-store.mjs";
import { connectSharedBrowser } from "./shared-browser-bridge-client.mjs";
import { trySavedSignIn, trySavedSignInAtCurrentForm } from "./saved-signin.mjs";
import { createBackgroundTarget } from "./cdp-background-target.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENDPOINT = "http://127.0.0.1:9226";
const LOCK_PATH = path.join(os.tmpdir(), "family-history-subscription-cdp.lock");
const AFFINITY_PREFIX = "family-history-subscription-cdp-affinity";
const ALLOWED_HOST = /(^|\.)(ancestry\.(com|co\.uk)|findmypast\.(com|co\.uk))$/i;
const SLOT_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
const ARCHIVE_FILE_PATTERN = /^[^\\/]+\.(?:jpe?g|png|webp|pdf)$/i;

function normalizeExpectedRowTerms(rawTerms) {
  const source = Array.isArray(rawTerms) ? rawTerms : String(rawTerms || "").split("|");
  const terms = [...new Set(source.map((term) => String(term).replace(/\s+/g, " ").trim()).filter(Boolean))];
  if (terms.length < 2 || terms.length > 12) {
    throw new Error("--expected-row-terms must contain 2 through 12 unique pipe-delimited terms.");
  }
  if (terms.some((term) => term.length > 160)) {
    throw new Error("Each --expected-row-terms value must be at most 160 characters.");
  }
  return terms;
}

function normalizedResultText(value) {
  return String(value || "").normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase();
}

function normalizeFindmypastRecordId(value) {
  const recordId = String(value || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{2,200}$/.test(recordId)) {
    throw new Error("--expected-record-id must be a bounded Findmypast record ID.");
  }
  return recordId.toLocaleLowerCase();
}

function findmypastViewerMatchesRecordId(activeUrl, expectedRecordId) {
  try {
    const parsed = new URL(activeUrl);
    if (providerForUrl(parsed.href) !== "findmypast" || !/^\/record\/?$/i.test(parsed.pathname)) return false;
    const parentId = parsed.searchParams.get("parentid") || "";
    return normalizedResultText(parentId) === normalizeFindmypastRecordId(expectedRecordId);
  } catch {
    return false;
  }
}

function findmypastTranscriptMatchesRecordId(activeUrl, expectedRecordId) {
  try {
    const parsed = new URL(activeUrl);
    return parsed.protocol === "https:" && providerForUrl(parsed.href) === "findmypast" &&
      /^\/transcript\/?$/i.test(parsed.pathname) &&
      normalizeFindmypastRecordId(parsed.searchParams.get("id")) === normalizeFindmypastRecordId(expectedRecordId);
  } catch { return false; }
}

// Runs atomically in the task page. Responsive layouts can hide the exact
// desktop action while displaying the same result as a mobile summary.
function activateBoundFindmypastAction(element, { expectedTerms, recordId, actionLabel }) {
  const clean = (value) => String(value || "").normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase();
  const label = (node) => clean(node.getAttribute("aria-label") || node.innerText || node.textContent);
  const safeUrl = (node) => {
    const url = new URL(node.href);
    if (url.protocol !== "https:" || !/^(?:www\.|search\.)?findmypast\.(?:com|co\.uk)$/i.test(url.hostname)) {
      throw new Error("The bound Findmypast action has an unsafe provider URL.");
    }
    return url;
  };
  const row = element.closest("tr");
  if (!element.isConnected || element.tagName.toLocaleLowerCase() !== "a" || !row || !["View transcript", "View image"].includes(actionLabel) ||
      label(element) !== clean(actionLabel) || !expectedTerms.every((term) => clean(row.textContent).includes(clean(term)))) {
    throw new Error("The bound Findmypast action no longer matches its exact row.");
  }
  const actions = [...row.querySelectorAll("a,button")];
  const transcripts = actions.filter((node) => label(node) === "view transcript");
  const images = actions.filter((node) => label(node) === "view image");
  const requested = actions.filter((node) => label(node) === clean(actionLabel));
  if (transcripts.length !== 1 || images.length > 1 || requested.length !== 1 || requested[0] !== element) {
    throw new Error("The bound Findmypast row has ambiguous actions.");
  }
  const transcript = safeUrl(transcripts[0]);
  if (!/^\/transcript\/?$/i.test(transcript.pathname) || clean(transcript.searchParams.get("id")) !== clean(recordId)) {
    throw new Error("The bound Findmypast row no longer carries the expected record ID.");
  }
  safeUrl(element);
  element.click();
}

function selectUniqueFindmypastResultCandidate(candidates, expectedTerms) {
  const normalizedTerms = normalizeExpectedRowTerms(expectedTerms).map(normalizedResultText);
  const termMatches = candidates.filter((candidate) => {
    const text = normalizedResultText(candidate.text);
    return normalizedTerms.every((term) => text.includes(term));
  });
  const unsafe = termMatches.filter((candidate) =>
    candidate.boundaryStrength &&
    (candidate.genericViewActions !== 1 ||
      Number(candidate.nestedMatchingCompositeActions || 0) > 0 ||
      candidate.transcriptActions > 1 || candidate.imageActions > 1),
  );
  if (unsafe.length > 0) {
    throw new Error("The expected Findmypast result boundary aggregates multiple row actions; no result was expanded.");
  }
  const matches = termMatches.filter((candidate) =>
    candidate.boundaryStrength &&
    candidate.genericViewActions === 1 &&
    Number(candidate.nestedMatchingCompositeActions || 0) === 0 &&
    candidate.transcriptActions <= 1 &&
    candidate.imageActions <= 1,
  );
  if (matches.length > 1) {
    throw new Error("More than one bounded Findmypast result row matched every expected term; no result was expanded.");
  }
  if (matches.length === 0) {
    throw new Error("No bounded Findmypast result row matched every expected term; no result was expanded.");
  }
  return matches[0];
}

function selectUniqueFindmypastActionRow(candidates, expectedTerms) {
  const normalizedTerms = normalizeExpectedRowTerms(expectedTerms).map(normalizedResultText);
  const termMatches = candidates.filter((candidate) => {
    const text = normalizedResultText(candidate.text);
    return normalizedTerms.every((term) => text.includes(term));
  });
  const unsafe = termMatches.filter((candidate) => candidate.boundaryStrength &&
    (candidate.transcriptActions > 1 || candidate.imageActions > 1));
  if (unsafe.length > 0) {
    throw new Error("The expected Findmypast semantic result row aggregates multiple row actions; no result action was selected.");
  }
  const matches = termMatches.filter((candidate) => candidate.boundaryStrength &&
    candidate.transcriptActions <= 1 && candidate.imageActions <= 1 &&
    candidate.transcriptActions + candidate.imageActions > 0);
  if (matches.length > 1) {
    throw new Error("More than one semantic Findmypast result row matched every expected term; no result action was selected.");
  }
  if (matches.length === 0) {
    throw new Error("No semantic Findmypast result row matched every expected term; no result action was selected.");
  }
  return matches[0];
}

function selectUniqueFindmypastActionRowByRecordId(candidates, expectedTerms, expectedRecordId) {
  const normalizedTerms = normalizeExpectedRowTerms(expectedTerms).map(normalizedResultText);
  const normalizedRecordId = normalizeFindmypastRecordId(expectedRecordId);
  const termMatches = candidates.filter((candidate) => {
    const text = normalizedResultText(candidate.text);
    return normalizedTerms.every((term) => text.includes(term));
  });
  const unsafe = termMatches.filter((candidate) => candidate.boundaryStrength &&
    (candidate.transcriptActions > 1 || candidate.imageActions > 1));
  if (unsafe.length > 0) {
    throw new Error("The expected Findmypast semantic result row aggregates multiple row actions; no record-ID action was selected.");
  }
  const matches = termMatches.filter((candidate) => candidate.boundaryStrength === "semantic-table-row" &&
    candidate.transcriptActions === 1 && candidate.imageActions <= 1 &&
    (candidate.transcriptRecordIds || []).map(normalizedResultText).includes(normalizedRecordId));
  if (matches.length > 1) {
    throw new Error("More than one semantic Findmypast result row carries the exact expected record ID; no action was selected.");
  }
  if (matches.length === 0) {
    throw new Error("No semantic Findmypast result row carries the exact expected record ID; no action was selected.");
  }
  return matches[0];
}

function selectUniqueFindmypastBrowseRow(candidates, expectedTerms) {
  const normalizedTerms = normalizeExpectedRowTerms(expectedTerms).map(normalizedResultText);
  const termMatches = candidates.filter((candidate) => {
    const text = normalizedResultText(candidate.text);
    return normalizedTerms.every((term) => text.includes(term));
  });
  if (termMatches.some((candidate) => candidate.imageActions !== 1)) {
    throw new Error("The expected Findmypast browse boundary aggregates multiple image actions; no image was opened.");
  }
  const matches = termMatches.filter((candidate) =>
    candidate.boundaryStrength === "semantic-table-row" && candidate.imageActions === 1,
  );
  if (matches.length > 1) {
    throw new Error("More than one Findmypast browse row matched every expected term; no image was opened.");
  }
  if (matches.length === 0) {
    throw new Error("No Findmypast browse row matched every expected term; no image was opened.");
  }
  return matches[0];
}

function assertSafeFindmypastActionBoundary(boundary) {
  if (!boundary || boundary.compositeActions !== 1 || boundary.genericViewActions !== 1 ||
      boundary.transcriptActions > 1 || boundary.imageActions > 1 ||
      boundary.transcriptActions + boundary.imageActions === 0) {
    throw new Error("The expected Findmypast result boundary aggregates multiple row actions; no result action was selected.");
  }
  return boundary;
}

function findmypastResultAccessPlan(verification) {
  if (verification?.control) return "visible";
  if (verification?.unsafeBoundary) return "unsafe";
  if (Number(verification?.matchCount || 0) > 1) return "ambiguous";
  return "collapsed";
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function parseArgs(argv) {
  const options = {
    mode: "status",
    provider: "any",
    resultIndex: 1,
    affinitySlot: "default",
    part: 1,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      options[key] = true;
    } else {
      options[key] = value;
      index += 1;
    }
  }
  options.resultIndex = Number(options.resultIndex);
  options.part = Number(options.part);
  if (!Number.isInteger(options.resultIndex) || options.resultIndex < 1 || options.resultIndex > 50) {
    throw new Error("--result-index must be an integer from 1 through 50.");
  }
  if (!Number.isInteger(options.part) || options.part < 1 || options.part > 20) {
    throw new Error("--part must be an integer from 1 through 20.");
  }
  if (!SLOT_PATTERN.test(options.affinitySlot)) {
    throw new Error("--affinity-slot must be a stable lowercase letter/digit/hyphen identifier up to 32 characters.");
  }
  if (options.expectedRowTerms !== undefined) {
    options.expectedRowTerms = normalizeExpectedRowTerms(options.expectedRowTerms);
  }
  if (options.expectedRecordId !== undefined) {
    options.expectedRecordId = String(options.expectedRecordId).trim();
    normalizeFindmypastRecordId(options.expectedRecordId);
  }
  return options;
}

function providerForUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("The requested subscription URL is invalid.");
  }
  if (parsed.protocol !== "https:" || !ALLOWED_HOST.test(parsed.hostname)) {
    throw new Error("Only HTTPS Ancestry and Findmypast URLs are permitted.");
  }
  return parsed.hostname.toLowerCase().includes("ancestry.") ? "ancestry" : "findmypast";
}

function assertProviderUrl(rawUrl, expectedProvider = "any") {
  const provider = providerForUrl(rawUrl);
  if (expectedProvider !== "any" && provider !== expectedProvider) {
    throw new Error("The requested provider does not match the allowlisted URL host.");
  }
  return provider;
}

function urlFingerprint(rawUrl) {
  const parsed = new URL(rawUrl);
  parsed.hash = "";
  const ignored = /^(?:utm_|searchId$|source$|ssrc$|o_xid$|o_lid$|o_sch$|usePUBJs$)/i;
  const entries = [...parsed.searchParams.entries()]
    .filter(([key]) => !ignored.test(key))
    .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
      `${leftKey}\0${leftValue}`.localeCompare(`${rightKey}\0${rightValue}`),
    );
  parsed.search = "";
  for (const [key, value] of entries) parsed.searchParams.append(key, value);
  const canonical = `${parsed.protocol}//${parsed.hostname.replace(/^www\./i, "").toLowerCase()}${parsed.pathname}${parsed.search}`;
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

function affinityPath(slot) {
  const suffix = slot === "default" ? "" : `-${slot}`;
  return path.join(os.tmpdir(), `${AFFINITY_PREFIX}${suffix}.json`);
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function writeJsonAtomic(filePath, value) {
  const temporary = `${filePath}.${process.pid}.partial`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, filePath);
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function acquireLock(timeoutMilliseconds = 180_000) {
  const deadline = Date.now() + timeoutMilliseconds;
  const token = crypto.randomUUID();
  while (Date.now() < deadline) {
    try {
      fs.mkdirSync(LOCK_PATH, { mode: 0o700 });
      writeJsonAtomic(path.join(LOCK_PATH, "owner.json"), {
        schemaVersion: 1,
        pid: process.pid,
        token,
        acquiredAt: new Date().toISOString(),
      });
      return () => {
        const owner = readJson(path.join(LOCK_PATH, "owner.json"));
        if (owner?.pid === process.pid && owner?.token === token) {
          fs.rmSync(LOCK_PATH, { recursive: true, force: true });
        }
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const owner = readJson(path.join(LOCK_PATH, "owner.json"));
      const acquiredAt = Date.parse(owner?.acquiredAt || "");
      let lockAge = 0;
      try { lockAge = Date.now() - fs.statSync(LOCK_PATH).mtimeMs; } catch {}
      const ownerMetadataComplete = Number.isInteger(owner?.pid) && typeof owner?.token === "string";
      const stale = ownerMetadataComplete
        ? !processExists(owner.pid) && (Number.isFinite(acquiredAt) ? Date.now() - acquiredAt > 5_000 : lockAge > 5_000)
        : lockAge > 5_000;
      if (stale) {
        const quarantine = `${LOCK_PATH}.stale-${token}-${crypto.randomUUID()}`;
        try {
          fs.renameSync(LOCK_PATH, quarantine);
        } catch (renameError) {
          if (!["ENOENT", "EEXIST", "EPERM"].includes(renameError?.code)) throw renameError;
          await sleep(25);
          continue;
        }
        fs.rmSync(quarantine, { recursive: true, force: true });
        continue;
      }
      await sleep(250);
    }
  }
  throw new Error("The shared background subscription browser is busy in another session; retry after that transaction finishes.");
}

function runPowerShell(scriptName, argumentsList = [], { capture = false } = {}) {
  const scriptPath = path.join(PROJECT_ROOT, "tools", scriptName);
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, ...argumentsList],
    {
      cwd: os.tmpdir(),
      encoding: "utf8",
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = capture ? String(result.stderr || result.stdout || "").trim() : "";
    throw new Error(detail || `${scriptName} failed with exit code ${result.status}.`);
  }
  return capture ? String(result.stdout || "") : "";
}

async function endpointReady() {
  try {
    const response = await fetch(`${ENDPOINT}/json/version`, { signal: AbortSignal.timeout(2_000) });
    if (!response.ok) return false;
    const version = await response.json();
    return /^ws:\/\/(?:127\.0\.0\.1|localhost):9226\//.test(String(version.webSocketDebuggerUrl || ""));
  } catch {
    return false;
  }
}

async function bridgeHealth() {
  try {
    const response = await fetch("http://127.0.0.1:8931/health", { signal: AbortSignal.timeout(2_000) });
    return await response.json();
  } catch {
    return null;
  }
}

async function ensureBrowserStarted() {
  if (!await endpointReady()) {
    const health = await bridgeHealth();
    if (health?.browser?.status === "unhealthy") {
      const detail = String(health.browser.lastError || "Chrome CDP health check failed").slice(0, 300);
      const deadline = health.browser.restartDeadline ? `; protected restart deadline ${health.browser.restartDeadline}` : "";
      throw new Error(`Shared Browser Bridge is unhealthy: ${detail}${deadline}. Existing protected leases were left untouched.`);
    }
    runPowerShell("shared-browser-command-windows.ps1", ["-Mode", "start"]);
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (await endpointReady()) break;
      await sleep(250);
    }
  }
  if (!await endpointReady()) {
    throw new Error("The dedicated Windows Chrome profile did not expose its localhost debugging endpoint.");
  }
  runPowerShell("shared-browser-command-windows.ps1", ["-Mode", "health"], { capture: true });
}

async function stopDedicatedBrowser() {
  await ensureBrowserStarted();
  const connection = await connectSharedBrowser({
    chromium,
    endpoint: ENDPOINT,
    taskLabel: "subscription-provider-stop",
    namespace: "family-history",
    lifetime: "persistent",
    affinitySlot: "subscription-providers",
    provider: "Subscriptions"
  });
  const { browser, context } = connection;
  try {
    const leasedTargets = new Set(connection.lease?.descendants || []);
    const recordedTargets = new Set(readSubscriptionAffinityRecords().map((record) => record.targetId).filter(Boolean));
    const inventory = await pageInventory(context);
    const owned = inventory.filter(({ page, targetInfo }) => {
      if (leasedTargets.has(targetInfo.targetId)) return true;
      if (!recordedTargets.has(targetInfo.targetId)) return false;
      try { return Boolean(providerForUrl(page.url())); } catch { return false; }
    });
    if (owned.length >= context.pages().filter((page) => !page.isClosed()).length)
      await context.newPage();
    await Promise.all(owned.map(({ page }) => page.close({ runBeforeUnload: false }).catch(() => {})));
    for (const { targetInfo } of owned) await connection.forgetTarget(targetInfo.targetId).catch(() => {});
    clearSubscriptionAffinityRecords();
    console.log(`Closed ${owned.length} Ancestry/Findmypast task tab(s) without stopping shared Chrome.`);
  } finally {
    await connection.closeClient({ leaseAction: "release" }).catch(() => {});
  }
}

function readSubscriptionAffinityRecords() {
  return fs.readdirSync(os.tmpdir())
    .filter((entry) => entry.startsWith(AFFINITY_PREFIX) && entry.endsWith(".json"))
    .map((entry) => ({ path: path.join(os.tmpdir(), entry), ...readJson(path.join(os.tmpdir(), entry)) }));
}

function clearSubscriptionAffinityRecords() {
  for (const record of readSubscriptionAffinityRecords()) fs.rmSync(record.path, { force: true });
}

async function targetIdentity(context, page) {
  const session = await context.newCDPSession(page);
  try {
    const { targetInfo } = await session.send("Target.getTargetInfo");
    return targetInfo;
  } finally {
    await session.detach().catch(() => {});
  }
}

async function pageInventory(context, pages = context.pages()) {
  const inventory = [];
  for (const page of pages) {
    if (page.isClosed()) continue;
    const targetInfo = await targetIdentity(context, page);
    inventory.push({ page, targetInfo });
  }
  return inventory;
}

async function ownedPageInventory(connection, context) {
  return await pageInventory(context, connection.ownedPages());
}

async function windowForTarget(browserSession, targetId) {
  try {
    const result = await browserSession.send("Browser.getWindowForTarget", { targetId });
    const windowId = Number(result.windowId);
    return Number.isFinite(windowId) ? windowId : null;
  } catch (error) {
    if (/window not found/i.test(String(error?.message || error))) return null;
    throw error;
  }
}

async function sharedWindowState(context, browserSession) {
  const inventory = await pageInventory(context);
  const windowIds = new Set();
  for (const { targetInfo } of inventory) {
    const windowId = await windowForTarget(browserSession, targetInfo.targetId);
    if (windowId !== null) windowIds.add(windowId);
  }
  if (!windowIds.size) {
    throw new Error("The dedicated subscription profile exposed no window-backed page target; no background action was taken.");
  }
  const windowId = windowIds.size === 1 ? [...windowIds][0] : null;
  return { inventory, windowId, windowIds: [...windowIds].sort((left, right) => left - right) };
}

async function ownedWindowState(connection, context, browserSession, { allowEmpty = false } = {}) {
  const pages = connection.ownedPages();
  if (allowEmpty && pages.length === 0) return { inventory: [], windowId: null, windowIds: [] };
  const inventory = await pageInventory(context, pages);
  const windowIds = new Set();
  for (const { targetInfo } of inventory) {
    const windowId = await windowForTarget(browserSession, targetInfo.targetId);
    if (windowId !== null) windowIds.add(windowId);
  }
  if (!windowIds.size) {
    throw new Error("The subscription lease exposed no window-backed page target; no background action was taken.");
  }
  return {
    inventory,
    windowId: windowIds.size === 1 ? [...windowIds][0] : null,
    windowIds: [...windowIds].sort((left, right) => left - right),
  };
}

async function closeExactBlankPages(context, keepTargetId = "", pages = context.pages()) {
  const closedTargetIds = [];
  for (const { page, targetInfo } of await pageInventory(context, pages)) {
    if (targetInfo.targetId === keepTargetId) continue;
    if (page.url() === "about:blank" || page.url().startsWith("chrome://newtab")) {
      await page.close({ runBeforeUnload: false }).catch(() => {});
      if (!await findPageByTargetId(context, targetInfo.targetId)) closedTargetIds.push(targetInfo.targetId);
    }
  }
  return closedTargetIds;
}

async function findPageByTargetId(context, targetId) {
  if (!targetId) return null;
  for (const item of await pageInventory(context)) {
    if (item.targetInfo.targetId === targetId) return item;
  }
  return null;
}

async function closeTargetVerified(context, browserSession, targetId) {
  const found = await findPageByTargetId(context, targetId);
  if (!found) return false;
  await found.page.close({ runBeforeUnload: false }).catch(() => {});
  if (await findPageByTargetId(context, targetId)) {
    await browserSession.send("Target.closeTarget", { targetId }).catch(() => {});
  }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!await findPageByTargetId(context, targetId)) return true;
    await sleep(100);
  }
  throw new Error(`Chrome did not close the exact controlled target ${targetId}; its affinity record was retained.`);
}

async function waitForTargetPage(context, targetId, timeoutMilliseconds = 20_000) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    const found = await findPageByTargetId(context, targetId);
    if (found) return found;
    await sleep(100);
  }
  return null;
}

async function verifyPageWindow(browserSession, targetId, expectedWindowId) {
  const windowId = await windowForTarget(browserSession, targetId);
  if (windowId === null) {
    throw new Error("The controlled bridge-affinity target is not backed by a Chrome window.");
  }
  if (expectedWindowId !== null && windowId !== expectedWindowId) {
    throw new Error("The controlled tab moved away from its recorded bridge-affinity window.");
  }
  return windowId;
}

async function createBackgroundPage(connection, context, browserSession, rawUrl, expectedWindowId, { root = false } = {}) {
  const { targetId } = await createBackgroundTarget(browserSession, rawUrl);
  let created;
  try {
    created = await waitForTargetPage(context, targetId);
    if (!created) throw new Error("Chrome created no observable background tab for the requested target.");
    const identity = await connection.adoptPage(created.page, { root });
    if (identity.targetId !== targetId || !Number.isFinite(identity.windowId)) {
      throw new Error("The bridge could not bind the subscription task tab to its exact window-backed target.");
    }
    const windowId = await verifyPageWindow(browserSession, targetId, expectedWindowId);
    return { ...created, windowId };
  } catch (error) {
    await browserSession.send("Target.closeTarget", { targetId }).catch(() => {});
    await connection.forgetTarget(targetId).catch(() => {});
    throw error;
  }
}

function isExactProviderHome(rawUrl, provider) {
  try {
    const parsed = new URL(rawUrl);
    return providerForUrl(rawUrl) === provider && parsed.pathname === "/" && !parsed.search && !parsed.hash;
  } catch {
    return false;
  }
}

async function setupProviderTabs(connection, context, browserSession, { interactive = false } = {}) {
  let shared = await ownedWindowState(connection, context, browserSession, { allowEmpty: true });
  for (const provider of ["ancestry", "findmypast"]) {
    const homes = shared.inventory.filter(({ page }) => isExactProviderHome(page.url(), provider));
    for (const duplicate of homes.slice(1)) {
      await closeTargetVerified(context, browserSession, duplicate.targetInfo.targetId);
      await connection.forgetTarget(duplicate.targetInfo.targetId).catch(() => {});
    }
  }
  shared = await ownedWindowState(connection, context, browserSession, { allowEmpty: true });
  for (const [provider, rawUrl] of [
    ["ancestry", "https://www.ancestry.com/"],
    ["findmypast", "https://www.findmypast.com/"],
  ]) {
    const present = shared.inventory.some(({ page }) => {
      try { return providerForUrl(page.url()) === provider; } catch { return false; }
    });
    if (!present) {
      const created = await createBackgroundPage(
        connection,
        context,
        browserSession,
        rawUrl,
        null,
        { root: shared.inventory.length === 0 },
      );
      await waitForProviderPage(created.page, provider);
      shared = await ownedWindowState(connection, context, browserSession);
    }
  }
  shared = await ownedWindowState(connection, context, browserSession);
  if (interactive) {
    const ancestry = shared.inventory.find(({ page }) => {
      try { return providerForUrl(page.url()) === "ancestry"; } catch { return false; }
    });
    if (!ancestry) throw new Error("Chrome exposed no Ancestry provider tab for interactive sign-in.");
    const ancestryWindowId = await windowForTarget(browserSession, ancestry.targetInfo.targetId);
    if (ancestryWindowId === null) throw new Error("The Ancestry sign-in tab has no window-backed bridge target.");
    await browserSession.send("Browser.setWindowBounds", {
      windowId: ancestryWindowId,
      bounds: { windowState: "normal" },
    });
    await ancestry.page.bringToFront();
  }
  const finalState = await ownedWindowState(connection, context, browserSession);
  const providerPages = finalState.inventory.filter(({ page }) => {
    try { return Boolean(providerForUrl(page.url())); } catch { return false; }
  });
  console.log(`The verified shared Chrome profile is ready; windows=${finalState.windowIds.length}; provider-tabs=${providerPages.length}.`);
}

async function waitForProviderPage(page, provider, timeoutMilliseconds = 30_000) {
  await page.waitForLoadState("domcontentloaded", { timeout: timeoutMilliseconds }).catch(() => {});
  const deadline = Date.now() + timeoutMilliseconds;
  let stableUrl = "";
  let stableSamples = 0;
  while (Date.now() < deadline) {
    const currentUrl = page.url();
    try {
      assertProviderUrl(currentUrl, provider);
      if (currentUrl === stableUrl) stableSamples += 1;
      else {
        stableUrl = currentUrl;
        stableSamples = 1;
      }
      if (stableSamples >= 4) return currentUrl;
    } catch {
      stableUrl = "";
      stableSamples = 0;
    }
    await sleep(250);
  }
  throw new Error("The controlled background tab did not settle on the requested provider.");
}

function affinityRecord(options, provider, targetId, windowId, requestedUrl, activeUrl) {
  return {
    schemaVersion: 1,
    backend: "windows-chrome-cdp",
    affinitySlot: options.affinitySlot,
    provider,
    targetId,
    windowId,
    requestedUrlFingerprint: urlFingerprint(requestedUrl),
    activeUrlFingerprint: urlFingerprint(activeUrl),
    updatedAt: new Date().toISOString(),
  };
}

function assertAffinityLocationRequest(saved, options) {
  if (!saved || saved.schemaVersion !== 1 || saved.backend !== "windows-chrome-cdp" ||
      saved.affinitySlot !== options.affinitySlot || !saved.targetId || saved.targetId !== options.targetId ||
      !Number.isInteger(saved.windowId) || !options.url ||
      urlFingerprint(options.url) !== saved.requestedUrlFingerprint ||
      assertProviderUrl(options.url, options.provider) !== saved.provider) {
    throw new Error("Location inspection requires the exact saved task target and original request.");
  }
}

async function getAffinityPage(connection, context, browserSession, options, expectedProvider = "any") {
  const saved = readJson(affinityPath(options.affinitySlot));
  if (!saved || saved.schemaVersion !== 1 || saved.backend !== "windows-chrome-cdp" ||
      saved.affinitySlot !== options.affinitySlot || !saved.targetId || !Number.isInteger(saved.windowId) ||
      !saved.activeUrlFingerprint ||
      (expectedProvider !== "any" && saved.provider !== expectedProvider)) {
    return null;
  }
  const found = await findPageByTargetId(context, saved.targetId);
  if (!found) return null;
  const windowId = await windowForTarget(browserSession, saved.targetId);
  if (windowId !== saved.windowId) return null;
  const identity = await connection.adoptPage(found.page, { root: true });
  if (identity.targetId !== saved.targetId || identity.windowId !== saved.windowId) {
    throw new Error("The bridge returned a mismatched identity for the recorded subscription affinity tab.");
  }
  try {
    assertProviderUrl(found.page.url(), saved.provider);
    if (urlFingerprint(found.page.url()) !== saved.activeUrlFingerprint) return null;
  } catch {
    return null;
  }
  return { ...found, windowId, saved };
}

async function openInAffinity(context, browserSession, options, rawUrl) {
  const provider = assertProviderUrl(rawUrl, options.provider);
  const connection = options.connection;
  if (!connection) throw new Error("The subscription action has no Shared Browser Bridge lease.");
  let controlled = await getAffinityPage(connection, context, browserSession, options, "any");
  if (controlled) {
    await controlled.page.goto(rawUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  } else {
    controlled = await createBackgroundPage(connection, context, browserSession, rawUrl, null, { root: true });
    options.transactionTargetIds?.add(controlled.targetInfo.targetId);
    writeJsonAtomic(
      affinityPath(options.affinitySlot),
      affinityRecord(options, provider, controlled.targetInfo.targetId, controlled.windowId, rawUrl, rawUrl),
    );
  }
  const activeUrl = await waitForProviderPage(controlled.page, provider);
  const identity = await targetIdentity(context, controlled.page);
  const windowId = await verifyPageWindow(browserSession, identity.targetId, controlled.windowId);
  writeJsonAtomic(
    affinityPath(options.affinitySlot),
    affinityRecord(options, provider, identity.targetId, windowId, rawUrl, activeUrl),
  );
  return { page: controlled.page, targetId: identity.targetId, windowId, provider, activeUrl };
}

async function requireAffinityPage(context, browserSession, options) {
  if (!options.connection) throw new Error("The subscription action has no Shared Browser Bridge lease.");
  const controlled = await getAffinityPage(options.connection, context, browserSession, options, options.provider);
  if (!controlled) {
    throw new Error("No valid background subscription tab is recorded for this affinity slot; run open first.");
  }
  if (options.url) {
    assertProviderUrl(options.url, controlled.saved.provider);
    const requestedFingerprint = urlFingerprint(options.url);
    const sameBoundAncestryViewer = controlled.saved.provider === "ancestry" &&
      ancestryViewerMatchesTarget(controlled.page.url(), options.url);
    if (requestedFingerprint !== controlled.saved.requestedUrlFingerprint &&
      requestedFingerprint !== controlled.saved.activeUrlFingerprint &&
      !sameBoundAncestryViewer) {
      throw new Error("The requested action URL does not match the exact background task tab affinity.");
    }
  }
  return {
    ...controlled,
    provider: controlled.saved.provider,
    activeUrl: controlled.page.url(),
  };
}

async function visibleMatches(locator, maximum = 100) {
  const matches = [];
  const count = Math.min(await locator.count(), maximum);
  for (let index = 0; index < count; index += 1) {
    const candidate = locator.nth(index);
    if (await candidate.isVisible().catch(() => false)) matches.push(candidate);
  }
  return matches;
}

async function namedLocator(root, names, resultIndex = 1, roles = ["button", "link"], {
  timeoutMilliseconds = 15_000,
  unique = false,
} = {}) {
  const deadline = Date.now() + timeoutMilliseconds;
  let ambiguous = false;
  do {
    let currentAmbiguity = false;
    for (const name of names) {
      let locator = null;
      for (const role of roles) {
        const roleLocator = root.getByRole(role, { name, exact: typeof name === "string" });
        locator = locator ? locator.or(roleLocator) : roleLocator;
      }
      const visible = await visibleMatches(locator);
      if (unique && visible.length > 1) {
        ambiguous = true;
        currentAmbiguity = true;
        break;
      }
      if (visible.length >= resultIndex) return visible[resultIndex - 1];
    }
    if (currentAmbiguity) {
      await sleep(100);
      continue;
    }
    await sleep(100);
  } while (Date.now() < deadline);
  if (unique && ambiguous) {
    throw new Error("The provider exposed more than one visible control with the requested accessible name.");
  }
  return null;
}

async function providerHref(locator, provider, baseUrl) {
  const href = await locator.getAttribute("href").catch(() => null);
  if (!href || /^\s*(?:#|javascript:|about:blank(?:#|$))/i.test(href)) return null;
  const absolute = new URL(href, baseUrl).href;
  assertProviderUrl(absolute, provider);
  if (urlFingerprint(absolute) === urlFingerprint(baseUrl) && new URL(absolute).hash) return null;
  return absolute;
}

async function installPopupInterception(locator) {
  await locator.evaluate((element) => {
    const anchor = element.closest("a");
    const form = element.closest("form");
    window.__familyHistoryPopupInterception = {
      originalOpen: window.open,
      anchor,
      anchorTarget: anchor?.getAttribute("target") ?? null,
      form,
      formTarget: form?.getAttribute("target") ?? null,
    };
    if (anchor) anchor.setAttribute("target", "_self");
    if (form) form.setAttribute("target", "_self");
    window.open = (url) => {
      if (typeof url === "string" && url.trim() && url !== "about:blank") {
        window.location.assign(url);
      }
      return window;
    };
  });
}

async function restorePopupInterception(page) {
  await page.evaluate(() => {
    const state = window.__familyHistoryPopupInterception;
    if (!state) return;
    window.open = state.originalOpen;
    if (state.anchor?.isConnected) {
      if (state.anchorTarget === null) state.anchor.removeAttribute("target");
      else state.anchor.setAttribute("target", state.anchorTarget);
    }
    if (state.form?.isConnected) {
      if (state.formTarget === null) state.form.removeAttribute("target");
      else state.form.setAttribute("target", state.formTarget);
    }
    delete window.__familyHistoryPopupInterception;
  }).catch(() => {});
}

async function assertActionPostcondition(page, provider, previousUrlFingerprint, postcondition) {
  const activeUrl = await waitForProviderPage(page, provider);
  if (postcondition) {
    if (!await postcondition(page, activeUrl)) {
      throw new Error("The provider action did not reach its required bound record/viewer state.");
    }
  } else if (urlFingerprint(activeUrl) === previousUrlFingerprint) {
    throw new Error("The provider action left the controlled tab on the same route and exposed no stronger success proof.");
  }
  return activeUrl;
}

async function clickWithoutPopupWindow(
  context,
  browserSession,
  page,
  locator,
  provider,
  expectedWindowId,
  { postcondition = null, followDirectHref = true, connection = null, activate = null } = {},
) {
  const previousUrlFingerprint = urlFingerprint(page.url());
  const directHref = await providerHref(locator, provider, page.url());
  if (directHref && followDirectHref) {
    await page.goto(directHref, { waitUntil: "domcontentloaded", timeout: 30_000 });
    return assertActionPostcondition(page, provider, previousUrlFingerprint, postcondition);
  }

  await installPopupInterception(locator);
  let popup = null;
  try {
    const popupPromise = page.waitForEvent("popup", { timeout: 2_000 }).catch(() => null);
    if (activate) await activate(locator);
    else await locator.click({ timeout: 15_000 });
    popup = await popupPromise;
  } finally {
    await restorePopupInterception(page);
  }
  if (popup && !popup.isClosed()) {
    if (!connection) throw new Error("The provider opened a popup but the action has no Shared Browser Bridge lease.");
    const popupIdentity = await connection.adoptPage(popup);
    await popup.close({ runBeforeUnload: false }).catch(() => {});
    await connection.forgetTarget(popupIdentity.targetId).catch(() => {});
    throw new Error("The provider bypassed same-tab popup interception; its exact lease-owned popup was closed and this action requires manual review.");
  }
  const identity = await targetIdentity(context, page);
  await verifyPageWindow(browserSession, identity.targetId, expectedWindowId);
  return assertActionPostcondition(page, provider, previousUrlFingerprint, postcondition);
}

async function updateAffinityAfterAction(context, browserSession, options, controlled, requestedUrl = null) {
  const activeUrl = await waitForProviderPage(controlled.page, controlled.provider);
  const identity = await targetIdentity(context, controlled.page);
  const windowId = await verifyPageWindow(browserSession, identity.targetId, controlled.windowId);
  writeJsonAtomic(
    affinityPath(options.affinitySlot),
    affinityRecord(options, controlled.provider, identity.targetId, windowId, requestedUrl || activeUrl, activeUrl),
  );
  return activeUrl;
}

async function closeAffinityTarget(context, browserSession, options) {
  const saved = readJson(affinityPath(options.affinitySlot));
  let closed = false;
  if (saved?.schemaVersion === 1 && saved.backend === "windows-chrome-cdp" &&
      saved.affinitySlot === options.affinitySlot && saved.targetId) {
    const found = await findPageByTargetId(context, saved.targetId);
    if (found) {
      const provider = providerForUrl(found.page.url());
      if (provider !== saved.provider) {
        throw new Error("The recorded affinity target no longer belongs to its saved provider; refusing to close it.");
      }
      const identity = await options.connection.adoptPage(found.page, { root: true });
      if (identity.targetId !== saved.targetId || identity.windowId !== saved.windowId) {
        throw new Error("The bridge returned a mismatched identity for the affinity target; refusing to close it.");
      }
      closed = await closeTargetVerified(context, browserSession, saved.targetId);
      await options.connection.forgetTarget(saved.targetId).catch(() => {});
    }
  }
  fs.rmSync(affinityPath(options.affinitySlot), { force: true });
  return closed;
}

function summarizeUrl(rawUrl) {
  const parsed = new URL(rawUrl);
  return `${parsed.protocol}//${parsed.hostname}${parsed.pathname}`;
}

function assertAncestryCollectionRoot(url, expectedUrl = url) {
  const route = new URL(url);
  if (route.protocol !== "https:" || !/^(?:www\.|search\.)?ancestry\.(?:com|co\.uk)$/i.test(route.hostname) ||
      !/^\/search\/collections\/\d+\/?$/.test(route.pathname) || route.search || route.hash || route.username || route.password || route.port ||
      route.href.replace(/\/$/, "") !== new URL(expectedUrl).href.replace(/\/$/, "")) {
    throw new Error("Collection inspection requires an exact Ancestry collection root without query parameters.");
  }
}

// Browse-by-volume selection is limited to reviewed image-only collections:
// 2972 (Staffordshire parish registers) and 8802 (Pennsylvania, U.S., Wills
// and Probate Records, 1683-1993; county will books such as Philadelphia).
const ANCESTRY_BROWSE_COLLECTIONS = Object.freeze(["2972", "8802"]);

function assertAncestryBrowseRoute(rawUrl) {
  const route = new URL(rawUrl);
  const match = /^\/search\/collections\/(\d+)\/?$/.exec(route.pathname);
  if (route.protocol !== "https:" || route.hostname !== "www.ancestry.com" || route.username || route.password
    || !match || !ANCESTRY_BROWSE_COLLECTIONS.includes(match[1])) {
    throw new Error(`select-ancestry-browse is restricted to Ancestry collections ${ANCESTRY_BROWSE_COLLECTIONS.join(", ")}.`);
  }
  return match[1];
}

// A browse label selects the one option containing it; when several do
// (e.g. "Philadelphia" and "Bucks, Chester, Philadelphia"), exactly one option
// whose whole text equals the label still identifies the choice.
function pickAncestryBrowseOption(matches, expected) {
  if (matches.length === 1) return matches[0];
  const normalized = String(expected).normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase();
  const exact = matches.filter((option) => option.text.toLocaleLowerCase() === normalized);
  if (exact.length === 1) return exact[0];
  throw new Error(`Ancestry browse label must match exactly one option; ${JSON.stringify(expected)} matched ${matches.length}.`);
}

function assertAncestryHistoricalSearchRoute(rawUrl) {
  const route = new URL(rawUrl);
  assertProviderUrl(rawUrl, "ancestry");
  if (!/^\/search\/collections\/62609\/?$/.test(route.pathname) || !route.search || route.hash || route.port || route.username || route.password) {
    throw new Error("Search state inspection requires the exact Ancestry 62609 query route.");
  }
}

// Read only known historical search controls, never arbitrary form values.
function inspectAncestryHistoricalSearchDom() {
  const visible = (node) => {
    const style = getComputedStyle(node);
    return style.display !== "none" && !["hidden", "collapse"].includes(style.visibility) && Number(style.opacity) !== 0 &&
      [...node.getClientRects()].some((rect) => rect.width > 0 && rect.height > 0);
  };
  const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
  if (document.querySelector('input[type="password"],input[autocomplete="username"],input[autocomplete="cc-number"]')) {
    throw new Error("Historical search inspection stopped at a sensitive form.");
  }
  if ([...document.querySelectorAll('iframe[src*="captcha" i],iframe[src*="challenge" i],[id*="captcha" i],[id*="challenge" i],[class*="captcha" i],[class*="challenge" i],[role="alert"],[role="dialog"]')]
    .some((node) => visible(node) && (node.tagName === "IFRAME" || /captcha|challenge|verify (?:you|your)|verification/i.test(`${node.id} ${node.className} ${node.textContent || ""}`)))) {
    throw new Error("Historical search inspection stopped at a visible challenge.");
  }
  const definitions = [
    ["sfs_FirstNameExactModule", /^(?:First (?:&|and) Middle Name\(s\)|First Name)$/i],
    ["sfsLastNameExactModule", /^Last Name$/i],
    ["sfs_SelfYear", /^(?:Any )?Event Year$/i],
    ["sfs__SelfPlace", /^(?:Any )?Event (?:Place|Location)$/i],
    ["sfs__RecordType", /^(?:Record Type)?$/i],
  ];
  const excluded = (node) => node.closest('nav,header,footer,aside,[id*="account" i],[class*="account" i],[id*="profile" i],[class*="profile" i]');
  const controls = definitions.map(([id, expectedLabel]) => {
    const matches = [...document.querySelectorAll(`[id="${id}"]`)];
    if (!matches.length) return { id, state: "missing" };
    if (matches.length !== 1) throw new Error("Historical search control is ambiguous.");
    const node = matches[0];
    const label = clean(node.getAttribute("aria-label") || [...(node.labels || [])].map((item) => item.textContent).join(" "));
    if (node.tagName !== "INPUT" || node.type !== "text" || excluded(node) || !expectedLabel.test(label)) {
      throw new Error("Historical search control has an unexpected boundary or label.");
    }
    if (!visible(node)) return { id, state: "hidden", label };
    const value = clean(node.value);
    return { id, state: "visible", label, value: value.slice(0, 160), truncated: value.length > 160 };
  });
  const headings = [...document.querySelectorAll('main h1,main h2,main [role="status"],main .noResults,main .searchResultsHeader')]
    .filter((node) => visible(node) && !excluded(node))
    .map((node) => clean(node.textContent)).filter(Boolean);
  return { controls, headings: headings.slice(0, 20).map((text) => text.slice(0, 500)), headingsTruncated: headings.length > 20 || headings.some((text) => text.length > 500), exactnessVerified: false, interactionPerformed: false };
}

function assertSameCollectionTarget(before, after) {
  const targetId = before.targetInfo?.targetId;
  if (!targetId || after.targetInfo?.targetId !== targetId) {
    throw new Error("Collection inspection lost its exact leased target.");
  }
}

async function inspectAncestryCollection(page, expectedTerms) {
  const startingUrl = page.url();
  assertAncestryCollectionRoot(startingUrl);
  const terms = normalizeExpectedRowTerms(expectedTerms);
  const result = await page.locator("main, [role='main']").first().evaluate((main) => {
    if (main.querySelector('input[type="password"], input[autocomplete="username"], input[autocomplete="cc-number"]')) {
      throw new Error("Collection inspection stopped at a sensitive form.");
    }
    const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const visible = (element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden";
    const fields = [...main.querySelectorAll("input,select")]
      .filter((element) => visible(element) && element.type !== "hidden")
      .map((element) => ({
        tag: element.tagName.toLowerCase(), type: element.type, name: element.name, id: element.id,
        label: clean(element.getAttribute("aria-label") || [...(element.labels || [])].map((label) => label.textContent).join(" ")).slice(0, 240),
      }));
    const sections = [...main.querySelectorAll("header.conHeader")].filter(visible)
      .filter((header) => /^(?:Source Information|About |Información de la fuente|Acerca de )/i.test(clean(header.textContent)))
      .map((header) => header.nextElementSibling)
      .filter((body) => body?.matches(".conBody") && visible(body));
    if (sections.length !== 2) throw new Error("The two verified collection description/source containers are unavailable.");
    const description = sections.map((section) => {
      const copy = section.cloneNode(true);
      const originalNodes = [...section.querySelectorAll("*")];
      const copiedNodes = [...copy.querySelectorAll("*")];
      originalNodes.forEach((element, index) => { if (!visible(element)) copiedNodes[index].remove(); });
      copy.querySelectorAll("form,input,select,textarea,button,nav,header,footer,aside,script,style,[role='dialog'],[role='navigation'],[contenteditable='true'],[id*='account' i],[class*='account' i],[id*='profile' i],[class*='profile' i]")
        .forEach((element) => element.remove());
      return clean(copy.textContent);
    }).join("\n");
    return {
      description: description.slice(0, 16000), descriptionTruncated: description.length > 16000,
      fieldCount: fields.length, fields: fields.slice(0, 80), fieldsTruncated: fields.length > 80,
    };
  });
  // The parish browse selector may be outside the collection's main element.
  // Read only matching static option labels, never its current selection.
  const browse = await page.locator("select:visible").evaluateAll((selects, requested) =>
    selects.flatMap((select) => [...select.options]
      .filter((option) => requested.some((term) => String(option.textContent || "").toLowerCase().includes(term.toLowerCase())))
      .map((option) => ({ selectId: select.id, selectName: select.name, text: String(option.textContent || "").replace(/\s+/g, " ").trim().slice(0, 240) }))),
  terms);
  result.matchedOptionCount = browse.length;
  result.matchedOptions = browse.slice(0, 40);
  result.matchedOptionsTruncated = browse.length > 40;
  assertAncestryCollectionRoot(page.url(), startingUrl);
  return result;
}

// Runs inside the exact leased collection page; reads static metadata only.
function inspectAncestryEventControlsDom() {
  const clean = (text) => String(text || "").replace(/\s+/g, " ").trim();
  const visible = (node) => node.getClientRects().length > 0 && getComputedStyle(node).visibility !== "hidden";
  const sensitive = 'input[type="password"],input[autocomplete="username"],input[autocomplete="cc-number"]';
  if (document.querySelector(sensitive)) throw new Error("Event control inspection stopped at a sensitive form.");
  if ([...document.querySelectorAll('iframe[src*="captcha" i],iframe[src*="challenge" i],[class*="captcha" i],[id*="captcha" i],[class*="challenge" i],[id*="challenge" i],[role="alert"],[role="dialog"]')]
    .some((node) => visible(node) && (/captcha|verify (?:you|your)|verification|verifica|challenge/i.test(`${node.id} ${node.className} ${node.textContent || ""}`) || node.tagName === "IFRAME"))) {
    throw new Error("Event control inspection stopped at a visible challenge.");
  }
  const definitions = [
    { id: "sfs_SelfYear", label: /^(?:Event Year|Acontecimiento Año)$/i },
    { id: "sfs__SelfPlace", label: /^(?:Event (?:Place|Location)|Acontecimiento Lugar)$/i },
    { id: "sfs__RecordType", label: null },
  ];
  const uniqueId = (id) => {
    if (!/^[A-Za-z0-9_:.-]{1,100}$/.test(id)) throw new Error("Unsafe associated control ID.");
    const matches = [...document.querySelectorAll(`[id="${id}"]`)];
    if (matches.length !== 1) throw new Error("Event control ID is missing or ambiguous.");
    return matches[0];
  };
  const excluded = (node) => Boolean(node.closest('[id*="account" i],[class*="account" i],[id*="profile" i],[class*="profile" i],nav,header,footer,aside'));
  const labelOf = (node) => clean(node.getAttribute("aria-label") || [...(node.labels || [])].map((label) => label.textContent).join(" "));
  const anchors = definitions.map((definition) => {
    const node = uniqueId(definition.id);
    if (node.tagName !== "INPUT" || node.type !== "text" || !visible(node) || excluded(node)) throw new Error("Expected visible historical event field is unavailable.");
    const label = labelOf(node);
    if (definition.label && !definition.label.test(label)) throw new Error("Historical event field label does not match; refusing birth/death substitution.");
    return { node, definition, label };
  });
  const optionSummary = (node) => {
    const options = [...node.querySelectorAll('option,[role="option"]')].filter((option) => !excluded(option));
    return { count: options.length, truncated: options.length > 24,
      labels: options.slice(0, 24).map((option) => ({ text: clean(option.textContent).slice(0, 160), visible: visible(option) })) };
  };
  const fields = anchors.map(({ node, definition, label }) => {
    const otherEditable = (container) => [...container.querySelectorAll('input,textarea,[contenteditable]')]
      .some((input) => input !== node && !(input.tagName === "INPUT" && ["hidden", "checkbox", "radio"].includes(input.type)));
    // Stop before any container with a different text field; never inspect the whole search form.
    let container = node.parentElement;
    if (!container || /^(?:BODY|MAIN|FORM|HTML)$/.test(container.tagName) || excluded(container) ||
        otherEditable(container)) {
      throw new Error("Event field has no safe associated container.");
    }
    for (let depth = 0; depth < 2; depth += 1) {
      const parent = container.parentElement;
      if (!parent || /^(?:BODY|MAIN|FORM|HTML)$/.test(parent.tagName) || excluded(parent) ||
          otherEditable(parent)) break;
      container = parent;
    }
    const candidates = [...container.querySelectorAll('label,button,a[role="button"],input[type="checkbox"],input[type="radio"],select,datalist,[role="listbox"]')]
      .filter((candidate) => !excluded(candidate));
    const controls = candidates.slice(0, 24).map((control) => ({
      tag: control.tagName.toLowerCase(), id: control.id, role: control.getAttribute("role") || "",
      label: (labelOf(control) || (/^(?:LABEL|BUTTON)$/.test(control.tagName) || control.getAttribute("role") === "button" ? clean(control.textContent) : "")).slice(0, 160),
      visible: visible(control),
      ...((control.tagName === "SELECT" || control.tagName === "DATALIST" || control.getAttribute("role") === "listbox") ? { options: optionSummary(control) } : {}),
    }));
    const associations = [];
    for (const attribute of ["aria-controls", "aria-describedby", "list"]) {
      const ids = clean(node.getAttribute(attribute)).split(/\s+/).filter(Boolean);
      if (ids.length > 4) throw new Error("Too many associated event-control references.");
      for (const id of ids) {
        if (!/^[A-Za-z0-9_:.-]{1,100}$/.test(id)) throw new Error("Unsafe associated control ID.");
        const matches = [...document.querySelectorAll(`[id="${id}"]`)];
        if (matches.length > 1) throw new Error("Associated event control ID is ambiguous.");
        if (!matches.length) { associations.push({ attribute, id, status: "not-rendered" }); continue; }
        const target = matches[0];
        if (excluded(target) || !container.contains(target)) {
          associations.push({ attribute, id, status: "outside-field-container-not-inspected" }); continue;
        }
        if (target.querySelector(sensitive)) throw new Error("Associated control crosses a sensitive boundary.");
        const isOptions = target.tagName === "DATALIST" || target.getAttribute("role") === "listbox";
        associations.push({ attribute, id, tag: target.tagName.toLowerCase(), role: target.getAttribute("role") || "",
          visible: visible(target), ...(isOptions ? { options: optionSummary(target) } : {}) });
      }
    }
    return { id: definition.id, type: node.type, label, containerId: container.id || "", controls,
      controlCount: candidates.length, controlsTruncated: candidates.length > 24, associations };
  });
  return { fields, interactionPerformed: false, inputValuesRead: false, appliedFiltersVerified: false,
    coverageVerified: false, limit: "Static associated-control metadata only; absent options may require a separate guarded disclosure. No search submitted." };
}

function assertYaxleyBrowseRoute(url) {
  assertAncestryCollectionRoot(url);
  if (!/^\/search\/collections\/62609\/?$/.test(new URL(url).pathname)) {
    throw new Error("Yaxley metadata inspection requires collection 62609.");
  }
}

function ancestryBrowseMetadataConfig(url, parish = "Yaxley") {
  assertAncestryCollectionRoot(url);
  const collectionId = { Yaxley: "62609", Farcet: "62609", "Hampton Lovett": "62087", Philadelphia: "8802" }[parish];
  if (!collectionId || !new RegExp(`^/search/collections/${collectionId}/?$`).test(new URL(url).pathname)) {
    throw new Error("Browse metadata requires an allowlisted exact parish and collection root.");
  }
  return { parish, collectionId };
}

// Runs inside the exact leased page; option values remain internal to Chrome.
function inspectYaxleyBrowseDom({ selectParish = false, parish = "Yaxley", collectionId = "62609", linkTerms = [] } = {}) {
  if (!((["Yaxley", "Farcet"].includes(parish) && collectionId === "62609") || (parish === "Hampton Lovett" && collectionId === "62087") || (parish === "Philadelphia" && collectionId === "8802"))) throw new Error("Unapproved browse parish/collection pair.");
  const clean = (value) => String(value || "").normalize("NFKC").replace(/\s+/g, " ").trim();
  const visible = (element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden";
  if (document.querySelector('input[type="password"],input[autocomplete="username"],input[autocomplete="cc-number"]')) {
    throw new Error("Parish metadata inspection stopped at a sensitive form.");
  }
  if ([...document.querySelectorAll('[role="dialog"],iframe[src*="captcha" i],iframe[src*="challenge" i],[id*="captcha" i]')].some(visible)) {
    throw new Error("Parish metadata inspection stopped at a visible dialog or challenge.");
  }
  const candidates = [...document.querySelectorAll('select[name="BrowseLevel"]')].filter(visible)
    .flatMap((select) => [...select.options].filter((option) => clean(option.textContent) === parish)
      .map((option) => ({ select, option })));
  if (candidates.length !== 1 || candidates[0].option.disabled || candidates[0].option.closest("optgroup")?.disabled || candidates[0].select.disabled) {
    throw new Error(`Exactly one enabled ${parish} browse option is required.`);
  }
  const { select, option } = candidates[0];
  let panel = select.parentElement;
  while (panel && !["BODY", "HTML"].includes(panel.tagName)) {
    const headings = [...panel.querySelectorAll('h1,h2,h3,h4,[role="heading"]')].filter(visible);
    if (headings.some((heading) => /^(?:Browse|Explorar|Examinar)\b/i.test(clean(heading.textContent))) &&
        !panel.querySelector('input:not([type="hidden"]),textarea,[contenteditable="true"]')) break;
    panel = panel.parentElement;
  }
  if (!panel || ["BODY", "HTML"].includes(panel.tagName)) {
    return { boundary: "browse-panel-unavailable", selected: false, ancestors: (() => {
      const rows = []; let node = select.parentElement;
      for (let i = 0; node && i < 5; i++, node = node.parentElement) rows.push({ tag: node.tagName, id: node.id, className: clean(node.className).slice(0, 160) });
      return rows;
    })() };
  }
  if (selectParish) {
    if (!select.isConnected || !option.isConnected || select.name !== "BrowseLevel" || !option.value) {
      throw new Error("The exact parish browse control became stale.");
    }
    const state = window.__familyHistoryBrowseGuard;
    if (!state) throw new Error("The Parish metadata navigation guard is missing.");
    state.beforeLabels = JSON.stringify([...panel.querySelectorAll('select[name="BrowseLevel"]')].filter((node) => node !== select).map((node) => [...node.options].map((item) => clean(item.textContent))));
    state.panel = panel;
    state.parishSelect = select;
    select.value = option.value;
    select.dispatchEvent(new Event("input", { bubbles: true }));
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return { selected: true };
  }
  const selects = [...panel.querySelectorAll('select[name="BrowseLevel"]')].filter(visible);
  const parishIndex = selects.indexOf(select);
  const dependent = selects.slice(parishIndex + 1);
  const levels = dependent.slice(0, 2).map((element, index) => {
    const labels = [...element.options].map((item) => ({ text: clean(item.textContent).slice(0, 240), disabled: item.disabled }));
    return { level: index + 1, disabled: element.disabled, optionCount: labels.length,
      options: labels.slice(0, 100), truncated: labels.length > 100 };
  });
  const copy = panel.cloneNode(true);
  const originalNodes = [...panel.querySelectorAll("*")];
  const copiedNodes = [...copy.querySelectorAll("*")];
  originalNodes.forEach((element, index) => { if (!visible(element)) copiedNodes[index].remove(); });
  copy.querySelectorAll('form,input,select,textarea,button,script,style,nav,[role="dialog"],[id*="account" i],[class*="account" i],[id*="profile" i],[class*="profile" i]').forEach((element) => element.remove());
  const text = clean(copy.textContent);
  // Optional label filter (every term must appear) narrows a large browse list, e.g. one county's will books.
  const wanted = (linkTerms || []).map((term) => clean(term).toLowerCase()).filter(Boolean);
  const links = [...panel.querySelectorAll("a[href]")].filter(visible)
    .filter((anchor) => wanted.every((term) => clean(anchor.textContent).toLowerCase().includes(term))).map((anchor) => {
    const route = new URL(anchor.href, location.href);
    // Ancestry adds presentation/tracking keys to browse links; they do not change the image route.
    route.searchParams.delete("usePUB");
    route.searchParams.delete("_phsrc");
    const allowed = route.protocol === "https:" && route.origin === location.origin &&
      new RegExp(`^/imageviewer/collections/${collectionId}(?:/|$)`).test(route.pathname) && !route.username && !route.password && !route.hash &&
      [...route.searchParams.keys()].every((key) => ["cc", "wc", "backurl", "pid"].includes(key));
    route.searchParams.delete("backurl");
    return { text: clean(anchor.textContent).slice(0, 240), ...(allowed ? { url: route.href } : { routeOmitted: true, origin: route.origin, pathname: route.pathname, queryKeys: [...route.searchParams.keys()] }) };
  });
  return { boundary: "browse-metadata-only", parish, parishSelected: select.selectedOptions.length === 1 && select.selectedOptions[0] === option,
    dependentLevelCount: dependent.length, levels, levelsTruncated: dependent.length > 2,
    browseLinkCount: links.length, browseLinks: links.slice(0, 20), browseLinksTruncated: links.length > 20,
    metadataPanel: { kind: "browse-panel", text: text.slice(0, 6000), truncated: text.length > 6000 } };
}

async function withBrowseNavigationGuard(page, action) {
  let blockedNavigationCount = 0;
  let blockedImageCount = 0;
  const handler = async (route) => {
    if (route.request().isNavigationRequest() || /\/(?:imageviewer|discoveryui-content|mediasvc)\//i.test(new URL(route.request().url()).pathname)) {
      blockedNavigationCount += 1;
      await route.abort("blockedbyclient");
    } else if (["image", "media"].includes(route.request().resourceType())) {
      blockedImageCount += 1;
      await route.abort("blockedbyclient");
    } else await route.continue();
  };
  let installed = false;
  await page.route("**/*", handler);
  try {
    await page.evaluate(() => {
      if (window.__familyHistoryBrowseGuard) throw new Error("A metadata navigation guard is already installed.");
      const state = { originalOpen: window.open, originalSubmit: HTMLFormElement.prototype.submit,
        originalRequestSubmit: HTMLFormElement.prototype.requestSubmit, originalPushState: history.pushState, originalReplaceState: history.replaceState, blockedActions: 0 };
      const block = (event) => { state.blockedActions += 1; event?.preventDefault(); event?.stopImmediatePropagation(); };
      state.block = block;
      window.__familyHistoryBrowseGuard = state;
      window.open = () => { block(); return null; };
      HTMLFormElement.prototype.submit = () => block();
      HTMLFormElement.prototype.requestSubmit = () => block();
      document.addEventListener("submit", block, true);
      history.pushState = (...args) => { if (args[2] && new URL(args[2], location.href).href !== location.href) return block(); return state.originalPushState.apply(history, args); };
      history.replaceState = (...args) => { if (args[2] && new URL(args[2], location.href).href !== location.href) return block(); return state.originalReplaceState.apply(history, args); };
    });
    installed = true;
    const result = await action();
    const blockedActions = await page.evaluate(() => window.__familyHistoryBrowseGuard?.blockedActions || 0);
    if (blockedNavigationCount || blockedActions) throw new Error("Parish metadata stopped after a blocked navigation, popup, form or history action.");
    return { ...result, blockedNavigationCount, blockedImageCount, blockedActions };
  } finally {
    try {
      if (installed) await page.evaluate(() => {
      const state = window.__familyHistoryBrowseGuard;
      if (!state) return;
      window.open = state.originalOpen;
      HTMLFormElement.prototype.submit = state.originalSubmit;
      HTMLFormElement.prototype.requestSubmit = state.originalRequestSubmit;
      history.pushState = state.originalPushState;
      history.replaceState = state.originalReplaceState;
      document.removeEventListener("submit", state.block, true);
      delete window.__familyHistoryBrowseGuard;
    });
    } finally { await page.unroute("**/*", handler); }
  }
}

async function inspectAncestryYaxleyBrowse(page, verifyTarget, inspectOnly = false, parish = "Yaxley", linkTerms = []) {
  const startingUrl = page.url();
  const config = { ...ancestryBrowseMetadataConfig(startingUrl, parish), linkTerms };
  return withBrowseNavigationGuard(page, async () => {
    await verifyTarget();
    if (inspectOnly) {
      const result = await page.evaluate(inspectYaxleyBrowseDom, config);
      if (!result.parishSelected) throw new Error("Read-only parish metadata inspection requires an existing exact parish selection.");
      assertAncestryCollectionRoot(page.url(), startingUrl);
      await verifyTarget();
      return { ...result, dependentRefresh: "not-verified-this-read", coverageVerified: false };
    }
    const selection = await page.evaluate(inspectYaxleyBrowseDom, { ...config, selectParish: true });
    if (!selection.selected) return selection;
    const refreshed = await page.waitForFunction(() => {
      const state = window.__familyHistoryBrowseGuard;
      if (!state?.panel?.isConnected) return false;
      const clean = (value) => String(value || "").normalize("NFKC").replace(/\s+/g, " ").trim();
      const labels = JSON.stringify([...state.panel.querySelectorAll('select[name="BrowseLevel"]')].filter((node) => node !== state.parishSelect).map((node) => [...node.options].map((item) => clean(item.textContent))));
      if (labels === state.beforeLabels || state.panel.querySelector('[aria-busy="true"]')) return false;
      if (labels !== state.lastLabels) { state.lastLabels = labels; state.changedAt = Date.now(); return false; }
      return Date.now() - state.changedAt >= 750;
    }, null, { timeout: 15000 }).then(() => true).catch((error) => {
      if (error.name !== "TimeoutError") throw error;
      return false;
    });
    assertAncestryCollectionRoot(page.url(), startingUrl);
    await verifyTarget();
    const result = await page.evaluate(inspectYaxleyBrowseDom, config);
    if (!result.parishSelected) throw new Error("The exact parish selection was not retained.");
    assertAncestryCollectionRoot(page.url(), startingUrl);
    await verifyTarget();
    return { ...result, dependentRefresh: refreshed ? "changed-labels-stable-750ms" : "unverified-timeout", coverageVerified: false };
  });
}

async function inspectPage(page) {
  const title = await page.title();
  const controls = await page.locator("a,button,input,select").evaluateAll((elements) =>
    elements.slice(0, 160).map((element) => ({
      role: element.getAttribute("role") || element.tagName.toLowerCase(),
      label: element.getAttribute("aria-label") || element.innerText || element.getAttribute("value") || "",
    })).filter((item) => item.label.trim()).map((item) => ({
      role: item.role,
      label: item.label.replace(/\s+/g, " ").trim().slice(0, 240),
    })),
  );
  console.log(`Background tab title: ${title}`);
  console.log(`Verified provider route: ${summarizeUrl(page.url())}`);
  console.log("Visible controls (role and accessible label only):");
  for (const control of controls) console.log(`  ${control.role}: ${control.label}`);
  if (providerForUrl(page.url()) === "findmypast" && (/^\/search-world-records\/[a-z0-9-]+\/?$/i.test(new URL(page.url()).pathname) ||
      new URL(page.url()).pathname === "/discover/birth-marriage-death-and-parish-records/civil-deaths-and-burials/england-and-wales-government-probate-death-index-1858-2019")) {
    const searchFields = await page.locator("form input, form select").evaluateAll((elements) => elements.map((element) => ({
      name: element.getAttribute("name") || "",
      id: element.id || "",
      type: element.getAttribute("type") || element.tagName.toLowerCase(),
      label: [...(element.labels || [])].map((label) => label.innerText).join(" ").replace(/\s+/g, " ").trim().slice(0, 240),
      placeholder: element.getAttribute("placeholder") || "",
      options: element.tagName === "SELECT" ? [...element.options].map((option) => ({ label: option.label, value: option.value })) : undefined,
    })).filter((field) => !/password|email|cookie|token|credential|account/i.test(`${field.name} ${field.id} ${field.type}`)).slice(0, 100));
    console.log(`Findmypast search field schema (no entered values): ${JSON.stringify(searchFields)}`);
    const forms = await page.locator("form").evaluateAll((elements) => elements.map((form) => ({
      action: form.action, method: form.method,
    })));
    for (const form of forms) console.log(`Findmypast form route: ${form.method} ${summarizeUrl(form.action)}`);
  }
}

async function inspectFindmypastResultStructure(page, expectedTerms) {
  const normalizedTerms = normalizeExpectedRowTerms(expectedTerms).map(normalizedResultText);
  const diagnostics = await page.locator("button").evaluateAll((buttons, terms) => {
    const normalize = (value) => String(value || "").normalize("NFKC")
      .replace(/\s+/g, " ").trim().toLocaleLowerCase();
    const label = (element) => (element.getAttribute("aria-label") || element.innerText || element.textContent || "")
      .replace(/\s+/g, " ").trim();
    const visible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0 &&
        rect.width > 0 && rect.height > 0;
    };
    const actionCounts = (boundary) => {
      const actions = [...boundary.querySelectorAll("a,button")];
      const directActions = [...boundary.children]
        .filter((action) => ["a", "button"].includes(action.tagName.toLocaleLowerCase()));
      const count = (expected, visibleOnly) => actions.filter((action) =>
        normalize(label(action)) === expected && (!visibleOnly || visible(action)),
      ).length;
      return {
        composite: actions.filter((action) => terms.every((term) => normalize(label(action)).includes(term))).length,
        genericView: count("view", false),
        visibleGenericView: count("view", true),
        directGenericView: directActions.filter((action) => normalize(label(action)) === "view").length,
        transcript: count("view transcript", false),
        visibleTranscript: count("view transcript", true),
        image: count("view image", false),
        visibleImage: count("view image", true),
      };
    };
    return buttons
      .filter((button) => visible(button) && terms.every((term) => normalize(label(button)).includes(term)))
      .slice(0, 12)
      .map((button) => {
        const ancestors = [];
        let current = button;
        for (let depth = 0; depth <= 12 && current; depth += 1, current = current.parentElement) {
          ancestors.push({
            depth,
            tag: current.tagName.toLocaleLowerCase(),
            role: (current.getAttribute("role") || "").toLocaleLowerCase(),
            classes: [...current.classList].slice(0, 8),
            directChildren: [...current.children].map((child) => child.tagName.toLocaleLowerCase()).slice(0, 12),
            ...actionCounts(current),
          });
        }
        return { label: label(button).slice(0, 500), ancestors };
      });
  }, normalizedTerms);
  console.log(`Matching visible composite result buttons: ${diagnostics.length}`);
  for (const [index, candidate] of diagnostics.entries()) {
    console.log(`  candidate ${index + 1}: ${candidate.label}`);
    for (const ancestor of candidate.ancestors) {
      console.log(
        `    depth=${ancestor.depth} tag=${ancestor.tag} role=${ancestor.role || "-"} ` +
        `classes=${ancestor.classes.join(",") || "-"} children=${ancestor.directChildren.join(",") || "-"} ` +
        `composite=${ancestor.composite} view=${ancestor.visibleGenericView}/${ancestor.genericView} ` +
        `direct-view=${ancestor.directGenericView} ` +
        `transcript=${ancestor.visibleTranscript}/${ancestor.transcript} image=${ancestor.visibleImage}/${ancestor.image}`,
      );
    }
  }
  const semanticRows = await page.locator('tr,[role="row"],li,article').evaluateAll((boundaries, terms) => {
    const normalize = (value) => String(value || "").normalize("NFKC")
      .replace(/\s+/g, " ").trim().toLocaleLowerCase();
    const label = (element) => element.getAttribute("aria-label") || element.innerText || element.textContent || "";
    const visible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0 &&
        rect.width > 0 && rect.height > 0;
    };
    return boundaries.map((boundary) => {
      const text = label(boundary).replace(/\s+/g, " ").trim();
      if (!terms.every((term) => normalize(text).includes(term))) return null;
      const actions = [...boundary.querySelectorAll("a,button")];
      const labels = actions.map((action) => normalize(label(action)));
      return {
        tag: boundary.tagName.toLocaleLowerCase(),
        role: (boundary.getAttribute("role") || "").toLocaleLowerCase(),
        visible: visible(boundary),
        text: text.slice(0, 500),
        genericView: labels.filter((value) => value === "view").length,
        transcript: labels.filter((value) => value === "view transcript").length,
        image: labels.filter((value) => value === "view image").length,
      };
    }).filter(Boolean).slice(0, 20);
  }, normalizedTerms);
  console.log(`Matching semantic action rows: ${semanticRows.length}`);
  for (const [index, row] of semanticRows.entries()) {
    console.log(
      `  row ${index + 1}: tag=${row.tag} role=${row.role || "-"} visible=${row.visible} ` +
      `view=${row.genericView} transcript=${row.transcript} image=${row.image} text=${row.text}`,
    );
  }
  const actionAncestors = await page.locator("a,button").evaluateAll((controls, terms) => {
    const normalize = (value) => String(value || "").normalize("NFKC")
      .replace(/\s+/g, " ").trim().toLocaleLowerCase();
    const label = (element) => element.getAttribute("aria-label") || element.innerText || element.textContent || "";
    return controls.filter((control) => normalize(label(control)) === "view transcript").slice(0, 20).map((control) => {
      const ancestors = [];
      for (let depth = 0, current = control; depth <= 10 && current; depth += 1, current = current.parentElement) {
        const text = label(current).replace(/\s+/g, " ").trim();
        const actions = [...current.querySelectorAll("a,button")];
        const labels = actions.map((action) => normalize(label(action)));
        ancestors.push({
          depth,
          tag: current.tagName.toLocaleLowerCase(),
          role: (current.getAttribute("role") || "").toLocaleLowerCase(),
          classes: [...current.classList].slice(0, 8),
          matchesTerms: terms.every((term) => normalize(text).includes(term)),
          transcript: labels.filter((value) => value === "view transcript").length,
          image: labels.filter((value) => value === "view image").length,
          text: text.slice(0, 500),
        });
      }
      return ancestors;
    });
  }, normalizedTerms);
  console.log(`Transcript-action ancestry chains: ${actionAncestors.length}`);
  for (const [actionIndex, ancestors] of actionAncestors.entries()) {
    console.log(`  transcript ${actionIndex + 1}:`);
    for (const ancestor of ancestors) {
      console.log(
        `    depth=${ancestor.depth} tag=${ancestor.tag} role=${ancestor.role || "-"} ` +
        `classes=${ancestor.classes.join(",") || "-"} matches=${ancestor.matchesTerms} ` +
        `transcript=${ancestor.transcript} image=${ancestor.image} text=${ancestor.text}`,
      );
    }
  }
  const tableRows = await page.locator("tr").evaluateAll((rows) => {
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const label = (element) => element.getAttribute("aria-label") || element.innerText || element.textContent || "";
    return rows.map((row) => {
      const actions = [...row.querySelectorAll("a,button")].map((action) => normalize(label(action)).toLocaleLowerCase());
      if (!actions.includes("view transcript") && !actions.includes("view image")) return null;
      const table = row.closest("table");
      return {
        headers: [...(table?.querySelectorAll("thead th") || [])].map((cell) => normalize(label(cell))).slice(0, 20),
        cells: [...row.children].map((cell) => normalize(label(cell))).slice(0, 20),
      };
    }).filter(Boolean).slice(0, 20);
  });
  console.log(`Action-bearing table rows: ${tableRows.length}`);
  for (const [index, row] of tableRows.entries()) {
    console.log(`  table row ${index + 1} headers=${row.headers.join(" | ")} cells=${row.cells.join(" | ")}`);
  }
}

function classifyFindmypastSearchSummary(summary) {
  const rowCount = Number(summary?.semanticRowCount || 0);
  const viewCount = Number(summary?.compositeViewCount || 0);
  if (summary?.explicitZero && (rowCount > 0 || viewCount > 0)) return "conflict";
  if (summary?.explicitZero) return "zero";
  if (rowCount > 0 || viewCount > 0) return "ready";
  return "incomplete";
}

async function inspectFindmypastSearchSummary(page) {
  const route = new URL(page.url());
  if (route.pathname !== "/search/results") {
    throw new Error("inspect-fmp-search-summary requires an exact Findmypast search-results route.");
  }
  const deadline = Date.now() + 15_000;
  let summary;
  do {
    summary = await page.evaluate(() => {
      const visible = (element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0 &&
          rect.width > 0 && rect.height > 0;
      };
      const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
      const main = document.querySelector("main");
      const mainText = normalize(main?.innerText || main?.textContent || "").slice(0, 12_000);
      const semanticRows = [...document.querySelectorAll("main tr, main [role='row'], main article")]
        .filter(visible)
        .filter((row) => row.querySelector('a[href*="transcript" i], a[href*="record" i], a[href*="image" i]'));
      const compositeButtons = [...document.querySelectorAll("main button")]
        .filter(visible)
        .filter((button) => /\bView\b/i.test(normalize(button.getAttribute("aria-label") || button.innerText || button.textContent)));
      const pagination = [...document.querySelectorAll("main nav a, main nav button, main [aria-label*='pagination' i] a, main [aria-label*='pagination' i] button")]
        .filter(visible)
        .map((element) => normalize(element.getAttribute("aria-label") || element.innerText || element.textContent))
        .filter(Boolean)
        .slice(0, 100);
      const explicitZero = /\b(?:0|zero)\s+(?:search\s+)?results?\b|\bno (?:matching )?(?:results|records)(?: were)? found\b|\byour search returned no results\b/i.test(mainText);
      const countMatch = mainText.match(/\b([0-9][0-9,]*)\s+(?:search\s+)?results?\b/i);
      const headings = [...document.querySelectorAll("main h1, main h2, main h3, main [role='status'], main [aria-live]")]
        .filter(visible)
        .map((element) => normalize(element.innerText || element.textContent))
        .filter(Boolean)
        .filter((value, index, values) => values.indexOf(value) === index)
        .slice(0, 40);
      const searchFilters = [...document.querySelectorAll("main input, main select")]
        .filter(visible)
        .filter((element) => !["password", "email", "hidden"].includes(element.type))
        .flatMap((element) => {
          const label = normalize(element.getAttribute("aria-label") || [...(element.labels || [])].map((label) => label.innerText).join(" "));
          if (!/^(?:First name\(s\)|Last name|Baptism year|Marriage year|Give or take|Year range|Father.s first name\(s\)|Mother.s first name\(s\)|Spouse.s first name\(s\)|Spouse.s last name|Family member first name\(s\)|Family member last name|Location in 1851|Name variants)$/i.test(label)) return [];
          return [{ label, value: element.type === "checkbox" ? element.checked : element.value }];
        });
      const spouseSurnameChips = [...document.querySelectorAll("main a[aria-label]")]
        .filter(visible)
        .filter((element) => /^Edit Spouse.s last name field$/i.test(normalize(element.getAttribute("aria-label"))))
        .map((element) => {
          let container = element.parentElement;
          for (let depth = 0; container && depth < 3; depth += 1, container = container.parentElement) {
            if (/^(?:MAIN|FORM|BODY|HTML)$/.test(container.tagName)) break;
            const text = normalize(container.innerText);
            if (text) return text.slice(0, 300);
          }
          return "not exposed";
        });
      const familyMemberChips = [...document.querySelectorAll("main a[aria-label]")]
        .filter(visible)
        .filter((element) => /^Edit Family member (?:first name\(s\)|last name) field$/i.test(normalize(element.getAttribute("aria-label"))))
        .map((element) => {
          let container = element.parentElement;
          for (let depth = 0; container && depth < 3; depth += 1, container = container.parentElement) {
            if (/^(?:MAIN|FORM|BODY|HTML)$/.test(container.tagName)) break;
            const text = normalize(container.innerText);
            if (text) return { label: normalize(element.getAttribute("aria-label")), text: text.slice(0, 300) };
          }
          return { label: normalize(element.getAttribute("aria-label")), text: "not exposed" };
        });
      return {
        explicitZero,
        visibleCountText: countMatch?.[0] || "",
        semanticRowCount: semanticRows.length,
        compositeViewCount: compositeButtons.length,
        pagination,
        headings,
        searchFilters,
        spouseSurnameChips,
        familyMemberChips,
        mainText,
      };
    });
    if (classifyFindmypastSearchSummary(summary) !== "incomplete") break;
    await sleep(200);
  } while (Date.now() < deadline);
  console.log(`Findmypast explicit zero: ${summary.explicitZero ? "yes" : "no"}`);
  console.log(`Findmypast visible count text: ${summary.visibleCountText || "not exposed"}`);
  console.log(`Findmypast semantic result rows: ${summary.semanticRowCount}`);
  console.log(`Findmypast composite View controls: ${summary.compositeViewCount}`);
  console.log(`Findmypast pagination controls: ${summary.pagination.length ? summary.pagination.join(" | ") : "none"}`);
  console.log(`Findmypast result headings: ${summary.headings.length ? summary.headings.join(" | ") : "none"}`);
  console.log(`Findmypast displayed search filters: ${JSON.stringify(summary.searchFilters)}`);
  console.log(`Findmypast displayed spouse surname chips: ${JSON.stringify(summary.spouseSurnameChips)}`);
  console.log(`Findmypast displayed family member chips: ${JSON.stringify(summary.familyMemberChips)}`);
  const state = classifyFindmypastSearchSummary(summary);
  if (state === "conflict") {
    throw new Error("Findmypast search results exposed an explicit zero together with semantic result rows or View controls.");
  }
  if (state === "incomplete") {
    throw new Error(`Findmypast search results exposed neither a semantic row nor an explicit zero state. Visible main text: ${summary.mainText.slice(0, 2_000)}`);
  }
}

async function findmypastBrowseRowMetadata(page) {
  return page.locator("tr").evaluateAll((rows) => rows.map((row, rowIndex) => {
    const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const label = (element) => element.getAttribute("aria-label") || element.innerText || element.textContent || "";
    const imageLinks = [...row.querySelectorAll("a,button")].filter((element) =>
      clean(label(element)).toLocaleLowerCase() === "image",
    );
    if (imageLinks.length === 0) return null;
    const href = imageLinks.length === 1 && imageLinks[0].tagName.toLocaleLowerCase() === "a"
      ? imageLinks[0].href
      : "";
    return {
      rowIndex,
      boundaryStrength: "semantic-table-row",
      text: clean(label(row)),
      imageActions: imageLinks.length,
      href,
    };
  }).filter(Boolean).slice(0, 200));
}

async function inspectFindmypastBrowseResults(page) {
  if (!/^\/results\/world-images\//i.test(new URL(page.url()).pathname)) {
    throw new Error("inspect-fmp-browse-results requires an exact Findmypast world-images results page.");
  }
  const rows = await findmypastBrowseRowMetadata(page);
  console.log(`Visible Findmypast browse rows: ${rows.length}`);
  for (const [index, row] of rows.entries()) {
    const href = row.href ? new URL(row.href) : null;
    console.log(`  ${index + 1}. ${row.text.slice(0, 1_000)}${href ? ` -> ${href.pathname}${href.search}` : ""}`);
  }
}

async function resolveUniqueFindmypastBrowseRow(page, expectedTerms, timeoutMilliseconds = 10_000) {
  if (!/^\/results\/world-images\//i.test(new URL(page.url()).pathname)) {
    throw new Error("view-fmp-browse-image requires an exact Findmypast world-images results page.");
  }
  const deadline = Date.now() + timeoutMilliseconds;
  let stableSignature = "";
  let stableSamples = 0;
  let lastError = null;
  const observed = new Set();
  do {
    const rows = await page.locator("tr").all();
    const candidates = await findmypastBrowseRowMetadata(page);
    for (const candidate of candidates) observed.add(candidate.text.slice(0, 1_000));
    try {
      const selected = selectUniqueFindmypastBrowseRow(candidates, expectedTerms);
      const signature = crypto.createHash("sha256").update(JSON.stringify({
        text: normalizedResultText(selected.text),
        href: selected.href,
        imageActions: selected.imageActions,
      })).digest("hex");
      if (signature === stableSignature) stableSamples += 1;
      else {
        stableSignature = signature;
        stableSamples = 1;
      }
      if (stableSamples >= 3) {
        const container = rows[selected.rowIndex];
        const actions = [];
        for (const anchor of await container.locator("a[href]").all()) {
          if (!await anchor.isVisible().catch(() => false)) continue;
          const label = await anchor.evaluate((element) =>
            (element.getAttribute("aria-label") || element.innerText || element.textContent || "")
              .replace(/\s+/g, " ").trim(),
          );
          if (label !== "Image") continue;
          const href = await providerHref(anchor, "findmypast", page.url());
          if (href) actions.push(anchor);
        }
        if (actions.length !== 1) {
          throw new Error("The exact Findmypast browse row no longer owns one visible Image link.");
        }
        return { container, action: actions[0], summary: selected.text, href: selected.href };
      }
      lastError = null;
    } catch (error) {
      if (!/^No Findmypast browse row/.test(error.message)) throw error;
      lastError = error;
      stableSignature = "";
      stableSamples = 0;
    }
    await sleep(100);
  } while (Date.now() < deadline);
  const detail = [...observed].slice(0, 20);
  throw new Error(`${lastError?.message || "No stable Findmypast browse row was available."}` +
    `${detail.length ? ` Observed browse rows: ${detail.join(" || ")}` : ""}`);
}

async function inspectSearchResults(page) {
  const rows = await page.locator('a[href*="/search/collections/"][href*="/records/"]').evaluateAll((links) => {
    const seen = new Set();
    const results = [];
    for (const link of links) {
      if (seen.has(link.href)) continue;
      seen.add(link.href);
      const container = link.closest('tr, [role="row"], li, article') || link.parentElement?.parentElement || link.parentElement;
      const text = (container?.innerText || link.innerText || "").replace(/\s+/g, " ").trim();
      results.push({ href: link.href, text: text.slice(0, 1_000) });
      if (results.length >= 100) break;
    }
    return results;
  });
  console.log(`Visible subscription search results: ${rows.length}`);
  for (const [index, row] of rows.entries()) {
    console.log(`  ${index + 1}. ${row.text || "(no visible result text)"} -> ${summarizeUrl(row.href)}`);
  }
}

async function inspectRecordFacts(page) {
  if (!/^\/search\/collections\/\d+\/records\/\d+\/?$/i.test(new URL(page.url()).pathname)) {
    throw new Error("inspect-record-facts requires an exact subscription record page.");
  }
  const facts = await page.locator("main h1, main h2, main h3, main table tr, main dl dt, main dl dd").evaluateAll((elements) => {
    const seen = new Set();
    const values = [];
    for (const element of elements) {
      const text = (element.innerText || "").replace(/\s+/g, " ").trim();
      if (!text || seen.has(text)) continue;
      seen.add(text);
      values.push(text.slice(0, 1_000));
      if (values.length >= 120) break;
    }
    return values;
  });
  console.log(`Visible exact-record facts: ${facts.length}`);
  for (const fact of facts) console.log(`  ${fact}`);
}

async function inspectOverlays(page) {
  const overlays = await page.locator('[role="alert"]:visible, [role="dialog"]:visible').evaluateAll((elements) =>
    elements.slice(0, 20).map((element) => ({
      role: element.getAttribute("role") || "overlay",
      text: (element.innerText || "").replace(/\s+/g, " ").trim().slice(0, 2_000),
    })).filter((entry) => entry.text),
  );
  console.log(`Visible provider alerts/dialogs: ${overlays.length}`);
  for (const [index, overlay] of overlays.entries()) {
    console.log(`  ${index + 1}. ${overlay.role}: ${overlay.text}`);
  }
}

async function inspectRecordSourceLinks(page) {
  if (!/^\/search\/collections\/\d+\/records\/\d+\/?$/i.test(new URL(page.url()).pathname)) {
    throw new Error("inspect-record-source-links requires an exact subscription record page.");
  }
  const links = await page.locator("main a[href]").evaluateAll((elements) => {
    const allowed = /(^|\.)(?:newspapers\.com|fold3\.com)$/i;
    const seen = new Set();
    const results = [];
    for (const element of elements) {
      try {
        const parsed = new URL(element.href);
        if (parsed.protocol !== "https:" || !allowed.test(parsed.hostname)) continue;
        parsed.search = "";
        parsed.hash = "";
        const href = parsed.toString();
        if (seen.has(href)) continue;
        seen.add(href);
        results.push({
          label: (element.innerText || element.getAttribute("aria-label") || "Source link").replace(/\s+/g, " ").trim().slice(0, 240),
          href,
        });
      } catch {}
    }
    return results.slice(0, 20);
  });
  console.log(`Visible external record-source links: ${links.length}`);
  for (const link of links) console.log(`  ${link.label}: ${link.href}`);
}

async function inspectExternalRecordSource(context, browserSession, controlled) {
  const { page, provider, windowId } = controlled;
  const originalUrl = page.url();
  if (provider !== "ancestry" || !/^\/search\/collections\/\d+\/records\/\d+\/?$/i.test(new URL(originalUrl).pathname)) {
    throw new Error("inspect-external-record-source requires an exact Ancestry record page.");
  }
  const candidates = await page.locator("main a[href]").evaluateAll((elements) => {
    const seen = new Set();
    const values = [];
    for (const element of elements) {
      try {
        const parsed = new URL(element.href);
        if (parsed.protocol !== "https:" || !/(^|\.)newspapers\.com$/i.test(parsed.hostname) ||
            !/^\/image\/\d+\/?$/i.test(parsed.pathname)) continue;
        parsed.search = "";
        parsed.hash = "";
        const href = parsed.toString();
        if (seen.has(href)) continue;
        seen.add(href);
        values.push(href);
      } catch {}
    }
    return values;
  });
  if (candidates.length !== 1) {
    throw new Error(`Expected exactly one Newspapers.com image link on the exact Ancestry record; found ${candidates.length}.`);
  }
  const sourceUrl = candidates[0];
  try {
    await page.goto(sourceUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForTimeout(5_000);
    const active = new URL(page.url());
    if (!/(^|\.)newspapers\.com$/i.test(active.hostname) || !/^\/image\/\d+\/?$/i.test(active.pathname)) {
      throw new Error("The external source did not remain on the uniquely linked Newspapers.com image route.");
    }
    const identity = await targetIdentity(context, page);
    await verifyPageWindow(browserSession, identity.targetId, windowId);
    const title = (await page.title()).replace(/\s+/g, " ").trim().slice(0, 500);
    const text = await page.locator("main, [role='main']").first().innerText({ timeout: 5_000 }).catch(async () =>
      page.locator("body").innerText({ timeout: 5_000 }),
    );
    const cleaned = String(text || "").replace(/\s+/g, " ").trim().slice(0, 20_000);
    const media = await page.evaluate(() => ({
      canvases: [...document.querySelectorAll("canvas")].map((canvas) => ({
        width: canvas.width,
        height: canvas.height,
        displayedWidth: Math.round(canvas.getBoundingClientRect().width),
        displayedHeight: Math.round(canvas.getBoundingClientRect().height),
      })).filter((item) => item.width > 1 && item.height > 1).slice(0, 20),
      images: [...document.images].map((image) => ({
        alt: (image.alt || "").replace(/\s+/g, " ").trim().slice(0, 240),
        width: image.naturalWidth,
        height: image.naturalHeight,
        displayedWidth: Math.round(image.getBoundingClientRect().width),
        displayedHeight: Math.round(image.getBoundingClientRect().height),
      })).filter((item) => item.width > 1 && item.height > 1).slice(0, 40),
    }));
    console.log(`External source route: ${active.protocol}//${active.hostname}${active.pathname}`);
    console.log(`External source title: ${title || "not exposed"}`);
    console.log(`Visible external source text: ${cleaned || "none"}`);
    console.log(`External source media: ${JSON.stringify(media)}`);
    const screenshotPath = path.join(os.tmpdir(), `family-history-external-record-inspection-${process.pid}-${Date.now()}.png`);
    let screenshotSaved = await page.screenshot({ path: screenshotPath, fullPage: false, timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    if (!screenshotSaved) {
      const pageSession = await context.newCDPSession(page).catch(() => null);
      if (pageSession) {
        screenshotSaved = await pageSession.send("Page.captureScreenshot", { format: "png", fromSurface: true })
          .then(({ data }) => {
            fs.writeFileSync(screenshotPath, Buffer.from(data, "base64"));
            return true;
          })
          .catch(() => false);
        await pageSession.detach().catch(() => {});
      }
    }
    console.log(screenshotSaved
      ? `Temporary external source inspection screenshot: ${screenshotPath}`
      : "Temporary external source inspection screenshot: unavailable (page did not settle within the bounded timeout)");
  } finally {
    await page.goto(originalUrl, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => {});
    await page.waitForTimeout(1_000).catch(() => {});
    const identity = await targetIdentity(context, page).catch(() => null);
    if (identity) await verifyPageWindow(browserSession, identity.targetId, windowId);
  }
}

function windowsDownloadsPaths() {
  const windowsProfile = process.platform === "win32"
    ? String(process.env.USERPROFILE || "").trim()
    : execFileSync("cmd.exe", ["/d", "/s", "/c", "echo %USERPROFILE%"], { encoding: "utf8" }).trim();
  if (!/^[A-Za-z]:\\/.test(windowsProfile)) throw new Error("The Windows user profile path could not be resolved.");
  const localProfile = process.platform === "win32"
    ? windowsProfile
    : execFileSync("wslpath", ["-u", windowsProfile], { encoding: "utf8" }).trim();
  return {
    windows: path.win32.join(windowsProfile, "Downloads", "FamilyHistoryResearch"),
    local: path.join(localProfile, "Downloads", "FamilyHistoryResearch"),
  };
}

async function archiveDownload(download, options) {
  if (!options.targetId) throw new Error("download-record requires --target-id for archive/manifest binding.");
  if (!options.archiveFile || !ARCHIVE_FILE_PATTERN.test(options.archiveFile)) {
    throw new Error("download-record requires a safe JPEG, PNG, WebP, or PDF --archive-file name.");
  }
  const suggested = download.suggestedFilename();
  const extension = (path.extname(suggested || "") || path.extname(options.archiveFile)).toLowerCase();
  if (!/^\.(?:jpe?g|png|webp|pdf)$/.test(extension)) {
    throw new Error("The provider download did not suggest an approved source-master file type.");
  }
  const downloads = windowsDownloadsPaths();
  fs.mkdirSync(downloads.local, { recursive: true });
  const stagingName = `family-history-cdp-${process.pid}-${Date.now()}${extension}`;
  const stagingLocal = path.join(downloads.local, stagingName);
  const stagingWindows = path.win32.join(downloads.windows, stagingName);
  let archived = false;
  try {
    await download.saveAs(stagingLocal);
    const stats = fs.statSync(stagingLocal);
    if (!stats.isFile() || stats.size < 1_024) {
      throw new Error("The provider download was empty or too small to be a source master.");
    }
    runPowerShell("archive-subscription-download-windows.ps1", [
      "-TargetId", options.targetId,
      "-SourceFile", stagingWindows,
      "-ArchiveFile", options.archiveFile,
      "-Part", String(options.part),
      ...(options.deferValidation === true ? ["-DeferValidation"] : []),
    ]);
    archived = true;
  } catch (error) {
    if (!fs.existsSync(stagingLocal)) {
      const artifactPath = await download.path().catch(() => null);
      if (artifactPath && fs.existsSync(artifactPath)) {
        fs.copyFileSync(artifactPath, stagingLocal);
      }
    }
    const detail = error instanceof Error ? error.message : String(error);
    if (fs.existsSync(stagingLocal)) {
      throw new Error(`${detail} The staged source was retained at ${stagingWindows}.`);
    }
    throw new Error(`${detail} No staging copy was created; the provider download transaction remains failed.`);
  } finally {
    if (archived) {
      fs.rmSync(stagingLocal, { force: true });
      await download.delete().catch(() => {});
    }
  }
}

function findmypastTargetReadyForCapture(target) {
  if (!target) return false;
  const routes = (target.routes || []).filter((route) =>
    route.id === target.id && route.targetId === target.id);
  return routes.length === 1
    && routes[0].provider === "Findmypast"
    && routes[0].sourceQueue === "subscription-records"
    && routes[0].route === "windows-subscription-profile"
    && routes[0].status === "ready-subscription-capture";
}

async function downloadFromViewer(page, options, provider) {
  let downloadControl = await namedLocator(
    page,
    provider === "findmypast" ? ["Download record", "Download"] : ["Download"],
    1,
    ["button", "link"],
    { unique: true },
  );
  if (!downloadControl && provider === "ancestry") {
    const toolMenu = await namedLocator(page, ["Tool menu"], 1, ["button"], { unique: true });
    if (toolMenu) {
      await toolMenu.click({ timeout: 15_000 });
      downloadControl = await namedLocator(page, ["Download"], 1, ["button", "link"], { unique: true });
    }
  }
  if (!downloadControl) throw new Error("The provider viewer exposed no unique normal Download control.");
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 90_000 }),
    downloadControl.click({ timeout: 20_000 }),
  ]);
  await archiveDownload(download, options);
}

function assertFindmypastProbateFormRoute(rawUrl) {
  const url = new URL(rawUrl);
  if (url.origin !== "https://search.findmypast.co.uk" || url.username || url.password || url.search || url.hash ||
      url.pathname !== "/search-world-records/england-and-wales-probate-calendars-1858-1995-browse") {
    throw new Error("Probate browse requires the exact observed collection form route.");
  }
}

function assertFindmypastProbateResultRoute(rawUrl) {
  const url = new URL(rawUrl);
  const expected = { eventyear: "1858", eventyear_offset: "0", surnameinitial: "w" };
  if (url.origin !== "https://search.findmypast.co.uk" || url.username || url.password || url.hash ||
      url.pathname !== "/results/world-images/england-and-wales-probate-calendars-1858-1995-browse" ||
      [...url.searchParams].length !== 3 || Object.entries(expected).some(([key, value]) => url.searchParams.get(key) !== value)) {
    throw new Error("Native probate result route does not preserve the exact collection and 1858/W filters.");
  }
}

// This inspector deliberately never reads an input value, including hidden or
// autofilled account fields. Only historical control schemas leave the page.
function inspectFindmypastProbateFormDom() {
  const clean = value => String(value || "").replace(/\s+/g, " ").trim();
  const visible = element => {
    const style = getComputedStyle(element);
    const bounds = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && bounds.width > 0 && bounds.height > 0;
  };
  if ([...document.querySelectorAll('input[type="password"], iframe[src*="captcha"], [id*="challenge"]')].some(visible)) {
    throw new Error("Probate form has a visible sign-in or challenge gate.");
  }
  const headings = [...document.querySelectorAll("h1")].filter(visible).map(node => clean(node.textContent));
  if (headings.length !== 1 || !/^England (?:and|&) Wales Probate Calendars 1858-1995 Browse$/i.test(headings[0])) {
    throw new Error(`Probate collection heading is missing or ambiguous: ${JSON.stringify(headings.slice(0, 3))}`);
  }
  const forms = [...document.querySelectorAll("form")].filter(form =>
    [...form.querySelectorAll("label")].some(label => clean(label.textContent) === "Surname letter"));
  if (forms.length !== 1) throw new Error("Probate historical form is missing or ambiguous.");
  const form = forms[0];
  if (![null, "", "_self"].includes(form.getAttribute("target")) ||
      [...form.querySelectorAll('button[type="submit"],input[type="submit"]')].some(button =>
        ["formaction", "formmethod", "formtarget", "form"].some(name => button.hasAttribute(name)))) {
    throw new Error("Probate form has an unexpected submit override.");
  }
  const method = (form.getAttribute("method") || "get").toLowerCase();
  const action = new URL(form.getAttribute("action"), location.href).href;
  const actionUrl = new URL(action);
  const actionKeys = [...actionUrl.searchParams.keys()].sort();
  if (method !== "post" || actionUrl.origin !== "https://search.findmypast.co.uk" || actionUrl.pathname !== "/results/search" ||
      actionUrl.username || actionUrl.password || actionUrl.hash || JSON.stringify(actionKeys) !== JSON.stringify(["datasetname", "region", "searcharea", "searchlevel"])) {
    throw new Error(`Probate form action differs from the observed native POST route: ${method} ${new URL(action).origin}${new URL(action).pathname}; query keys=${JSON.stringify([...new URL(action).searchParams.keys()])}; fragment=${Boolean(new URL(action).hash)}`);
  }
  const controls = [...form.querySelectorAll("input,select,button")].filter(visible).map(node => {
    const label = clean([...(node.labels || [])].map(item => item.textContent).join(" ") || node.getAttribute("aria-label") || (node.tagName === "BUTTON" ? node.textContent : ""));
    const type = clean(node.getAttribute("type"));
    if (node.tagName !== "BUTTON" && type !== "submit" && !["Year", "Give or take", "Surname letter"].includes(label)) {
      throw new Error("Probate form contains an unexpected visible control.");
    }
    return { tag: node.tagName, type, id: node.id, name: node.name, label,
      ...(type === "button" ? { parentText: clean(node.parentElement.textContent).slice(0, 800), expanded: node.getAttribute("aria-expanded"), popup: node.getAttribute("aria-haspopup") } : {}),
      ...(node.tagName === "SELECT" ? { options: [...node.options].map(option => ({ label: clean(option.textContent), value: option.value })) } : {}) };
  });
  const choices = [...form.querySelectorAll("li,a,[role=option]")].filter(visible).map(node => ({
    tag: node.tagName, role: node.getAttribute("role"), className: node.className, text: clean(node.textContent).slice(0, 160),
    ...(clean(node.textContent) === "Browse Surname letter" ? { href: node.getAttribute("href"), target: node.getAttribute("data-target"), attributes: [...node.attributes].map(attr => attr.name) } : {}),
  }));
  const browsePanels = [...document.querySelectorAll('[id="modal-wrapper"]')].filter(visible).map(node => {
    if (!clean(node.textContent).startsWith("Filter by Surname letter within England & Wales Probate Calendars 1858-1995 Browse")) throw new Error("Unexpected probate browse modal.");
    return { text: clean(node.textContent).slice(0, 900), controls: [...node.querySelectorAll("input,button,a,label")].filter(visible).map(control => ({ tag: control.tagName, type: control.getAttribute("type"), id: control.id, className: control.className, checked: control.type === "checkbox" ? control.checked : undefined, text: clean(control.textContent), label: clean([...(control.labels || [])].map(label => label.textContent).join(" ")) })) };
  });
  return { heading: headings[0], method, action, controls, choices: choices.slice(0, 30), choicesTruncated: choices.length > 30, browsePanels };
}

function validateFindmypastProbateForm(metadata) {
  const action = new URL(metadata.action);
  const expected = { region: "world", datasetname: "england-and-wales-probate-calendars-1858-1995-browse", searchlevel: "dataset", searcharea: "records" };
  if (metadata.method !== "post" || action.origin !== "https://search.findmypast.co.uk" || action.pathname !== "/results/search" ||
      action.username || action.password || action.hash || [...action.searchParams].length !== 4 ||
      Object.entries(expected).some(([key, value]) => action.searchParams.get(key) !== value)) {
    throw new Error("Probate form is not bound to the exact native browse dataset.");
  }
  const controls = metadata.controls;
  if (controls.length !== 4 ||
      controls.filter(c => c.tag === "INPUT" && c.type === "tel" && c.id === "SearchFacets_0__Value" && c.name === "SearchFacets[0].Value" && c.label === "Year").length !== 1 ||
      controls.filter(c => c.tag === "INPUT" && c.type === "text" && c.id === "SurnameInitial_typeahead" && c.name === "" && c.label === "Surname letter").length !== 1 ||
      controls.filter(c => c.tag === "BUTTON" && c.type === "button" && /^-\/\+ (?:0|2)yrs$/.test(c.label) && c.parentText?.includes("-/+ 0yrs")).length !== 1 ||
      controls.filter(c => c.tag === "BUTTON" && c.type === "submit" && c.id === "advanced-search-button" && (c.label === "Search England & Wales Probate Calendars 1858-1995 Browse" || /^View \d+ Results?$/.test(c.label))).length !== 1) {
    throw new Error("Probate historical controls are missing, changed or ambiguous.");
  }
}

function activateFindmypastProbateSubmit(element, { expectedAction }) {
  const clean = value => String(value || "").replace(/\s+/g, " ").trim();
  const visible = node => {
    const style = getComputedStyle(node);
    const box = node.getBoundingClientRect();
    return style.visibility !== "hidden" && style.display !== "none" && box.width > 0 && box.height > 0;
  };
  const form = element.closest("form");
  if (location.href !== "https://search.findmypast.co.uk/search-world-records/england-and-wales-probate-calendars-1858-1995-browse" ||
      !element.isConnected || element.tagName !== "BUTTON" || element.id !== "advanced-search-button" || element.type !== "submit" || element.disabled || !visible(element) ||
      !form || form.dataset.familyHistoryProbateSubmitted || form.getAttribute("method").toLowerCase() !== "post" ||
      new URL(form.getAttribute("action"), location.href).href !== expectedAction ||
      ![null, "", "_self"].includes(form.getAttribute("target")) ||
      ["formaction", "formmethod", "formtarget", "form"].some(name => element.hasAttribute(name)) ||
      [...document.querySelectorAll('input[type="password"], iframe[src*="captcha"], [id*="challenge"]')].some(visible)) {
    throw new Error("Probate form changed or acquired an unsafe submit override.");
  }
  const unique = selector => {
    const nodes = form.querySelectorAll(selector);
    if (nodes.length !== 1) throw new Error("Probate submit control is ambiguous.");
    return nodes[0];
  };
  const year = unique('[id="SearchFacets_0__Value"]');
  const offset = unique('select[id="SearchFacets_0__Offset"]');
  const letter = unique('[id="SurnameInitial_typeahead"]');
  const chips = [...form.querySelectorAll("a.filter-remove-link")].filter(visible);
  if (year.tagName !== "INPUT" || year.type !== "tel" || year.name !== "SearchFacets[0].Value" || !visible(year) ||
      clean([...year.labels].map(label => label.textContent).join(" ")) !== "Year" ||
      letter.tagName !== "INPUT" || letter.type !== "text" || !visible(letter) ||
      clean([...letter.labels].map(label => label.textContent).join(" ")) !== "Surname letter" ||
      clean([...offset.labels].map(label => label.textContent).join(" ")) !== "Give or take" ||
      year.value !== "1858" || offset.value !== "0" || chips.length !== 1 || clean(chips[0].textContent) !== "W" ||
      clean(element.textContent) !== "View 1 Result") {
    throw new Error("Probate submission requires verified 1858, exact year, committed W and one result.");
  }
  form.dataset.familyHistoryProbateSubmitted = "true";
  element.click();
}

async function providerAction(context, browserSession, options) {
  const controlled = await requireAffinityPage(context, browserSession, options);
  const { page, provider } = controlled;
  const index = options.resultIndex;

  if (["inspect-fmp-probate-form", "prepare-fmp-probate-form", "expand-fmp-probate-letters", "apply-fmp-probate-letter", "submit-fmp-probate-form"].includes(options.mode)) {
    assertFindmypastProbateFormRoute(page.url());
    const result = await page.evaluate(inspectFindmypastProbateFormDom);
    if (options.mode !== "inspect-fmp-probate-form") validateFindmypastProbateForm(result);
    assertFindmypastProbateFormRoute(page.url());
    assertSameCollectionTarget(controlled, await requireAffinityPage(context, browserSession, options));
    if (options.mode === "submit-fmp-probate-form") {
      if (result.browsePanels.length || result.choicesTruncated) throw new Error("Probate form is not ready for submission.");
      const submit = page.locator('button[id="advanced-search-button"]');
      await clickWithoutPopupWindow(context, browserSession, page, submit, provider, controlled.windowId, {
        connection: options.connection, followDirectHref: false,
        activate: locator => locator.evaluate(activateFindmypastProbateSubmit, { expectedAction: result.action }),
        postcondition: async (_page, activeUrl) => {
          assertFindmypastProbateResultRoute(activeUrl);
          return true;
        },
      });
      const activeUrl = await updateAffinityAfterAction(context, browserSession, options, controlled, options.url);
      console.log(`Native probate browse result route: ${activeUrl}`);
      const rows = await page.locator("tr").evaluateAll(nodes => nodes.filter(row =>
        [...row.querySelectorAll("a,button")].some(action => (action.textContent || "").trim().toLowerCase() === "image"))
        .map(row => ({ cells: [...row.querySelectorAll("td")].map(cell => (cell.textContent || "").replace(/\s+/g, " ").trim()),
          imageLinks: [...row.querySelectorAll("a")].filter(link => (link.textContent || "").trim().toLowerCase() === "image").map(link => link.href) })));
      if (rows.length > 20) throw new Error("Native probate browse exceeds the 20-row cap; no original opened.");
      if (rows.length !== 1 || JSON.stringify(rows[0].cells) !== JSON.stringify(["540", "w", "1858", "Image"]) || rows[0].imageLinks.length !== 1) {
        throw new Error("Native probate result row differs from the verified 1858/W entry; no original opened.");
      }
      const headings = await page.locator("h1,thead th").allTextContents();
      console.log(`Native probate result metadata: ${JSON.stringify({ headings, rowCount: rows.length, rows, originalExposures: 0 })}`);
      return;
    }
    if (options.mode === "apply-fmp-probate-letter") {
      if (result.browsePanels.length !== 1) throw new Error("Expected one native surname-letter modal.");
      const modal = page.locator('[id="modal-wrapper"]');
      const checks = await modal.locator('input[type="checkbox"]').evaluateAll(nodes => nodes.map(node => ({
        label: [...node.labels].map(label => label.textContent.trim()).join(" "), checked: node.checked || [...node.labels].some(label => label.classList.contains("node--checked")),
      })));
      if (checks.length !== 26 || checks.map(c => c.label).join("") !== "ABCDEFGHIJKLMNOPQRSTUVWXYZ" || checks.some(c => c.checked && c.label !== "W")) {
        throw new Error("Native letter options are incomplete or another letter is selected.");
      }
      const letterLabel = modal.locator("label").filter({ hasText: /^\s*W\s*$/ });
      if (await letterLabel.count() !== 1) throw new Error("Native W label is ambiguous.");
      if (!await letterLabel.evaluate(node => node.classList.contains("node--checked"))) await letterLabel.click({ timeout: 5000 });
      if (!await letterLabel.evaluate(node => node.classList.contains("node--checked"))) throw new Error("Native W selection did not commit.");
      await modal.getByRole("button", { name: "Apply filters", exact: true }).click({ timeout: 5000 });
      await modal.waitFor({ state: "hidden", timeout: 5000 });
      assertFindmypastProbateFormRoute(page.url());
      assertSameCollectionTarget(controlled, await requireAffinityPage(context, browserSession, options));
      console.log(`Applied native letter filter without search submission: ${JSON.stringify(await page.evaluate(inspectFindmypastProbateFormDom))}`);
      return;
    }
    if (options.mode === "expand-fmp-probate-letters") {
      if (result.browsePanels.length !== 1) throw new Error("Expected one native surname-letter modal.");
      await page.locator('[id="modal-wrapper"]').getByText("More", { exact: true }).click({ timeout: 5000 });
      await page.waitForTimeout(750);
      assertFindmypastProbateFormRoute(page.url());
      console.log(`Expanded historical letter options: ${JSON.stringify((await page.evaluate(inspectFindmypastProbateFormDom)).browsePanels)}`);
      return;
    }
    if (options.mode === "prepare-fmp-probate-form") {
      const cookieDialog = page.getByRole("dialog").filter({ hasText: "But first, cookies" });
      if (await cookieDialog.count() === 1 && await cookieDialog.isVisible()) {
        await cookieDialog.getByRole("button", { name: "Reject All", exact: true }).click({ timeout: 5000 });
        await cookieDialog.waitFor({ state: "hidden", timeout: 5000 });
        validateFindmypastProbateForm(await page.evaluate(inspectFindmypastProbateFormDom));
      }
      const form = page.locator("form").filter({ has: page.locator('[id="SearchFacets_0__Value"]') });
      if (await form.count() !== 1) throw new Error("Probate owning form became ambiguous.");
      await form.locator('[id="SearchFacets_0__Value"]').fill("1858");
      if (result.controls.find(c => c.type === "button").label !== "-/+ 0yrs") {
        const exactOption = form.locator("a:visible").filter({ hasText: /^-\/\+ 0yrs$/ });
        if (await exactOption.count() === 0) await form.getByRole("button", { name: "-/+ 2yrs", exact: true }).click({ timeout: 5000 });
        if (await exactOption.count() !== 1) throw new Error("Exact-year native option is ambiguous.");
        await exactOption.click({ timeout: 5000 });
      }
      await form.locator('[id="SurnameInitial_typeahead"]').fill("W");
      await page.waitForTimeout(750);
      await form.getByRole("button", { name: "Browse Surname letter", exact: true }).click({ timeout: 5000 });
      assertFindmypastProbateFormRoute(page.url());
      validateFindmypastProbateForm(await page.evaluate(inspectFindmypastProbateFormDom));
      const suggestions = await form.locator('[class*="suggest"]:visible, [role="option"]:visible').evaluateAll(nodes => ({
        count: nodes.length, truncated: nodes.length > 20,
        items: nodes.slice(0, 20).map(node => ({ tag: node.tagName, role: node.getAttribute("role"), className: node.className, text: (node.textContent || "").replace(/\s+/g, " ").trim().slice(0, 160) })),
      }));
      assertSameCollectionTarget(controlled, await requireAffinityPage(context, browserSession, options));
      console.log(`Probate form prepared without submission; historical suggestions: ${JSON.stringify(suggestions)}`);
      await inspectOverlays(page);
      return;
    }
    console.log(`Probate form metadata: ${JSON.stringify(result)}`);
    return;
  }

  if (options.mode === "inspect") {
    await inspectPage(page);
    return;
  }
  if (options.mode === "inspect-ancestry-event-controls") {
    if (provider !== "ancestry") throw new Error("Event controls inspection is restricted to Ancestry.");
    const startingUrl = page.url();
    assertYaxleyBrowseRoute(startingUrl);
    const result = await page.evaluate(inspectAncestryEventControlsDom);
    assertAncestryCollectionRoot(page.url(), startingUrl);
    assertSameCollectionTarget(controlled, await requireAffinityPage(context, browserSession, options));
    console.log(`Event control metadata: ${JSON.stringify(result)}`);
    return;
  }
  if (options.mode === "inspect-ancestry-search-state") {
    if (provider !== "ancestry") throw new Error("Historical search inspection is restricted to Ancestry.");
    const startingUrl = page.url();
    assertAncestryHistoricalSearchRoute(startingUrl);
    const result = await page.evaluate(inspectAncestryHistoricalSearchDom);
    if (page.url() !== startingUrl) throw new Error("Historical search route changed during inspection.");
    assertSameCollectionTarget(controlled, await requireAffinityPage(context, browserSession, options));
    console.log(`Historical search state: ${JSON.stringify(result)}`);
    return;
  }
  if (["inspect-ancestry-yaxley-browse", "inspect-ancestry-hampton-lovett-browse", "inspect-ancestry-farcet-browse", "inspect-ancestry-philadelphia-wills-browse"].includes(options.mode)) {
    const parish = { "inspect-ancestry-hampton-lovett-browse": "Hampton Lovett", "inspect-ancestry-farcet-browse": "Farcet", "inspect-ancestry-philadelphia-wills-browse": "Philadelphia" }[options.mode] || "Yaxley";
    if (provider !== "ancestry") throw new Error("Yaxley metadata inspection is restricted to Ancestry.");
    const verifyTarget = async () => assertSameCollectionTarget(controlled, await requireAffinityPage(context, browserSession, options));
    const result = await inspectAncestryYaxleyBrowse(page, verifyTarget, options.inspectOnly, parish, Array.isArray(options.expectedRowTerms) ? options.expectedRowTerms : []);
    await verifyTarget();
    console.log(`${parish} browse metadata: ${JSON.stringify(result)}`);
    return;
  }
  if (options.mode === "inspect-ancestry-collection") {
    if (provider !== "ancestry") throw new Error("Collection inspection is restricted to Ancestry.");
    const result = await inspectAncestryCollection(page, options.expectedRowTerms);
    const verified = await requireAffinityPage(context, browserSession, options);
    assertSameCollectionTarget(controlled, verified);
    console.log(`Collection inspection: ${JSON.stringify(result)}`);
    return;
  }
  if (options.mode === "inspect-results") {
    await inspectSearchResults(page);
    return;
  }
  if (options.mode === "inspect-fmp-transcript") {
    const route = new URL(page.url());
    const recordId = route.searchParams.get("id") || "";
    if (provider !== "findmypast" || route.pathname !== "/transcript" || !/^[a-z0-9][a-z0-9._:/-]{2,200}$/i.test(recordId)) {
      throw new Error("Findmypast transcript inspection requires one exact provider transcript ID.");
    }
    const allFacts = await page.locator("main h1, main h2, main h3, main table tr, main dl dt, main dl dd, main p").evaluateAll(elements =>
      [...new Set(elements.map(element => (element.innerText || "").replace(/\s+/g, " ").trim()).filter(Boolean))]);
    const verified = await requireAffinityPage(context, browserSession, options);
    assertSameCollectionTarget(controlled, verified);
    if (page.url() !== route.href) throw new Error("Findmypast transcript changed during inspection.");
    console.log(JSON.stringify({ provider: "Findmypast", recordId, url: `${route.origin}/transcript?id=${encodeURIComponent(recordId)}`, facts: allFacts.slice(0, 500), totalFacts: allFacts.length, truncated: allFacts.length > 500 }));
    return;
  }
  if (options.mode === "inspect-record-facts") {
    await inspectRecordFacts(page);
    return;
  }
  if (options.mode === "inspect-overlays") {
    await inspectOverlays(page);
    return;
  }
  if (options.mode === "select-ancestry-browse") {
    if (provider !== "ancestry") throw new Error("select-ancestry-browse is restricted to Ancestry.");
    assertAncestryBrowseRoute(page.url());
    if (!Array.isArray(options.expectedRowTerms)) {
      throw new Error("select-ancestry-browse requires 2 through 12 exact browse labels in --expected-row-terms.");
    }
    for (const expected of options.expectedRowTerms) {
      const matches = await page.locator("select:visible").evaluateAll((selects, term) => {
        const normalized = String(term).normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase();
        return selects.flatMap((select, selectIndex) => [...select.options]
          .map((option) => ({
            selectIndex,
            value: option.value,
            text: String(option.textContent || "").replace(/\s+/g, " ").trim(),
          }))
          .filter((option) => option.value && option.text.toLocaleLowerCase().includes(normalized)));
      }, expected);
      if (matches.length === 0) {
        const links = await page.locator("a:visible").evaluateAll((anchors, term) => {
          const normalized = String(term).normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase();
          return anchors.map((anchor, anchorIndex) => ({
            anchorIndex,
            text: String(anchor.textContent || "").replace(/\s+/g, " ").trim(),
          })).filter((anchor) => anchor.text.toLocaleLowerCase().includes(normalized));
        }, expected);
        if (links.length !== 1) {
          // Name the visible browse choices so the next call can use an exact label.
          const choices = await page.locator("select:visible").evaluateAll((selects) => selects.flatMap((select) =>
            [...select.options].filter((option) => option.value).map((option) => String(option.textContent || "").replace(/\s+/g, " ").trim().slice(0, 120))));
          throw new Error(`Ancestry browse label must match exactly one option or link; ${JSON.stringify(expected)} matched ${links.length}. Visible browse options (${choices.length}): ${JSON.stringify(choices.slice(-80))}`);
        }
        await page.locator("a:visible").nth(links[0].anchorIndex).click({ timeout: 15_000 });
        await page.waitForTimeout(1_000);
        console.log(`Selected Ancestry browse link: ${links[0].text}`);
        continue;
      }
      const selected = pickAncestryBrowseOption(matches, expected);
      const countOptions = () => page.locator("select:visible").evaluateAll((selects) =>
        selects.reduce((total, select) => total + select.options.length, 0) * 1000 + selects.length);
      const before = await countOptions();
      await page.locator("select:visible").nth(selected.selectIndex).selectOption(selected.value);
      // The next browse level loads asynchronously; wait (bounded) for it to appear.
      for (let waited = 0; waited < 10_000 && await countOptions() === before; waited += 500) await page.waitForTimeout(500);
      console.log(`Selected Ancestry browse label: ${selected.text}`);
    }
    await page.waitForTimeout(1_000);
    const activeUrl = await updateAffinityAfterAction(context, browserSession, options, controlled, options.url);
    console.log(`Activated the exact Ancestry browse route: ${new URL(activeUrl).pathname}${new URL(activeUrl).search}`);
    if (new URL(activeUrl).pathname.startsWith("/imageviewer/")) {
      const identity = await viewerSourceIdentity(page);
      console.log(`Viewer identity: ${identity.hash}; counter=${identity.counter || "not exposed"}; media=${identity.media.width}x${identity.media.height}`);
    }
    await inspectOverlays(page);
    return;
  }
  if (options.mode === "inspect-fmp-browse-results") {
    if (provider !== "findmypast") throw new Error("inspect-fmp-browse-results is restricted to Findmypast routes.");
    await inspectFindmypastBrowseResults(page);
    await inspectOverlays(page);
    return;
  }
  if (options.mode === "inspect-fmp-transcript") {
    if (provider !== "findmypast" || new URL(page.url()).pathname !== "/transcript") {
      throw new Error("inspect-fmp-transcript requires an exact Findmypast transcript page.");
    }
    const transcriptText = (await page.locator("main").innerText()).replace(/\s+/g, " ").trim();
    console.log("Visible exact Findmypast transcript:");
    console.log(transcriptText.slice(0, 12_000));
    await inspectOverlays(page);
    return;
  }
  if (options.mode === "view-fmp-browse-image") {
    if (provider !== "findmypast") throw new Error("view-fmp-browse-image is restricted to Findmypast routes.");
    if (!Array.isArray(options.expectedRowTerms)) {
      throw new Error("view-fmp-browse-image requires --expected-row-terms with 2 through 12 pipe-delimited row terms.");
    }
    const verified = await resolveUniqueFindmypastBrowseRow(page, options.expectedRowTerms);
    console.log(`Verified Findmypast browse row: ${verified.summary.slice(0, 1_000)}`);
    await clickWithoutPopupWindow(
      context,
      browserSession,
      page,
      verified.action,
      provider,
      controlled.windowId,
      { postcondition: findmypastImageViewerReady, connection: options.connection },
    );
    const activeUrl = await updateAffinityAfterAction(context, browserSession, options, controlled, options.url);
    console.log(`Activated the exact Findmypast browse image: ${new URL(activeUrl).pathname}${new URL(activeUrl).search}`);
    await inspectOverlays(page);
    return;
  }
  if (options.mode === "inspect-viewer-identity") {
    const identity = await viewerSourceIdentity(page);
    console.log(`Stable viewer identity: ${identity.hash}`);
    console.log(`Viewer route: ${identity.pathname}${new URLSearchParams(identity.routeKeys).toString() ? `?${new URLSearchParams(identity.routeKeys)}` : ""}`);
    console.log(`Viewer counter: ${identity.counter || "not exposed"}`);
    console.log(`Viewer media: ${identity.media.tag} ${identity.media.width}x${identity.media.height}`);
    return;
  }
  if (options.mode === "capture-viewer-inspection") {
    // --part N (1-3) temporarily makes the viewport N times taller so a tall,
    // narrow register page that the viewer fits to width is drawn whole; the
    // original viewport is always restored. Temporary inspection only.
    const tallFactor = Math.min(3, options.part);
    const originalViewport = tallFactor > 1 ? page.viewportSize() : null;
    let dataUrl = "";
    const screenshotPath = path.join(os.tmpdir(), `family-history-viewer-inspection-${process.pid}-${Date.now()}.png`);
    try {
      if (tallFactor > 1) {
        const base = originalViewport || await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
        await page.setViewportSize({ width: base.width, height: Math.round(base.height * tallFactor) });
        await page.waitForTimeout(1500);
      }
      await stableViewerIdentity(page);
      dataUrl = await page.evaluate(() => {
      const visible = (element) => {
        const style = getComputedStyle(element);
        const bounds = element.getBoundingClientRect();
        return style.visibility !== "hidden" && style.display !== "none" && bounds.width > 1 && bounds.height > 1;
      };
      const canvas = [...document.querySelectorAll("canvas")]
        .filter((element) => visible(element) && !element.closest("header,nav,footer,aside,[role='banner']"))
        .sort((left, right) => {
          const leftBounds = left.getBoundingClientRect();
          const rightBounds = right.getBoundingClientRect();
          return rightBounds.width * rightBounds.height - leftBounds.width * leftBounds.height;
        })[0];
      if (!canvas) return "";
      try { return canvas.toDataURL("image/png"); } catch { return ""; }
      });
    } finally {
      if (tallFactor > 1) {
        if (originalViewport) await page.setViewportSize(originalViewport);
        else await page.context().newCDPSession(page).then((cdp) => cdp.send("Emulation.clearDeviceMetricsOverride")).catch(() => {});
      }
    }
    if (!dataUrl.startsWith("data:image/png;base64,")) {
      throw new Error("The provider viewer source canvas could not be exported for temporary inspection.");
    }
    fs.writeFileSync(screenshotPath, Buffer.from(dataUrl.slice("data:image/png;base64,".length), "base64"));
    console.log(`Temporary viewer inspection screenshot: ${screenshotPath}`);
    return;
  }
  if (options.mode === "acquire-fmp-record-target") {
    if (provider !== "findmypast" || !options.targetId || !options.archiveFile || !options.expectedRecordId) {
      throw new Error("acquire-fmp-record-target requires Findmypast, --target-id, --archive-file, and --expected-record-id.");
    }
    if (options.part !== 1) {
      throw new Error("Each canonical Findmypast packet frame requires its own target ID and acquisition part 1.");
    }
    const target = loadResearchStore().acquisitionTargets.find((item) => item.id === options.targetId);
    if (!findmypastTargetReadyForCapture(target)) {
      throw new Error(`The canonical target is not ready for exact Findmypast capture: ${options.targetId}.`);
    }
    if (!target.recordBinding && target.browseBinding) {
      // An unindexed register frame (no transcript) opened by its exact browse
      // URL: bind to the visually verified viewer id instead of a parent record.
      const browse = target.browseBinding;
      if (!browse.viewerId || !browse.verifiedAt || !browse.verificationBasis) {
        throw new Error(`The canonical target lacks a complete exact Findmypast browse binding: ${options.targetId}.`);
      }
      const viewerId = normalizeFindmypastRecordId(browse.viewerId);
      if (normalizeFindmypastRecordId(options.expectedRecordId) !== viewerId) {
        throw new Error(`The requested record ID does not match the canonical browse binding: ${options.targetId}.`);
      }
      if (!await findmypastImageViewerReady(page)) {
        throw new Error(`The active Findmypast viewer is not ready for ${options.targetId}.`);
      }
      const identity = await viewerSourceIdentity(page);
      const activeViewerId = decodeURIComponent(identity.routeKeys.id || "").toLocaleLowerCase();
      if (activeViewerId !== viewerId) {
        throw new Error(`The active Findmypast frame does not match the canonical browse binding: ${options.targetId}.`);
      }
      await downloadFromViewer(page, options, provider);
      console.log(`Acquired exact Findmypast browse frame for ${options.targetId}; viewer identity=${identity.hash}.`);
      return;
    }
    const binding = target.recordBinding;
    if (!binding?.transcriptId || !binding?.parentId || !binding?.viewerId ||
        !Number.isInteger(binding?.packetPart) || binding.packetPart < 1 ||
        !binding?.verifiedAt || !binding?.verificationBasis) {
      throw new Error(`The canonical target lacks a complete exact Findmypast record binding: ${options.targetId}.`);
    }
    const expected = normalizeFindmypastRecordId(options.expectedRecordId);
    if (normalizeFindmypastRecordId(binding.transcriptId) !== expected ||
        normalizeFindmypastRecordId(binding.parentId) !== expected) {
      throw new Error(`The requested record ID does not match the canonical target binding: ${options.targetId}.`);
    }
    const activeUrl = page.url();
    if (!await findmypastImageViewerReady(page) || !findmypastViewerMatchesRecordId(activeUrl, expected)) {
      throw new Error(`The active Findmypast viewer is not bound to the canonical parent record: ${options.targetId}.`);
    }
    const identity = await viewerSourceIdentity(page);
    const activeViewerId = decodeURIComponent(identity.routeKeys.id || "").toLocaleLowerCase();
    if (activeViewerId !== normalizeFindmypastRecordId(binding.viewerId)) {
      throw new Error(`The active Findmypast frame does not match the canonical viewer binding: ${options.targetId}.`);
    }
    await downloadFromViewer(page, options, provider);
    console.log(`Acquired exact Findmypast packet frame ${binding.packetPart} for ${options.targetId}; viewer identity=${identity.hash}.`);
    return;
  }
  if (options.mode === "acquire-fmp-browse-target") {
    if (provider !== "findmypast") throw new Error("acquire-fmp-browse-target is restricted to Findmypast routes.");
    if (!options.targetId || !options.archiveFile) {
      throw new Error("acquire-fmp-browse-target requires --target-id and --archive-file.");
    }
    const queue = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, "evidence", "subscription-records-queue.json"), "utf8"));
    const target = queue.targets?.find((item) => item.id === options.targetId);
    if (!target) throw new Error(`Unknown subscription target: ${options.targetId}.`);
    if (target.provider !== "Findmypast" || target.status !== "pending-subscription") {
      throw new Error(`The browse target is not a pending Findmypast subscription record: ${options.targetId}.`);
    }
    if (!target.browseBinding?.viewerId || !target.browseBinding?.verificationBasis || !target.peopleVerifiedAt) {
      throw new Error(`The browse target lacks an exact visually verified viewer binding: ${options.targetId}.`);
    }
    const identity = await viewerSourceIdentity(page);
    const activeViewerId = decodeURIComponent(identity.routeKeys.id || "").toLocaleLowerCase();
    if (activeViewerId !== target.browseBinding.viewerId.toLocaleLowerCase()) {
      throw new Error(`The active Findmypast frame does not match the queue-bound viewer for ${options.targetId}.`);
    }
    const catalogue = new URL(target.catalogueUrl);
    const catalogueViewerId = decodeURIComponent(catalogue.searchParams.get("id") || "").toLocaleLowerCase();
    if (catalogueViewerId !== activeViewerId) {
      throw new Error(`The target catalogue URL does not match its active Findmypast browse frame: ${options.targetId}.`);
    }
    await downloadFromViewer(page, options, provider);
    console.log(`Acquired and registered exact browse-bound target ${options.targetId}; viewer identity=${identity.hash}.`);
    return;
  }
  if (options.mode === "inspect-fmp-structure") {
    if (provider !== "findmypast") {
      throw new Error("inspect-fmp-structure is restricted to Findmypast routes.");
    }
    if (!Array.isArray(options.expectedRowTerms)) {
      throw new Error("inspect-fmp-structure requires --expected-row-terms with 2 through 12 pipe-delimited row terms.");
    }
    await inspectFindmypastResultStructure(page, options.expectedRowTerms);
    return;
  }
  if (options.mode === "inspect-fmp-search-summary") {
    if (provider !== "findmypast") {
      throw new Error("inspect-fmp-search-summary is restricted to Findmypast routes.");
    }
    await inspectFindmypastSearchSummary(page);
    await inspectOverlays(page);
    return;
  }
  if (options.mode === "inspect-record-source-links") {
    await inspectRecordSourceLinks(page);
    return;
  }
  if (options.mode === "inspect-external-record-source") {
    await inspectExternalRecordSource(context, browserSession, controlled);
    return;
  }
  if (options.mode === "record-links") {
    const links = await page.locator("a[href]").evaluateAll((elements) => elements.slice(0, 240).map((element) => ({
      text: (element.innerText || element.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim(),
      href: element.href,
    })).filter((item) => item.text && item.href));
    for (const link of links) {
      try {
        assertProviderUrl(link.href, provider);
        console.log(`${link.text.slice(0, 180)} -> ${summarizeUrl(link.href)}`);
      } catch {}
    }
    return;
  }
  if (options.mode === "inspect-view-action") {
    const candidates = await page.getByRole("link").allTextContents();
    const visible = candidates.map((value) => value.replace(/\s+/g, " ").trim())
      .filter((value) => /^View(?: image| Image| original record| record| transcript)?$/i.test(value));
    console.log(visible.length ? `Visible view actions: ${visible.join(" | ")}` : "No provider view action is visible.");
    return;
  }
  if ([
    "inspect-fmp-result",
    "view-fmp-result-transcript",
    "view-fmp-result-image",
    "inspect-fmp-result-id",
    "view-fmp-result-transcript-id",
    "view-fmp-result-image-id",
  ].includes(options.mode)) {
    if (provider !== "findmypast") {
      throw new Error(`${options.mode} is restricted to Findmypast routes.`);
    }
    if (!Array.isArray(options.expectedRowTerms)) {
      throw new Error(`${options.mode} requires --expected-row-terms with 2 through 12 pipe-delimited row terms.`);
    }
    const byRecordId = options.mode.endsWith("-id");
    if (byRecordId && !options.expectedRecordId) {
      throw new Error(`${options.mode} requires --expected-record-id.`);
    }
    const verified = byRecordId
      ? await resolveFindmypastResultRowByRecordId(page, options.expectedRowTerms, options.expectedRecordId)
      : await resolveUniqueFindmypastResultRow(page, options.expectedRowTerms);
    console.log(`Verified Findmypast result row: ${verified.summary.slice(0, 1_000)}`);
    if (verified.recordId) console.log(`Verified Findmypast record ID: ${verified.recordId}`);
    console.log(`Verified-row actions: ${verified.actionLabels.join(" | ")}`);
    if (["inspect-fmp-result", "inspect-fmp-result-id"].includes(options.mode)) {
      await inspectOverlays(page);
      return;
    }
    const actionLabel = options.mode.includes("image") ? "View image" : "View transcript";
    const action = verified.actions.get(actionLabel);
    if (!action) {
      throw new Error(`The uniquely verified Findmypast result row exposed no visible ${actionLabel} action.`);
    }
    const activate = byRecordId ? (locator) => locator.evaluate(activateBoundFindmypastAction, {
      expectedTerms: options.expectedRowTerms,
      recordId: options.expectedRecordId,
      actionLabel,
    }) : null;
    await clickWithoutPopupWindow(
      context,
      browserSession,
      page,
      action,
      provider,
      controlled.windowId,
      options.mode.includes("image") ? {
        connection: options.connection,
        followDirectHref: !byRecordId,
        activate,
        postcondition: byRecordId
          ? async (page, activeUrl) => await findmypastImageViewerReady(page) &&
            findmypastViewerMatchesRecordId(activeUrl, options.expectedRecordId)
          : findmypastImageViewerReady,
      } : {
        followDirectHref: !byRecordId, connection: options.connection, activate,
        postcondition: byRecordId
          ? async (_page, activeUrl) => findmypastTranscriptMatchesRecordId(activeUrl, options.expectedRecordId)
          : null,
      },
    );
    const activeUrl = await updateAffinityAfterAction(context, browserSession, options, controlled, options.url);
    console.log(`Activated ${actionLabel} for the uniquely verified Findmypast row: ${summarizeUrl(activeUrl)}`);
    await inspectOverlays(page);
    return;
  }
  if (["view-image", "view-transcript", "view-article"].includes(options.mode)) {
    if (provider === "findmypast" && /\/search\/results\/?$/i.test(new URL(page.url()).pathname) &&
        ["view-image", "view-transcript"].includes(options.mode)) {
      throw new Error(
        "Generic Findmypast result-page actions are disabled. Use view-fmp-result-image or " +
        "view-fmp-result-transcript with bounded --expected-row-terms.",
      );
    }
    const names = options.mode === "view-image"
      ? ["View image", "View Image", "View original record", /^View .+/]
      : options.mode === "view-transcript"
        ? ["View transcript", "View record", "View Record"]
        : [/Added on.*\b(?:18|19|20)\d{2}\b/i];
    const locator = await namedLocator(page, names, index, ["link", "button"]);
    if (!locator) throw new Error(`No unique ${options.mode} control was found at result index ${index}.`);
    await clickWithoutPopupWindow(
      context,
      browserSession,
      page,
      locator,
      provider,
      controlled.windowId,
      { connection: options.connection },
    );
    const activeUrl = await updateAffinityAfterAction(context, browserSession, options, controlled, options.url);
    console.log(`Activated ${options.mode} in the existing background task tab: ${summarizeUrl(activeUrl)}`);
    return;
  }
  if (["zoom-in", "zoom-out"].includes(options.mode)) {
    const label = options.mode === "zoom-in" ? "Zoom in" : "Zoom out";
    for (let step = 1; step <= options.part; step += 1) {
      const locator = await namedLocator(page, [label], 1, ["button"], { unique: true });
      if (!locator) throw new Error(`The provider viewer exposed no unique ${label} control.`);
      await locator.click({ timeout: 15_000 });
    }
    console.log(`${label} activated ${options.part} bounded time(s) in the background viewer.`);
    return;
  }
  if (options.mode === "image-tools") {
    const names = provider === "findmypast" ? ["Expand image tools"] : ["Tool menu"];
    const locator = await namedLocator(page, names, 1, ["button"]);
    if (!locator) throw new Error("The provider viewer exposed no image-tools control.");
    await locator.click({ timeout: 15_000 });
    console.log("Expanded the provider image tools without foregrounding Chrome.");
    return;
  }
  if (options.mode === "next-image") {
    const previousIdentity = await stableViewerIdentity(page);
    const locator = await namedLocator(page, ["Next image", "Next", /next/i], 1, ["button", "link"]);
    if (!locator) throw new Error("The provider viewer exposed no next-image control.");
    await locator.click({ timeout: 15_000 });
    await waitForViewerIdentityChange(page, provider, previousIdentity);
    await updateAffinityAfterAction(context, browserSession, options, controlled, options.url);
    console.log("Advanced the provider viewer by one image without foregrounding Chrome.");
    await inspectOverlays(page);
    return;
  }
  if (options.mode === "next-fmp-image-id") {
    if (provider !== "findmypast" || !options.expectedRecordId) {
      throw new Error("next-fmp-image-id requires Findmypast and --expected-record-id.");
    }
    const previousUrl = page.url();
    if (!await findmypastImageViewerReady(page) ||
        !findmypastViewerMatchesRecordId(previousUrl, options.expectedRecordId)) {
      throw new Error("The current Findmypast viewer is not bound to the exact expected record ID.");
    }
    const previousIdentity = await stableViewerIdentity(page);
    const locator = await namedLocator(page, ["Next image", "Next", /next/i], 1, ["button", "link"], { unique: true });
    if (!locator) throw new Error("The bound Findmypast viewer exposed no unique next-image control.");
    await locator.click({ timeout: 15_000 });
    await waitForViewerIdentityChange(page, provider, previousIdentity);
    const activeUrl = await waitForProviderPage(page, provider);
    if (!await findmypastImageViewerReady(page) ||
        !findmypastViewerMatchesRecordId(activeUrl, options.expectedRecordId)) {
      await page.goto(previousUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await stableViewerIdentity(page);
      throw new Error("The next image crossed the exact Findmypast parent-record boundary; the prior bound frame was restored.");
    }
    await updateAffinityAfterAction(context, browserSession, options, controlled, options.url);
    const identity = await viewerSourceIdentity(page);
    console.log(`Advanced within exact Findmypast parent ${options.expectedRecordId}: ${new URL(activeUrl).pathname}${new URL(activeUrl).search}; identity=${identity.hash}`);
    await inspectOverlays(page);
    return;
  }
  if (options.mode === "previous-image") {
    const previousIdentity = await stableViewerIdentity(page);
    const locator = await namedLocator(page, ["Previous image", "Previous", /previous/i], 1, ["button", "link"]);
    if (!locator) throw new Error("The provider viewer exposed no previous-image control.");
    await locator.click({ timeout: 15_000 });
    await waitForViewerIdentityChange(page, provider, previousIdentity);
    await updateAffinityAfterAction(context, browserSession, options, controlled, options.url);
    console.log("Moved the provider viewer back by one image without foregrounding Chrome.");
    await inspectOverlays(page);
    return;
  }
  if (options.mode === "advance-images") {
    for (let advance = 1; advance <= options.part; advance += 1) {
      const previousIdentity = await stableViewerIdentity(page);
      const locator = await namedLocator(page, ["Next image", "Next", /next/i], 1, ["button", "link"]);
      if (!locator) throw new Error(`The provider viewer exposed no next-image control at bounded advance ${advance}.`);
      await locator.click({ timeout: 15_000 });
      await waitForViewerIdentityChange(page, provider, previousIdentity);
      const activeUrl = await updateAffinityAfterAction(context, browserSession, options, controlled, options.url);
      const identity = await viewerSourceIdentity(page);
      console.log(`Advanced image ${advance}/${options.part}: ${new URL(activeUrl).pathname}${new URL(activeUrl).search}; identity=${identity.hash}`);
      await inspectOverlays(page);
    }
    return;
  }
  if (["select-image-region", "capture-full-page", "download-clipping", "extra-materials"].includes(options.mode)) {
    const namesByMode = {
      "select-image-region": ["Activate selection of an image region"],
      "capture-full-page": ["Capture full page"],
      "download-clipping": ["Download"],
      "extra-materials": [/Extra materials/i],
    };
    const locator = await namedLocator(page, namesByMode[options.mode], 1, ["button", "link"]);
    if (!locator) throw new Error(`The provider exposed no unique ${options.mode} control.`);
    await locator.click({ timeout: 15_000 });
    console.log(`Activated ${options.mode} without foregrounding Chrome.`);
    return;
  }
  if (["download-record", "preview-download"].includes(options.mode)) {
    if (options.mode === "preview-download" && (!options.targetId || !options.archiveFile)) {
      throw new Error("Unarchived preview downloads are disabled; provide --target-id and --archive-file so every relevant original is preserved.");
    }
    await downloadFromViewer(page, options, provider);
    console.log(`Downloaded, EFS-archived, hashed, manifested, and registered ${options.targetId}.`);
    return;
  }
  if (options.mode === "signin-saved") {
    // Guarded helper: submits only a sign-in form Chrome has visibly
    // autofilled; MFA, CAPTCHA, account choice or a missing saved password
    // stays a human step. Never reads either field value.
    const outcome = await trySavedSignIn(page, provider, { log: (message) => console.log(message) });
    if (outcome.status === "needs-user") process.exitCode = 3;
    return;
  }
  if (options.mode === "adopt-viewer") {
    const title = await page.title();
    if (options.expectedTabTitle && !title.includes(options.expectedTabTitle.replace(/ - Memory usage - \d+ MB$/, ""))) {
      throw new Error("The current background task tab does not match the expected viewer title.");
    }
    console.log("The current affinity already identifies the exact CDP viewer tab; no foreground adoption was needed.");
    return;
  }
  throw new Error(`Background CDP mode is not implemented: ${options.mode}`);
}

function ancestrySourceBinding(rawUrl) {
  const parsed = new URL(rawUrl);
  const recordIdParameter = [...parsed.searchParams.entries()]
    .find(([key]) => key.toLocaleLowerCase() === "pid")?.[1] || "";
  const record = parsed.pathname.match(/^\/search\/collections\/(\d+)\/records\/(\d+)\/?$/i);
  if (record) return { kind: "record", collectionId: record[1], recordId: record[2] };
  const viewer = parsed.pathname.match(/^\/imageviewer\/collections\/(\d+)\/images\/([^/]+)\/?$/i);
  if (viewer) {
    return {
      kind: "viewer",
      collectionId: viewer[1],
      imageId: decodeURIComponent(viewer[2]),
      recordId: recordIdParameter,
    };
  }
  return null;
}

function ancestryViewerMatchesTarget(activeUrl, targetUrl) {
  const expected = ancestrySourceBinding(targetUrl);
  const active = ancestrySourceBinding(activeUrl);
  if (!expected || !active || active.kind !== "viewer" || active.collectionId !== expected.collectionId) return false;
  if (expected.recordId && active.recordId !== expected.recordId) return false;
  if (expected.kind === "viewer" && active.imageId !== expected.imageId) return false;
  return true;
}

async function findmypastImageViewerReady(page) {
  const title = await page.title();
  if (!/\bImage\s*\|\s*findmypast\.(?:com|co\.uk)\b/i.test(title)) return false;
  return Boolean(await viewerSourceIdentity(page).catch(() => null));
}

async function findUniqueFindmypastCollapsedRow(page, expectedTerms) {
  const deadline = Date.now() + 15_000;
  const observed = new Set();
  let stableSignature = "";
  let stableSamples = 0;
  let lastError = null;
  do {
    const controls = await visibleMatches(page.getByRole("button"));
    const candidates = [];
    for (const [controlIndex, control] of controls.entries()) {
      const metadata = await control.evaluate((element, terms) => {
        const normalize = (value) => String(value || "").normalize("NFKC")
          .replace(/\s+/g, " ").trim().toLocaleLowerCase();
        const label = (candidate) => candidate.getAttribute("aria-label") ||
          candidate.innerText || candidate.textContent || "";
        const text = label(element).replace(/\s+/g, " ").trim();
        if (!terms.every((term) => normalize(text).includes(term))) return null;
        const actions = [...element.querySelectorAll("a,button")];
        const actionLabels = actions.map((candidate) => normalize(label(candidate)));
        return {
          depth: 0,
          boundaryStrength: "composite-button",
          text,
          genericViewActions: actionLabels.filter((value) => value === "view").length,
          nestedMatchingCompositeActions: actions.filter((candidate) =>
            terms.every((term) => normalize(label(candidate)).includes(term)),
          ).length,
          transcriptActions: actionLabels.filter((value) => value === "view transcript").length,
          imageActions: actionLabels.filter((value) => value === "view image").length,
        };
      }, normalizeExpectedRowTerms(expectedTerms).map(normalizedResultText));
      if (metadata?.text) {
        candidates.push({ ...metadata, controlIndex });
        observed.add(metadata.text.slice(0, 500));
      }
    }
    try {
      const selected = selectUniqueFindmypastResultCandidate(candidates, expectedTerms);
      const signature = crypto.createHash("sha256").update(JSON.stringify({
        text: normalizedResultText(selected.text),
        boundaryStrength: selected.boundaryStrength,
        genericViewActions: selected.genericViewActions,
        nestedMatchingCompositeActions: selected.nestedMatchingCompositeActions,
        transcriptActions: selected.transcriptActions,
        imageActions: selected.imageActions,
      })).digest("hex");
      if (signature === stableSignature) stableSamples += 1;
      else {
        stableSignature = signature;
        stableSamples = 1;
      }
      if (stableSamples >= 3) {
        const container = controls[selected.controlIndex];
        const expanders = await visibleMatches(container.getByRole("button", { name: "View", exact: true }));
        if (expanders.length !== 1) {
          throw new Error("The unique composite Findmypast result no longer owned exactly one visible generic View action.");
        }
        return { control: expanders[0], container, summary: selected.text };
      }
      lastError = null;
    } catch (error) {
      if (!/^No bounded Findmypast result row/.test(error.message)) {
        const detail = [...observed].slice(0, 12);
        throw new Error(`${error.message}${detail.length ? ` Observed bounded rows: ${detail.join(" || ")}` : ""}`);
      }
      lastError = error;
      stableSignature = "";
      stableSamples = 0;
    }
    await sleep(100);
  } while (Date.now() < deadline);
  const detail = [...observed].slice(0, 12);
  throw new Error(`${lastError?.message || "No stable bounded Findmypast result row was available."}` +
    `${detail.length ? ` Observed bounded rows: ${detail.join(" || ")}` : ""}`);
}

async function findUniqueFindmypastTableActionRow(page, expectedTerms, timeoutMilliseconds = 5_000) {
  const deadline = Date.now() + timeoutMilliseconds;
  let stableSignature = "";
  let stableSamples = 0;
  let lastError = null;
  do {
    const rows = await page.locator("tr").all();
    const candidates = [];
    for (const [rowIndex, row] of rows.entries()) {
      const metadata = await row.evaluate((element) => {
        const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
        const label = (candidate) => candidate.getAttribute("aria-label") ||
          candidate.innerText || candidate.textContent || "";
        const table = element.closest("table");
        const headers = [...(table?.querySelectorAll("thead th") || [])].map((cell) => clean(label(cell)));
        const cells = [...element.children].map((cell) => clean(label(cell)));
        const fields = new Map();
        for (let index = 0; index < Math.min(headers.length, cells.length); index += 1) {
          const header = headers[index];
          const cell = cells[index];
          const value = cell.toLocaleLowerCase().startsWith(header.toLocaleLowerCase())
            ? cell.slice(header.length).trim()
            : cell;
          fields.set(header.toLocaleLowerCase(), value);
        }
        const actions = [...element.querySelectorAll("a,button")];
        const actionLabels = actions.map((candidate) => clean(label(candidate)).toLocaleLowerCase());
        const transcriptActions = actionLabels.filter((value) => value === "view transcript").length;
        const imageActions = actionLabels.filter((value) => value === "view image").length;
        if (transcriptActions + imageActions === 0) return null;
        const text = [...fields.entries()]
          .filter(([, value]) => value)
          .map(([header, value]) => `${header} ${value}`)
          .join(" ");
        return {
          boundaryStrength: "semantic-table-row",
          text,
          transcriptActions,
          imageActions,
        };
      });
      if (metadata?.text) candidates.push({ ...metadata, rowIndex });
    }
    try {
      const selected = selectUniqueFindmypastActionRow(candidates, expectedTerms);
      const signature = crypto.createHash("sha256").update(JSON.stringify({
        text: normalizedResultText(selected.text),
        transcriptActions: selected.transcriptActions,
        imageActions: selected.imageActions,
      })).digest("hex");
      if (signature === stableSignature) stableSamples += 1;
      else {
        stableSignature = signature;
        stableSamples = 1;
      }
      if (stableSamples >= 3) {
        return { container: rows[selected.rowIndex], summary: selected.text };
      }
      lastError = null;
    } catch (error) {
      if (!/^No semantic Findmypast result row/.test(error.message)) throw error;
      lastError = error;
      stableSignature = "";
      stableSamples = 0;
    }
    await sleep(100);
  } while (Date.now() < deadline);
  throw lastError || new Error("No stable semantic Findmypast result row was available.");
}

async function findUniqueFindmypastTableActionRowByRecordId(
  page,
  expectedTerms,
  expectedRecordId,
  timeoutMilliseconds = 5_000,
) {
  const deadline = Date.now() + timeoutMilliseconds;
  let stableSignature = "";
  let stableSamples = 0;
  let lastError = null;
  do {
    const rows = await page.locator("tr").all();
    const candidates = [];
    for (const [rowIndex, row] of rows.entries()) {
      const metadata = await row.evaluate((element) => {
        const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
        const label = (candidate) => candidate.getAttribute("aria-label") ||
          candidate.innerText || candidate.textContent || "";
        const table = element.closest("table");
        const headers = [...(table?.querySelectorAll("thead th") || [])].map((cell) => clean(label(cell)));
        const cells = [...element.children].map((cell) => clean(label(cell)));
        const fields = new Map();
        for (let index = 0; index < Math.min(headers.length, cells.length); index += 1) {
          const header = headers[index];
          const cell = cells[index];
          const value = cell.toLocaleLowerCase().startsWith(header.toLocaleLowerCase())
            ? cell.slice(header.length).trim()
            : cell;
          fields.set(header.toLocaleLowerCase(), value);
        }
        const actions = [...element.querySelectorAll("a,button")];
        const actionMetadata = actions.map((candidate) => {
          const actionLabel = clean(label(candidate)).toLocaleLowerCase();
          let recordId = "";
          if (candidate.tagName.toLocaleLowerCase() === "a" && candidate.href) {
            try {
              const actionUrl = new URL(candidate.href, location.href);
              const safeHost = /^(?:www\.)?findmypast\.(?:com|co\.uk)$/i.test(actionUrl.hostname);
              if (safeHost && /^\/transcript\/?$/i.test(actionUrl.pathname)) {
                recordId = actionUrl.searchParams.get("id") || "";
              }
            } catch {}
          }
          return { actionLabel, recordId };
        });
        const transcriptActions = actionMetadata.filter(({ actionLabel }) => actionLabel === "view transcript");
        const imageActions = actionMetadata.filter(({ actionLabel }) => actionLabel === "view image");
        if (transcriptActions.length + imageActions.length === 0) return null;
        const text = [...fields.entries()]
          .filter(([, value]) => value)
          .map(([header, value]) => `${header} ${value}`)
          .join(" ");
        return {
          boundaryStrength: "semantic-table-row",
          text,
          transcriptActions: transcriptActions.length,
          imageActions: imageActions.length,
          transcriptRecordIds: transcriptActions.map(({ recordId }) => recordId).filter(Boolean),
          imageRecordIds: imageActions.map(({ recordId }) => recordId).filter(Boolean),
        };
      });
      if (metadata?.text) candidates.push({ ...metadata, rowIndex });
    }
    try {
      const selected = selectUniqueFindmypastActionRowByRecordId(
        candidates,
        expectedTerms,
        expectedRecordId,
      );
      const signature = crypto.createHash("sha256").update(JSON.stringify({
        text: normalizedResultText(selected.text),
        transcriptActions: selected.transcriptActions,
        imageActions: selected.imageActions,
        transcriptRecordIds: selected.transcriptRecordIds,
        imageRecordIds: selected.imageRecordIds,
      })).digest("hex");
      if (signature === stableSignature) stableSamples += 1;
      else {
        stableSignature = signature;
        stableSamples = 1;
      }
      if (stableSamples >= 3) {
        return { container: rows[selected.rowIndex], summary: selected.text, recordId: expectedRecordId };
      }
      lastError = null;
    } catch (error) {
      if (!/^No semantic Findmypast result row/.test(error.message)) throw error;
      lastError = error;
      stableSignature = "";
      stableSamples = 0;
    }
    await sleep(100);
  } while (Date.now() < deadline);
  throw lastError || new Error("No stable semantic Findmypast record-ID row was available.");
}

async function findUniqueFindmypastActionContainer(composite, expectedTerms, timeoutMilliseconds = 15_000) {
  const deadline = Date.now() + timeoutMilliseconds;
  let stableSignature = "";
  let stableSamples = 0;
  do {
    const boundary = await composite.evaluate((element, terms) => {
      const normalize = (value) => String(value || "").normalize("NFKC")
        .replace(/\s+/g, " ").trim().toLocaleLowerCase();
      const label = (candidate) => candidate.getAttribute("aria-label") ||
        candidate.innerText || candidate.textContent || "";
      for (let depth = 0, current = element; depth <= 12 && current; depth += 1, current = current.parentElement) {
        const actions = [...current.querySelectorAll("a,button")];
        const labels = actions.map((candidate) => normalize(label(candidate)));
        const transcriptActions = labels.filter((value) => value === "view transcript").length;
        const imageActions = labels.filter((value) => value === "view image").length;
        if (transcriptActions + imageActions === 0) continue;
        const compositeActions = actions.filter((candidate) => {
          if (candidate.tagName.toLocaleLowerCase() !== "button") return false;
          const candidateText = normalize(label(candidate));
          if (!terms.every((term) => candidateText.includes(term))) return false;
          return [...candidate.querySelectorAll("a,button")].filter((nested) =>
            normalize(label(nested)) === "view",
          ).length === 1;
        }).length;
        return {
          depth,
          compositeActions,
          genericViewActions: labels.filter((value) => value === "view").length,
          transcriptActions,
          imageActions,
        };
      }
      return null;
    }, normalizeExpectedRowTerms(expectedTerms).map(normalizedResultText));
    if (!boundary) {
      stableSignature = "";
      stableSamples = 0;
      await sleep(100);
      continue;
    }
    assertSafeFindmypastActionBoundary(boundary);
    const signature = JSON.stringify(boundary);
    if (signature === stableSignature) stableSamples += 1;
    else {
      stableSignature = signature;
      stableSamples = 1;
    }
    if (stableSamples >= 3) {
      let container = composite;
      for (let depth = 0; depth < boundary.depth; depth += 1) container = container.locator("..");
      return container;
    }
    await sleep(100);
  } while (Date.now() < deadline);
  throw new Error("The unique composite Findmypast result did not settle inside a single-row action boundary.");
}

async function exactFindmypastRowActions(container) {
  const controls = await container.locator("a,button").all();
  const actions = new Map();
  for (const control of controls) {
    const label = await control.evaluate((element) =>
      (element.getAttribute("aria-label") || element.innerText || element.textContent || "")
        .replace(/\s+/g, " ").trim(),
    );
    if (!["View transcript", "View image"].includes(label)) continue;
    if (actions.has(label)) {
      throw new Error(`The verified Findmypast result boundary exposes more than one ${label} action.`);
    }
    actions.set(label, control);
  }
  if (actions.size === 0) {
    throw new Error("The verified Findmypast result boundary exposes no transcript or image action.");
  }
  return actions;
}

function findmypastResolvedResult(row, actions) {
  if (!row?.summary) throw new Error("The resolved Findmypast row has no summary.");
  return {
    summary: row.summary,
    actions,
    actionLabels: [...actions.keys()],
  };
}

async function resolveUniqueFindmypastResultRow(page, expectedTerms) {
  try {
    const semanticRow = await findUniqueFindmypastTableActionRow(page, expectedTerms);
    const actions = await exactFindmypastRowActions(semanticRow.container);
    return findmypastResolvedResult(semanticRow, actions);
  } catch (error) {
    if (!/^No semantic Findmypast result row/.test(error.message)) throw error;
  }

  const row = await findUniqueFindmypastCollapsedRow(page, expectedTerms);
  const container = await findUniqueFindmypastActionContainer(row.container, expectedTerms);
  const actions = await exactFindmypastRowActions(container);
  return findmypastResolvedResult(row, actions);
}

async function resolveFindmypastResultRowByRecordId(page, expectedTerms, expectedRecordId) {
  const semanticRow = await findUniqueFindmypastTableActionRowByRecordId(
    page,
    expectedTerms,
    expectedRecordId,
  );
  const actions = await exactFindmypastRowActions(semanticRow.container);
  return { ...findmypastResolvedResult(semanticRow, actions), recordId: expectedRecordId };
}

async function exactAncestryViewerLocator(page, targetUrl) {
  const candidates = await visibleMatches(page.locator('a[href*="/imageviewer/collections/"]'));
  const matches = [];
  for (const candidate of candidates) {
    const href = await candidate.getAttribute("href");
    if (!href) continue;
    let absolute;
    try { absolute = new URL(href, page.url()).href; } catch { continue; }
    if (ancestryViewerMatchesTarget(absolute, targetUrl)) matches.push(candidate);
  }
  return matches.length === 1 ? matches[0] : null;
}

async function acquireAncestryTarget(context, browserSession, options, queueTarget) {
  const rawUrl = queueTarget.catalogueUrl;
  if (!ancestrySourceBinding(rawUrl)) {
    throw new Error(`Ancestry target has no supported exact record/viewer binding: ${options.targetId}.`);
  }
  const controlled = await openInAffinity(context, browserSession, options, rawUrl);
  if (!ancestryViewerMatchesTarget(controlled.page.url(), rawUrl)) {
    let view = await namedLocator(
      controlled.page,
      ["View image", "View Image", "View original record"],
      1,
      ["link", "button"],
      { unique: true },
    );
    view ||= await exactAncestryViewerLocator(controlled.page, rawUrl);
    if (!view) throw new Error(`Ancestry exposed no current-record image action for ${options.targetId}.`);
    await clickWithoutPopupWindow(
      context,
      browserSession,
      controlled.page,
      view,
      "ancestry",
      controlled.windowId,
      {
        postcondition: (page, activeUrl) => ancestryViewerMatchesTarget(activeUrl, rawUrl),
        connection: options.connection,
      },
    );
    await updateAffinityAfterAction(context, browserSession, options, controlled);
  }
  if (!ancestryViewerMatchesTarget(controlled.page.url(), rawUrl)) {
    throw new Error(`Ancestry did not expose the exact collection/record-bound viewer for ${options.targetId}.`);
  }
  await stableViewerIdentity(controlled.page);
  await downloadFromViewer(controlled.page, options, "ancestry");
  console.log(`Acquired and registered ${options.targetId} through the background Windows Chrome profile.`);
}

async function findVerifiedResultControl(page, controlName, matchTerms, timeoutMilliseconds = 20_000) {
  const controls = page.getByRole("link", { name: controlName, exact: true })
    .or(page.getByRole("button", { name: controlName, exact: true }));
  const observed = new Set();
  const deadline = Date.now() + timeoutMilliseconds;
  let stableSignature = "";
  let stableSamples = 0;
  let maximumMatchCount = 0;
  let unsafeBoundarySeen = false;
  do {
    const visibleControls = await visibleMatches(controls);
    const matches = [];
    let currentUnsafeBoundary = false;
    for (const control of visibleControls) {
      const result = await control.evaluate((element, terms) => {
        let current = element;
        let nearestBoundedText = "";
        for (let depth = 1; depth <= 12 && current.parentElement; depth += 1) {
          current = current.parentElement;
          const tag = current.tagName.toLocaleLowerCase();
          const role = (current.getAttribute("role") || "").toLocaleLowerCase();
          const semanticIdentity = [
            current.getAttribute("class") || "",
            current.getAttribute("id") || "",
            current.getAttribute("data-testid") || "",
            current.getAttribute("data-qa") || "",
          ].join(" ").toLocaleLowerCase();
          const strongBoundary = tag === "tr" || role === "row" ||
            /(?:^|[\s_-])(?:search-result|record-result|result-item|result-row|record-card|record-row)(?:[\s_-]|$)/.test(semanticIdentity);
          const weakBoundary = ["article", "li"].includes(tag) || ["article", "listitem"].includes(role);
          if (!strongBoundary && !weakBoundary) continue;
          const text = (current.innerText || current.textContent || "").replace(/\s+/g, " ").trim();
          if (!text || text.length > 12_000) continue;
          nearestBoundedText ||= text;
          const viewImageActions = [...current.querySelectorAll("a,button")].filter((candidate) => {
            const label = candidate.getAttribute("aria-label") || candidate.innerText || candidate.textContent || "";
            return label.replace(/\s+/g, " ").trim().toLocaleLowerCase() === "view image";
          }).length;
          if (viewImageActions > 1) {
            return { depth, text, matched: false, unsafeAggregate: true };
          }
          const residualText = text.replace(/\bview image\b/ig, "").trim();
          if (viewImageActions !== 1 || (weakBoundary && !strongBoundary && residualText.length < 20)) continue;
          const normalized = text.toLocaleLowerCase();
          return {
            depth,
            text,
            matched: terms.every((term) => normalized.includes(String(term).toLocaleLowerCase())),
            unsafeAggregate: false,
          };
        }
        return nearestBoundedText ? { depth: 0, text: nearestBoundedText, matched: false, unsafeAggregate: false } : null;
      }, matchTerms);
      if (!result) continue;
      observed.add(result.text.slice(0, 800));
      if (result.unsafeAggregate) {
        unsafeBoundarySeen = true;
        currentUnsafeBoundary = true;
        continue;
      }
      if (!result.matched) continue;
      let container = control;
      for (let depth = 0; depth < result.depth; depth += 1) container = container.locator("..");
      matches.push({ control, container, text: result.text });
    }
    maximumMatchCount = Math.max(maximumMatchCount, matches.length);
    if (matches.length === 1 && !currentUnsafeBoundary) {
      const signature = crypto.createHash("sha256").update(matches[0].text).digest("hex");
      if (signature === stableSignature) stableSamples += 1;
      else {
        stableSignature = signature;
        stableSamples = 1;
      }
      if (stableSamples >= 3) {
        return {
          control: matches[0].control,
          container: matches[0].container,
          observed: [...observed],
          matchCount: 1,
          unsafeBoundary: false,
        };
      }
    } else {
      stableSignature = "";
      stableSamples = 0;
    }
    await sleep(100);
  } while (Date.now() < deadline);
  if (!observed.size) {
    const allLabels = await controls.allTextContents();
    for (const label of allLabels.map((value) => value.replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 12)) observed.add(label);
  }
  return {
    control: null,
    container: null,
    observed: [...observed],
    matchCount: maximumMatchCount,
    unsafeBoundary: unsafeBoundarySeen,
  };
}

async function viewerSourceIdentity(page) {
  const state = await page.evaluate(() => {
    const isVisible = (element) => {
      const style = getComputedStyle(element);
      const bounds = element.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && bounds.width > 1 && bounds.height > 1;
    };
    const candidates = [...document.querySelectorAll("canvas,img")]
      .filter((element) => {
        if (!isVisible(element)) return false;
        if (element.closest("header,nav,footer,aside,[role='banner']")) return false;
        const identity = [
          element.getAttribute("class") || "",
          element.getAttribute("id") || "",
          element.getAttribute("alt") || "",
          element.closest("[class],[id]")?.getAttribute("class") || "",
          element.closest("[class],[id]")?.getAttribute("id") || "",
        ].join(" ").toLocaleLowerCase();
        return !/(?:^|[\s_-])(?:advert|advertisement|banner|logo|avatar|icon)(?:[\s_-]|$)/.test(identity);
      })
      .map((element) => {
        const bounds = element.getBoundingClientRect();
        const descriptor = {
          element,
          tag: element.tagName.toLocaleLowerCase(),
          area: Math.round(bounds.width * bounds.height),
          centerX: bounds.left + bounds.width / 2,
          centerY: bounds.top + bounds.height / 2,
          width: element.width || 0,
          height: element.height || 0,
          source: element.currentSrc || element.src || "",
          ancestry: [],
          sample: "",
        };
        let current = element;
        for (let depth = 0; depth < 6 && current; depth += 1, current = current.parentElement) {
          descriptor.ancestry.push([
            current.getAttribute?.("aria-valuenow") || "",
            current.getAttribute?.("data-page") || "",
            current.getAttribute?.("data-index") || "",
            current.getAttribute?.("data-image-index") || "",
            current.getAttribute?.("data-image-id") || "",
          ]);
        }
        try {
          const sampler = document.createElement("canvas");
          sampler.width = 64;
          sampler.height = 64;
          sampler.getContext("2d").drawImage(element, 0, 0, 64, 64);
          descriptor.sample = sampler.toDataURL("image/jpeg", 0.35);
        } catch {}
        return descriptor;
      })
      .filter((item) => item.area >= 25_000)
      .sort((left, right) => right.area - left.area);
    const primary = candidates[0] || null;
    if (!primary) return null;
    const counters = [...document.querySelectorAll("body *")]
      .filter((element) => {
        const candidate = element.textContent || "";
        return candidate.length <= 40 && /^\s*\d+\s*(?:of|\/)\s*\d+\s*$/i.test(candidate) && isVisible(element);
      })
      .map((element) => {
        const bounds = element.getBoundingClientRect();
        const centerX = bounds.left + bounds.width / 2;
        const centerY = bounds.top + bounds.height / 2;
        return {
          text: (element.textContent || "").replace(/\s+/g, " ").trim(),
          distance: Math.hypot(centerX - primary.centerX, centerY - primary.centerY),
        };
      })
      .sort((left, right) => left.distance - right.distance);
    const counter = counters[0]?.distance < 1_200 ? counters[0].text : "";
    const { element, centerX, centerY, ...media } = primary;
    return { counter, media };
  });
  if (!state?.media) {
    const error = new Error("The provider viewer exposed no identifiable primary source canvas or image.");
    error.code = "VIEWER_MEDIA_NOT_READY";
    throw error;
  }
  const parsed = new URL(page.url());
  const routeKeys = {};
  const sourceRouteKeys = new Set(["id", "parentid", "image", "imageid", "page", "recordid", "pid"]);
  for (const [key, value] of parsed.searchParams.entries()) {
    const normalizedKey = key.toLocaleLowerCase();
    if (value && sourceRouteKeys.has(normalizedKey)) routeKeys[normalizedKey] = value;
  }
  const sourceState = { pathname: parsed.pathname, routeKeys, ...state };
  return {
    ...sourceState,
    hash: crypto.createHash("sha256").update(JSON.stringify(sourceState)).digest("hex"),
  };
}

async function viewerIdentity(page) {
  return (await viewerSourceIdentity(page)).hash;
}

async function stableViewerIdentity(page, timeoutMilliseconds = 10_000) {
  const deadline = Date.now() + timeoutMilliseconds;
  let previous = "";
  let stableSamples = 0;
  while (Date.now() < deadline) {
    const current = await viewerIdentity(page).catch((error) => {
      if (error.code === "VIEWER_MEDIA_NOT_READY") return null;
      throw error;
    });
    if (!current) {
      previous = "";
      stableSamples = 0;
      await sleep(250);
      continue;
    }
    if (current === previous) stableSamples += 1;
    else {
      previous = current;
      stableSamples = 1;
    }
    if (stableSamples >= 3) return current;
    await sleep(250);
  }
  throw new Error("The provider viewer source identity did not become stable before acquisition.");
}

async function waitForViewerIdentityChange(page, provider, previousIdentity, timeoutMilliseconds = 20_000) {
  const deadline = Date.now() + timeoutMilliseconds;
  let candidateIdentity = "";
  let stableSamples = 0;
  while (Date.now() < deadline) {
    try { assertProviderUrl(page.url(), provider); } catch {
      await sleep(200);
      continue;
    }
    const current = await viewerIdentity(page).catch((error) => {
      if (error.code === "VIEWER_MEDIA_NOT_READY") return null;
      throw error;
    });
    if (!current) {
      candidateIdentity = "";
      stableSamples = 0;
      await sleep(200);
      continue;
    }
    if (current === previousIdentity) {
      candidateIdentity = "";
      stableSamples = 0;
    } else if (current === candidateIdentity) {
      stableSamples += 1;
    } else {
      candidateIdentity = current;
      stableSamples = 1;
    }
    if (stableSamples >= 3) return candidateIdentity;
    await sleep(200);
  }
  throw new Error("The provider did not prove that the viewer advanced to a different source image.");
}

async function waitForClippingDialogDownload(page, timeoutMilliseconds = 15_000) {
  const deadline = Date.now() + timeoutMilliseconds;
  let ambiguous = false;
  while (Date.now() < deadline) {
    const dialogs = await visibleMatches(page.getByRole("dialog"));
    const candidates = [];
    for (const dialog of dialogs) {
      const controls = dialog.getByRole("button", { name: "Download", exact: true })
        .or(dialog.getByRole("link", { name: "Download", exact: true }));
      const downloads = await visibleMatches(controls);
      if (downloads.length === 1) candidates.push(downloads[0]);
      if (downloads.length > 1) ambiguous = true;
    }
    if (candidates.length === 1) return candidates[0];
    if (candidates.length > 1) ambiguous = true;
    await sleep(100);
  }
  throw new Error(ambiguous
    ? "The clipping workflow exposed more than one eligible dialog Download control."
    : "The Findmypast clipping dialog did not expose one unique Download control.");
}

async function acquireFindmypastNewspaper(context, browserSession, options, queueTarget, controlled, matchTerms) {
  const articleLinks = controlled.page.getByRole("link", { name: /Added on.*\b(?:18|19|20)\d{2}\b/i });
  let matchedArticle = null;
  const observed = new Set();
  let stableLabel = "";
  let stableSamples = 0;
  let maximumMatches = 0;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const visible = await visibleMatches(articleLinks);
    const matches = [];
    for (const candidate of visible) {
      const label = (await candidate.innerText()).replace(/\s+/g, " ").trim();
      observed.add(label.slice(0, 800));
      if (matchTerms.every((term) => label.toLocaleLowerCase().includes(String(term).toLocaleLowerCase()))) {
        matches.push({ candidate, label });
      }
    }
    maximumMatches = Math.max(maximumMatches, matches.length);
    if (matches.length === 1) {
      if (matches[0].label === stableLabel) stableSamples += 1;
      else {
        stableLabel = matches[0].label;
        stableSamples = 1;
      }
      if (stableSamples >= 3) {
        matchedArticle = matches[0].candidate;
        break;
      }
    } else {
      stableLabel = "";
      stableSamples = 0;
    }
    await sleep(100);
  }
  if (options.inspectOnly) {
    console.log(`Expected newspaper terms: ${matchTerms.join(", ")}`);
    for (const label of [...observed].slice(0, 8)) console.log(`  ${label}`);
    console.log(matchedArticle
      ? "One stable verified full-page newspaper result is ready."
      : maximumMatches > 1
        ? `The newspaper route is ambiguous: at least ${maximumMatches} results matched.`
        : "No stable matching newspaper result was exposed.");
    return;
  }
  if (maximumMatches > 1) throw new Error(`Multiple newspaper results matched every verification term for ${options.targetId}.`);
  if (!matchedArticle) throw new Error(`No newspaper result matched every verification term for ${options.targetId}.`);
  await clickWithoutPopupWindow(
    context,
    browserSession,
    controlled.page,
    matchedArticle,
    "findmypast",
    controlled.windowId,
    {
      connection: options.connection,
      postcondition: async (page) => Boolean(await namedLocator(
        page,
        ["Activate selection of an image region"],
        1,
        ["button"],
        { timeoutMilliseconds: 20_000, unique: true },
      )),
    },
  );
  await updateAffinityAfterAction(context, browserSession, options, controlled);
  await inspectOverlays(controlled.page);

  const selectRegion = await namedLocator(controlled.page, ["Activate selection of an image region"], 1, ["button"]);
  if (!selectRegion) throw new Error("The verified newspaper result did not expose the full-page selection control.");
  await selectRegion.click({ timeout: 15_000 });
  const capture = await namedLocator(controlled.page, ["Capture full page"], 1, ["button"]);
  if (!capture) throw new Error("The newspaper viewer exposed no provider full-page capture control.");
  await capture.click({ timeout: 15_000 });
  const downloadControl = await waitForClippingDialogDownload(controlled.page);
  const [download] = await Promise.all([
    controlled.page.waitForEvent("download", { timeout: 90_000 }),
    downloadControl.click({ timeout: 20_000 }),
  ]);
  await archiveDownload(download, options);
  console.log(`Acquired and registered ${options.targetId} using Findmypast's full-page capture control.`);
}

async function acquireFindmypastTarget(context, browserSession, options, queueTarget) {
  const route = queueTarget.searchUrl || queueTarget.catalogueUrl;
  const matchTerms = (queueTarget.resultMatch || []).filter(Boolean);
  if (!route || !matchTerms.length) {
    throw new Error("The Findmypast target lacks a narrow route or result-row verification terms.");
  }
  const controlled = await openInAffinity(context, browserSession, options, route);
  await inspectOverlays(controlled.page);
  if (queueTarget.captureKind === "newspaper-page") {
    await acquireFindmypastNewspaper(context, browserSession, options, queueTarget, controlled, matchTerms);
    return;
  }
  if (queueTarget.captureKind !== "record-image") {
    throw new Error("The Findmypast target does not use a supported record-image/newspaper-page workflow.");
  }

  const verified = await findVerifiedResultControl(controlled.page, "View image", matchTerms, 3_000);
  const accessPlan = findmypastResultAccessPlan(verified);
  let expanded = null;
  let expansionError = null;
  if (accessPlan === "collapsed") {
    try {
      expanded = await resolveUniqueFindmypastResultRow(controlled.page, matchTerms);
    } catch (error) {
      expansionError = error;
    }
  }
  if (expanded) await inspectOverlays(controlled.page);
  if (options.inspectOnly) {
    console.log(`Expected row terms: ${matchTerms.join(", ")}`);
    for (const summary of verified.observed.slice(0, 12)) console.log(`  ${summary}`);
    console.log(verified.control
      ? "One stable verified image-bearing row is ready."
      : expanded
        ? `One stable verified image-bearing row is ready from a safely scoped composite result: ${expanded.summary.slice(0, 1_000)}`
      : verified.unsafeBoundary
        ? "The result structure aggregates multiple View image actions; acquisition is refused."
      : verified.matchCount > 1
        ? `The route is ambiguous: at least ${verified.matchCount} rows matched.`
        : `No stable matching image-bearing row was exposed.${expansionError ? ` ${expansionError.message}` : ""}`);
    return;
  }
  if (options.inspectTranscript) {
    const transcript = expanded?.actions.get("View transcript") ||
      (verified.container
        ? await namedLocator(verified.container, ["View transcript"], 1, ["link", "button"], { unique: true })
        : null);
    if (!transcript) {
      if (verified.unsafeBoundary) {
        throw new Error("Transcript inspection was refused because the result boundary aggregates multiple image-bearing records.");
      }
      if (verified.matchCount > 1) {
        throw new Error(
          "Transcript inspection was refused because multiple result rows matched every verification term.",
        );
      }
      throw new Error(expansionError
        ? `No verified result row was available for transcript inspection. ${expansionError.message}`
        : "No verified result row was available for transcript inspection.");
    }
    await clickWithoutPopupWindow(
      context,
      browserSession,
      controlled.page,
      transcript,
      "findmypast",
      controlled.windowId,
      { connection: options.connection },
    );
    await updateAffinityAfterAction(context, browserSession, options, controlled);
    await inspectOverlays(controlled.page);
    const transcriptText = (await controlled.page.locator("body").innerText()).replace(/\s+/g, " ").trim();
    console.log(`Visible transcript text for verified target ${options.targetId}:`);
    console.log(transcriptText.slice(0, 12_000));
    return;
  }
  const imageControl = verified.control || expanded?.actions.get("View image") || null;
  if (!imageControl) {
    if (verified.unsafeBoundary) {
      throw new Error(`Acquisition was refused because no single-record result boundary could be proven for ${options.targetId}.`);
    }
    if (verified.matchCount > 1) {
      throw new Error(`Acquisition was refused because multiple image-bearing rows matched every verification term for ${options.targetId}.`);
    }
    if (expansionError) {
      throw new Error(`No image-bearing result row matched every verification term for ${options.targetId}. ${expansionError.message}`);
    }
    throw new Error(`No image-bearing result row matched every verification term for ${options.targetId}.`);
  }
  await clickWithoutPopupWindow(
    context,
    browserSession,
    controlled.page,
    imageControl,
    "findmypast",
    controlled.windowId,
    { postcondition: findmypastImageViewerReady, connection: options.connection },
  );
  await updateAffinityAfterAction(context, browserSession, options, controlled);
  await inspectOverlays(controlled.page);
  for (let advance = 1; advance < options.part; advance += 1) {
    const previousIdentity = await stableViewerIdentity(controlled.page);
    const next = await namedLocator(controlled.page, ["Next", "Next image", /Next$/], 1, ["link", "button"], { unique: true });
    if (!next) throw new Error(`Findmypast exposed no next image while acquiring part ${options.part}.`);
    await next.click({ timeout: 15_000 });
    await waitForViewerIdentityChange(controlled.page, "findmypast", previousIdentity);
    if (!await findmypastImageViewerReady(controlled.page)) {
      throw new Error(`Findmypast did not remain on a source-image viewer while advancing to part ${options.part}.`);
    }
    await updateAffinityAfterAction(context, browserSession, options, controlled);
    await inspectOverlays(controlled.page);
  }
  await downloadFromViewer(controlled.page, options, "findmypast");
  console.log(`Acquired and registered ${options.targetId} from a verified Findmypast result row.`);
}

async function acquireTarget(context, browserSession, options) {
  if (!options.targetId) throw new Error("acquire-target requires --target-id.");
  if (!options.archiveFile || !ARCHIVE_FILE_PATTERN.test(options.archiveFile)) {
    throw new Error("acquire-target requires a safe supported --archive-file.");
  }
  const queue = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, "evidence", "subscription-records-queue.json"), "utf8"));
  const matches = queue.targets.filter((target) => target.id === options.targetId);
  if (matches.length > 1) throw new Error(`Subscription queue target is not unique: ${options.targetId}`);
  let target = matches[0];
  if (!target) {
    const canonicalPath = path.join(PROJECT_ROOT, "evidence", "acquisition", "targets", `${options.targetId}.json`);
    if (!fs.existsSync(canonicalPath)) throw new Error(`Unknown subscription target: ${options.targetId}`);
    const canonical = JSON.parse(fs.readFileSync(canonicalPath, "utf8"));
    const route = (canonical.routes || []).find((candidate) =>
      candidate.id === options.targetId
      && candidate.sourceQueue === "subscription-records"
      && ["Ancestry", "Findmypast"].includes(candidate.provider)
      && ["pending-subscription", "ready-subscription-capture", "acquired"].includes(candidate.status));
    if (!route?.sourceUrl) throw new Error(`Canonical subscription target has no exact ready route: ${options.targetId}`);
    target = {
      id: canonical.id,
      provider: route.provider,
      catalogueUrl: route.sourceUrl,
      searchUrl: route.sourceUrl,
      captureKind: route.provider === "Findmypast" ? "record-image" : undefined,
      resultMatch: canonical.resultMatch || [],
    };
  }
  if (target.provider === "Ancestry") {
    options.provider = "ancestry";
    await acquireAncestryTarget(context, browserSession, options, target);
    return;
  }
  if (target.provider === "Findmypast") {
    options.provider = "findmypast";
    await acquireFindmypastTarget(context, browserSession, options, target);
    return;
  }
  throw new Error(`Unsupported subscription provider for background acquisition: ${target.provider}`);
}

async function run(options) {
  if (options.mode === "stop") {
    await stopDedicatedBrowser();
    return;
  }
  await ensureBrowserStarted();
  const connection = await connectSharedBrowser({
    chromium,
    endpoint: ENDPOINT,
    taskLabel: `subscription-${options.mode}`,
    namespace: "family-history",
    lifetime: "persistent",
    affinitySlot: "subscription-providers",
    provider: "Subscriptions"
  });
  const { browser, context } = connection;
  options.connection = connection;
  try {
    const browserSession = await browser.newBrowserCDPSession();
    try {
      if (["setup", "start"].includes(options.mode)) {
        const interactive = options.mode === "setup";
        await setupProviderTabs(connection, context, browserSession, { interactive });
        console.log(interactive
          ? "Use the visible Ancestry and Findmypast tabs for interactive sign-in; credentials remain inside this dedicated Windows Chrome profile."
          : "The shared provider tabs are ready in the minimized/background Windows Chrome profile.");
        return;
      }
      if (options.mode === "status") {
        const state = await ownedWindowState(connection, context, browserSession, { allowEmpty: true });
        const providerPages = state.inventory.filter(({ page }) => {
          try { return Boolean(providerForUrl(page.url())); } catch { return false; }
        });
        console.log(`Background subscription Chrome: connected; windows=${state.windowIds.length}; provider-tabs=${providerPages.length}.`);
        return;
      }
      if (options.mode === "login-status") {
        const state = await ownedWindowState(connection, context, browserSession, { allowEmpty: true });
        for (const provider of ["ancestry", "findmypast"]) {
          const entry = state.inventory.find(({ page }) => {
            try { return providerForUrl(page.url()) === provider; } catch { return false; }
          });
          if (!entry) {
            console.log(`${provider}: no provider tab`);
            continue;
          }
          const accountVisible = await entry.page.getByText(/^(?:My Account|Account)$/i).first().isVisible().catch(() => false);
          const signInVisible = await entry.page.getByRole("link", { name: /^(?:Sign in|Log in)$/i }).first().isVisible().catch(() => false) ||
            await entry.page.getByRole("button", { name: /^(?:Sign in|Log in)$/i }).first().isVisible().catch(() => false);
          const routeRequiresLogin = /\/(?:signin|login)(?:\/|$)/i.test(new URL(entry.page.url()).pathname);
          const status = accountVisible ? "signed-in indicator visible" :
            (signInVisible || routeRequiresLogin) ? "sign-in required" : "no explicit sign-in indicator";
          console.log(`${provider}: ${status}`);
        }
        return;
      }
      if (options.mode === "viewer-inventory") {
        const state = await ownedWindowState(connection, context, browserSession, { allowEmpty: true });
        const viewers = [];
        for (const { page } of state.inventory) {
          let provider;
          try { provider = providerForUrl(page.url()); } catch { continue; }
          const title = await page.title();
          if ((provider === "findmypast" && / Image \| findmypast\.(?:com|co\.uk)(?: - Memory usage - \d+ MB)?$/i.test(title)) ||
            (provider === "ancestry" && /Ancestry\.com(?: - Memory usage - \d+ MB)?$/i.test(title) && /imageviewer/i.test(page.url()))) {
            viewers.push(`${provider}: ${title.slice(0, 240)}`);
          }
        }
        console.log(`Subscription viewer inventory: exact-viewer-tabs=${viewers.length}`);
        for (const viewer of viewers.sort()) console.log(`  ${viewer}`);
        return;
      }
      if (options.mode === "audit-tabs") {
        const state = await ownedWindowState(connection, context, browserSession, { allowEmpty: true });
        const blanks = state.inventory.filter(({ page }) => page.url() === "about:blank" || page.url().startsWith("chrome://newtab"));
        console.log(`Background subscription tab audit: page-targets=${state.inventory.length}; exact-blank-tabs=${blanks.length}; windows=${state.windowIds.length}.`);
        return;
      }
      if (options.mode === "page-inventory") {
        const state = await ownedWindowState(connection, context, browserSession, { allowEmpty: true });
        console.log(`Background subscription page inventory: ${state.inventory.length}`);
        for (const [index, { page }] of state.inventory.entries()) {
          let provider = "non-provider";
          try { provider = providerForUrl(page.url()); } catch {}
          console.log(`  ${index + 1}. ${provider}: ${(await page.title()).slice(0, 240)} -> ${summarizeUrl(page.url())}`);
        }
        return;
      }
      if (options.mode === "clean-tabs") {
        const before = (await ownedPageInventory(connection, context)).length;
        const closedTargetIds = await closeExactBlankPages(context, "", connection.ownedPages());
        for (const targetId of closedTargetIds) await connection.forgetTarget(targetId).catch(() => {});
        const after = (await ownedPageInventory(connection, context)).length;
        console.log(`Closed ${before - after} exact CDP blank/new-tab target(s); no provider page was closed.`);
        return;
      }
      if (options.mode === "clean-error-tabs") {
        let closed = 0;
        for (const { page, targetInfo } of await ownedPageInventory(connection, context)) {
          let provider;
          try { provider = providerForUrl(page.url()); } catch { continue; }
          if (provider && (await page.title()) === "500 Internal Server Error") {
            await page.close({ runBeforeUnload: false });
            await connection.forgetTarget(targetInfo.targetId).catch(() => {});
            closed += 1;
          }
        }
        console.log(`Closed ${closed} exact provider 500-error target(s); no record page was closed.`);
        return;
      }
      if (options.mode === "acquire-target") {
        options.transactionTargetIds = new Set();
        try {
          await acquireTarget(context, browserSession, options);
        } finally {
          let closeError = null;
          for (const targetId of options.transactionTargetIds) {
            try {
              await closeTargetVerified(context, browserSession, targetId);
              await connection.forgetTarget(targetId).catch(() => {});
            } catch (error) {
              closeError ||= error;
            }
          }
          try {
            await closeAffinityTarget(context, browserSession, options);
          } catch (error) {
            closeError ||= error;
          }
          if (closeError) {
            const liveTargets = [];
            for (const targetId of options.transactionTargetIds) {
              if (await findPageByTargetId(context, targetId)) liveTargets.push(targetId);
            }
            const savedAfterClose = readJson(affinityPath(options.affinitySlot));
            if (savedAfterClose?.targetId && await findPageByTargetId(context, savedAfterClose.targetId)) {
              liveTargets.push(savedAfterClose.targetId);
            }
            if (liveTargets.length === 0) {
              fs.rmSync(affinityPath(options.affinitySlot), { force: true });
              closeError = null;
            }
          }
          if (closeError) throw closeError;
        }
        return;
      }
      if (options.mode === "close-affinity") {
        const closed = await closeAffinityTarget(context, browserSession, options);
        console.log(closed ? "Closed the exact background task tab for this affinity slot." : "The affinity slot has no live background task tab.");
        return;
      }
      if (["inspect-affinity-location", "signin-saved-affinity"].includes(options.mode)) {
        // A late redirect can invalidate the URL fingerprint. Inspect only
        // that recorded target; never relax the normal action/parent guards.
        const saved = readJson(affinityPath(options.affinitySlot));
        assertAffinityLocationRequest(saved, options);
        const found = (await ownedPageInventory(connection, context)).find(entry => entry.targetInfo.targetId === saved.targetId);
        if (!found) throw new Error("The recorded task target is no longer live.");
        await verifyPageWindow(browserSession, saved.targetId, saved.windowId);
        const adopted = await connection.adoptPage(found.page, { root: true });
        if (adopted.targetId !== saved.targetId || adopted.windowId !== saved.windowId) {
          throw new Error("Location inspection lost its exact task lease.");
        }
        const actual = new URL(found.page.url());
        assertProviderUrl(actual.href, saved.provider);
        console.log(`Exact task location: ${summarizeUrl(actual.href)}`);
        if (options.mode === "signin-saved-affinity") {
          const outcome = await trySavedSignInAtCurrentForm(found.page, saved.provider, { log: message => console.log(message) });
          await updateAffinityAfterAction(context, browserSession, options,
            { ...found, provider: saved.provider, targetId: saved.targetId, windowId: saved.windowId }, options.url);
          if (outcome.status === "needs-user") process.exitCode = 3;
          return;
        }
        console.log("No page content read, navigation performed or affinity binding changed.");
        return;
      }
      if (options.mode === "bind-existing") {
        if (!options.url) throw new Error("bind-existing requires --url.");
        const provider = providerForUrl(options.url);
        const matches = (await pageInventory(context)).filter(({ page, targetInfo }) => {
          if (options.targetId && targetInfo.targetId !== options.targetId) return false;
          try {
            return providerForUrl(page.url()) === provider && urlFingerprint(page.url()) === urlFingerprint(options.url);
          } catch {
            return false;
          }
        });
        if (matches.length !== 1) {
          throw new Error(`bind-existing requires exactly one live tab for the exact provider route; found ${matches.length}.`);
        }
        const identity = await targetIdentity(context, matches[0].page);
        const adopted = await connection.adoptPage(matches[0].page, { root: true });
        if (adopted.targetId !== identity.targetId) {
          throw new Error("The bridge returned a mismatched identity for the exact existing provider tab.");
        }
        const windowId = await verifyPageWindow(browserSession, identity.targetId, null);
        writeJsonAtomic(
          affinityPath(options.affinitySlot),
          affinityRecord(options, provider, identity.targetId, windowId, options.url, matches[0].page.url()),
        );
        console.log(`Bound the exact existing provider tab to affinity ${options.affinitySlot}: ${summarizeUrl(matches[0].page.url())}`);
        await inspectOverlays(matches[0].page);
        return;
      }
      if (options.mode === "bind-existing-viewer") {
        if (!options.url) throw new Error("bind-existing-viewer requires the originating provider route in --url.");
        if (!options.expectedTabTitle) throw new Error("bind-existing-viewer requires --expected-tab-title.");
        const provider = options.provider === "any" ? providerForUrl(options.url) : options.provider;
        const expectedTitle = options.expectedTabTitle.replace(/ - Memory usage - \d+ MB$/, "");
        const matches = [];
        for (const entry of await pageInventory(context)) {
          try {
            if (providerForUrl(entry.page.url()) !== provider) continue;
          } catch {
            continue;
          }
          const title = (await entry.page.title()).replace(/ - Memory usage - \d+ MB$/, "");
          if (title !== expectedTitle) continue;
          if (provider === "findmypast" && !await findmypastImageViewerReady(entry.page)) continue;
          matches.push(entry);
        }
        if (matches.length !== 1) {
          throw new Error(`bind-existing-viewer requires exactly one matching live viewer tab; found ${matches.length}.`);
        }
        const identity = await targetIdentity(context, matches[0].page);
        const adopted = await connection.adoptPage(matches[0].page, { root: true });
        if (adopted.targetId !== identity.targetId) {
          throw new Error("The bridge returned a mismatched identity for the exact existing viewer tab.");
        }
        const windowId = await verifyPageWindow(browserSession, identity.targetId, null);
        writeJsonAtomic(
          affinityPath(options.affinitySlot),
          affinityRecord(options, provider, identity.targetId, windowId, options.url, matches[0].page.url()),
        );
        console.log(`Bound the one exact existing viewer to affinity ${options.affinitySlot}: ${summarizeUrl(matches[0].page.url())}`);
        await inspectOverlays(matches[0].page);
        return;
      }
      if (["open", "navigate", "adopt-search", "adopt-transcription", "recover-record", "recover-ancestry-record"].includes(options.mode)) {
        if (!options.url) throw new Error(`${options.mode} requires --url.`);
        const controlled = await openInAffinity(context, browserSession, options, options.url);
        console.log(`Opened the requested provider route in the shared background task tab: ${summarizeUrl(controlled.activeUrl)}`);
        return;
      }
      await providerAction(context, browserSession, options);
    } finally {
      await browserSession.detach().catch(() => {});
    }
  } finally {
    await connection.closeClient({ leaseAction: "park" });
  }
}

export {
  assertAffinityLocationRequest,
  assertFindmypastProbateResultRoute,
  activateFindmypastProbateSubmit,
  assertFindmypastProbateFormRoute,
  inspectFindmypastProbateFormDom,
  validateFindmypastProbateForm,
  assertAncestryBrowseRoute,
  pickAncestryBrowseOption,
  assertAncestryHistoricalSearchRoute,
  inspectAncestryHistoricalSearchDom,
  findmypastTargetReadyForCapture,
  inspectAncestryEventControlsDom,
  assertYaxleyBrowseRoute,
  ancestryBrowseMetadataConfig,
  inspectYaxleyBrowseDom,
  withBrowseNavigationGuard,
  assertAncestryCollectionRoot,
  assertSameCollectionTarget,
  activateBoundFindmypastAction,
  findmypastTranscriptMatchesRecordId,
  ancestrySourceBinding,
  ancestryViewerMatchesTarget,
  assertSafeFindmypastActionBoundary,
  assertProviderUrl,
  classifyFindmypastSearchSummary,
  findmypastResultAccessPlan,
  findmypastResolvedResult,
  findmypastViewerMatchesRecordId,
  normalizeFindmypastRecordId,
  normalizeExpectedRowTerms,
  parseArgs,
  providerForUrl,
  selectUniqueFindmypastActionRow,
  selectUniqueFindmypastActionRowByRecordId,
  selectUniqueFindmypastBrowseRow,
  selectUniqueFindmypastResultCandidate,
  sharedWindowState,
  urlFingerprint,
  stableViewerIdentity,
  waitForViewerIdentityChange,
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = parseArgs(process.argv.slice(2));
  const releaseLock = await acquireLock();
  try {
    await run(options);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    releaseLock();
  }
}
