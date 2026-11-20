#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { deriveExternalRequest } from "./external-request-store.mjs";
import { openSharedChromeTask, sharedChromeEndpoint } from "./shared-chrome-task.mjs";
import { requireConsent } from "./consents.mjs";
requireConsent("mailbox-read");

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requestId = valueAfter("--request");
const endpoint = valueAfter("--endpoint") || sharedChromeEndpoint;
const affinitySlot = valueAfter("--affinity-slot") || "inquiry-attachment-download";
if (!/^[a-z0-9][a-z0-9-]{0,127}$/.test(requestId || "")) throw new Error("Pass one safe --request ID.");
if (!process.argv.includes("--shared-window") || endpoint !== sharedChromeEndpoint) {
  throw new Error(`Attachment recovery must use the shared Windows Chrome wrapper at ${sharedChromeEndpoint}.`);
}

const request = readJson(path.join(projectRoot, "evidence", "acquisition", "requests", `${requestId}.json`));
const responseSubjects = boundResponseSubjects(request);
const derived = deriveExternalRequest(request);
if (derived.operationalState !== "delivery-reported") {
  throw new Error(`${requestId} is ${derived.operationalState}; only a canonically reported delivery can be downloaded.`);
}
// One request can cover several targets: a batch submission answers three
// separate canonical records in one thread. Collect the bound artifacts from
// every item's own target rather than assuming a target named for the request.
const targetIds = [...new Set((request.items || []).map((item) => item.targetId).filter(Boolean))];
if (!targetIds.length) throw new Error(`${requestId} has no canonical target items.`);
for (const id of targetIds) {
  if (!/^[a-z0-9][a-z0-9-]{0,127}$/.test(id)) throw new Error(`${requestId} contains an unsafe target id.`);
}
const artifacts = [];
for (const targetId of targetIds) {
  const itemTarget = readJson(path.join(projectRoot, "evidence", "acquisition", "targets", `${targetId}.json`));
  const itemRoutes = (itemTarget.routes || []).filter((item) => item.requestId === requestId);
  for (const itemRoute of itemRoutes) artifacts.push(...(itemRoute.deliveryArtifacts || []));
}
if (!artifacts.length) throw new Error(`${requestId} has no verified canonical deliveryArtifacts.`);
for (const artifact of artifacts) {
  if (!safeFilename(artifact.providerFilename) || !safeFilename(artifact.archiveFile) || !artifact.sourceId
    || !safeMessageId(artifact.replyMessageId)) {
    throw new Error(`${requestId} contains an unsafe delivery artifact binding.`);
  }
}
const userProfile = process.env.USERPROFILE;
if (!userProfile || !path.win32.isAbsolute(userProfile)) throw new Error("Windows USERPROFILE is unavailable.");
const downloadsRoot = path.join(userProfile, "Downloads");
const archiveRoot = path.join(userProfile, "OneDrive", "Documents", "FamilyHistorySourceMasters");
fs.mkdirSync(downloadsRoot, { recursive: true });
fs.mkdirSync(archiveRoot, { recursive: true });

