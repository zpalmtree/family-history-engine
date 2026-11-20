#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";
import { openSharedChromeTask, sharedChromeEndpoint } from "./shared-chrome-task.mjs";

const mode = valueAfter("--mode");
const county = valueAfter("--county");
const pagesArg = valueAfter("--pages");
const lastName = valueAfter("--last-name");
const firstName = valueAfter("--first-name");
const book = valueAfter("--book");
const pageNumber = valueAfter("--page");
const targetId = valueAfter("--target-id");
const affinitySlot = valueAfter("--affinity-slot") || "mdlandrec";
const endpoint = valueAfter("--endpoint") || sharedChromeEndpoint;

const homeUrl = "https://landrec.msa.maryland.gov/";
const signInWaitMs = 300_000;
const downloadWaitMs = 90_000;

if (!new Set(["inspect", "capture", "search"]).has(mode)) throw new Error("Pass --mode inspect, --mode search, or --mode capture.");
if (!process.argv.includes("--shared-window") || endpoint !== sharedChromeEndpoint) {
  throw new Error(`MDLandRec capture must use the shared Windows Chrome wrapper at ${sharedChromeEndpoint}.`);
}
if (mode === "capture") {
  if (pagesArg && !/^\d{1,4}(,\d{1,4})*$/.test(pagesArg)) {
    throw new Error("--pages must be a comma-separated list of folio numbers.");
  }
  if (!county || !book || (!pagesArg && !/^\d{1,4}$/.test(pageNumber || ""))) {
    throw new Error("Capture needs --county, --book, and either a numeric --page or a --pages list.");
  }
  if (!/^[a-z0-9][a-z0-9-]{0,127}$/.test(targetId || "")) throw new Error("Capture needs one safe --target-id.");
}

const downloadsDir = process.env.USERPROFILE ? path.join(process.env.USERPROFILE, "Downloads") : null;
if (mode === "capture" && (!downloadsDir || !fs.existsSync(downloadsDir))) {
  throw new Error("The Windows Downloads folder was not found; run through the Windows wrapper.");
}

// Every capture writes to the same target-named file, so a run that fails
// before writing leaves the previous folio's download in place. Clear it first:
// a stale image silently read as the requested folio is worse than no image.
if (mode === "capture" && targetId && downloadsDir) {
  for (const extension of ["pdf", "jpg", "png"]) {
    const stale = path.join(downloadsDir, `${targetId}.${extension}`);
    if (fs.existsSync(stale)) {
      fs.unlinkSync(stale);
      console.log(`Removed a stale ${extension.toUpperCase()} from a previous capture: ${stale}`);
    }
  }
}

