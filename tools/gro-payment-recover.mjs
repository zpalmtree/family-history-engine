#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { openSharedChromeTask, sharedChromeEndpoint } from "./shared-chrome-task.mjs";
import { deriveExternalRequest } from "./external-request-store.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const targetId = valueAfter("--target");
const endpoint = valueAfter("--endpoint") || sharedChromeEndpoint;
const affinitySlot = valueAfter("--affinity-slot") || "gro-payment-recovery";

if (!targetId || !/^gro-[a-z0-9-]+$/.test(targetId)) {
  throw new Error("usage: --target <gro-target-slug>");
}
if (endpoint !== sharedChromeEndpoint) throw new Error(`Payment recovery is restricted to ${sharedChromeEndpoint}.`);

const acquisition = JSON.parse(await fs.readFile(path.join(
  projectRoot, "evidence", "acquisition", "targets", `${targetId}.json`
), "utf8"));
const route = (acquisition.routes || []).find((candidate) => candidate.id === targetId);
if (!route?.requestId) throw new Error(`${targetId} has no canonical external request.`);
const request = JSON.parse(await fs.readFile(path.join(
  projectRoot, "evidence", "acquisition", "requests", `${route.requestId}.json`
), "utf8"));
const requestState = deriveExternalRequest(request);
const confirmation = request.guard.requiredPhrase;
if (!requestState.authorizationValid
    || !["authorized", "conflict-hold"].includes(requestState.operationalState)
    || confirmation !== `PAY ${targetId}`) {
  throw new Error(`${targetId} has no recoverable canonical payment authorization.`);
}
if (request.guard.currency !== "GBP") throw new Error(`${targetId} is not guarded in GBP.`);
const estimatedCostGbp = Number(request.guard.maxAmount);
if (!Number.isFinite(estimatedCostGbp) || estimatedCostGbp <= 0) throw new Error("Target cost guard is missing.");
const guardGbp = estimatedCostGbp + 0.5;
const paidRun = await findUnfinishedPaidRun(targetId, guardGbp);

const rl = createInterface({ input, output });
const entered = (await rl.question("Payment-recovery authorization: ")).trim();
rl.close();
if (entered !== confirmation) throw new Error("Exact recovery authorization did not match the target.");

const session = await openSharedChromeTask({
  chromium,
  endpoint,
  taskLabel: "GRO payment recovery",
  affinitySlot
});
const reopened = [];
try {
  await session.showForManualStep("the already-paid Worldpay confirmation recovery");
  let confirmationPage = null;
  const inspectedKinds = [];
  for (let attempt = 0; attempt < 5 && !confirmationPage; attempt += 1) {
    const before = new Set(session.context.pages());
    await session.page.bringToFront();
    await session.page.keyboard.press("Control+Shift+T");
    await session.page.waitForTimeout(1200);
    const added = session.context.pages().filter((page) => !before.has(page) && !page.isClosed());
    if (added.length !== 1) {
      inspectedKinds.push(added.length ? `ambiguous-${added.length}-tabs` : "no-restored-tab");
      continue;
    }
    const page = added[0];
    reopened.push(page);
    await page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(500);
    const state = await classifyRestoredPage(page);
    inspectedKinds.push(state.kind);
    if (state.kind === "worldpay-complete-payment") confirmationPage = page;
  }

  if (!confirmationPage) {
    console.log(JSON.stringify({
      targetId,
      recovered: false,
      clicked: false,
      inspectedKinds,
      note: "Chrome did not restore the already-paid Complete Payment page; no transaction action was taken."
    }, null, 2));
    process.exitCode = 2;
  } else {
    const state = await classifyRestoredPage(confirmationPage);
    if (state.hasCardFields || state.hasVisibleAmount) {
      throw new Error("Restored page looked like a new payment form; recovery click refused.");
    }
    const controls = confirmationPage.locator("button, input[type='submit'], input[type='button']");
    const matches = [];
    const count = await controls.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const control = controls.nth(index);
      if (!(await control.isVisible().catch(() => false))) continue;
      const label = [
        await control.innerText().catch(() => ""),
        await control.getAttribute("value").catch(() => ""),
        await control.getAttribute("aria-label").catch(() => "")
      ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
      if (/^complete payment$/i.test(label)) matches.push(control);
    }
    if (matches.length !== 1) throw new Error(`Expected one exact Complete Payment control; found ${matches.length}.`);

    await Promise.all([
      confirmationPage.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {}),
      matches[0].click({ timeout: 5000 })
    ]);
    await confirmationPage.waitForTimeout(2500);
    const finalText = await confirmationPage.locator("body").innerText().catch(() => "");
    const finalUrl = new URL(confirmationPage.url());
    const finished = /gro\.gov\.uk$/i.test(finalUrl.hostname)
      && /\/gro\/content\/certificates\/check_out\.asp/i.test(finalUrl.pathname)
      && /success|thank you|complete|reference|order/i.test(finalText);
    const summary = finalText.split(/\r?\n/).map((line) => line.trim()).find((line) =>
      /success|thank you|complete|reference|order number|col number|processing|despatch/i.test(line)
    ) || "";
    const result = {
      targetId,
      recovered: true,
      clicked: true,
      clickedControl: "Complete Payment",
      boundPaymentRun: path.basename(paidRun.file),
      verifiedAmountGbp: paidRun.amount,
      finalLocation: `${finalUrl.origin}${finalUrl.pathname}`,
      finished,
      summary: summary.slice(0, 240)
    };
    await fs.writeFile(path.join(path.dirname(paidRun.file), `${timestamp()}-payment-recovery.json`), `${JSON.stringify(result, null, 2)}\n`);
    console.log(JSON.stringify(result, null, 2));
  }
} finally {
  await Promise.all(reopened.map((page) => page.isClosed()
    ? null
    : page.close({ runBeforeUnload: false }).catch(() => null)));
  await session.close();
}