const session = await openSharedChromeTask({
  chromium,
  endpoint,
  taskLabel: "inquiry attachment recovery",
  affinitySlot,
  timeoutMs: 20_000
});
const recovered = [];
try {
  const page = session.page;
  page.setDefaultTimeout(20_000);
  await page.goto("https://mail.google.com/mail/u/0/#inbox", { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page.waitForTimeout(2_000);
  const search = page.locator('input[aria-label="Search mail"], input[placeholder="Search mail"]').first();
  if (!await search.isVisible().catch(() => false)) throw new Error("Gmail sign-in is required; no attachments were downloaded.");
  for (const artifact of artifacts) {
    const message = await openExactReplyThread(page, responseSubjects, artifact.replyMessageId, request);
    if (!message) throw new Error(`The bound Gmail reply is absent for ${artifact.sourceId}; no attachment was selected.`);
    const matching = await exactDownloadControls(message, artifact.providerFilename);
    const staging = path.join(downloadsRoot, `.family-history-${process.pid}-${artifact.archiveFile}`);
    let download = null;
    try {
      const attachmentUrl = await exactAttachmentUrl(message, artifact.providerFilename);
      const linkedAttachmentUrl = attachmentUrl ? "" : await exactLinkedAttachmentUrl(message, artifact.providerFilename);
      if (matching.length === 1) {
        const downloadPromise = page.waitForEvent("download", { timeout: 45_000 });
        await matching[0].click();
        download = await downloadPromise;
        if (download.suggestedFilename() !== artifact.providerFilename) {
          throw new Error(`Provider filename changed for ${artifact.sourceId}; no archive binding was made.`);
        }
        await download.saveAs(staging);
      } else if (attachmentUrl) {
        const fetched = await page.evaluate(async (url) => {
          const response = await fetch(url, { credentials: "include" });
          if (!response.ok) return { ok: false, status: response.status, data: "" };
          const bytes = new Uint8Array(await response.arrayBuffer());
          let binary = "";
          for (let index = 0; index < bytes.length; index += 0x8000) {
            binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
          }
          return { ok: true, status: response.status, data: btoa(binary) };
        }, attachmentUrl);
        if (!fetched.ok) throw new Error(`Gmail attachment fetch failed for ${artifact.sourceId} with status ${fetched.status}.`);
        fs.writeFileSync(staging, Buffer.from(fetched.data, "base64"), { flag: "wx" });
      } else if (linkedAttachmentUrl) {
        const response = await page.context().request.get(linkedAttachmentUrl, {
          headers: { referer: page.url() },
          timeout: 45_000
        });
        if (!response.ok()) {
          throw new Error(`Linked attachment fetch failed for ${artifact.sourceId} with status ${response.status()}.`);
        }
        fs.writeFileSync(staging, await response.body(), { flag: "wx" });
      } else {
        const control = await nearestAttachmentDownloadControl(page, message, artifact.providerFilename);
        if (!control) throw new Error(`Expected one visible download route for ${artifact.sourceId}; found ${matching.length}.`);
        const downloadPromise = page.waitForEvent("download", { timeout: 45_000 });
        await control.click();
        download = await downloadPromise;
        if (download.suggestedFilename() !== artifact.providerFilename) {
          throw new Error(`Provider filename changed for ${artifact.sourceId}; no archive binding was made.`);
        }
        await download.saveAs(staging);
      }
      const bytes = fs.readFileSync(staging);
      validateMedia(bytes, artifact.archiveFile);
      const digest = crypto.createHash("sha256").update(bytes).digest("hex");
      const destination = path.join(archiveRoot, artifact.archiveFile);
      if (fs.existsSync(destination)) {
        const existing = crypto.createHash("sha256").update(fs.readFileSync(destination)).digest("hex");
        if (existing !== digest) throw new Error(`Archive collision for ${artifact.sourceId}; existing bytes differ.`);
      } else {
        const partial = `${destination}.partial-${process.pid}`;
        fs.copyFileSync(staging, partial, fs.constants.COPYFILE_EXCL);
        encryptAndVerify(partial);
        fs.renameSync(partial, destination);
      }
      encryptAndVerify(destination);
      recovered.push({ sourceId: artifact.sourceId, archiveFile: artifact.archiveFile, sha256: digest, length: bytes.length });
    } finally {
      fs.rmSync(staging, { force: true });
      await download?.delete().catch(() => {});
    }
  }
  console.log(JSON.stringify({ requestId, state: "attachments-archived", artifacts: recovered }, null, 2));
} finally {
  await session.close();
}

function encryptAndVerify(file) {
  execFileSync("cipher.exe", ["/e", "/a", "/q", file], { stdio: "ignore" });
  const script = "$item=Get-Item -LiteralPath $env:FAMILY_HISTORY_VERIFY_FILE; if (-not ($item.Attributes -band [IO.FileAttributes]::Encrypted)) { exit 2 }";
  execFileSync("powershell.exe", ["-NoProfile", "-Command", script], {
    stdio: "ignore",
    env: { ...process.env, FAMILY_HISTORY_VERIFY_FILE: file }
  });
}

function validateMedia(bytes, file) {
  const extension = path.extname(file).toLowerCase();
  const jpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const pdf = bytes.length >= 5 && bytes.subarray(0, 5).toString("ascii") === "%PDF-";
  if (!((extension === ".jpg" || extension === ".jpeg") && jpeg) && !(extension === ".pdf" && pdf)) {
    throw new Error(`Downloaded bytes do not match the canonical media type for ${path.basename(file)}.`);
  }
}

async function firstVisible(locator) {
  for (let index = 0; index < await locator.count(); index += 1) {
    if (await locator.nth(index).isVisible().catch(() => false)) return locator.nth(index);
  }
  return null;
}

async function exactReplyMessage(page, messageId) {
  const messages = page.locator([
    `div.adn.ads[data-legacy-message-id="${messageId}"]`,
    `div.adn.ads[data-message-id="${messageId}"]`,
    `div.adn.ads:has([data-legacy-message-id="${messageId}"])`,
    `div.adn.ads:has([data-message-id="${messageId}"])`
  ].join(", "));
  if (await messages.count() !== 1) return null;
  return messages.first();
}

async function openExactReplyThread(page, subjects, messageId, request) {
  for (const subject of subjects) {
    await page.goto("https://mail.google.com/mail/u/0/#inbox", { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForTimeout(2_000);
    const search = page.locator('input[aria-label="Search mail"], input[placeholder="Search mail"]').first();
    if (!await search.isVisible().catch(() => false)) throw new Error("Gmail search is unavailable during attachment recovery.");
    for (const query of responseSubjectQueries(request, subject, subjects[0])) {
      const matchCount = (await exactSubjectRows(page, search, query, subject)).length;
      // Gmail can split one correspondence into several conversations with the
      // same subject. Open each in turn; only the conversation that holds the
      // exact bound reply message is used, so a sibling thread is never read
      // for attachments.
      for (let ordinal = 0; ordinal < matchCount; ordinal += 1) {
        if (ordinal > 0) {
          await page.goto("https://mail.google.com/mail/u/0/#inbox", { waitUntil: "domcontentloaded", timeout: 45_000 });
          await page.waitForTimeout(2_000);
        }
        const matches = await exactSubjectRows(page, search, query, subject);
        if (matches.length !== matchCount) throw new Error(`The exact response threads for ${subject} changed while they were being read; no attachment was selected.`);
        // A row carrying inline attachment chips is taller than its subject
        // line, so a centre click lands on a chip and opens an attachment
        // preview instead of the conversation. Click the subject span itself.
        const subjectCell = matches[ordinal].locator("span.bog").first();
        const clickable = await subjectCell.isVisible().catch(() => false) ? subjectCell : matches[ordinal];
        await clickable.click();
        await page.locator("div.adn.ads").first()
          .waitFor({ state: "visible", timeout: 20_000 }).catch(() => {});
        await page.waitForTimeout(2_000);
        const expandAll = await firstVisible(page.locator('[aria-label*="Expand all"], [data-tooltip*="Expand all"]'));
        if (expandAll) {
          await expandAll.click();
          await page.waitForTimeout(1_500);
        }
        const message = await exactReplyMessage(page, messageId);
        if (message) return message;
      }
      if (matchCount) break;
    }
  }
  return null;
}

async function exactSubjectRows(page, search, query, subject) {
  const box = await search.isVisible().catch(() => false)
    ? search
    : page.locator('input[aria-label="Search mail"], input[placeholder="Search mail"]').first();
  await box.fill(query);
  await box.press("Enter");
  await page.waitForTimeout(3_000);
  const rows = page.locator("tr.zA:visible");
  const matches = [];
  for (let index = 0; index < await rows.count(); index += 1) {
    const row = rows.nth(index);
    const rowSubject = await row.locator(".bog, .bqe").first().innerText().catch(() => "");
    if (canonicalizeSubject(rowSubject) === canonicalizeSubject(subject)) matches.push(row);
  }
  return matches;
}

async function exactDownloadControls(message, providerFilename) {
  const controls = message.locator('[aria-label*="Download attachment"]');
  const matching = [];
  for (let index = 0; index < await controls.count(); index += 1) {
    const control = controls.nth(index);
    const label = await control.getAttribute("aria-label") || "";
    if (label.includes(providerFilename) && await control.isVisible().catch(() => false)) matching.push(control);
  }
  return matching;
}

async function exactAttachmentUrl(message, providerFilename) {
  const candidates = message.locator("[download_url]");
  const matches = [];
  for (let index = 0; index < await candidates.count(); index += 1) {
    const candidate = candidates.nth(index);
    const binding = await candidate.getAttribute("download_url") || "";
    const text = await candidate.innerText().catch(() => "");
    if (binding.includes(providerFilename) || text.includes(providerFilename)) matches.push(binding);
  }
  if (matches.length !== 1) return "";
  const start = matches[0].indexOf("https://");
  return start >= 0 ? matches[0].slice(start) : "";
}

async function exactLinkedAttachmentUrl(message, providerFilename) {
  const anchors = message.locator("a[href]");
  const matches = [];
  for (let index = 0; index < await anchors.count(); index += 1) {
    const anchor = anchors.nth(index);
    const text = String(await anchor.innerText().catch(() => "") || "").replace(/\s+/g, " ").trim();
    if (text !== providerFilename) continue;
    const href = await anchor.getAttribute("href") || "";
    let parsed;
    try { parsed = new URL(href); } catch { continue; }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) continue;
    matches.push(parsed.href);
  }
  return matches.length === 1 ? matches[0] : "";
}

async function nearestAttachmentDownloadControl(page, message, providerFilename) {
  const filename = await firstVisible(message.getByText(providerFilename, { exact: true }));
  if (!filename) return null;
  let ancestor = filename;
  for (let level = 0; level < 7; level += 1) {
    ancestor = ancestor.locator("xpath=..");
    const candidates = ancestor.locator('[aria-label^="Download"]');
    const visible = [];
    for (let index = 0; index < await candidates.count(); index += 1) {
      const candidate = candidates.nth(index);
      const label = await candidate.getAttribute("aria-label") || "";
      if (!/download all/i.test(label) && await candidate.isVisible().catch(() => false)) visible.push(candidate);
    }
    if (visible.length === 1) return visible[0];
  }
  // Gmail's PDF attachment card may expose only a preview action. Open that
  // exact verified attachment inside Gmail, then use the preview's normal
  // Download control; this remains in the owned background task tab.
  await filename.click();
  await page.waitForTimeout(2_000);
  const previewControls = page.locator('[aria-label^="Download"], [data-tooltip^="Download"]');
  const visiblePreviewControls = [];
  for (let index = 0; index < await previewControls.count(); index += 1) {
    const candidate = previewControls.nth(index);
    const label = `${await candidate.getAttribute("aria-label") || ""} ${await candidate.getAttribute("data-tooltip") || ""}`;
    if (!/download all/i.test(label) && await candidate.isVisible().catch(() => false)) visiblePreviewControls.push(candidate);
  }
  if (visiblePreviewControls.length === 1) return visiblePreviewControls[0];
  return null;
}

function safeFilename(value) {
  // Providers legitimately send diacritics: the Hauptstaatsarchiv Stuttgart's
  // scan arrived as "E 146_Bü 1790.pdf". Accept any Unicode letter or digit
  // while still refusing path separators, traversal, and control characters.
  // Cameras name files in capitals: the Norris Museum sent "IMG_2224.JPG".
  return typeof value === "string" && path.basename(value) === value
    && /^[\p{L}\p{N}][\p{L}\p{N} ._(),&'’-]{0,220}\.(?:jpe?g|pdf)$/iu.test(value);
}

function safeMessageId(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{6,128}$/.test(value);
}

function boundResponseSubjects(request) {
  const primary = request.spec?.subject || request.responseBinding?.subject;
  const aliases = request.responseBinding?.subjectAliases || [];
  if (!Array.isArray(aliases) || aliases.length > 5) throw new Error(`${requestId} has invalid response subject aliases.`);
  const subjects = [...new Set([primary, ...aliases])];
  if (!subjects.length || subjects.some((subject) => typeof subject !== "string"
    || !subject || /[\r\n]/.test(subject) || subject.length > 240)) {
    throw new Error(`${requestId} has no safe canonical response subject binding.`);
  }
  return subjects;
}

// -in:drafts: a compose that stopped before sending leaves an auto-saved draft with the
// same subject (15 Nov 2026), which must not count as a second canonical thread.
function responseSubjectQueries(request, subject, primarySubject) {
  const exactQuery = `in:anywhere -in:drafts subject:"${subject.replaceAll('"', "")}"`;
  if (canonicalizeSubject(subject) !== canonicalizeSubject(primarySubject)) {
    const terms = request.responseBinding?.matchTerms || [];
    if (!Array.isArray(terms) || !terms.length || terms.length > 8
      || terms.some((term) => typeof term !== "string" || !term.trim() || /[\r\n]/.test(term) || term.length > 120)) {
      throw new Error(`${requestId} has an alias without safe request-specific match terms.`);
    }
    return [`${exactQuery} ${terms.map((term) => `"${term.trim().replaceAll('"', "")}"`).join(" ")}`];
  }
  return [exactQuery, `in:anywhere -in:drafts ${subjectSearchTerms(subject)}`];
}

function subjectSearchTerms(value) {
  const words = canonicalizeSubject(value)
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(/\s+/)
    .filter((word) => word.length >= 3)
    .slice(0, 8);
  if (!words.length) throw new Error("The canonical subject has no safe fallback search terms.");
  return words.join(" ");
}

function canonicalizeSubject(value) {
  return String(value || "").replace(/\s+/g, " ").trim().toLocaleLowerCase()
    .replace(/^(?:(?:re|fw|fwd)\s*:\s*)+/i, "")
    .normalize("NFKC");
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  return index < 0 ? "" : process.argv[index + 1] || "";
}
