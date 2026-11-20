#!/usr/bin/env node

// Guarded saved-card payment (AGENTS.md, 28 Oct 2026).
//
//   npm run pay:win -- -Request <request-id> -Url <checkout-or-payment-link> [-Inspect]
//   npm run pay:win -- -Request <tna-request-id> -TnaPageCheck [-Inspect]
//   npm run pay:win -- -Request <gro-target-slug> -GroOrder [-Inspect]
//
// Pays one canonical request whose exact PAY phrase is already recorded. The
// checkout must be on the provider's allowlisted payment host and every visible
// amount in the authorized currency must be at or under what the approval has
// left. Chrome's first saved card is chosen with CDP keyboard events; no card
// value is ever read, typed, logged, or captured. Where a provider's profile
// says it charges the payment method stored on the user's own account and the
// checkout shows no card field, no card is chosen at all. The exact pay control is
// clicked only after the card shows as autofilled and the amounts are checked
// again. CVV, an ambiguous card choice, and any bank verification are the
// user's: the checkout tab is revealed and left open on that step. Every click
// is bracketed by canonical request events so an interrupted run is held for
// review and can never pay twice. --inspect reports the checkout without
// acting, which is how a new provider's real payment host is first observed.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { appendExternalRequestEvent } from "./external-request-store.mjs";
import {
  amountGuard,
  authorizedPayment,
  cardSource,
  driverAllowed,
  checkoutHostAllowed,
  merchantHostReached,
  checkoutProfileFor,
  classifyPaymentResult,
  inspectionBasis
} from "./payment-policy.mjs";
import { requireConsent } from "./consents.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function requestFilePath(requestId) {
  if (!/^[a-z0-9][a-z0-9-]{0,127}$/.test(requestId || "")) throw new Error("Pass one safe request ID.");
  return path.join(projectRoot, "evidence", "acquisition", "requests", `${requestId}.json`);
}

function readRequest(requestId) {
  return JSON.parse(fs.readFileSync(requestFilePath(requestId), "utf8"));
}

// For a provider driver that settles a result from the provider's own record.
export function recordRequestEvent(requestId, event) {
  persistEvent(requestId, event);
}

