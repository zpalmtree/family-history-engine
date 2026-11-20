#!/usr/bin/env node

// Guarded Wise bank transfer (AGENTS.md, 3 Nov 2026).
//
//   npm run transfer:win -- -Request <request-id> -Explore [-Path /home]
//   npm run transfer:win -- -Request <request-id>
//
// Prepares a Wise transfer to a provider that takes only bank transfer, for a
// request carrying the user's exact PAY approval and the provider's payment
// request. Payee details come only from the provider's own payment
// instructions, held in memory; only a masked summary is ever printed. The
// helper stops on Wise's final review: the user presses the send control and
// completes any sign-in, 2FA or funding step, and the result is recorded from
// Wise's confirmation. --explore reports page structure (headings, field
// labels, control labels) without values or actions.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { appendExternalRequestEvent } from "./external-request-store.mjs";
import {
  authorizedTransfer,
  bankTransferProfileFor,
  docxText,
  crossCurrencyGuard,
  maskedPayee,
  parseIbanPayee,
  parsePayee,
  referenceIsValid,
  reviewGuard,
  sentActivityMatches
} from "./bank-transfer-policy.mjs";
import { requireConsent } from "./consents.mjs";
import { ownerName } from "./tree-config.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const wiseOrigin = "https://wise.com";

function requestFile(requestId) {
  if (!/^[a-z0-9][a-z0-9-]{0,127}$/.test(requestId || "")) throw new Error("Pass one safe request ID.");
  return path.join(projectRoot, "evidence", "acquisition", "requests", `${requestId}.json`);
}