async function findUnfinishedPaidRun(slug, guardGbp) {
  const runsDir = path.join(projectRoot, "evidence", "gro", slug, "runs");
  const files = (await fs.readdir(runsDir)).filter((name) => /-order\.json$/.test(name)).sort().reverse();
  for (const name of files) {
    const file = path.join(runsDir, name);
    const run = JSON.parse(await fs.readFile(file, "utf8"));
    if (run.target?.slug !== slug) continue;
    const step = (run.steps || []).find((candidate) =>
      candidate.name === "manual-payment-step-finished"
      && candidate.paymentResult?.ok === true
      && candidate.paymentResult?.clicked === "Make Payment"
      && !candidate.paymentResult?.completion
    );
    const amounts = step?.paymentResult?.amounts || [];
    const amount = amounts.length ? Math.max(...amounts.map(Number)) : null;
    if (!Number.isFinite(amount) || amount > guardGbp) continue;
    return { file, amount };
  }
  throw new Error(`No unfinished, cost-guarded Make Payment run exists for ${slug}.`);
}

async function classifyRestoredPage(page) {
  const url = page.url();
  const text = await page.locator("body").innerText().catch(() => "");
  const hasCardFields = /card number|security code|expiry date/i.test(text);
  const hasVisibleAmount = /£\s*[0-9]+(?:\.[0-9]{1,2})?/i.test(text);
  if (/^https:\/\/payments\.worldpay\.com\//i.test(url)
    && /click on the ["“']?complete payment["”']? button to see reference details/i.test(text)
    && /complete payment/i.test(text)
    && !hasCardFields) {
    return { kind: "worldpay-complete-payment", hasCardFields, hasVisibleAmount };
  }
  if (/^https:\/\/payments\.worldpay\.com\//i.test(url) && hasCardFields) {
    return { kind: "worldpay-new-payment-form", hasCardFields, hasVisibleAmount };
  }
  if (/gro\.gov\.uk/i.test(url) && /my recent order details|my orders/i.test(text)) {
    return { kind: "gro-order-history", hasCardFields, hasVisibleAmount };
  }
  return { kind: /^chrome:/i.test(url) ? "chrome-internal" : "other", hasCardFields, hasVisibleAmount };
}

function valueAfter(flag) {
  const index = argv.indexOf(flag);
  return index < 0 ? "" : argv[index + 1] || "";
}

function timestamp() {
  return new Date().toISOString().replaceAll(":", "-").replace(/\.\d{3}Z$/, "Z");
}