function persistEvent(requestId, event) {
  const file = requestFilePath(requestId);
  const request = readRequest(requestId);
  const updated = appendExternalRequestEvent(request, event, { expectedRevision: request.revision });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(updated, null, 2)}\n`, { flag: "wx" });
  fs.renameSync(temporary, file);
  execFileSync(process.execPath, ["tools/sync-external-request-projections.mjs"], { cwd: projectRoot, stdio: "ignore" });
}

async function checkoutText(page) {
  const parts = [];
  for (const frame of page.frames()) {
    parts.push(await frame.locator("body").innerText({ timeout: 5_000 }).catch(() => ""));
  }
  return parts.join("\n");
}

async function visibleCardNumberFields(page) {
  const fields = [];
  for (const frame of page.frames()) {
    const candidates = frame.locator([
      'input[autocomplete="cc-number"]',
      'input[name*="cardnumber" i]',
      'input[id*="cardnumber" i]',
      'input[aria-label*="card number" i]'
    ].join(", "));
    const count = await candidates.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const candidate = candidates.nth(index);
      if (await candidate.isVisible().catch(() => false)) fields.push(candidate);
    }
  }
  return fields;
}

// Worldpay also requires a billing address, which the saved card does not
// carry. Choose Chrome's saved address the same way: CDP keyboard selection
// of the first autofill suggestion, judged only by autofill state.
async function autofillBillingAddress(page, log) {
  // Chrome offers the saved address from any field of the billing block; the
  // name fields come first on Worldpay's page (TNA, 18 Nov 2026).
  const selector = [
    'input[autocomplete~="given-name"]', 'input[name*="firstname" i]', 'input[id*="firstname" i]',
    'input[autocomplete~="address-line1"]', 'input[autocomplete~="street-address"]',
    'input[name*="address1" i]', 'input[id*="address1" i]', 'input[name*="addressline1" i]',
    'input[autocomplete~="postal-code"]', 'input[name*="postcode" i]', 'input[id*="postcode" i]'
  ].join(", ");
  for (const frame of page.frames()) {
    const candidates = frame.locator(selector);
    const count = await candidates.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const field = candidates.nth(index);
      if (!(await field.isVisible().catch(() => false))) continue;
      if (await field.evaluate((element) => element.matches(":-webkit-autofill")).catch(() => false)) return true;
      await field.click({ timeout: 5_000 });
      await page.waitForTimeout(500);
      await page.keyboard.press("ArrowDown");
      await page.waitForTimeout(1_200);
      await page.keyboard.press("Enter");
      await page.waitForTimeout(1_500);
      const filled = await field.evaluate((element) => element.matches(":-webkit-autofill")).catch(() => false);
      log(filled ? "Chrome's saved billing address was applied." : "No saved billing address was applied.");
      return filled;
    }
  }
  return false;
}

// Which payment inputs still block the pay control, named only by their
// semantic attributes and judged only by CSS validity and autofill state.
// No field value is ever read.
async function incompletePaymentFields(page) {
  const fields = [];
  for (const frame of page.frames()) {
    fields.push(...await frame.evaluate(() => [...document.querySelectorAll("input:not([type=hidden]), select")]
      .filter((element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      })
      .filter((element) => element.matches(":invalid") || (element.required && !element.matches(":-webkit-autofill")))
      .map((element) => element.getAttribute("autocomplete") || element.name || element.id || element.type)
      .slice(0, 10)).catch(() => []));
  }
  return fields;
}

async function visibleControlLabels(page) {
  const labels = [];
  for (const frame of page.frames()) {
    labels.push(...await frame.evaluate(() => [...document.querySelectorAll("button, input[type='submit'], input[type='button'], a[role='button']")]
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== "hidden";
      })
      .map((element) => (element.innerText || element.value || element.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .map((label) => label.slice(0, 60))).catch(() => []));
  }
  return [...new Set(labels)].slice(0, 20);
}

async function exactPayControl(page, label) {
  for (const frame of page.frames()) {
    const controls = frame.locator("button, input[type='submit'], input[type='button']");
    const count = await controls.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const control = controls.nth(index);
      if (!(await control.isVisible().catch(() => false))) continue;
      const text = [
        await control.innerText().catch(() => ""),
        await control.getAttribute("value").catch(() => ""),
        await control.getAttribute("aria-label").catch(() => "")
      ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
      if (!label.test(text)) continue;
      const disabled = await control.evaluate((element) =>
        element.matches(":disabled") || element.getAttribute("aria-disabled") === "true").catch(() => true);
      return { control, enabled: !disabled };
    }
  }
  return null;
}

// Reports a checkout without acting on it: where it is, which hosts its frames
// come from, the labels of its controls and the amounts it shows. This is how a
// provider's checkout is observed before it has a reviewed profile, so it runs
// with no profile and for a request the user has not yet decided to pay.
export async function inspectCheckout(page, request) {
  const { profile, authorized, expected } = inspectionBasis(request);
  const hostAllowed = Boolean(profile) && checkoutHostAllowed(profile, page.url());
  // A reviewed checkout that asks for a payment method first is taken to its
  // card form, as a payment would be; an unreviewed page is left as it is.
  if (hostAllowed && profile.cardMethod && !(await visibleCardNumberFields(page)).length) {
    let method = page.getByRole("link", { name: profile.cardMethod }).first();
    if (!await method.isVisible().catch(() => false)) method = page.getByRole("button", { name: profile.cardMethod }).first();
    if (await method.isVisible().catch(() => false)) {
      await method.click();
      await page.waitForLoadState("domcontentloaded").catch(() => {});
      await page.waitForTimeout(2_500);
    }
  }
  const url = new URL(page.url());
  const text = await checkoutText(page);
  const guard = expected ? amountGuard(text, expected, profile?.buffer || 0) : { ok: false, amounts: [], reason: "the request has no amount to compare" };
  const payControl = profile?.payControl ? await exactPayControl(page, profile.payControl) : null;
  return {
    requestId: request.id, status: "inspected", checkout: `${url.origin}${url.pathname}`,
    profile: profile?.id || null, hostAllowed, authorized,
    ...(authorized ? { authorizedRemaining: expected.amount } : { expectedAmount: expected?.amount ?? null }),
    currency: expected?.currency || null,
    visibleAmounts: guard.amounts, amountGuardOk: guard.ok,
    cardNumberFields: (await visibleCardNumberFields(page)).length,
    payControlFound: Boolean(payControl), payControlEnabled: Boolean(payControl?.enabled),
    // Labels and hosts only, for observing a new provider's checkout steps.
    controls: await visibleControlLabels(page),
    frameHosts: [...new Set(page.frames().map((frame) => {
      try { return new URL(frame.url()).hostname; } catch { return ""; }
    }).filter(Boolean))]
  };
}

// Drives one checkout page the caller has already reached. `task` is the
// bridge task that owns the page (for revealing it on a human step).
export async function payOnCheckout(page, { requestId, task, inspect = false, fromDriver = "", resultTimeoutMs = 600_000, manualStepTimeoutMs = 600_000, log = console.error }) {
  // The tree's owner must have switched card payment on (consents.json);
  // inspection only reads the page.
  if (!inspect) requireConsent("card-payment");
  const request = readRequest(requestId);
  if (inspect) return inspectCheckout(page, request);
  const authorization = authorizedPayment(request);
  const profile = checkoutProfileFor(request);
  if (!inspect && !driverAllowed(profile, fromDriver)) {
    throw new Error(`${profile.provider} is paid only through its order driver (npm run pay:win -- -Request ${requestId} ${profile.driverOnly}); nothing was paid.`);
  }
  const hostAllowed = checkoutHostAllowed(profile, page.url());
  // Worldpay's hosted page asks for a payment method before showing card fields.
  if (hostAllowed && profile.cardMethod && !(await visibleCardNumberFields(page)).length) {
    // Worldpay offers the method as a link; Zettle's invoice page as a button.
    let method = page.getByRole("link", { name: profile.cardMethod }).first();
    if (!await method.isVisible().catch(() => false)) method = page.getByRole("button", { name: profile.cardMethod }).first();
    if (await method.isVisible().catch(() => false)) {
      await method.click();
      await page.waitForLoadState("domcontentloaded").catch(() => {});
      await page.waitForTimeout(2_500);
    }
  }
  const url = new URL(page.url());
  const where = `${url.origin}${url.pathname}`;
  let text = await checkoutText(page);
  let guard = amountGuard(text, authorization, profile.buffer || 0);
  if (!hostAllowed) throw new Error(`${where} is not an allowlisted ${profile.provider} payment host; nothing was paid.`);
  if (!guard.ok) throw new Error(`Payment refused: ${guard.reason}; nothing was paid.`);

  const fields = await visibleCardNumberFields(page);
  if (cardSource(profile, fields.length) === "provider-stored-method") {
    // The provider charges the payment method already stored on the user's
    // own account: no card is chosen and nothing is typed. Only the exact pay
    // control is clicked, after the amounts are checked once more.
    const stored = await exactPayControl(page, profile.payControl);
    // Not ready (for example the stored card needs replacing): nothing is
    // revealed for the user to click unrecorded; the run stops and reports.
    if (!stored?.enabled) {
      return { requestId, status: "needs-user", reason: "pay-control-not-enabled", incompleteFields: await incompletePaymentFields(page), checkout: where, tabClosed: true };
    }
    text = await checkoutText(page);
    guard = amountGuard(text, authorization, profile.buffer || 0);
    if (!guard.ok) throw new Error(`Payment refused: ${guard.reason}; nothing was paid.`);
    persistEvent(requestId, startedEvent(authorization, guard, `${where} (payment method stored with the provider)`));
    log(`Paying ${authorization.currency} ${guard.highest.toFixed(2)} for ${requestId} at ${where} with the payment method stored on the account.`);
    await stored.control.click({ timeout: 10_000 });
    return awaitPaymentResult(page, { requestId, task, authorization, profile, guard, where, resultTimeoutMs, log });
  }
  await page.bringToFront();
  // Chrome offers saved cards and addresses only in a focused window, and
  // Windows will not let a background process take focus. Reveal the tab and
  // wait for the user to click into Chrome before choosing the saved details.
  const focused = () => page.evaluate(() => document.hasFocus()).catch(() => false);
  if (!(await focused())) {
    await task?.showForManualStep?.("saved-card autofill");
    log("Click into the shared Chrome window; the saved card and address are chosen once it has focus.");
    const focusDeadline = Date.now() + manualStepTimeoutMs;
    while (Date.now() < focusDeadline && !(await focused())) {
      if (page.isClosed()) return { requestId, status: "needs-user", reason: "checkout-tab-closed", checkout: where };
      await page.waitForTimeout(1_000);
    }
  }
  await fields[0].click({ timeout: 5_000 });
  await page.waitForTimeout(500);
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(1_200);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1_500);
  const autofilled = await fields[0].evaluate((element) => element.matches(":-webkit-autofill")).catch(() => false);
  // Worldpay can re-render the card field so it no longer reports autofill
  // even when Chrome filled it (TNA, 18 Nov 2026): always offer the saved
  // billing address; an already-filled block is left alone.
  await autofillBillingAddress(page, log);
  if (profile.userSubmits) {
    // The pay control cannot show readiness here, so never click it: wait for
    // the user's own submit, then record it and follow the result.
    await task?.showForManualStep?.("the card security code and the final submit");
    log("Enter the card's security code, then click the checkout's own submit button; the helper records the result.");
    const deadline = Date.now() + manualStepTimeoutMs;
    while (Date.now() < deadline) {
      await page.waitForTimeout(1_500);
      if (page.isClosed()) return { requestId, status: "needs-user", reason: "checkout-tab-closed", checkout: where };
      const moved = !checkoutHostAllowed(profile, page.url()) || new URL(page.url()).pathname !== url.pathname;
      if (moved || classifyPaymentResult(await checkoutText(page)) !== "pending") {
        persistEvent(requestId, startedEvent(authorization, guard, `${where} (user submitted)`));
        return awaitPaymentResult(page, { requestId, task, authorization, profile, guard, where, resultTimeoutMs, log });
      }
    }
    return { requestId, status: "needs-user", reason: "user-did-not-submit", checkout: where };
  }
  let pay = await exactPayControl(page, profile.payControl);
  if (!pay?.enabled) {
    // Usually the security code, a billing address Chrome has not saved, or a
    // saved card Chrome did not apply: all the user's to complete. Wait for it
    // in the revealed tab; the amounts are rechecked before the click.
    await task?.showForManualStep?.(autofilled ? "the card security code" : "the card details");
    log(`Still incomplete: ${(await incompletePaymentFields(page)).join(", ") || "(none reported)"}.`);
    log("Enter the card's security code in the revealed checkout tab; the payment continues once Make Payment is enabled.");
    const deadline = Date.now() + manualStepTimeoutMs;
    let userClicked = false;
    while (Date.now() < deadline && !pay?.enabled) {
      await page.waitForTimeout(1_500);
      if (page.isClosed()) return { requestId, status: "needs-user", reason: "checkout-tab-closed", checkout: where };
      pay = await exactPayControl(page, profile.payControl);
      // If the user pressed Make Payment themselves, record and follow it.
      if (!pay && classifyPaymentResult(await checkoutText(page)) !== "pending") { userClicked = true; break; }
    }
    if (userClicked) {
      persistEvent(requestId, startedEvent(authorization, guard, `${where} (user clicked)`));
      return awaitPaymentResult(page, { requestId, task, authorization, profile, guard, where, resultTimeoutMs, log });
    }
    if (!pay?.enabled) {
      return { requestId, status: "needs-user", reason: "pay-control-not-enabled", incompleteFields: await incompletePaymentFields(page), checkout: where };
    }
  }

  text = await checkoutText(page);
  guard = amountGuard(text, authorization, profile.buffer || 0);
  if (!guard.ok) throw new Error(`Payment refused after card selection: ${guard.reason}; nothing was paid.`);

  persistEvent(requestId, startedEvent(authorization, guard, where));
  log(`Paying ${authorization.currency} ${guard.highest.toFixed(2)} for ${requestId} at ${where}.`);
  await pay.control.click({ timeout: 10_000 });
  return awaitPaymentResult(page, { requestId, task, authorization, profile, guard, where, resultTimeoutMs, log });
}

function startedEvent(authorization, guard, where) {
  return authorization.mode === "quote"
    ? { type: "payment-started", amount: guard.highest, currency: authorization.currency, basis: `guarded-card-payment ${where}` }
    : { type: "submission-started", basis: `guarded-card-payment ${where}` };
}

const merchantPageGraceMs = 60_000;

// Host and path only: never a query string, which can carry tokens.
function safeLocation(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname}`;
  } catch {
    return "(unparseable URL)";
  }
}

