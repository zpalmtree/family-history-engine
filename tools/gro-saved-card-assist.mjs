#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { sharedChromeEndpoint } from "./shared-chrome-task.mjs";
import { connectSharedBrowser } from "./shared-browser-bridge-client.mjs";
import { deriveExternalRequest } from "./external-request-store.mjs";
import { requireConsent } from "./consents.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const targetId = valueAfter("--target");
const endpoint = valueAfter("--endpoint") || sharedChromeEndpoint;
const inspectOnly = process.argv.includes("--inspect");

if (!targetId || !/^gro-[a-z0-9-]+$/.test(targetId)) {
  throw new Error("usage: --target <gro-target-slug> [--endpoint http://127.0.0.1:9226]");
}
if (endpoint !== sharedChromeEndpoint) {
  throw new Error(`Saved-card assist is restricted to ${sharedChromeEndpoint}.`);
}
if (!inspectOnly) requireConsent("card-payment");

const targetFile = path.join(projectRoot, "evidence", "acquisition", "targets", `${targetId}.json`);
const target = JSON.parse(await fs.readFile(targetFile, "utf8"));
const route = (target.routes || []).find((candidate) => candidate.id === targetId);
if (!route || route.provider !== "General Register Office") {
  throw new Error(`${targetId} is not a canonical GRO acquisition route.`);
}
const request = JSON.parse(await fs.readFile(path.join(
  projectRoot, "evidence", "acquisition", "requests", `${route.requestId}.json`
), "utf8"));
const requestState = deriveExternalRequest(request);
const confirmation = request.guard.requiredPhrase;
if (!requestState.authorizationValid || requestState.operationalState !== "authorized" || confirmation !== `PAY ${targetId}`) {
  throw new Error(`${targetId} has no active canonical payment authorization.`);
}
if (request.guard.currency !== "GBP") throw new Error(`${targetId} is not guarded in GBP.`);
const estimatedCostGbp = Number(request.guard.maxAmount);
if (!Number.isFinite(estimatedCostGbp) || estimatedCostGbp <= 0) {
  throw new Error(`${targetId} has no usable estimated cost guard.`);
}
const costGuardGbp = estimatedCostGbp + 0.5;

if (!inspectOnly) {
  const rl = createInterface({ input, output });
  const entered = (await rl.question("Saved-card authorization: ")).trim();
  rl.close();
  if (entered !== confirmation) throw new Error("Exact saved-card authorization did not match the active target.");
}

const sharedConnection = await connectSharedBrowser({
  chromium,
  endpoint,
  taskLabel: `GRO-saved-card-${targetId}`,
  namespace: "family-history",
  lifetime: "manual",
  affinitySlot: "gro-orders",
  provider: "GRO"
});
const { browser } = sharedConnection;
try {
  const contexts = browser.contexts();
  if (contexts.length !== 1) throw new Error(`Expected one shared Chrome context; found ${contexts.length}.`);
  const worldpayPages = contexts[0].pages().filter((page) =>
    !page.isClosed() && /^https:\/\/(?:payments|hpp)\.worldpay\.com\//i.test(page.url())
  );
  if (worldpayPages.length !== 1) {
    throw new Error(`Expected exactly one Worldpay checkout page; found ${worldpayPages.length}.`);
  }

  const page = worldpayPages[0];
  await sharedConnection.adoptPage(page, { root: true });
  const bodyText = await page.locator("body").innerText().catch(() => "");
  const amounts = extractPoundAmounts(bodyText);
  const maxAmount = amounts.length ? Math.max(...amounts) : null;
  if (maxAmount == null) throw new Error("No visible GBP amount was found; saved-card selection refused.");
  if (maxAmount > costGuardGbp) {
    throw new Error(`Visible GBP ${maxAmount.toFixed(2)} exceeds the target guard GBP ${costGuardGbp.toFixed(2)}.`);
  }
  if (!/card number|payment details|make payment|worldpay/i.test(bodyText)) {
    if (!inspectOnly) throw new Error("The exact Worldpay page does not expose the expected payment form labels.");
  }

  const initialPaymentState = await visiblePaymentButtonState(page);
  if (inspectOnly) {
    const current = new URL(page.url());
    console.log(JSON.stringify({
      targetId,
      page: `${current.origin}${current.pathname}`,
      visibleAmountGbp: maxAmount,
      paymentButtonFound: initialPaymentState.found,
      paymentButtonEnabled: initialPaymentState.enabled,
      paymentFormVisible: /card number|payment details|security code|make payment/i.test(bodyText),
      processingOrVerificationVisible: /processing|verification|authentication|authoris/i.test(bodyText),
      finalResultVisible: /success|successful|thank you|complete|receipt|declined|failed|failure|cancelled|canceled|expired/i.test(bodyText)
    }, null, 2));
  } else {

    const cardFields = [];
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
        if (await candidate.isVisible().catch(() => false)) cardFields.push(candidate);
      }
    }
    if (cardFields.length !== 1) {
      throw new Error(`Expected one visible semantic card-number field; found ${cardFields.length}.`);
    }

    await page.bringToFront();
    await cardFields[0].click({ timeout: 5000 });
    await page.waitForTimeout(500);
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(1500);
    const previewState = await visiblePaymentButtonState(page);
    let committedSelection = false;
    if (!previewState.enabled) {
      await page.keyboard.press("Enter");
      committedSelection = true;
      await page.waitForTimeout(1500);
    }

    const cardAutofilled = await cardFields[0].evaluate((element) =>
      element.matches(":-webkit-autofill")
    ).catch(() => false);
    const paymentState = committedSelection ? await visiblePaymentButtonState(page) : previewState;
    console.log(JSON.stringify({
      targetId,
      visibleAmountGbp: maxAmount,
      savedCardSelectionRequested: true,
      previewEnabledPayment: previewState.enabled,
      committedSelection,
      cardAutofilled,
      paymentButtonFound: paymentState.found,
      paymentButtonEnabled: paymentState.enabled,
      needsManualSecurityStep: !paymentState.enabled
    }, null, 2));
  }
} finally {
  await sharedConnection.closeClient({ leaseAction: "park" }).catch(() => {});
}

async function visiblePaymentButtonState(page) {
  const controls = page.locator("button, input[type='submit'], input[type='button']");
  const count = await controls.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const control = controls.nth(index);
    if (!(await control.isVisible().catch(() => false))) continue;
    const label = [
      await control.innerText().catch(() => ""),
      await control.getAttribute("value").catch(() => ""),
      await control.getAttribute("aria-label").catch(() => ""),
      await control.getAttribute("title").catch(() => "")
    ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
    if (!/^make payment$/i.test(label)) continue;
    const disabled = await control.evaluate((element) =>
      element.matches(":disabled") || element.getAttribute("aria-disabled") === "true" || Boolean(element.disabled)
    );
    return { found: true, enabled: !disabled };
  }
  return { found: false, enabled: false };
}

function extractPoundAmounts(text) {
  const amounts = [];
  for (const match of String(text).matchAll(/£\s*([0-9]+(?:\.[0-9]{1,2})?)/g)) {
    const amount = Number(match[1]);
    if (Number.isFinite(amount)) amounts.push(amount);
  }
  return [...new Set(amounts)];
}

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  return index < 0 ? "" : process.argv[index + 1] || "";
}