const task = await openSharedChromeTask({ chromium, endpoint, taskLabel: "mdlandrec", affinitySlot });
let failureShot = null;
let signInPending = false;
try {
  const page = task.page;
  await page.goto(homeUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await settle(page);

  if (await needsSignIn(page)) {
    await task.showForManualStep("the visible MDLandRec sign-in; no credential is read or typed by the agent");
    const deadline = Date.now() + signInWaitMs;
    while (Date.now() < deadline && await needsSignIn(page)) await page.waitForTimeout(3_000);
    if (await needsSignIn(page)) {
      // Closing here left nothing to sign into: the wait window and the only
      // visible tab disappeared together, so the person being asked to act had
      // nothing on screen by the time they were told. Leave it open instead and
      // let a later run reuse the signed-in session.
      signInPending = true;
      throw new Error("MDLandRec is still showing its sign-in page. The tab has been left open in the shared Chrome window; sign in there and re-run this command, which will reuse the session.");
    }
    console.log("Signed-in MDLandRec session detected; continuing in the background tab.");
    await settle(page);
  }

  if (mode === "inspect") {
    console.log(JSON.stringify(await inventory(page), null, 2));
  } else if (mode === "search") {
    // Look the party up in the county's own grantor/grantee index instead of
    // pulling folios speculatively. Each blind page pull costs a download and a
    // read, and an index entry number is not a printed folio.
    await selectCounty(page, county);
    console.log(JSON.stringify(await searchPartyIndex(page, { lastName, firstName, book }), null, 2));
  } else {
    const jumpNav = page.locator("a:visible, button:visible").filter({ hasText: /^jump to new volume$/i }).first();
    if (await jumpNav.count()) {
      await jumpNav.click();
      await settle(page);
      console.log(`Opened the dedicated jump-to-volume section: ${page.url().split("?")[0]}`);
    }
    await selectCounty(page, county);
    // Pull every requested folio inside one signed-in run. Separate runs left
    // long idle gaps while images were read and reported, and the site's
    // session expired in between, which cost a re-authentication each time.
    const requestedPages = (pagesArg ? pagesArg.split(",") : [pageNumber])
      .map((value) => String(value).trim()).filter(Boolean);
    const captured = [];
    for (const folio of requestedPages) {
    // After a capture the tab sits on the viewer, which has no jump fields.
    // Return to the jump form before each folio.
    if (captured.length) {
      const backToJump = page.locator("a:visible, button:visible").filter({ hasText: /^jump to new volume$/i }).first();
      if (await backToJump.count()) {
        await backToJump.click();
        await settle(page);
      } else {
        await page.goto("https://landrec.msa.maryland.gov/Pages/Search.aspx", { waitUntil: "domcontentloaded", timeout: 45_000 });
        await settle(page);
      }
      // The county persists across jumps inside a session, and the selector is
      // not always re-rendered, so this is best effort rather than fatal.
      await selectCounty(page, county).catch((error) => {
        console.log(`County already scoped for this session: ${String(error).slice(0, 80)}`);
      });
    }
    const priorPages = new Set(task.context.pages());
    await jumpToVolume(page, book, folio);
    console.log(`Post-jump URL: ${page.url().split("?")[0]}`);
    for (const frame of page.frames()) {
      if (frame !== page.mainFrame()) console.log(`Frame: ${frame.url().split("?")[0]}`);
    }
    const bodyText = ((await page.locator("body").innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim();
    console.log(`Post-jump page text (bounded): ${bodyText.slice(0, 800)}`);
    const viewer = await findViewerPage(task.context, priorPages, page);
    if (viewer !== page) console.log(`Viewer opened as a child page: ${viewer.url().split("?")[0]}`);
    const header = (await pageHeaderText(viewer)).slice(0, 300);
    console.log(`Viewer context: ${header || "(no header text found)"}`);
    if (!matchesVolume(header, book, folio)) {
      console.log("WARNING: the viewer header does not clearly confirm the requested book/page; the download proceeds so the image can be visually verified before archiving.");
    }
    const file = await captureViewerImage(viewer, `-p${folio}`) || await downloadCurrentImage(viewer);
    captured.push({ folio, file });
    console.log(`Captured folio ${folio}: ${file}`);
    if (viewer !== page) await viewer.close({ runBeforeUnload: false }).catch(() => {});
    }
    console.log(JSON.stringify({ targetId, county, book, captured }, null, 2));
  }
} catch (error) {
  failureShot = await saveFailureShot(task.page).catch(() => null);
  if (failureShot) console.error(`Failure screenshot (outside Git): ${failureShot}`);
  console.error(JSON.stringify(await inventory(task.page).catch(() => ({})), null, 2));
  throw error;
} finally {
  if (signInPending) await task.leaveOpen();
  else await task.close();
}

// Fills the MDLandRec party-name index search and reports its result rows.
// Read-only: it submits the site's own search form and reports what comes back.
async function searchPartyIndex(page, { lastName, firstName, book }) {
  if (!lastName) throw new Error("search mode needs at least --last-name.");
  // Stay on the party-search form. The INDICES link goes to an index-volume
  // browse listing CE numbers, which is a different thing entirely.
  if (!/Search\.aspx/i.test(page.url())) {
    await page.goto("https://landrec.msa.maryland.gov/Pages/Search.aspx", { waitUntil: "domcontentloaded", timeout: 45_000 });
    await settle(page);
  }
  const fill = async (id, value) => {
    if (!value) return;
    const field = page.locator(`#${id}`).first();
    if (await field.count()) await field.fill(value);
  };
  await fill("body_tbLastName", lastName);
  await fill("body_tbFirstName", firstName);
  await fill("body_tbjtnvBook", book);
  // An input[type=submit] carries its label in value, not text, so a text
  // filter never matches it.
  let clickable = page.locator("input[type=submit][value='Search' i]:visible").first();
  if (!await clickable.count()) {
    clickable = page.locator("button:visible").filter({ hasText: /^search$/i }).first();
  }
  if (!await clickable.count()) throw new Error("The MDLandRec search control was not found; nothing was submitted.");
  await clickable.click();
  await settle(page);
  await page.waitForTimeout(2_000);

  const rows = [];
  for (const row of (await page.locator("table tr:visible").all()).slice(0, 60)) {
    const cells = [];
    for (const cell of (await row.locator("td").all()).slice(0, 12)) {
      cells.push(((await cell.innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim().slice(0, 80));
    }
    if (cells.filter(Boolean).length > 1) rows.push(cells);
  }
  return { url: page.url().split("?")[0], query: { lastName, firstName, book }, rowCount: rows.length, rows };
}

async function needsSignIn(page) {
  if (/login|signin|account\/logon/i.test(page.url())) return true;
  return await page.locator("input[type=password]:visible").count() > 0;
}

async function settle(page) {
  await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
}

async function selectCounty(page, wanted) {
  const wantedCompact = compact(wanted);
  for (const select of await page.locator("select:visible").all()) {
    for (const option of await select.locator("option").all()) {
      const text = (await option.textContent() || "").trim();
      if (compact(text).includes(wantedCompact)) {
        await select.selectOption({ label: text });
        await settle(page);
        console.log(`Selected county option: "${text}".`);
        return;
      }
    }
  }
  const clerkField = await fieldByLabel(page, /clerk|county/i);
  if (clerkField) {
    const tag = await clerkField.evaluate((element) => element.tagName.toLowerCase());
    if (tag === "select") {
      for (const option of await clerkField.locator("option").all()) {
        const text = (await option.textContent() || "").trim();
        if (compact(text).includes(wantedCompact)) {
          await clerkField.selectOption({ label: text });
          await settle(page);
          return;
        }
      }
    } else {
      await clerkField.fill(wanted);
      await page.waitForTimeout(1_200);
      const suggestion = page.locator("[role=option]:visible, li:visible").filter({ hasText: new RegExp(escapeRegExp(wanted.split("'")[0]), "i") }).first();
      if (await suggestion.count()) await suggestion.click().catch(() => {});
      await settle(page);
      return;
    }
  }
  throw new Error(`No visible county/clerk selector matched "${wanted}"; run --mode inspect and refine the flow.`);
}

async function jumpToVolume(page, wantedBook, wantedPage) {
  const typed = await typeIntoJumpFields(page, wantedBook, wantedPage);
  if (!typed) throw new Error("No visible jump book/page fields were found; run --mode inspect and refine the flow.");
  const go = await jumpControl(page);
  if (!go) throw new Error("No visible jump/submit control was found next to the book/page fields.");
  const goText = ((await go.textContent().catch(() => "")) || (await go.getAttribute("value").catch(() => "")) || "").trim();
  console.log(`Clicking jump control: "${goText}".`);
  await go.click();
  await settle(page);
  await page.waitForTimeout(2_000);
  const shot = await saveFailureShot(page).catch(() => null);
  if (shot) console.log(`Post-jump screenshot (outside Git): ${shot}`);
  const validator = page.locator("text=/No\\. is required/i").first();
  if (await validator.isVisible().catch(() => false)) {
    console.log("Jump validators still report empty fields after typed input.");
  }
}

async function typeIntoJumpFields(page, wantedBook, wantedPage) {
  const inputs = await page.locator("input:visible").all();
  const hints = [];
  for (const input of inputs) {
    hints.push(`${await input.getAttribute("name") || ""} ${await input.getAttribute("id") || ""}`);
  }
  // Maryland libers are named by clerk initials plus volume number ("TM 2",
  // "WR 13"). When the jump strip has its own Clerk box, split the liber into
  // clerk initials and the numeric book; otherwise type the whole designation.
  const hasClerkBox = hints.some((hint) => /clerk/i.test(hint));
  const liberParts = wantedBook.match(/^([A-Za-z]+[A-Za-z .]*?)\s*(\d+)$/);
  const clerkValue = hasClerkBox && liberParts ? liberParts[1].trim() : null;
  const bookValue = clerkValue ? liberParts[2] : wantedBook;
  let clerkDone = !clerkValue;
  let bookDone = false;
  let pageDone = false;
  for (let index = 0; index < inputs.length; index++) {
    const hint = hints[index];
    if (/cross|ref|password|email|user|date|name/i.test(hint)) continue;
    const isClerk = Boolean(clerkValue) && /clerk/i.test(hint);
    const isBook = /book|liber/i.test(hint);
    const isPage = /page|folio/i.test(hint);
    if (!isClerk && !isBook && !isPage) continue;
    const value = isClerk ? clerkValue : isBook ? bookValue : String(wantedPage);
    await inputs[index].click();
    await inputs[index].fill("");
    await inputs[index].pressSequentially(value, { delay: 40 });
    await inputs[index].dispatchEvent("change");
    console.log(`Typed "${value}" into [${hint.trim().slice(0, 60)}].`);
    if (isClerk) clerkDone = true;
    if (isBook) bookDone = true;
    if (isPage) pageDone = true;
  }
  return clerkDone && bookDone && pageDone;
}

async function jumpControl(page) {
  const buttons = "button:visible, input[type=submit]:visible, input[type=button]:visible";
  for (const pattern of [/^jump$/i, /^(go|view)$/i, /^search$/i]) {
    for (const control of await page.locator(buttons).all()) {
      const text = ((await control.textContent().catch(() => "")) || (await control.getAttribute("value").catch(() => "")) || "").trim();
      if (pattern.test(text)) return control;
    }
  }
  return null;
}

async function fieldByLabel(page, pattern) {
  for (const label of await page.locator("label:visible").all()) {
    const text = (await label.textContent() || "").trim();
    if (!pattern.test(text)) continue;
    const forId = await label.getAttribute("for");
    if (forId) {
      const field = page.locator(`#${cssEscape(forId)}`);
      if (await field.count()) return field.first();
    }
    const nested = label.locator("input:visible, select:visible").first();
    if (await nested.count()) return nested;
  }
  for (const input of await page.locator("input:visible").all()) {
    const hint = `${await input.getAttribute("placeholder") || ""} ${await input.getAttribute("name") || ""} ${await input.getAttribute("aria-label") || ""}`;
    if (pattern.test(hint) && !/password|email|user/i.test(hint)) return input;
  }
  return null;
}

async function pageHeaderText(page) {
  const parts = [];
  for (const selector of ["h1:visible", "h2:visible", "h3:visible", "[class*=header]:visible", "[class*=title]:visible"]) {
    for (const element of await page.locator(selector).all()) {
      const text = (await element.textContent() || "").trim();
      if (text) parts.push(text);
      if (parts.length > 6) return parts.join(" | ");
    }
  }
  return parts.join(" | ");
}

function matchesVolume(header, wantedBook, wantedPage) {
  const compacted = compact(header);
  return compacted.includes(compact(wantedBook)) && compacted.includes(String(wantedPage));
}

async function findViewerPage(context, priorPages, fallback) {
  const deadline = Date.now() + 15_000;
  const offHost = new Set();
  while (Date.now() < deadline) {
    const fresh = context.pages().filter((candidate) => !priorPages.has(candidate) && !candidate.isClosed());
    const onHost = fresh.filter((candidate) => /landrec/i.test(candidate.url()));
    for (const candidate of fresh) {
      if (!onHost.includes(candidate) && candidate.url() !== "about:blank" && !offHost.has(candidate.url())) {
        offHost.add(candidate.url());
        console.log(`Ignoring off-host child page: ${candidate.url().split("?")[0]}`);
      }
    }
    if (onHost.length) {
      const viewer = onHost[onHost.length - 1];
      await viewer.waitForLoadState("domcontentloaded", { timeout: 20_000 }).catch(() => {});
      await settle(viewer);
      return viewer;
    }
    await fallback.waitForTimeout(500);
  }
  return fallback;
}

async function captureViewerImage(viewer, fileSuffix = "") {
  const sources = [];
  for (const scope of [viewer, ...viewer.frames()]) {
    const found = await scope.evaluate(() => {
      const results = [];
      for (const element of document.querySelectorAll("embed, object, iframe")) {
        const src = element.src || element.data || "";
        if (/\.pdf|getpdf|imagepdf/i.test(src)) results.push({ src, kind: "pdf", area: 0 });
      }
      for (const image of document.querySelectorAll("img")) {
        const area = (image.naturalWidth || 0) * (image.naturalHeight || 0);
        if (area > 250_000) results.push({ src: image.src, kind: "img", area });
      }
      return results;
    }).catch(() => []);
    sources.push(...found);
  }
  if (!sources.length) {
    console.log("No large viewer image or embedded PDF was found for direct capture.");
    return null;
  }
  sources.sort((first, second) => Number(second.kind === "pdf") - Number(first.kind === "pdf") || second.area - first.area);
  const chosen = sources[0];
  console.log(`Direct capture source (${chosen.kind}): ${chosen.src.split("?")[0]}`);
  const payload = await viewer.evaluate(async (src) => {
    const response = await fetch(src, { credentials: "include" });
    if (!response.ok) throw new Error(`fetch ${response.status}`);
    const buffer = await response.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = "";
    const chunk = 32_768;
    for (let offset = 0; offset < bytes.length; offset += chunk) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
    }
    return { base64: btoa(binary), contentType: response.headers.get("content-type") || "" };
  }, chosen.src).catch((error) => {
    console.log(`Direct capture fetch failed: ${String(error).slice(0, 120)}`);
    return null;
  });
  if (!payload) return null;
  const bytes = Buffer.from(payload.base64, "base64");
  const extension = /pdf/i.test(payload.contentType) || bytes.subarray(0, 5).toString("ascii") === "%PDF-"
    ? "pdf"
    : bytes[0] === 0x89 ? "png" : "jpg";
  if (bytes.length < 10_000) {
    console.log(`Direct capture returned only ${bytes.length} bytes; falling back to the download control.`);
    return null;
  }
  const file = path.join(downloadsDir, `${targetId}${fileSuffix}.${extension}`);
  fs.writeFileSync(file, bytes);
  console.log(`Wrote ${bytes.length} bytes (${payload.contentType || "unknown type"}) to ${file}.`);
  return file;
}

async function downloadControl(page) {
  const scopes = [page, ...page.frames()];
  for (const scope of scopes) {
    const control = scope.locator("a:visible, button:visible, [role=button]:visible, input[type=button]:visible, input[type=submit]:visible, [title*=ownload], [title*=rint], [aria-label*=ownload]")
      .filter({ hasText: /download|pdf|save|print/i }).first();
    if (await control.count().catch(() => 0)) return control;
    const byAttr = scope.locator("[title*=ownload]:visible, [aria-label*=ownload]:visible, [title*=rint]:visible, [id*=download i]:visible, [id*=print i]:visible").first();
    if (await byAttr.count().catch(() => 0)) return byAttr;
  }
  return null;
}

async function downloadCurrentImage(page) {
  const before = snapshotDownloads();
  const control = await downloadControl(page);
  if (!control) throw new Error("No visible download/PDF control was found on the viewer page or its frames.");
  const started = Date.now();
  await control.click();
  await page.waitForTimeout(1_000);
  const confirm = page.locator("button:visible, a:visible").filter({ hasText: /download|pdf|ok|confirm/i }).first();
  if (await confirm.count()) await confirm.click().catch(() => {});
  const deadline = Date.now() + downloadWaitMs;
  while (Date.now() < deadline) {
    const fresh = newStableDownload(before, started);
    if (fresh) return fresh;
    await page.waitForTimeout(1_500);
  }
  throw new Error("No new stable PDF/JPEG/PNG appeared in the Windows Downloads folder within the wait window.");
}

function snapshotDownloads() {
  return new Set(fs.readdirSync(downloadsDir));
}

function newStableDownload(before, startedMs) {
  const candidates = fs.readdirSync(downloadsDir)
    .filter((name) => !before.has(name))
    .filter((name) => /\.(pdf|jpe?g|png)$/i.test(name) && !name.endsWith(".crdownload"))
    .map((name) => path.join(downloadsDir, name))
    .filter((file) => fs.statSync(file).mtimeMs >= startedMs - 5_000);
  for (const file of candidates) {
    const size = fs.statSync(file).size;
    if (size > 10_000) return file;
  }
  return null;
}

async function inventory(page) {
  const capped = (items, limit) => items.slice(0, limit);
  const selects = [];
  for (const select of capped(await page.locator("select:visible").all(), 6)) {
    const options = [];
    for (const option of capped(await select.locator("option").all(), 8)) {
      options.push(((await option.textContent()) || "").trim().slice(0, 60));
    }
    selects.push({ name: await select.getAttribute("name"), options });
  }
  const labels = [];
  for (const label of capped(await page.locator("label:visible").all(), 20)) {
    labels.push(((await label.textContent()) || "").trim().slice(0, 60));
  }
  const inputs = [];
  for (const field of capped(await page.locator("input[type=text]:visible").all(), 20)) {
    inputs.push({ name: await field.getAttribute("name"), id: await field.getAttribute("id") });
  }
  const actions = [];
  for (const control of capped(await page.locator("button:visible, input[type=submit]:visible, a:visible").all(), 30)) {
    const text = ((await control.textContent()) || (await control.getAttribute("value")) || "").trim().slice(0, 60);
    if (text) actions.push(text);
  }
  return { url: page.url().split("?")[0], title: await page.title(), selects, labels, inputs, actions: [...new Set(actions)] };
}

async function saveFailureShot(page) {
  const dir = process.env.TEMP || process.env.TMP;
  if (!dir) return null;
  const file = path.join(dir, `mdlandrec-${affinitySlot}-${Date.now()}.png`);
  await page.screenshot({ path: file, fullPage: false });
  return file;
}

function normalize(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function compact(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function cssEscape(value) {
  return value.replace(/([^a-zA-Z0-9_-])/g, "\\$1");
}

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  return index < 0 ? "" : process.argv[index + 1] || "";
}