async function awaitPaymentResult(page, { requestId, task, authorization, profile, guard, where, resultTimeoutMs, log }) {
  let revealed = false;
  let confirmed = false;
  let leftCheckoutAt = 0;
  const deadline = Date.now() + resultTimeoutMs;
  while (Date.now() < deadline) {
    await page.waitForTimeout(2_000);
    if (page.isClosed()) break;
    // Once the provider has taken the browser back to its own site and that
    // page stays unrecognized for a minute, stop waiting: the dispatcher then
    // settles the result from the provider's own order record instead.
    // A bank's verification page is neither host, so it is always waited for.
    if (!merchantHostReached(profile, page.url())) leftCheckoutAt = 0;
    else if (!leftCheckoutAt) leftCheckoutAt = Date.now();
    else if (Date.now() - leftCheckoutAt > merchantPageGraceMs) {
      log(`Back on the provider's site (${safeLocation(page.url())}) with no recognized result.`);
      break;
    }
    const text = await checkoutText(page);
    // GRO's Worldpay integration asks once more ("Complete Payment") after the
    // card step. Click that exact control once, on the allowlisted host, after
    // the amounts pass the same guard.
    if (!confirmed && profile.confirmControl && checkoutHostAllowed(profile, page.url())) {
      const confirm = await exactPayControl(page, profile.confirmControl);
      if (confirm?.enabled && amountGuard(text, authorization, profile.buffer || 0).ok) {
        confirmed = true;
        log("Confirming the payment on the provider's exact Complete Payment step.");
        await confirm.control.click({ timeout: 10_000 });
        continue;
      }
    }
    const result = classifyPaymentResult(text);
    // A provider whose driver settles from its own order record: the page's
    // wording is reported, never recorded, so a misread page can neither
    // confirm an order that was not placed nor reopen one that was.
    if (profile.settlesFromOrderRecord && ["succeeded", "declined"].includes(result)) {
      return { requestId, status: "uncertain", pageResult: result, amount: guard.highest, currency: authorization.currency, checkout: where };
    }
    if (result === "needs-bank-verification" && !revealed) {
      revealed = true;
      await task?.showForManualStep?.("bank verification for an authorized payment");
      log("Waiting for the bank verification to be approved in the revealed tab.");
    }
    if (result === "succeeded") {
      persistEvent(requestId, authorization.mode === "quote"
        ? { type: "payment-submitted", amount: guard.highest, currency: authorization.currency, basis: `guarded-card-payment ${where}` }
        : { type: "submission-confirmed", basis: `guarded-card-payment provider confirmation ${where}` });
      return { requestId, status: "paid", amount: guard.highest, currency: authorization.currency, checkout: where };
    }
    if (result === "declined") {
      persistEvent(requestId, authorization.mode === "quote"
        ? { type: "payment-retryable", basis: `provider declined at ${where}` }
        : { type: "submission-retryable", basis: `provider declined at ${where}` });
      return { requestId, status: "declined", checkout: where };
    }
  }
  // The started event stays unmatched, which holds the request for review.
  if (profile.settlesFromOrderRecord) return { requestId, status: "uncertain", pageResult: revealed ? "needs-bank-verification" : "pending", amount: guard.highest, currency: authorization.currency, checkout: where };
  if (!page.isClosed()) await task?.showForManualStep?.("an unconfirmed payment result");
  return { requestId, status: "uncertain", checkout: where };
}