export function persistEvent(requestId, event) {
  const file = requestFile(requestId);
  const request = JSON.parse(fs.readFileSync(file, "utf8"));
  const updated = appendExternalRequestEvent(request, event, { expectedRevision: request.revision });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(updated, null, 2)}\n`, { flag: "wx" });
  fs.renameSync(temporary, file);
  execFileSync(process.execPath, ["tools/sync-external-request-projections.mjs"], { cwd: projectRoot, stdio: "ignore" });
}

// Structure only: headings, labelled fields (never their values) and visible
// control labels, across frames.
export async function pageStructure(page) {
  const parts = [];
  for (const frame of page.frames()) {
    parts.push(await frame.evaluate(() => {
      const visible = (element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== "hidden";
      };
      const clean = (value) => String(value || "").replace(/\s+/g, " ").trim().slice(0, 80);
      const labelFor = (element) => clean(element.labels?.[0]?.innerText || element.getAttribute("aria-label")
        || element.getAttribute("placeholder") || element.name || element.id);
      return {
        headings: [...document.querySelectorAll("h1, h2, h3, h4, h5, legend")].filter(visible).map((node) => clean(node.innerText)).filter(Boolean).slice(0, 12),
        alerts: [...document.querySelectorAll("[role='alert'], [aria-live='assertive'], .alert, .has-error, .invalid-feedback, [class*='error'], [class*='Error']")]
          .filter(visible).map((node) => clean(node.innerText)).filter(Boolean).slice(0, 10),
        fields: [...document.querySelectorAll("input:not([type=hidden]), select, textarea")].filter(visible)
          .map((node) => `${node.tagName.toLowerCase()}${node.type ? `[${node.type}]` : ""}: ${labelFor(node)}`).slice(0, 25),
        controls: [...document.querySelectorAll("button, a, [role='button'], [role='link'], [role='tab'], [role='radio'], [role='option'], [role='menuitem'], label, li[tabindex], [tabindex='0']")].filter(visible)
          .map((node) => clean(node.innerText || node.getAttribute("aria-label"))).filter(Boolean).slice(0, 40)
      };
    }).catch(() => null));
  }
  const merged = { headings: [], alerts: [], fields: [], controls: [] };
  for (const part of parts.filter(Boolean)) for (const key of Object.keys(merged)) merged[key].push(...part[key]);
  // Never report balances, amounts or transaction rows: any label carrying a
  // digit is dropped, so the structure names steps and controls only.
  for (const key of Object.keys(merged)) merged[key] = [...new Set(merged[key])].filter((label) => !/\d/.test(label));
  const url = new URL(page.url());
  return { at: `${url.origin}${url.pathname}`, ...merged };
}

// Payee details read from the provider's own payment-instructions attachment,
// saved to a task-local temporary file, parsed in memory, and deleted.
export async function readPayee(page, profile, authorization = null) {
  if (profile.instructionsMessageId) {
    // Instructions stated in the body of one exact provider message.
    await page.goto(`https://mail.google.com/mail/u/0/#all/${profile.instructionsMessageId}`, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.locator("div.adn.ads").first().waitFor({ state: "visible", timeout: 30_000 });
    await page.waitForTimeout(1_500);
    const bodies = await page.locator("div.adn.ads div.a3s").evaluateAll((nodes) => nodes.map((node) => node.innerText || ""));
    const matching = bodies.filter((body) => profile.referenceRule.test(body.replace(/\s+/g, " ")) && /\bIBAN\b/i.test(body));
    if (matching.length !== 1) throw new Error(`Found ${matching.length} provider messages stating the payment instructions; nothing was prepared.`);
    // Only the provider's own text, never a quoted earlier message below it.
    return parseIbanPayee(matching[0].split(/\n(?:Da |On .* wrote:|Il .* ha scritto:)/)[0], profile, authorization);
  }
  const { readGmailConversation, saveConversationAttachment } = await import("./gmail-payment-link.mjs");
  await readGmailConversation(page, profile.gmailQuery, { log: () => {} });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "family-history-transfer-"));
  try {
    const file = await saveConversationAttachment(page, profile.instructionsAttachment, directory);
    return parsePayee(docxText(fs.readFileSync(file)), profile);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

// Types the verified payee into Wise's organisation bank-details form, checks
// every field kept exactly what was typed (values stay in memory), and moves on.
// Describes a mismatch without revealing either value.
export function keptValueDiagnostic(kept, expected) {
  const relation = kept === "" ? "empty"
    : expected.startsWith(kept) ? "a prefix of the expected value"
      : kept.startsWith(expected) ? "the expected value plus extra characters"
        : kept.endsWith(expected.slice(-2)) ? "same ending, different body" : "different";
  return `kept ${kept.length} of ${expected.length} characters, ${relation}`;
}

// The organisation bank-details fields Wise shows for this payee's account type.
export function recipientFields(payee) {
  if (payee?.iban) return [["Name of the business / organisation", payee.accountName], ["IBAN", payee.iban]];
  return [
    ["Name of the business / organisation", payee.accountName],
    ["UK sort code", payee.sortCode],
    ["Account number", payee.accountNumber]
  ];
}

// The account-type choice Wise lists for the authorized currency.
export function currencyChoice(currency) {
  const choices = { GBP: "GBP British pound", EUR: "EUR Euro" };
  if (!choices[currency]) throw new Error(`No reviewed Wise currency choice for ${currency}.`);
  return choices[currency];
}

// Only an exact payee-name match lets the transfer continue: the UK
// Confirmation of Payee or the euro Verification of Payee.
export function payeeCheckIsExactMatch(heading) {
  return /^account name and account details match$/i.test(String(heading || "").replace(/\s+/g, " ").trim());
}

export async function fillRecipient(page, payee) {
  const fields = recipientFields(payee);
  for (const [label, value] of fields) {
    const input = page.getByLabel(label, { exact: true });
    if (await input.count() !== 1) throw new Error(`Expected one "${label}" field; nothing was submitted.`);
    const expected = value.replace(/[\s-]/g, "");
    const readKept = async () => (await input.inputValue()).replace(/[\s-]/g, "");
    await input.click();
    await input.fill("");
    await input.pressSequentially(value, { delay: 40 });
    await page.waitForTimeout(300);
    if (await readKept() !== expected) {
      // Some Wise fields reformat or auto-advance while typing; set the value
      // directly once, as a paste would.
      await input.click();
      await input.fill(value);
      await page.waitForTimeout(300);
    }
    await input.press("Tab");
    await page.waitForTimeout(300);
    const kept = await readKept();
    if (kept !== expected) {
      throw new Error(`"${label}" did not keep the verified value (${keptValueDiagnostic(kept, expected)}); nothing was submitted.`);
    }
  }
  const invalid = [];
  for (const [label] of fields) {
    if (await page.getByLabel(label, { exact: true }).getAttribute("aria-invalid") === "true") invalid.push(label);
  }
  if (invalid.length) throw new Error(`Wise marked ${invalid.join(", ")} invalid; nothing was submitted.`);
  const next = page.getByRole("button", { name: "Continue", exact: true });
  if (await next.count() !== 1) throw new Error("Expected one Continue control.");
  // Wise checks the sort code and account asynchronously before enabling Continue.
  const enabledBy = Date.now() + 20_000;
  while (await next.isDisabled() && Date.now() < enabledBy) await page.waitForTimeout(1_000);
  if (await next.isDisabled()) {
    const state = await page.evaluate(() => [...document.querySelectorAll("input:not([type=hidden]), select, textarea")]
      .filter((node) => node.getBoundingClientRect().width > 0)
      .map((node) => `${node.labels?.[0]?.innerText?.trim() || node.name || node.id}: ${node.value ? "filled" : "empty"}${node.required ? ", required" : ""}${node.getAttribute("aria-invalid") === "true" ? ", invalid" : ""}${node.matches(":invalid") ? ", css-invalid" : ""}`));
    throw new Error(`Continue stayed disabled after the verified payee was entered. Fields: ${state.join("; ")}`);
  }
  await next.click({ timeout: 5_000 }).catch(() => next.evaluate((element) => element.click()));
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(3_000);
  // UK Confirmation of Payee: only an exact match lets the transfer continue.
  // A close match, no match or an unavailable check stops for the user.
  // The name check runs asynchronously; wait for Wise to leave the form.
  const readHeading = async () => (await page.locator("h1, h2, h3").first().innerText().catch(() => "")).replace(/\s+/g, " ").trim();
  let heading = await readHeading();
  const checkedBy = Date.now() + 30_000;
  while (/^enter the organisation's account details$/i.test(heading) && Date.now() < checkedBy) {
    await page.waitForTimeout(1_000);
    heading = await readHeading();
  }
  if (!payeeCheckIsExactMatch(heading)) {
    const structure = await pageStructure(page).catch(() => ({}));
    if (structure.alerts?.length) console.error(`Wise alerts: ${structure.alerts.join(" | ")}`);
    throw new Error(`Wise's payee check did not return an exact match ("${heading.replace(/\d/g, "#").slice(0, 80)}"); nothing was sent.`);
  }
  const accept = page.getByRole("button", { name: "Continue", exact: true });
  if (await accept.count() !== 1) throw new Error("Expected one Continue after the payee check.");
  await accept.click({ timeout: 5_000 }).catch(() => accept.evaluate((element) => element.click()));
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(3_000);
  return { payeeCheck: "exact-match" };
}

// The payee must receive exactly the authorized amount: it is typed into the
// recipient ("To") side, never the sending side, and read back before Continue.
export async function setRecipientAmount(page, authorization, payee) {
  const candidates = page.getByLabel("To", { exact: true });
  const visible = [];
  for (let index = 0; index < await candidates.count(); index += 1) {
    const candidate = candidates.nth(index);
    if (await candidate.isVisible().catch(() => false) && await candidate.isEditable().catch(() => false)) visible.push(candidate);
  }
  if (visible.length !== 1) {
    const labels = await page.evaluate(() => [...document.querySelectorAll("input")].filter((node) => node.getBoundingClientRect().width > 0)
      .map((node) => `${node.getAttribute("aria-label") || node.labels?.[0]?.innerText?.trim() || node.id}${node.readOnly ? " (read-only)" : ""}`));
    throw new Error(`Expected one editable recipient-amount field; found ${visible.length}. Inputs: ${labels.join("; ").replace(/\d/g, "#")}`);
  }
  const to = visible[0];
  const bodyText = (await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ");
  // The recipient card names the verified payee and the currency it receives.
  const payeeName = payee?.accountName || "Cambridgeshire County Council";
  const recipientCurrency = new RegExp(`${payeeName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*[·•\\-–]\\s*([A-Z]{3})`).exec(bodyText)?.[1];
  if (recipientCurrency !== authorization.currency) {
    throw new Error(`The recipient is shown receiving ${recipientCurrency || "an unidentified currency"}, not ${authorization.currency}.`);
  }
  await to.click();
  await to.fill("");
  await to.pressSequentially(String(authorization.amount), { delay: 60 });
  await to.press("Tab");
  await page.waitForTimeout(3_000);
  const kept = Number((await to.inputValue()).replace(/[^0-9.]/g, ""));
  if (kept !== authorization.amount) throw new Error(`The recipient amount reads ${kept}, not ${authorization.amount}; nothing was sent.`);
  const next = page.getByRole("button", { name: "Continue", exact: true });
  const enabledBy = Date.now() + 20_000;
  while (await next.isDisabled() && Date.now() < enabledBy) await page.waitForTimeout(1_000);
  if (await next.isDisabled()) throw new Error("Continue stayed disabled on the amount step.");
  await next.click({ timeout: 5_000 }).catch(() => next.evaluate((element) => element.click()));
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(3_000);
}

// The provider's reference and the beneficiary's reviewed address, typed into
// Wise's details step and read back. Nothing here sends anything.
export async function fillTransferDetails(page, profile) {
  const typeInto = async (label, value) => {
    // Match the same visible label text the explorer reports, then address
    // the field by a task-local marker (Wise's accessible names vary).
    const source = label instanceof RegExp ? label.source : `^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
    const flags = label instanceof RegExp ? label.flags : "";
    const marker = `fh-${Math.random().toString(36).slice(2)}`;
    const mark = () => page.evaluate(({ source, flags, marker }) => {
      const pattern = new RegExp(source, flags);
      for (const node of document.querySelectorAll("input:not([type=hidden]), textarea")) {
        const text = String(node.labels?.[0]?.innerText || node.getAttribute("aria-label") || node.getAttribute("placeholder") || "")
          .replace(/\s+/g, " ").trim();
        if (pattern.test(text)) node.setAttribute("data-fh-field", marker);
      }
    }, { source, flags, marker });
    const candidates = page.locator(`[data-fh-field="${marker}"]`);
    let input = null;
    let expanded = false;
    const readyBy = Date.now() + 15_000;
    while (!input && Date.now() < readyBy) {
      await mark();
      const editable = [];
      for (let index = 0; index < await candidates.count(); index += 1) {
        const candidate = candidates.nth(index);
        if (await candidate.isVisible().catch(() => false) && await candidate.isEditable().catch(() => false)) editable.push(candidate);
      }
      if (editable.length > 1) throw new Error(`Found ${editable.length} editable "${label}" fields; nothing was sent.`);
      input = editable[0] || null;
      if (!input && !expanded && Date.now() > readyBy - 10_000) {
        // A summary screen can collapse the details; the reference sits in the
        // Amount section, which a click expands without changing anything.
        expanded = true;
        const section = page.getByText("Amount", { exact: true }).first();
        if (await section.isVisible().catch(() => false)) {
          await section.click({ timeout: 5_000 }).catch(() => section.evaluate((element) => element.click()));
        }
      }
      if (!input) await page.waitForTimeout(1_000);
    }
    if (!input) {
      const seen = await page.evaluate(() => [...document.querySelectorAll("input:not([type=hidden]), textarea, select, [role='combobox']")]
        .filter((node) => node.getBoundingClientRect().width > 0)
        .map((node) => String(node.labels?.[0]?.innerText || node.getAttribute("aria-label") || node.getAttribute("placeholder") || node.name || node.id).replace(/\s+/g, " ").trim()));
      const headings = await page.evaluate(() => [...document.querySelectorAll("h1, h2, h3")].map((node) => node.innerText.replace(/\s+/g, " ").trim()));
      throw new Error(`No editable "${label}" field appeared. Headings: ${headings.join(" | ")}. Fields: ${seen.join(" | ").replace(/\d/g, "#")}`);
    }
    // Wise re-renders these fields, so re-find the field immediately before
    // focusing it and again before reading it back; type with the keyboard.
    await page.waitForTimeout(1_000);
    let focused = false;
    let why = "";
    const focusBy = Date.now() + 15_000;
    while (!focused && Date.now() < focusBy) {
      await mark();
      ({ focused, why } = await page.evaluate((marker) => {
        const node = document.querySelector(`[data-fh-field="${marker}"]`);
        if (!node) return { focused: false, why: "missing" };
        if (node.disabled || node.readOnly) return { focused: false, why: node.disabled ? "disabled" : "read-only" };
        node.scrollIntoView({ block: "center" });
        node.click();
        node.focus();
        node.select?.();
        return { focused: document.activeElement === node, why: `active is ${document.activeElement?.tagName?.toLowerCase()}` };
      }, marker));
      if (!focused && why === "missing") {
        // The final screen collapses the details; the reference sits in the
        // Amount section, which a click expands without changing anything.
        const section = page.getByText("Amount", { exact: true }).first();
        if (await section.isVisible().catch(() => false)) {
          await section.click({ timeout: 5_000 }).catch(() => section.evaluate((element) => element.click()));
          await page.waitForTimeout(1_500);
        }
      }
      if (!focused) await page.waitForTimeout(1_000);
    }
    if (!focused) {
      const structure = await pageStructure(page).catch(() => ({}));
      throw new Error(`Could not focus "${label}" (${why}); nothing was sent. Page: ${JSON.stringify({ h: structure.headings, f: structure.fields, c: structure.controls })}`);
    }
    await page.keyboard.press("Control+A");
    await page.keyboard.press("Backspace");
    await page.keyboard.type(value, { delay: 30 });
    await page.keyboard.press("Tab");
    await page.waitForTimeout(800);
    await mark();
    const kept = await page.evaluate((marker) => document.querySelector(`[data-fh-field="${marker}"]`)?.value ?? null, marker);
    if ((kept || "").trim() !== value) throw new Error(`"${label}" did not keep its value; nothing was sent.`);
  };
  if (!referenceIsValid(profile.reference, profile)) throw new Error("The reviewed reference is invalid.");
  const address = profile.beneficiaryAddress;
  const needsAddress = await page.getByText("Recipient address", { exact: true }).first().isVisible().catch(() => false);
  if (needsAddress && await page.getByText("Choose a country", { exact: true }).count()) {
    await page.getByText("Choose a country", { exact: true }).first().click();
    await page.waitForTimeout(1_000);
    await page.keyboard.type(address.country, { delay: 40 });
    await page.waitForTimeout(1_500);
    const option = page.getByRole("option", { name: address.country, exact: true })
      .or(page.getByRole("button", { name: address.country, exact: true }));
    if (!await option.count()) throw new Error("Wise offered no exact country option.");
    await option.first().click().catch(() => option.first().evaluate((element) => element.click()));
    await page.waitForTimeout(1_500);
  }
  if (needsAddress) {
    await typeInto("City", address.city);
    await typeInto("Recipient address", address.line);
    await typeInto("Post code", address.postcode);
  }
  const update = page.getByRole("button", { name: "Update", exact: true });
  if (needsAddress && await update.count() === 1) {
    await update.click({ timeout: 5_000 }).catch(() => update.evaluate((element) => element.click()));
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    await page.waitForTimeout(3_000);
  }
  // Wise shows the reference field once the recipient's details are complete.
  await typeInto(/^Reference\b/i, profile.reference);
  return { referenceEntered: true };
}

// This transfer's own quote lines only (never balances or history).
export async function quoteLines(page) {
  return (await page.locator("body").innerText().catch(() => ""))
    .split(/\n+/).map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => /GBP|USD|EUR|£|\$|fee|rate|total|you send|gets|arrives/i.test(line) && !/balance|interest|sent ·|received ·/i.test(line))
    .map((line) => line.slice(0, 100)).slice(0, 40);
}

const sentText = /transfer (?:is|has been) (?:on its way|sent|scheduled)|you(?:'ve| have) sent|your (?:money|transfer) is on its way|we(?:'ve| have) (?:got|received) your|transfer complete|payment (?:sent|complete)/i;
const failedText = /transfer (?:failed|was cancelled|couldn't|could not)|payment (?:failed|declined)|something went wrong/i;

// Prepares the transfer up to Wise's final "Send now", checks the quote, and
// leaves the press to the user. Records the result only from Wise's own page.
export async function prepareTransfer(page, { requestId, task, profile, authorization, payee, log = console.error, waitMs = 900_000 }) {
  await page.goto(`${wiseOrigin}/send`, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page.waitForTimeout(4_000);
  await awaitWiseSignIn(page, { task, log, waitMs });
  await exploreClicks(page, ["Add", currencyChoice(authorization.currency), "Bank details", "Business or Charity"]);
  await fillRecipient(page, payee);
  log("Wise's Confirmation of Payee returned an exact name match.");
  await setRecipientAmount(page, authorization, payee);
  await fillTransferDetails(page, profile);
  await page.waitForTimeout(3_000);
  let lines = await quoteLines(page);
  // The fee breakdown lives in the collapsible Amount section; toggling it
  // changes nothing in the transfer.
  for (let toggle = 0; toggle < 3 && !lines.some((line) => /^total fees/i.test(line)); toggle += 1) {
    const breakdown = page.getByText(/^Fees included$/).first();
    const section = page.getByText("Amount", { exact: true }).first();
    const target = toggle === 1 && await breakdown.isVisible().catch(() => false) ? breakdown : section;
    if (!await target.isVisible().catch(() => false)) break;
    await target.click({ timeout: 5_000 }).catch(() => target.evaluate((element) => element.click()));
    await page.waitForTimeout(2_000);
    lines = await quoteLines(page);
  }
  // This transfer's own send and receive amounts, held in Wise's From/To inputs.
  const amountInputs = await page.evaluate(() => {
    const value = (label) => {
      const node = [...document.querySelectorAll("input")].find((input) => input.getBoundingClientRect().width > 0
        && String(input.labels?.[0]?.innerText || input.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim() === label);
      const number = node ? Number(String(node.value).replace(/[^0-9.]/g, "")) : NaN;
      return Number.isFinite(number) && number > 0 ? number : null;
    };
    return { send: value("From"), receive: value("To") };
  });
  if (amountInputs.receive === null || amountInputs.send === null) {
    throw new Error("Wise's From/To amounts were not readable on the final step; nothing was sent.");
  }
  const guard = lines.some((line) => /1\s+[A-Z]{3}\s*=/.test(line)) && !lines.some((line) => new RegExp(`1\\s+${authorization.currency}\\s*=`).test(line))
    ? crossCurrencyGuard(lines, authorization, profile, amountInputs)
    : reviewGuard(lines.join("\n"), authorization, profile);
  if (!guard.ok) throw new Error(`Transfer refused: ${guard.reason}; nothing was sent. Quote lines: ${JSON.stringify(lines)}`);
  // Entering the reference opens the Amount section for editing; its own
  // Continue saves it and returns to the summary that carries Send now.
  const save = page.getByRole("button", { name: "Continue", exact: true });
  if (await save.count() === 1 && await save.isVisible().catch(() => false)) {
    await save.click({ timeout: 5_000 }).catch(() => save.evaluate((element) => element.click()));
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    await page.waitForTimeout(3_000);
  }
  const summaryText = (await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ");
  if (!summaryText.includes(profile.reference)) throw new Error("The summary does not show the reviewed reference; nothing was sent.");
  if (!summaryText.includes(payee.accountName)) throw new Error("The summary does not show the verified payee; nothing was sent.");
  const sendCandidates = page.getByRole("button", { name: "Send now", exact: true })
    .or(page.getByRole("link", { name: "Send now", exact: true }))
    .or(page.locator("button, a, [role='button']").filter({ hasText: /^\s*Send now\s*$/ }));
  const visibleSends = [];
  for (let index = 0; index < await sendCandidates.count(); index += 1) {
    if (await sendCandidates.nth(index).isVisible().catch(() => false)) visibleSends.push(sendCandidates.nth(index));
  }
  if (visibleSends.length !== 1) {
    const structure = await pageStructure(page).catch(() => ({}));
    throw new Error(`Expected exactly one visible Send now control; found ${visibleSends.length}. Nothing was sent. Page: ${JSON.stringify({ h: structure.headings, f: structure.fields, c: structure.controls })}`);
  }
  const send = visibleSends[0];
  const summary = guard.source
    ? `${payee.accountName} gets exactly ${authorization.currency} ${authorization.amount}; you send ${guard.total} ${guard.source} (fee ${guard.fee} ${guard.source}, about ${authorization.currency} ${guard.feeInTarget})`
    : `${payee.accountName} gets exactly ${authorization.currency} ${authorization.amount}`;
  await task?.showForManualStep?.("the final Wise Send now");
  log(`Checked: ${summary}, reference "${profile.reference}". Press Send now in the revealed Wise tab to pay; complete any 2FA there.`);
  const deadline = Date.now() + waitMs;
  let started = false;
  let startedAt = 0;
  let checkedActivity = false;
  while (Date.now() < deadline) {
    await page.waitForTimeout(2_000);
    if (page.isClosed()) return { requestId, status: started ? "uncertain" : "needs-user", reason: "wise-tab-closed" };
    const text = await page.locator("body").innerText().catch(() => "");
    const stillAtSend = await send.isVisible().catch(() => false);
    if (!stillAtSend && !started) {
      started = true;
      startedAt = Date.now();
      persistEvent(requestId, { type: "payment-started", amount: authorization.amount, currency: authorization.currency,
        basis: `guarded-bank-transfer Wise, user pressed Send now; ${summary}` });
    }
    if (started && sentText.test(text)) {
      persistEvent(requestId, { type: "payment-submitted", amount: authorization.amount, currency: authorization.currency,
        basis: `guarded-bank-transfer Wise confirmation; reference ${profile.reference}; ${summary}` });
      return { requestId, status: "paid", amount: authorization.amount, currency: authorization.currency, summary };
    }
    // Wise's confirmation wording varies; its own activity list is the
    // authority. Two minutes after the press, look for this payee's row.
    if (started && !checkedActivity && Date.now() - startedAt > 120_000) {
      checkedActivity = true;
      await page.goto(`${wiseOrigin}/home`, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => {});
      await page.waitForTimeout(5_000);
      const row = await page.evaluate((name) => [...document.querySelectorAll("a, button, li, [role='button'], [role='listitem']")]
        .map((node) => node.innerText.replace(/\s+/g, " ").trim())
        .find((value) => value.startsWith(name) && /\bSent\b.*\bToday\b/.test(value)) || "", payee.accountName);
      if (sentActivityMatches(row, authorization)) {
        persistEvent(requestId, { type: "payment-submitted", amount: authorization.amount, currency: authorization.currency,
          basis: `guarded-bank-transfer Wise activity "${row.slice(0, 120)}"; reference ${profile.reference}; ${summary}` });
        return { requestId, status: "paid", amount: authorization.amount, currency: authorization.currency, summary };
      }
    }
    if (started && failedText.test(text)) {
      persistEvent(requestId, { type: "payment-retryable", basis: "Wise reported the transfer did not go through" });
      return { requestId, status: "declined" };
    }
  }
  return { requestId, status: started ? "uncertain" : "needs-user", reason: started ? "no Wise confirmation seen" : "Send now not pressed", summary };
}

export function isWiseLoginUrl(url) {
  try {
    const parsed = new URL(url);
    return /(^|\.)wise\.com$/.test(parsed.hostname) && /^\/(login|account\/login|identity\/login)\b/.test(parsed.pathname);
  } catch {
    return false;
  }
}

// A lapsed Wise session lands on its login page. Signing in is the user's
// step: reveal the tab, wait for Wise to leave its login page, then resume on
// the send flow. The helper never types or reads any sign-in field.
async function awaitWiseSignIn(page, { task, log, waitMs }) {
  if (!isWiseLoginUrl(page.url())) return;
  await task?.showForManualStep?.("Wise sign-in");
  log("Wise is signed out: sign in to Wise in the revealed tab (complete any 2FA there); the transfer resumes automatically.");
  const deadline = Date.now() + Math.min(waitMs, 900_000);
  while (Date.now() < deadline && isWiseLoginUrl(page.url())) await page.waitForTimeout(3_000);
  if (isWiseLoginUrl(page.url())) throw new Error("Wise sign-in was not completed in time; nothing was sent.");
  await page.waitForTimeout(3_000);
  if (!/\/send\b/.test(new URL(page.url()).pathname)) {
    await page.goto(`${wiseOrigin}/send`, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForTimeout(4_000);
  }
}

async function exploreClicks(page, labels) {
  for (const label of labels) {
    if (!exploreClickAllowed(label)) throw new Error(`Never clicks "${label}".`);
    const control = page.getByRole("button", { name: label, exact: true })
      .or(page.getByRole("button", { name: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`) }))
      .or(page.getByRole("link", { name: label, exact: true }))
      .or(page.getByRole("option", { name: label, exact: true }))
      .or(page.getByText(label, { exact: true }));
    const visible = [];
    const appearBy = Date.now() + 15_000;
    while (!visible.length && Date.now() < appearBy) {
      for (let index = 0; index < await control.count(); index += 1) {
        if (await control.nth(index).isVisible().catch(() => false)) visible.push(control.nth(index));
      }
      if (!visible.length) await page.waitForTimeout(1_000);
    }
    if (!visible.length) throw new Error(`No visible "${label}" control.`);
    await visible[0].click({ timeout: 5_000 }).catch(() => visible[0].evaluate((element) => element.click()));
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(2_500);
  }
}