async function main() {
  const { chromium } = await import("playwright-core");
  const { openSharedChromeTask, sharedChromeEndpoint } = await import("./shared-chrome-task.mjs");
  const requestId = valueAfter("--request");
  const startUrl = valueAfter("--url");
  const gmailQuery = valueAfter("--gmail-query");
  const linkText = valueAfter("--link-text");
  const listLinks = process.argv.includes("--list-links");
  const saveAttachment = valueAfter("--save-attachment");
  const inspect = process.argv.includes("--inspect") || listLinks || Boolean(saveAttachment);
  if (!process.argv.includes("--shared-window")) throw new Error("Run through the Windows wrapper: npm run pay:win.");
  if (Boolean(startUrl) === Boolean(gmailQuery)) throw new Error("Pass exactly one of --url or --gmail-query.");
  if (gmailQuery && !listLinks && !saveAttachment && !linkText) throw new Error("--gmail-query needs --link-text (or --list-links to observe).");
  const request = readRequest(requestId);
  // Listing a message's link hosts is read-only and is how a new provider's
  // invoice host is first observed, so it needs no checkout profile yet.
  // Inspecting a checkout is read-only too and must work before the provider
  // has a profile: that is how its real payment host is first observed.
  const profile = inspect ? inspectionBasis(request).profile : checkoutProfileFor(request);
  if (profile?.driverOnly && !inspect) throw new Error(`${profile.provider} is paid only through its order driver: npm run pay:win -- -Request ${requestId} ${profile.driverOnly}`);
  if (!inspect) authorizedPayment(request);
  if (startUrl) {
    const start = new URL(startUrl);
    if (start.protocol !== "https:" || start.username || start.password) throw new Error("The payment link must be a plain HTTPS URL.");
  }

  const task = await openSharedChromeTask({
    chromium,
    endpoint: sharedChromeEndpoint,
    taskLabel: `payment-${requestId}`,
    affinitySlot: `payment-${requestId}`.slice(0, 32).replace(/-$/, ""),
    timeoutMs: 20_000
  });
  let keepOpen = false;
  try {
    if (gmailQuery) {
      const { readGmailConversation, summarizeConversation, choosePaymentLink } = await import("./gmail-payment-link.mjs");
      const messages = await readGmailConversation(task.page, gmailQuery);
      if (saveAttachment) {
        const { saveConversationAttachment } = await import("./gmail-payment-link.mjs");
        const { default: os } = await import("node:os");
        const file = await saveConversationAttachment(task.page, saveAttachment, path.join(os.tmpdir(), "family-history-payment"));
        console.log(JSON.stringify({ requestId, status: "attachment-saved-temporarily", file }));
        return;
      }
      if (listLinks) {
        console.log(JSON.stringify({ requestId, status: "links-listed", messages: summarizeConversation(messages) }));
        return;
      }
      // Only the newest message that carries a matching link is used.
      let link = null;
      let lastError = null;
      for (const message of [...messages].reverse()) {
        try {
          link = choosePaymentLink(message.anchors, { labelPattern: new RegExp(linkText, "i"), linkHosts: profile.linkHosts || [] });
          break;
        } catch (error) { lastError = error; }
      }
      if (!link) throw lastError || new Error("No payment link was found; nothing was opened.");
      console.error(`Following the ${link.host} payment link labelled "${link.label}".`);
      await task.page.goto(link.href, { waitUntil: "domcontentloaded", timeout: 45_000 });
    } else {
      await task.page.goto(new URL(startUrl).href, { waitUntil: "domcontentloaded", timeout: 45_000 });
    }
    const deadline = Date.now() + 60_000;
    while (!inspect && !checkoutHostAllowed(profile, task.page.url()) && Date.now() < deadline) {
      await task.page.waitForTimeout(1_000);
    }
    await task.page.waitForTimeout(2_000);
    const outcome = await payOnCheckout(task.page, { requestId, task, inspect });
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