// Exploration only navigates: it types nothing and never presses a control
// that could send, confirm, pay or change the account.
export function exploreClickAllowed(label) {
  return Boolean(label)
    && !/\b(?:send|confirm|pay|payment|transfer now|delete|remove|close account|save|submit|verify|approve)\b/i.test(label);
}

const log = (message) => console.error(message);

async function main() {
  const { chromium } = await import("playwright-core");
  const { openSharedChromeTask, sharedChromeEndpoint } = await import("./shared-chrome-task.mjs");
  const requestId = valueAfter("--request");
  const explore = process.argv.includes("--explore");
  const explorePath = valueAfter("--path") || "/home";
  const clickLabels = valueAfter("--clicks").split("|").map((label) => label.trim()).filter(Boolean);
  if (!process.argv.includes("--shared-window")) throw new Error("Run through the Windows wrapper: npm run transfer:win.");
  requireConsent("bank-transfer");
  ownerName(); // the payment reference carries the owner's surname
  if (!/^\/[A-Za-z0-9/_#?=&.-]{0,120}$/.test(explorePath)) throw new Error("Pass a plain Wise path.");
  const request = JSON.parse(fs.readFileSync(requestFile(requestId), "utf8"));
  const profile = bankTransferProfileFor(request);
  // A read-only status check must work while an unconfirmed payment holds the
  // request; every other mode needs the unpaid, approved quote.
  const statusOnly = explore && process.argv.includes("--transfer-status");
  const authorization = statusOnly ? null : authorizedTransfer(request);

  const task = await openSharedChromeTask({
    chromium,
    endpoint: sharedChromeEndpoint,
    taskLabel: `transfer-${requestId}`,
    affinitySlot: `transfer-${requestId}`.slice(0, 32).replace(/-$/, ""),
    timeoutMs: 20_000
  });
  let keepOpen = false;
  // Leaving Gmail after an attachment download can raise its "leave site?"
  // prompt; accept only that, dismiss any other dialog, and tolerate a dialog
  // the bridge already closed.
  task.page.on("dialog", (dialog) => {
    (dialog.type() === "beforeunload" ? dialog.accept() : dialog.dismiss()).catch(() => {});
  });
  try {
    if (explore) {
      console.error("Reading the provider's payment instructions in memory.");
      const payee = await readPayee(task.page, profile, authorization);
      console.error(`Verified payee ${maskedPayee(payee)}; opening Wise.`);
      await task.page.waitForTimeout(2_000);
      await task.page.goto(`${wiseOrigin}${explorePath}`, { waitUntil: "domcontentloaded", timeout: 45_000 });
      await task.page.waitForTimeout(4_000);
      if (isWiseLoginUrl(task.page.url())) {
        // Signing in is the user's step; explore resumes on its own path after.
        await awaitWiseSignIn(task.page, { task, log, waitMs: 900_000 });
        await task.page.goto(`${wiseOrigin}${explorePath}`, { waitUntil: "domcontentloaded", timeout: 45_000 });
        await task.page.waitForTimeout(4_000);
      }
      for (const label of clickLabels) {
        if (!exploreClickAllowed(label)) throw new Error(`Exploration never clicks "${label}".`);
        // A label may be the start of a richer choice ("Bank details Enter …").
        const control = task.page.getByRole("button", { name: label, exact: true })
          .or(task.page.getByRole("button", { name: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`) }))
          .or(task.page.getByRole("link", { name: label, exact: true }))
          .or(task.page.getByRole("tab", { name: label, exact: true }))
          .or(task.page.getByRole("option", { name: label, exact: true }))
          .or(task.page.getByRole("radio", { name: label, exact: true }))
          .or(task.page.getByText(label, { exact: true }));
        // A list may render the same choice twice (a featured row and the
        // full list); click only the first visible one, and only when every
        // match is the same accessible choice.
        const visible = [];
        const appearBy = Date.now() + 15_000;
        while (!visible.length && Date.now() < appearBy) {
          for (let index = 0; index < await control.count(); index += 1) {
            if (await control.nth(index).isVisible().catch(() => false)) visible.push(control.nth(index));
          }
          if (!visible.length) await task.page.waitForTimeout(1_000);
        }
        if (!visible.length) throw new Error(`No visible "${label}" control.`);
        // Wise list items wrap the button in a label that takes the pointer;
        // a keyboard press on the focused control is the same user action.
        await visible[0].click({ timeout: 5_000 }).catch(async () => {
          await visible[0].evaluate((element) => element.click());
        });
        await task.page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
        await task.page.waitForTimeout(2_500);
      }
      if (clickLabels.length) await task.page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
      if (process.argv.includes("--fill-recipient")) {
        await fillRecipient(task.page, payee);
        console.error("Wise's Confirmation of Payee returned an exact name match; continued.");
      }
      if (process.argv.includes("--set-amount")) {
        await setRecipientAmount(task.page, authorization, payee);
        console.error(`Set the recipient amount to exactly ${authorization.currency} ${authorization.amount}; continued.`);
      }
      if (process.argv.includes("--details")) {
        await fillTransferDetails(task.page, profile);
        console.error(`Entered the reviewed recipient address and the reference "${profile.reference}".`);
      }
      if (process.argv.includes("--transfer-status")) {
        // Only rows naming this request's verified payee: this transfer's own status.
        const rows = await task.page.evaluate((name) => [...document.querySelectorAll("a, button, li, [role='button'], [role='listitem']")]
          .map((node) => node.innerText.replace(/\s+/g, " ").trim())
          .filter((text) => text.includes(name) && text.length < 160), payee.accountName);
        console.error(JSON.stringify({ payeeRows: [...new Set(rows)].slice(0, 5) }));
      }
      if (process.argv.includes("--money-lines")) {
        // This transfer's own quote lines only (never balances or history).
        const lines = (await task.page.locator("main, body").first().innerText().catch(() => ""))
          .split(/\n+/).map((line) => line.replace(/\s+/g, " ").trim())
          .filter((line) => /GBP|USD|EUR|€|£|\$|fee|rate|total|you send|gets|arrives/i.test(line) && !/balance|interest|sent ·|received ·/i.test(line))
          .map((line) => line.slice(0, 100)).slice(0, 25);
        console.error(JSON.stringify({ moneyLines: lines }));
      }
      console.log(JSON.stringify({
        requestId, status: "explored", payee: maskedPayee(payee), reference: profile.reference,
        authorized: authorization, page: await pageStructure(task.page)
      }));
      return;
    }
    const payee = await readPayee(task.page, profile, authorization);
    log(`Verified payee ${maskedPayee(payee)} from the provider's own instructions.`);
    await task.page.waitForTimeout(2_000);
    const outcome = await prepareTransfer(task.page, { requestId, task, profile, authorization, payee });
    keepOpen = ["needs-user", "uncertain"].includes(outcome.status);
    console.log(JSON.stringify(outcome));
  } finally {
    if (keepOpen) await task.leaveOpen().catch(() => {});
    else await task.close().catch(() => {});
  }
}

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  return index < 0 ? "" : process.argv[index + 1] || "";
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
