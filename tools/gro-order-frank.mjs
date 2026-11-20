#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { openSharedChromeTask, sharedChromeEndpoint } from "./shared-chrome-task.mjs";
import { payOnCheckout } from "./guarded-card-payment.mjs";
import { amountGuard, authorizedPayment, checkoutHostAllowed, checkoutProfileFor } from "./payment-policy.mjs";
import { groIndexCoverage, groIndexRowText, hasGroIndexHeaders, parseGroIndexPairs } from "./gro-index-results.mjs";
import { groIndexSearchBounds, parseGroIndexSearchPairs, unparsedGroIndexPairs, verifyGroIndexSearchFields } from "./gro-index-search.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

await loadDotEnv(path.join(projectRoot, ".env"));
rejectRawPaymentEnv();

// Every order names its acquisition target with --target (or comes from
// --queue); there is no built-in default.
const defaultTarget = null;

const officialStartUrl = "https://www.gov.uk/order-copy-birth-death-marriage-certificate";
const groFallbackUrl = "https://www.gro.gov.uk/gro/content/certificates/default.asp";
const maxOrderCostGbp = Number(process.env.MAX_ORDER_COST_GBP || "8");

const argv = process.argv.slice(2);
const args = new Set(argv);
const mode = args.has("--auto-pay")
  ? "auto-pay"
  : args.has("--dry-run")
  ? "dry-run"
  : args.has("--order")
    ? "order"
  : args.has("--queue")
      ? "queue"
      : args.has("--index")
        ? "index"
      : args.has("--resume")
        ? "resume"
        : args.has("--profile")
          ? "profile"
          : args.has("--help") || args.has("-h")
            ? "help"
            : null;

const headless = args.has("--headless");
const sharedWindow = args.has("--shared-window");
const endpoint = getArgValue("--endpoint") || sharedChromeEndpoint;
const affinitySlot = getArgValue("--affinity-slot") || "gro-orders";
let activeTarget = defaultTarget;
let activePaths = pathsForTarget(activeTarget);
let runId = newRunId();
let activeSharedSession = null;
const rl = createInterface({ input, output });

if (!mode || mode === "help") {
  printHelp();
  process.exit(mode === "help" ? 0 : 1);
}

try {
  if (mode === "dry-run") {
    await setActiveTarget(await loadSingleTarget());
    await runDryRun();
  } else if (mode === "index") {
    await setActiveTarget(await loadSingleTarget());
    await runIndexSearch();
  } else if (mode === "order") {
    await setActiveTarget(await loadSingleTarget());
    await runOrder();
  } else if (mode === "auto-pay") {
    await runAutoPay();
  } else if (mode === "queue") {
    await runQueue();
  } else if (mode === "resume") {
    await setActiveTarget(await loadSingleTarget());
    await runResume();
  } else if (mode === "profile") {
    await runProfileSetup();
  }
} finally {
  rl.close();
}

async function runDryRun() {
  const session = await launchContext();
  const page = await getPage(session);
  const run = createRunMeta("dry-run");

  try {
    await gotoOfficialStart(page);
    await safeScreenshot(page, "dry-run-01-gov-start");
    const reachedGro = await clickStartNow(page);
    await injectPanel(page, "Dry run: official route reached. No login or payment actions will be performed.");
    await safeScreenshot(page, "dry-run-02-after-start");

    run.steps.push({ name: "official-start-route", ok: reachedGro, url: page.url() });

    if (!/gro\.gov\.uk/i.test(page.url())) {
      throw new Error(`Start flow did not reach gro.gov.uk. Current URL: ${sanitizeUrl(page.url())}`);
    }

    console.log(`Dry run OK for ${activeTarget.person}. Reached GRO without submitting anything.`);
    await writeRun(run);
  } finally {
    await session.close();
  }
}

async function runIndexSearch() {
  const session = await launchContext();
  const page = await getPage(session);
  const run = createRunMeta("index-search");

  try {
    const indexUrl = "https://www.gro.gov.uk/gro/content/certificates/indexes_search.asp";
    await page.goto(indexUrl, { waitUntil: "domcontentloaded" });
    await acceptCookieBanners(page);

    if (await isGroLoginPage(page)) {
      const login = await tryLoginPage(page);
      run.steps.push({ name: "saved-autofill-login", ...login, url: page.url() });
      if (!login.ok) {
        run.steps.push({ name: "index-search", ok: false, note: "GRO login required before index search." });
        await writeRun(run);
        console.log(JSON.stringify(sanitizeLogValue({
          target: activeTarget.slug,
          login,
          result: "login-required-no-credentials-read"
        }), null, 2));
        return;
      }
      await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => {});
      await page.waitForTimeout(1_000);
      await page.goto(indexUrl, { waitUntil: "domcontentloaded" });
      await acceptCookieBanners(page);
    }

    if (!/indexes_search\.asp/i.test(page.url())) {
      run.steps.push({ name: "open-index", ok: false, url: page.url(), note: "GRO did not expose the historical-index page." });
      await writeRun(run);
      console.log(JSON.stringify(sanitizeLogValue({ target: activeTarget.slug, result: "index-unavailable", url: page.url() }), null, 2));
      return;
    }

    const fill = { target: activeTarget.slug, filled: [], selected: [], skipped: [], warnings: [] };
    await fillGroIndexSearchPage(page, fill);
    let queryVerification = null;
    if (activeTarget.groIndexSearch) {
      const readback = await readGroIndexSearchFields(page, fill);
      queryVerification = { ...verifyGroIndexSearchFields(readback.fields, activeTarget, readback.birthSelected), readback };
      if (!queryVerification.ok) {
        run.steps.push({ name: "verify-index-query", ok: false, queryVerification });
        await writeRun(run);
        console.log(JSON.stringify({ target: activeTarget.slug, result: "query-verification-failed", queryVerification }, null, 2));
        return;
      }
    }
    const search = await submitGroIndexSearch(page);
    const text = await page.locator("body").innerText().catch(() => "");
    const result = summarizeGroIndexResult(text);
    const extracted = await extractGroIndexRows(page, activeTarget);
    result.queryVerification = queryVerification;
    result.entries = extracted.entries;
    result.unparsedEntries = unparsedGroIndexPairs(extracted.pairs, extracted.entries);
    result.rows = extracted.entries.map(groIndexRowText);
    result.rowCoverage = groIndexCoverage({ ...result, ...extracted, text, event: activeTarget.event });
    if (queryVerification) result.rowCoverage.complete = result.rowCoverage.complete && queryVerification.ok && extracted.candidateCount === result.count;
    run.steps.push({ name: "fill-index-fields", ok: true, fill, url: page.url() });
    run.steps.push({ name: "submit-index-search", ...search, url: page.url(), result });
    await writeRun(run);
    console.log(JSON.stringify(sanitizeLogValue({ target: activeTarget.slug, fill, search, result, url: page.url() }), null, 2));
  } finally {
    await session.close();
  }
}

async function runOrder() {
  const session = await launchContext();
  const page = await getPage(session);
  const run = createRunMeta("order");

  try {
    await startOrderPage(page, run, "Order mode: use a to auto-drive safe steps, or f/n manually. Login/payment still require the guarded checkpoints.");
    await printCommandHelp("order");
    await commandLoop(page, run, "order");
  } finally {
    await session.close();
  }
}

async function runQueue() {
  const queuePath = getArgValue("--queue") || path.join(projectRoot, "evidence", "gro", "order-queue.json");
  const loadedTargets = await loadTargetsFromFile(queuePath);
  if (!loadedTargets.length) throw new Error(`No targets found in ${queuePath}`);

  const pausedTargets = loadedTargets.filter(isPaidTargetPaused);
  const targets = loadedTargets.filter((target) => !isPaidTargetPaused(target));
  if (pausedTargets.length) {
    console.log(`Skipped ${pausedTargets.length} paused/free-first target(s):`);
    for (const target of pausedTargets) {
      console.log(`  - ${target.slug}: ${paidTargetPauseReason(target)}`);
    }
  }
  if (!targets.length) {
    console.log(
      `No runnable targets found in ${queuePath}. ` +
      "Paused targets must be researched further and explicitly marked readyForPaidOrder: true before queue automation runs."
    );
    return;
  }

  const session = await launchContext();
  const page = await getPage(session);

  try {
    console.log(`Loaded ${targets.length} runnable GRO target(s) from ${queuePath}`);
    console.log("The one shared Chrome profile and exact background task tab are reused across the queue, so GRO login/payment autofill can persist.");

    for (let index = 0; index < targets.length; index += 1) {
      await setActiveTarget(targets[index]);
      runId = newRunId();
      const run = createRunMeta("queue-order");
      run.queue = { path: queuePath, index: index + 1, total: targets.length };

      console.log("");
      console.log(`Queue item ${index + 1}/${targets.length}: ${describeTarget(activeTarget)}`);
      await startOrderPage(page, run, `Queue item ${index + 1}/${targets.length}. Use a to auto-drive safe steps. Payment remains checkpointed.`);
      await printCommandHelp("queue");
      const outcome = await commandLoop(page, run, "queue");

      if (outcome === "quit") break;
      if (index < targets.length - 1) {
        const answer = (await askQuestion("Continue to next queued target? [Y/n] ", "y")).trim().toLowerCase();
        if (answer === "n" || answer === "no") break;
      }
    }
  } finally {
    await session.close();
  }
}

// Non-interactive order for one authorized queue target (AGENTS.md, 28 Oct
// 2026): auto-drive to checkout, then hand the Worldpay page to the guarded
// saved-card helper. A GRO-hosted checkout step is crossed only after its
// total passes the same guard. --explore stops before any card page.
async function runAutoPay() {
  const slug = getArgValue("--target");
  const explore = args.has("--explore");
  const queuePath = path.join(projectRoot, "evidence", "gro", "order-queue.json");
  const target = (await loadTargetsFromFile(queuePath)).find((candidate) => candidate.slug === slug);
  if (!target) throw new Error(`${slug} is not in the GRO order queue.`);
  if (isPaidTargetPaused(target)) throw new Error(`${slug} is paused: ${paidTargetPauseReason(target)}`);
  const request = JSON.parse(await fs.readFile(path.join(projectRoot, "evidence", "acquisition", "requests", `${slug}.json`), "utf8"));
  const authorization = authorizedPayment(request);
  const profile = checkoutProfileFor(request);
  await setActiveTarget(target);

  const session = await launchContext();
  const page = await getPage(session);
  const run = createRunMeta("auto-pay");
  let keepOpen = false;
  try {
    await startOrderPage(page, run, `Auto-pay for ${slug}. Payment stays guarded.`);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      let auto = await runAutodrive(page, run, "auto-pay");
      // After login GRO lands on its account menu, which auto-drive does not
      // leave; its "Order a Certificate or PDF" entry is app_select.asp.
      if (/\/certificates\/menu\.asp$/i.test(new URL(page.url()).pathname)) {
        // A target already in the basket (from an earlier stopped run) is not
        // added again; otherwise start a new application.
        await page.goto("https://www.gro.gov.uk/gro/content/certificates/order_summary.asp", { waitUntil: "domcontentloaded" });
        const existing = await groBasketState(page, target);
        if (!existing.ours) {
          if (existing.items) throw new Error("The GRO basket holds other applications; only this authorized certificate may be paid. Nothing was paid.");
          await page.goto("https://www.gro.gov.uk/gro/content/certificates/app_select.asp", { waitUntil: "domcontentloaded" });
          auto = await runAutodrive(page, run, "auto-pay");
        }
      }
      if (/\/certificates\/order_summary\.asp$/i.test(new URL(page.url()).pathname)) {
        const basket = await groBasketState(page, target);
        const guard = amountGuard(basket.totalText, authorization, profile.buffer || 0);
        console.log(JSON.stringify({ stage: `gro-basket-${attempt}`, items: basket.items, ours: basket.ours, total: guard.amounts, amountGuardOk: guard.ok }));
        if (basket.items !== 1 || !basket.ours) throw new Error("The GRO basket must hold exactly this certificate; nothing was paid.");
        if (!guard.ok) throw new Error(`GRO basket refused: ${guard.reason}; nothing was paid.`);
        // Exploring stops here: submitting opens a Worldpay checkout, and an
        // abandoned one locks the GRO basket for several minutes.
        if (explore) return;
        for (let retry = 0; ; retry += 1) {
          // The basket's first submit control is "Set Ref"; only the exact Submit proceeds.
          await page.locator("input[type='submit'][value='Submit'], input[type='submit'][value='Submit ']").first().click();
          await waitForPageSettled(page, 3000);
          const text = await page.locator("body").innerText().catch(() => "");
          const locked = /basket unavailable/i.test(text) && /available again in (\d+) minutes?/i.exec(text);
          if (!locked) break;
          if (retry >= 2) throw new Error("The GRO basket stayed locked by an earlier checkout; nothing was paid.");
          const minutes = Math.min(Number(locked[1]) + 1, 20);
          console.log(JSON.stringify({ stage: "gro-basket-locked", waitMinutes: minutes }));
          await page.waitForTimeout(minutes * 60_000);
          await page.goto("https://www.gro.gov.uk/gro/content/certificates/order_summary.asp", { waitUntil: "domcontentloaded" });
          const recheck = await groBasketState(page, target);
          if (recheck.items !== 1 || !recheck.ours || !amountGuard(recheck.totalText, authorization, profile.buffer || 0).ok) {
            throw new Error("The GRO basket changed while locked; nothing was paid.");
          }
        }
        auto = await runAutodrive(page, run, "auto-pay");
      }
      await writeRun({ ...run, steps: [...run.steps, { name: "autodrive", url: sanitizeUrl(page.url()), autoResult: { reason: auto.reason, note: auto.note } }] });
      console.log(JSON.stringify({ stage: `autodrive-${attempt}`, reason: auto.reason, note: auto.note, page: sanitizeUrl(page.url()) }));
      if (auto.reason !== "payment") {
        if (explore) console.log(JSON.stringify({ stage: "stopped-page", structure: sanitizeLogValue(await inspectGroStructure(page)) }));
        keepOpen = ["login-required", "manual-review", "results-review", "application-detail-review", "filled-waiting"].includes(auto.reason);
        if (keepOpen) await activeSharedSession.showForManualStep(`GRO ${auto.reason}`);
        return;
      }
      if (checkoutHostAllowed(profile, page.url())) {
        const outcome = await payOnCheckout(page, { requestId: slug, task: activeSharedSession, inspect: explore });
        keepOpen = ["needs-user", "uncertain"].includes(outcome.status);
        console.log(JSON.stringify(outcome));
        return;
      }
      // A GRO-hosted review or checkout page before Worldpay: cross it only
      // when its total is within the authorized guard.
      const text = await page.locator("body").innerText().catch(() => "");
      const guard = amountGuard(text, authorization, profile.buffer || 0);
      console.log(JSON.stringify({ stage: `gro-checkout-${attempt}`, page: sanitizeUrl(page.url()), visibleAmounts: guard.amounts, amountGuardOk: guard.ok }));
      if (!guard.ok) throw new Error(`GRO checkout refused: ${guard.reason}; nothing was paid.`);
      if (explore) return;
      const crossed = await tryConfirmedPayment(page, { amounts: guard.amounts, warning: "" });
      if (!crossed.ok) throw new Error(`No exact GRO checkout control: ${crossed.note}`);
      await waitForPageSettled(page, 3000);
    }
    throw new Error("GRO checkout did not reach Worldpay; nothing was paid.");
  } finally {
    if (keepOpen) await activeSharedSession.leaveOpen().catch(() => {});
    else await activeSharedSession.close().catch(() => {});
  }
}

// Leaf rows of the GRO basket that price an application, and whether the one
// for this target is among them.
async function groBasketState(page, target) {
  const rows = await page.evaluate(() => [...document.querySelectorAll("tr")]
    .filter((row) => !row.querySelector("tr"))
    .map((row) => row.innerText.replace(/\s+/g, " ").trim())
    .filter((text) => /\b(?:certificate|pdf|digital image)\b/i.test(text) && /£\s?\d/.test(text)));
  const text = await page.locator("body").innerText().catch(() => "");
  const names = [target.person, target.spouse].filter(Boolean).map((name) => name.toLowerCase());
  const ours = rows.length > 0 && rows.some((row) => names.every((name) => row.toLowerCase().includes(name)));
  const total = /Order Total:\s*(£\s?\d+(?:\.\d{2})?)/i.exec(text)?.[1] || "";
  return { items: rows.length, ours, totalText: total };
}

async function runResume() {
  const session = await launchContext();
  const page = await getPage(session);
  const run = createRunMeta("resume");

  try {
    await gotoOfficialStart(page);
    await clickStartNow(page);
    await injectPanel(page, "Resume mode: log in if needed, go to order history, then use d to try download.");
    await safeScreenshot(page, "resume-01-start");
    run.steps.push({ name: "started-resume-flow", ok: true, url: page.url() });
    await writeRun(run);

    console.log("");
    console.log(`Resume mode is ready for ${describeTarget(activeTarget)}.`);
    console.log("Use the browser to reach GRO order history if needed.");
    await printCommandHelp("resume");

    await commandLoop(page, run, "resume");
  } finally {
    await session.close();
  }
}

async function runProfileSetup() {
  const session = await launchContext();
  const page = await getPage(session);
  const run = createRunMeta("profile");

  try {
    await gotoOfficialStart(page);
    await clickStartNow(page);
    await injectPanel(page, "Profile setup: sign into GRO and use Chrome or your password manager for payment autofill. The script will not read card data.");
    await session.showForManualStep("GRO sign-in and payment-profile setup");
    await safeScreenshot(page, "profile-setup-gro-start");
    run.steps.push({ name: "profile-setup-opened", ok: true, url: page.url() });
    await writeRun(run);

    console.log("");
    console.log("Profile setup is open.");
    console.log("Use Chrome/GRO to sign in and save payment/autofill details once.");
    console.log("The script does not read or store card numbers, expiry, or CVV.");
    await askQuestion("Press Enter after setup is done...", "");
  } finally {
    await session.close();
  }
}

async function startOrderPage(page, run, message) {
  await gotoOfficialStart(page);
  await clickStartNow(page);
  await injectPanel(page, message);
  await safeScreenshot(page, `${run.mode}-start`);
  run.steps.push({ name: "started-order-flow", ok: true, url: page.url(), target: activeTarget });
  await writeRun(run);
}

async function commandLoop(page, run, loopMode) {
  while (true) {
    await injectPanel(page, panelMessage(loopMode));
    const answer = (await askQuestion("\nCommand (a/f/n/d/i/s/p/q): ", "q")).trim().toLowerCase();

    if (answer === "q") {
      run.steps.push({ name: "user-quit", ok: true, url: page.url() });
      await writeRun(run);
      return "quit";
    }

    if (answer === "s") {
      const shot = await safeScreenshot(page, `${loopMode}-manual-${run.steps.length + 1}`);
      run.steps.push({ name: "manual-screenshot", ok: true, url: page.url(), screenshot: shot });
      await writeRun(run);
      continue;
    }

    if (answer === "i") {
      console.log(JSON.stringify(sanitizeLogValue(await inspectGroStructure(page)), null, 2));
      continue;
    }

    if (answer === "a") {
      const autoResult = await runAutodrive(page, run, loopMode);
      await injectPanel(page, autoResult.note || `Auto-drive stopped: ${autoResult.reason}`);
      run.steps.push({ name: "autodrive", ok: autoResult.ok, url: page.url(), autoResult });
      await writeRun(run);
      console.log(JSON.stringify(sanitizeLogValue(autoResult), null, 2));
      if (autoResult.reason === "payment") {
        await handlePaymentPause(page, run);
        return "payment-step-finished";
      }
      continue;
    }

    if (answer === "n") {
      const nextResult = await trySafeNext(page);
      await injectPanel(page, nextResult.ok ? "Clicked a non-payment continue button." : nextResult.note);
      const shot = await safeScreenshot(page, `${loopMode}-next-${run.steps.length + 1}`);
      run.steps.push({ name: "safe-next-attempt", ok: nextResult.ok, url: page.url(), nextResult, screenshot: shot });
      await writeRun(run);
      console.log(JSON.stringify(sanitizeLogValue(nextResult), null, 2));
      continue;
    }

    if (answer === "p") {
      await handlePaymentPause(page, run);
      return "payment-step-finished";
    }

    if (answer === "f") {
      const fillResult = await tryAutofillOrderPage(page);
      await injectPanel(page, `Autofill attempted: ${fillResult.filled.length} fields, ${fillResult.selected.length} selects/buttons.`);
      const shot = await safeScreenshot(page, `${loopMode}-autofill-${run.steps.length + 1}`);
      run.steps.push({ name: "autofill-attempt", ok: true, url: page.url(), fillResult, screenshot: shot });
      await writeRun(run);
      console.log(JSON.stringify(sanitizeLogValue(fillResult), null, 2));
      continue;
    }

    if (answer === "d") {
      const downloadResult = await tryDownloadOnlineView(page);
      await injectPanel(page, downloadResult.savedAs ? "Download saved." : "No download captured yet.");
      run.steps.push({ name: "download-attempt", ok: Boolean(downloadResult.savedAs), url: page.url(), downloadResult });
      await writeRun(run);
      console.log(JSON.stringify(sanitizeLogValue(downloadResult), null, 2));
      continue;
    }

    console.log("Unknown command.");
  }
}

async function handlePaymentPause(page, run) {
  await activeSharedSession.showForManualStep("payment autofill, final review, or bank verification");
  const costGuard = await checkCostGuard(page);
  const shot = await safeScreenshot(page, "payment-review-stop");
  run.steps.push({
    name: "payment-review-stop",
    ok: true,
    url: page.url(),
    screenshot: shot,
    costGuard,
    note: "Automation paused before manual payment/review."
  });
  await writeRun(run);

  console.log("");
  console.log("Automation is paused before payment/final submission.");
  console.log("Use Chrome saved payment details, Google Pay, or your password manager in the browser.");
  console.log("The script will not read card details. It can click the final payment button only after an exact typed confirmation.");
  if (costGuard.amounts.length) {
    console.log(`Detected page amounts: ${costGuard.amounts.map((amount) => `£${amount.toFixed(2)}`).join(", ")}`);
  }
  if (costGuard.warning) console.log(`Cost warning: ${costGuard.warning}`);

  const confirmation = paymentConfirmationPhrase(activeTarget);
  console.log("");
  console.log(`To let the script click the visible payment/final-submit button, type exactly: ${confirmation}`);
  console.log("Otherwise, complete/cancel manually in the browser and press Enter here.");
  let paymentResult = { ok: false, skipped: true, note: "No automated payment confirmation entered." };
  while (true) {
    const answer = (await askQuestion("Payment confirmation: ", "")).trim();
    if (answer !== confirmation) {
      break;
    }

    paymentResult = await tryConfirmedPayment(page, costGuard);
    if (paymentResult.ok || !paymentResult.canRetry) {
      break;
    }

    console.log(`Payment click not attempted: ${paymentResult.note}`);
    console.log("Fill/autofill the payment fields in the browser, then type the exact confirmation again.");
    console.log("Or complete/cancel manually in the browser and press Enter here.");
  }

  if (paymentResult.ok) {
    console.log(`Payment click attempted: ${paymentResult.clicked}`);
  } else if (!paymentResult.skipped) {
    console.log(`Payment click not attempted: ${paymentResult.note}`);
  }

  if (!paymentResult.ok) {
    await askQuestion("Press Enter here after the browser payment/review step is finished...", "");
  } else {
    await waitForPageSettled(page, 5000);
    const completion = await tryCompleteWorldpayConfirmation(page, costGuard);
    paymentResult.completion = completion;
    if (completion.ok) {
      console.log(`Worldpay confirmation click attempted: ${completion.clicked}`);
      await waitForPageSettled(page, 8000);
    }
    const state = await summarizePaymentState(page);
    paymentResult.finalState = state;
    console.log(`Post-payment URL: ${sanitizeUrl(state.url)}`);
    if (state.summary) console.log(`Post-payment page: ${state.summary}`);
    if (!state.finished) {
      console.log("If the browser is showing Worldpay processing, bank verification, or a final GRO result, finish that in the browser now.");
      console.log("If Chrome shows a save-card prompt, accept or dismiss it in the browser before continuing.");
      await askQuestion("Press Enter here only after the final page and any Chrome save-card prompt are handled...", "");
      await waitForPageSettled(page, 3000);
      paymentResult.finalState = await summarizePaymentState(page);
    } else {
      console.log("The browser reached a final payment page; no additional manual click is required.");
    }
  }

  const finalShot = await safeScreenshot(page, "after-manual-payment-step");
  run.steps.push({
    name: "manual-payment-step-finished",
    ok: true,
    url: page.url(),
    screenshot: finalShot,
    paymentResult,
    note: paymentResult.ok
      ? "User explicitly confirmed automated payment click."
      : "User handled payment/review manually in the browser."
  });
  await writeRun(run);
}

async function runAutodrive(page, run, loopMode) {
  const result = { ok: false, reason: "unknown", note: "", steps: [] };
  const maxSteps = 25;

  for (let step = 0; step < maxSteps; step += 1) {
    await acceptCookieBanners(page);
    const state = await classifyPage(page);
    result.steps.push({ step, state });

    if (state.kind === "login") {
      const login = await tryLoginPage(page);
      result.steps.push({ step, action: "login", login });
      if (!login.ok) {
        result.reason = "login-required";
        result.note = login.note;
        return result;
      }
      await page.waitForLoadState("domcontentloaded", { timeout: 8000 }).catch(() => {});
      continue;
    }

    if (state.kind === "payment") {
      result.ok = true;
      result.reason = "payment";
      result.note = "Payment/final-review page reached.";
      return result;
    }

    if (state.kind === "basket-unavailable") {
      const recovery = await tryRecoverUnavailableBasket(page);
      result.steps.push({ step, action: "recover-unavailable-basket", recovery });
      if (recovery.ok) {
        await waitForPageSettled(page, 1000);
        continue;
      }
      result.ok = true;
      result.reason = "basket-unavailable-review";
      result.note = recovery.note;
      return result;
    }

    if (state.kind === "basket") {
      const cost = await checkCostGuard(page);
      result.steps.push({ step, action: "basket-cost-guard", cost });
      if (cost.warning) {
        result.ok = true;
        result.reason = "cost-review";
        result.note = cost.warning;
        return result;
      }

      const next = await trySafeNext(page);
      result.steps.push({ step, action: "basket-next", next });
      if (next.ok) {
        await page.waitForLoadState("domcontentloaded", { timeout: 8000 }).catch(() => {});
        continue;
      }

      result.ok = true;
      result.reason = "basket-review";
      result.note = "Basket page reached, but no safe basket submit/continue button was found.";
      return result;
    }

    if (state.kind === "no-results") {
      result.ok = true;
      result.reason = "no-results";
      result.note = "GRO returned No Matching Results Found for the current search criteria.";
      return result;
    }

    if (state.kind === "results") {
      const selection = await trySelectGroSearchResult(page);
      result.steps.push({ step, action: "select-result", selection });
      if (!selection.ok) {
        result.ok = true;
        result.reason = "results-review";
        result.note = selection.note || "GRO results are visible, but the matching result row could not be selected automatically.";
        return result;
      }

      await waitForPageSettled(page);
      const orderOption = await trySelectGroOrderOption(page);
      result.steps.push({ step, action: "select-order-option", orderOption });
      if (orderOption.ok) {
        await page.waitForLoadState("domcontentloaded", { timeout: 8000 }).catch(() => {});
        continue;
      }

      const next = await trySafeNext(page, { allowSearch: false });
      result.steps.push({ step, action: "next-after-result-select", next });
      if (next.ok) {
        await page.waitForLoadState("domcontentloaded", { timeout: 8000 }).catch(() => {});
        continue;
      }

      result.ok = true;
      result.reason = "result-selected";
      result.note = "Selected the matching GRO result. Review the visible page for ordering options.";
      return result;
    }

    if (state.kind === "application-detail") {
      const terms = await tryAcceptDigitalImageTerms(page);
      result.steps.push({ step, action: "accept-digital-image-terms", terms });
      const next = await trySafeNext(page);
      result.steps.push({ step, action: "application-detail-next", next });
      if (next.ok) {
        await waitForPageSettled(page);
        const after = await classifyPage(page);
        if (after.kind === "application-detail" && page.url() === state.url) {
          result.ok = true;
          result.reason = "application-detail-review";
          result.note = "GRO application details Submit did not advance. Review the visible page before continuing.";
          return result;
        }
        continue;
      }

      result.ok = true;
      result.reason = "application-detail-review";
      result.note = "GRO application details page reached. Review the visible page before continuing.";
      return result;
    }

    const fill = await tryAutofillOrderPage(page);
    if (fill.navigationUnstable) {
      result.ok = true;
      result.reason = "navigation-review";
      result.note = "GRO kept changing pages while fields were being filled. Review the visible page, then rerun a/f/n.";
      return result;
    }
    if (fill.filled.length || fill.selected.length) {
      result.steps.push({ step, action: "fill", fill });
      if (fill.autoSubmitted) {
        await waitForPageSettled(page, 1000);
        continue;
      }
      const next = await trySafeNext(page);
      result.steps.push({ step, action: "next-after-fill", next });
      if (next.ok) {
        await page.waitForLoadState("domcontentloaded", { timeout: 8000 }).catch(() => {});
        await waitForPageSettled(page, 750);
        if (page.url() === state.url) {
          result.ok = true;
          result.reason = "fill-submit-no-advance";
          result.note = "GRO accepted a safe Submit/Continue click but kept the same application page. Review its validation message before retrying.";
          return result;
        }
        continue;
      }
      result.ok = true;
      result.reason = "filled-waiting";
      result.note = "Filled fields, but no safe continue/add button was found. Manual review is needed.";
      return result;
    }

    const entry = await tryOrderEntryPoint(page);
    result.steps.push({ step, action: "entry-point", entry });
    if (entry.ok) {
      await page.waitForLoadState("domcontentloaded", { timeout: 8000 }).catch(() => {});
      continue;
    }

    const next = await trySafeNext(page);
    result.steps.push({ step, action: "generic-next", next });
    if (next.ok) {
      await page.waitForLoadState("domcontentloaded", { timeout: 8000 }).catch(() => {});
      continue;
    }

    result.reason = "manual-review";
    result.note = entry.note || next.note || "No repeatable safe action found on this page.";
    return result;
  }

  result.reason = "step-limit";
  result.note = `Stopped after ${maxSteps} auto-drive steps.`;
  return result;
}

async function classifyPage(page) {
  const url = page.url();
  const text = await page.locator("body").innerText().catch(() => "");
  const hasUsername = await page.locator("input#username, input[name='username'], input[aria-label*='Email' i]").count().catch(() => 0);
  const hasPassword = await page.locator("input#password, input[name='password'], input[type='password']").count().catch(() => 0);

  if (hasUsername && hasPassword && /register or login|e-mail address|password/i.test(text)) {
    return { kind: "login", url };
  }

  if (looksLikePaymentPage(text)) {
    return { kind: "payment", url };
  }

  if (/no matching results found/i.test(text)) {
    return { kind: "no-results", url };
  }

  if (/\b\d+\s+Record\(s\)\s+Found\b/i.test(text) || /Select the button by an individual result/i.test(text)) {
    return { kind: "results", url };
  }

  if (/app_detail\.asp/i.test(url)) {
    return { kind: "application-detail", url };
  }

  if (/basket unavailable/i.test(text) && /being checked out|checkout process|cancel the process/i.test(text)) {
    return { kind: "basket-unavailable", url };
  }

  if (/app_[a-z0-9_]+_quoted\.asp/i.test(url)) {
    return { kind: "order", stage: "quoted-certificate-application", url };
  }

  if (/basket|cart/i.test(text) && /total|£|payment|checkout/i.test(text)) {
    return { kind: "basket", url };
  }

  if (/certificate|online view|registration|birth|death|marriage/i.test(text)) {
    return { kind: "order", url };
  }

  return { kind: "unknown", url };
}

async function inspectGroStructure(page) {
  const frames = [];
  for (const frame of page.frames()) {
    frames.push(await frame.evaluate(() => {
      const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
      const links = [...document.querySelectorAll("a")]
        .map((link) => ({ text: clean(link.innerText).slice(0, 120), href: link.href || "" }))
        .filter((link) => link.text || link.href)
        .slice(0, 40);
      const headings = [...document.querySelectorAll("h1, h2, h3")]
        .map((heading) => clean(heading.innerText).slice(0, 160))
        .filter(Boolean)
        .slice(0, 20);
      const radios = [...document.querySelectorAll("input[type='radio']")]
        .map((radio) => {
          const explicit = radio.id ? document.querySelector(`label[for="${CSS.escape(radio.id)}"]`)?.innerText || "" : "";
          const row = radio.closest("tr")?.innerText || radio.parentElement?.innerText || "";
          return clean(`${explicit} ${row}`).slice(0, 180);
        })
        .filter(Boolean)
        .slice(0, 20);
      const controls = [...document.querySelectorAll("input, select, button")]
        .filter((control) => {
          const style = getComputedStyle(control);
          return style.display !== "none" && style.visibility !== "hidden" && control.type !== "hidden";
        })
        .map((control) => {
          const explicit = control.id ? document.querySelector(`label[for="${CSS.escape(control.id)}"]`)?.innerText || "" : "";
          const context = clean(`${explicit} ${control.closest("tr")?.innerText || control.parentElement?.innerText || ""}`);
          const item = {
            tag: control.tagName.toLowerCase(),
            type: control.getAttribute("type") || "",
            name: control.getAttribute("name") || "",
            id: control.id || "",
            label: context.slice(0, 180),
            disabled: Boolean(control.disabled),
            events: {
              change: clean(control.getAttribute("onchange") || "").slice(0, 160),
              keyup: clean(control.getAttribute("onkeyup") || "").slice(0, 160),
              click: clean(control.getAttribute("onclick") || "").slice(0, 160)
            }
          };
          if (control.tagName === "SELECT") {
            item.options = [...control.options].map((option) => clean(option.text)).filter(Boolean).slice(0, 30);
          }
          return item;
        })
        .slice(0, 40);
      return { url: location.href, title: document.title, headings, links, radios, controls };
    }).catch((error) => ({ url: frame.url(), error: error.message || String(error) })));
  }
  return { pageUrl: page.url(), frames };
}

async function isGroLoginPage(page) {
  const text = await page.locator("body").innerText().catch(() => "");
  const hasUsername = await page.locator("input#username, input[name='username'], input[aria-label*='Email' i]").count().catch(() => 0);
  const hasPassword = await page.locator("input#password, input[name='password'], input[type='password']").count().catch(() => 0);
  return Boolean(hasUsername && hasPassword && /register or login|e-mail address|password/i.test(text));
}

async function tryLoginPage(page) {
  const username = page.locator("input#username, input[name='username'], input[aria-label*='Email' i]").first();
  const password = page.locator("input#password, input[name='password'], input[type='password']").first();

  if (!(await username.count().catch(() => 0)) || !(await password.count().catch(() => 0))) {
    return { ok: false, note: "Login form not found." };
  }

  const readAutofill = () => page.evaluate(() => ({
    username: Boolean(document.querySelector("input#username:-webkit-autofill, input[name='username']:-webkit-autofill, input[type='email']:-webkit-autofill")),
    password: Boolean(document.querySelector("input#password:-webkit-autofill, input[name='password']:-webkit-autofill, input[type='password']:-webkit-autofill"))
  }));
  let autofill = await readAutofill();
  if (!autofill.username || !autofill.password) {
    // Chrome fills a saved credential only after a user gesture on the form. One click into the
    // exact username field supplies that gesture; nothing is read or typed, and the CSS autofill
    // state is re-checked exactly as before.
    await username.click({ timeout: 5_000 }).catch(() => {});
    await page.waitForTimeout(1_200);
    autofill = await readAutofill();
  }
  if (!autofill.username || !autofill.password) {
    await password.focus().catch(() => {});
    await activeSharedSession.showForManualStep("manual GRO sign-in");
    return {
      ok: false,
      autofill,
      note: "GRO login page reached, but Chrome has not autofilled both fields. No credential was read, typed, copied, or submitted."
    };
  }

  const clicked = await tryClick(page, [
    { selector: "input[type='submit'][value='Login']" },
    { role: "button", name: /^login$/i },
    { role: "link", name: /^login$/i }
  ]);

  return clicked
    ? { ok: true, autofill, note: "Submitted only the browser-autofilled GRO login form." }
    : { ok: false, autofill, note: "Chrome autofilled GRO login, but no Login submit button was found." };
}

async function readGroIndexSearchFields(page, fill) {
  // Read only the historical search controls just filled, never account fields.
  const descriptors = [...fill.filled, ...fill.selected].filter((field) => field.purpose);
  return page.evaluate((fields) => {
    const captured = fields.map((field) => {
      const element = (field.id && document.getElementById(field.id)) || (field.name && document.getElementsByName(field.name)[0]);
      return { purpose: field.purpose, value: element?.value ?? null,
        text: element?.tagName === "SELECT" ? element.selectedOptions[0]?.textContent?.trim() ?? "" : "" };
    });
    const birthSelected = [...document.querySelectorAll("input[type=radio]:checked")].some((radio) => {
      const label = radio.id ? document.querySelector(`label[for="${CSS.escape(radio.id)}"]`)?.textContent ?? "" : "";
      return /^b(?:irths?)?$/i.test(radio.value) || /birth/i.test(`${radio.id} ${label}`);
    });
    return { fields: captured, birthSelected };
  }, descriptors);
}

async function submitGroIndexSearch(page) {
  const candidates = page.locator("button, input[type='submit'], input[type='button']");
  const count = await candidates.count().catch(() => 0);
  for (let index = 0; index < Math.min(count, 30); index += 1) {
    const candidate = candidates.nth(index);
    if (!await candidate.isVisible().catch(() => false)) continue;
    const label = await controlText(candidate);
    if (!/^search$/i.test(label.trim())) continue;
    await Promise.all([
      page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => {}),
      candidate.click()
    ]);
    await page.waitForTimeout(750);
    return { ok: true, clicked: label || "Search" };
  }
  return { ok: false, note: "No GRO index Search control was found." };
}

function summarizeGroIndexResult(text) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (/no matching results found/i.test(normalized)) return { kind: "no-results" };
  const count = normalized.match(/\b(\d+)\s+Record\(s\)\s+Found\b/i)?.[1];
  if (count) {
    const at = normalized.search(/\b\d+\s+Record\(s\)\s+Found\b/i);
    return {
      kind: "results",
      count: Number(count),
      excerpt: normalized.slice(Math.max(0, at), at + 1800)
    };
  }
  return { kind: "unclassified", excerpt: normalized.slice(0, 900) };
}

async function extractGroIndexRows(page, target) {
  const captured = await page.evaluate((currentTarget) => {
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const surname = currentTarget.person.trim().split(/\s+/).at(-1).toUpperCase();
    const rows = [...document.querySelectorAll("tr")].filter((row) =>
      row.cells.length === 3 && normalize(row.cells[1].innerText).toUpperCase().startsWith(surname + ","));
    const headers = [...new Set(rows.flatMap((row) => [...row.closest("table").querySelectorAll("th")]
      .map((cell) => normalize(cell.innerText))))];
    return {
      candidateCount: rows.length,
      headers,
      pairs: rows.slice(0, 50).map((row) => ({
        name: normalize(row.cells[1].innerText),
        maternalSurname: normalize(row.cells[2].innerText),
        reference: normalize(row.nextElementSibling?.innerText)
      }))
    };
  }, target);
  return { ...captured, entries: hasGroIndexHeaders(captured.headers, target.event)
    ? (target.groIndexSearch ? parseGroIndexSearchPairs(captured.pairs, target) : parseGroIndexPairs(captured.pairs, target)) : [] };
}

async function trySelectGroSearchResult(page) {
  const selected = await page.evaluate((target) => {
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim().toUpperCase();
    const digits = (value) => String(value || "").replace(/[^0-9]/g, "");
    const parts = String(target.person || "").trim().split(/\s+/);
    const spouseParts = String(target.spouse || "").trim().split(/\s+/).filter(Boolean);
    const surname = normalize(parts.length > 1 ? parts.at(-1) : "");
    const forename = normalize(parts.length > 1 ? parts.slice(0, -1).join(" ") : parts[0] || "");
    const firstForename = normalize(forename.split(/\s+/)[0] || forename);
    const spouseSurname = normalize(spouseParts.length > 1 ? spouseParts.at(-1) : "");
    const spouseFirstForename = normalize(spouseParts.length > 1 ? spouseParts[0] : spouseParts[0] || "");
    const mother = normalize(target.groMotherMaidenSurname || target.nationalIndex?.motherMaidenSurname || "");
    const quarter = normalize(target.quarter);
    const year = digits(target.year);
    const volume = normalize(target.volume);
    const page = digits(target.page);
    const quarterMatches = (text) => {
      const haystack = normalize(text);
      if (!quarter) return false;
      if (/MAR|MARCH|Q1|1/.test(quarter)) return /M\s*QUARTER|MAR|MARCH|JAN-MAR|Q1/.test(haystack);
      if (/JUN|JUNE|Q2|2/.test(quarter)) return /J\s*QUARTER|JUN|JUNE|APR-JUN|APR-MAY-JUN|Q2/.test(haystack);
      if (/SEP|SEPT|SEPTEMBER|Q3|3/.test(quarter)) return /S\s*QUARTER|SEP|SEPT|SEPTEMBER|JUL-SEP|Q3/.test(haystack);
      if (/DEC|DECEMBER|Q4|4/.test(quarter)) return /D\s*QUARTER|DEC|DECEMBER|OCT-DEC|Q4/.test(haystack);
      return haystack.includes(quarter);
    };

    const scoreRow = (text) => {
      const haystack = normalize(text);
      let score = 0;
      if (surname && haystack.includes(surname)) score += 3;
      if (firstForename && haystack.includes(firstForename)) score += 3;
      if (spouseSurname && haystack.includes(spouseSurname)) score += 2;
      if (spouseFirstForename && haystack.includes(spouseFirstForename)) score += 1;
      if (mother && haystack.includes(mother)) score += 3;
      if (year && digits(haystack).includes(year)) score += 2;
      if (volume && haystack.includes(volume)) score += 2;
      if (page && digits(haystack).includes(page)) score += 2;
      if (quarterMatches(text)) score += 1;
      return score;
    };

    const resultsHeading = [...document.querySelectorAll("h1, h2, h3, h4, p, div, td, th, span")]
      .find((element) => /^Results:?$/i.test((element.innerText || "").trim()));
    const resultsTop = resultsHeading?.getBoundingClientRect().top ?? 0;
    const controls = [...document.querySelectorAll("input[type='radio'], input[type='checkbox'], input[type='button'], input[type='submit'], button")];
    const candidates = controls
      .map((control, index) => {
        const rect = control.getBoundingClientRect();
        const row = control.closest("tr");
        const text = [
          row?.previousElementSibling?.innerText || "",
          row?.innerText || "",
          row?.nextElementSibling?.innerText || ""
        ].join(" ");
        return { index, row, control, text, top: rect.top, score: scoreRow(text) };
      })
      .filter((candidate) => candidate.top > resultsTop && candidate.score >= 8)
      .sort((a, b) => b.score - a.score);

    const best = candidates[0];
    if (!best) {
      return { ok: false, note: "No result row matched the target strongly enough." };
    }

    const control = best.control;
    if ("checked" in control) control.checked = true;
    control.click();
    control.dispatchEvent(new Event("input", { bubbles: true }));
    control.dispatchEvent(new Event("change", { bubbles: true }));

    return {
      ok: true,
      score: best.score,
      rowIndex: best.index,
      rowText: best.text.replace(/\s+/g, " ").trim().slice(0, 500),
      controlType: control.type || control.tagName.toLowerCase()
    };
  }, activeTarget).catch((error) => {
    if (isNavigationRaceError(error)) return { ok: true, note: "Result selection triggered navigation." };
    throw error;
  });

  return selected;
}

async function trySelectGroOrderOption(page) {
  await page.waitForTimeout(1500).catch(() => {});
  const selected = await page.evaluate((target) => {
    // GRO's three "Order this entry as a:" image buttons differ only by id
    // (OrderCertificate_n, OrderPDF_n, OrderDigitalImage_n), so the id, spelled out, joins the
    // visible text that the product patterns are matched against.
    const textOf = (control) => [
      control.innerText || "",
      control.value || "",
      control.alt || "",
      control.title || "",
      control.getAttribute("aria-label") || "",
      (control.id || "").replace(/_\d+$/, "").replace(/([a-z])([A-Z])/g, "$1 $2")
    ].join(" ").replace(/\s+/g, " ").trim();

    const visible = (element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style && style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };

    const resultsHeading = [...document.querySelectorAll("h1, h2, h3, h4, p, div, td, th, span")]
      .find((element) => /^Results:?$/i.test((element.innerText || "").trim()));
    const resultsTop = resultsHeading?.getBoundingClientRect().top ?? 0;
    const controls = [...document.querySelectorAll("a, button, input[type='button'], input[type='submit'], input[type='image']")]
      .filter((control) => visible(control) && control.getBoundingClientRect().top > resultsTop)
      .map((control, index) => ({ control, index, label: textOf(control) }));

    const service = `${target.serviceOption || ""} ${target.event || ""}`;
    const wantsCertificate = /marriage|certificate|standard/i.test(service) && !/digital|online[\s-]*view|pdf/i.test(service);
    const wantsOnlineView = /online[\s-]*view/i.test(service);
    const wantsPdf = !wantsOnlineView && /\bpdf\b/i.test(service);
    // Patterns are tried in order of preference across every visible control, so a GRO page that
    // lists "Digital Image (PDF)" before "Online View" still yields the GBP 3 Online View when
    // that is what the target asks for; a PDF target never falls through to a certificate.
    // GRO names the GBP 3 Online View product "Digital Image" on its result rows.
    const desiredPatterns = wantsCertificate
      ? [/standard.*certificate/i, /full.*certificate/i, /^certificate$/i, /\bcertificate\b/i]
      : wantsOnlineView
        ? [/online[\s-]*view/i, /digital\s*image/i]
        : wantsPdf
          ? [/\bpdf\b/i]
          : [/online[\s-]*view/i, /digital\s*image/i, /\bpdf\b/i];
    const excluded = wantsCertificate ? /passport|\bpdf\b|digital/i : wantsOnlineView ? /passport|\bpdf\b|certificate/i : /passport|certificate|digital/i;
    let option;
    for (const pattern of desiredPatterns) {
      option = controls.find(({ label }) => pattern.test(label) && !excluded.test(label));
      if (option) break;
    }
    if (!option) {
      return {
        ok: false,
        note: `${wantsCertificate ? "Certificate" : "Digital Image / Online View"} option was not visible after selecting the result.`,
        visibleControls: controls.map(({ label }) => label).filter(Boolean).slice(0, 12)
      };
    }

    option.control.click();
    option.control.dispatchEvent(new Event("input", { bubbles: true }));
    option.control.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true, clicked: option.label || `result-option-${option.index}` };
  }, activeTarget).catch((error) => {
    if (isNavigationRaceError(error)) return { ok: true, note: "Order-option selection triggered navigation." };
    throw error;
  });

  return selected;
}

async function tryAcceptDigitalImageTerms(page) {
  const result = await page.evaluate(() => {
    const bodyText = document.body?.innerText || "";
    if (!/digital image service|digital image/i.test(bodyText)) {
      return { ok: false, note: "This page does not look like the digital image terms page." };
    }

    const visible = (element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style && style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };

    const checkbox = [...document.querySelectorAll("input[type='checkbox']")].find(visible);
    if (!checkbox) return { ok: false, note: "No visible digital image terms checkbox found." };
    if (checkbox.checked) return { ok: true, alreadyChecked: true };

    checkbox.click();
    if (!checkbox.checked) checkbox.checked = true;
    checkbox.dispatchEvent(new Event("input", { bubbles: true }));
    checkbox.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true, checked: true, name: checkbox.name || "", id: checkbox.id || "" };
  }).catch((error) => {
    if (isNavigationRaceError(error)) return { ok: true, note: "Terms checkbox triggered navigation." };
    throw error;
  });

  return result;
}

async function tryOrderEntryPoint(page) {
  const candidates = page.locator("a, button, input[type='button'], input[type='submit']");
  const count = await candidates.count().catch(() => 0);
  const visible = [];

  for (let index = 0; index < Math.min(count, 40); index += 1) {
    const candidate = candidates.nth(index);
    if (!(await candidate.isVisible().catch(() => false))) continue;
    const label = await controlText(candidate);
    const href = await candidate.getAttribute("href").catch(() => "");
    const value = await candidate.getAttribute("value").catch(() => "");
    const combined = `${label} ${href || ""} ${value || ""}`;

    if (/register|login|forgot|faq|guide|youtube|cookie|gov\.uk|passport|contact/i.test(combined)) continue;
    if (!/order|birth|certificate|digital image|online view|pdf/i.test(combined)) continue;
    visible.push({ label: label || value || "", href: href || "" });

    if (/app_select\.asp/i.test(page.url())) {
      const wantsCertificate = targetWantsStandardCertificate(activeTarget);
      const isDigitalOnly = /order\s+a\s+digital\s+image|digital\s+image\s+service/i.test(combined);
      const isCertificateRoute = /order\s+(?:a\s+)?certificate|certificate\s+order|standard\s+certificate|paper\s+certificate/i.test(combined);
      if (wantsCertificate ? (!isCertificateRoute || isDigitalOnly) : !isDigitalOnly) continue;
    }

    await Promise.all([
      page.waitForLoadState("domcontentloaded").catch(() => {}),
      candidate.click().catch(() => null)
    ]);
    return { ok: true, clicked: label || value || href || `entry-candidate-${index}`, href };
  }

  return {
    ok: false,
    note: /app_select\.asp/i.test(page.url())
      ? `No ${targetWantsStandardCertificate(activeTarget) ? "standard-certificate" : "digital-image"} entry control was safely identifiable.`
      : "No safe order-entry link/button found.",
    visibleControls: visible.slice(0, 12)
  };
}

function targetWantsStandardCertificate(target) {
  const service = `${target?.serviceOption || ""} ${target?.event || ""}`;
  return /marriage|certificate|standard/i.test(service) && !/digital|online\s*view|pdf/i.test(service);
}

async function tryConfirmedPayment(page, costGuard) {
  if (!costGuard.amounts.length) {
    return { ok: false, note: "No GBP amount was detected on the page; refusing automated payment click." };
  }

  if (costGuard.warning) {
    return { ok: false, note: costGuard.warning };
  }

  const text = await page.locator("body").innerText().catch(() => "");
  if (!looksLikePaymentPage(text)) {
    return { ok: false, note: "This does not look like a payment/final-review page." };
  }

  const candidates = page.locator("button, input[type='submit'], input[type='button'], a");
  const count = await candidates.count().catch(() => 0);
  let disabledNote = "";
  for (let index = 0; index < Math.min(count, 10); index += 1) {
    const candidate = candidates.nth(index);
    if (!(await candidate.isVisible().catch(() => false))) continue;
    const label = await controlText(candidate);
    if (!isFinalPaymentControlLabel(label)) continue;
    const disabled = await candidate.evaluate((element) =>
      element.matches(":disabled") ||
      element.getAttribute("aria-disabled") === "true" ||
      Boolean(element.disabled)
    ).catch(() => false);
    if (disabled) {
      disabledNote = `Payment button "${label || `payment-candidate-${index}`}" is disabled; required payment fields are probably not filled.`;
      continue;
    }

    try {
      await Promise.all([
        page.waitForLoadState("domcontentloaded").catch(() => {}),
        candidate.click({ timeout: 5000 })
      ]);
    } catch (error) {
      return {
        ok: false,
        canRetry: true,
        note: `Payment button click failed: ${error.message || error}`
      };
    }
    return {
      ok: true,
      clicked: label || `payment-candidate-${index}`,
      amounts: costGuard.amounts,
      maxOrderCostGbp: costGuard.maxOrderCostGbp
    };
  }

  return {
    ok: false,
    canRetry: Boolean(disabledNote),
    note: disabledNote || "No clear visible payment/final-submit button was found."
  };
}

function isFinalPaymentControlLabel(label) {
  const normalized = String(label || "").replace(/\s+/g, " ").trim();
  if (/privacy|policy|terms|help|contact|cancel|back|worldpay/i.test(normalized)) return false;
  return /\b(?:pay(?:\s+now)?|submit\s+payment|confirm(?:\s+and)?\s+pay(?:ment)?|make\s+payment|place\s+order|complete\s+order|continue\s+to\s+payment)\b/i.test(normalized);
}

async function tryCompleteWorldpayConfirmation(page, authorizedCostGuard) {
  const url = page.url();
  const text = await page.locator("body").innerText().catch(() => "");
  if (!/^https:\/\/payments\.worldpay\.com\//i.test(url) || !/complete payment/i.test(text)) {
    return { ok: false, skipped: true, note: "No Worldpay Complete Payment confirmation step was present." };
  }

  if (!authorizedCostGuard?.amounts?.length || authorizedCostGuard.warning) {
    return {
      ok: false,
      note: authorizedCostGuard?.warning || "No verified pre-payment GBP amount was carried into the Worldpay confirmation step."
    };
  }
  const confirmationCostGuard = await checkCostGuard(page);
  if (confirmationCostGuard.warning) return { ok: false, note: confirmationCostGuard.warning };

  const candidates = page.locator("button, input[type='submit'], input[type='button']");
  const count = await candidates.count().catch(() => 0);
  for (let index = 0; index < Math.min(count, 10); index += 1) {
    const candidate = candidates.nth(index);
    if (!(await candidate.isVisible().catch(() => false))) continue;
    const label = await controlText(candidate);
    if (!/^complete payment$/i.test(label.trim())) continue;
    const disabled = await candidate.evaluate((element) =>
      element.matches(":disabled") || element.getAttribute("aria-disabled") === "true" || Boolean(element.disabled)
    ).catch(() => false);
    if (disabled) return { ok: false, note: "Worldpay's exact Complete Payment button is disabled." };
    await Promise.all([
      page.waitForLoadState("domcontentloaded").catch(() => {}),
      candidate.click({ timeout: 5000 })
    ]);
    return {
      ok: true,
      clicked: "Complete Payment",
      amounts: confirmationCostGuard.amounts.length
        ? confirmationCostGuard.amounts
        : authorizedCostGuard.amounts,
      maxOrderCostGbp: authorizedCostGuard.maxOrderCostGbp
    };
  }
  return { ok: false, note: "Worldpay requested Complete Payment, but no exact enabled button was safely identifiable." };
}

async function tryRecoverUnavailableBasket(page) {
  const text = await page.locator("body").innerText().catch(() => "");
  if (!/basket unavailable/i.test(text) || !/being checked out|checkout process|cancel the process/i.test(text)) {
    return { ok: false, note: "This is not the GRO abandoned-checkout recovery page." };
  }

  const candidates = page.locator("button, input[type='submit'], input[type='button']");
  const count = await candidates.count().catch(() => 0);
  for (let index = 0; index < Math.min(count, 10); index += 1) {
    const candidate = candidates.nth(index);
    if (!(await candidate.isVisible().catch(() => false))) continue;
    const label = await controlText(candidate);
    if (!/return.*basket|cancel.*checkout|cancel.*process|continue/i.test(label)) continue;
    await Promise.all([
      page.waitForLoadState("domcontentloaded").catch(() => {}),
      candidate.click()
    ]);
    return { ok: true, clicked: label };
  }
  return { ok: false, note: "GRO reports an abandoned checkout, but no exact return/cancel control was safely identifiable." };
}

async function launchContext() {
  if (isWsl()) {
    throw new Error(
      "Browser launches are disabled inside WSL for this project.\n" +
      "Run the Windows launcher instead:\n" +
      "  powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/gro-windows.ps1 -Mode queue\n" +
      "Or from Windows PowerShell in the project folder:\n" +
      "  .\\tools\\gro-windows.ps1 -Mode queue"
    );
  }
  if (!sharedWindow || endpoint !== sharedChromeEndpoint) {
    throw new Error(
      `GRO is restricted to a background task tab in the one shared Windows Chrome/CDP window at ${sharedChromeEndpoint}. ` +
      "Use tools/gro-windows.ps1; standalone profile and direct Chrome launches are disabled."
    );
  }
  if (headless) {
    throw new Error("GRO cannot launch a separate headless browser; the shared-window task tab already runs in the background.");
  }

  activeSharedSession = await openSharedChromeTask({
    chromium,
    endpoint,
    taskLabel: "GRO",
    affinitySlot
  });
  console.log(`Using a background GRO task tab in the one shared Windows Chrome window (affinity ${affinitySlot}).`);
  return activeSharedSession;
}

async function getPage(session) {
  const page = session.page;
  page.setDefaultTimeout(8000);
  page.on("dialog", async (dialog) => {
    console.log(`Dialog opened: ${dialog.message()}`);
    await dialog.dismiss().catch(() => {});
  });
  return page;
}

async function gotoOfficialStart(page) {
  await page.goto(officialStartUrl, { waitUntil: "domcontentloaded" });
  await tryClick(page, [
    { role: "button", name: /accept additional cookies/i },
    { role: "button", name: /hide cookie message/i }
  ]);
}

async function clickStartNow(page) {
  const clicked = await tryClick(page, [
    { role: "link", name: /start now/i },
    { role: "button", name: /start now/i }
  ]);

  if (clicked) {
    await page.waitForLoadState("domcontentloaded").catch(() => {});
  } else {
    await page.goto(groFallbackUrl, { waitUntil: "domcontentloaded" });
  }

  if (!/gro\.gov\.uk/i.test(page.url())) {
    await page.goto(groFallbackUrl, { waitUntil: "domcontentloaded" });
  }

  return /gro\.gov\.uk/i.test(page.url());
}

async function tryAutofillOrderPage(page) {
  const result = { target: activeTarget.slug, filled: [], selected: [], skipped: [], warnings: [] };

  let lowerText = await page.locator("body").innerText().catch(() => "");
  if (looksLikePaymentPage(lowerText)) {
    result.warnings.push("This page looks like payment/final review. Autofill skipped.");
    return result;
  }

  if (/app_select\.asp/i.test(page.url()) && targetWantsStandardCertificate(activeTarget)) {
    if (/where was the event registered/i.test(lowerText)) {
      const basics = await selectGroApplicationBasics(page, activeTarget.country, activeTarget.event);
      result.selected.push(...basics.selected);
      result.warnings.push(...basics.warnings);
      result.autoSubmitted ||= basics.autoSubmitted;
      await waitForPageSettled(page, 1000);
      lowerText = await page.locator("body").innerText().catch(() => "");
    }

    if (
      /when was the event registered/i.test(lowerText) &&
      !/how can the event be identified/i.test(lowerText)
    ) {
      const registrationYear = await fillGroApplicationYear(page, activeTarget.year);
      if (registrationYear.ok) {
        result.filled.push(registrationYear);
        result.autoSubmitted = true;
      } else {
        result.warnings.push(registrationYear.note);
      }
      await waitForPageSettled(page, 1000);
      lowerText = await page.locator("body").innerText().catch(() => "");
    }

    if (/how can the event be identified/i.test(lowerText)) {
      const identification = await selectGroIdentificationMethod(page);
      if (identification.ok && identification.changed) {
        result.selected.push(identification.selection);
        result.autoSubmitted = true;
      } else if (!identification.ok) {
        result.warnings.push(identification.note);
      }
      await waitForPageSettled(page, 1000);
    }

    await safeScreenshot(page, "latest-autofill");
    return result;
  }

  if (/app_[a-z0-9_]+_quoted\.asp/i.test(page.url()) && targetWantsStandardCertificate(activeTarget)) {
    await fillGroQuotedCertificateApplication(page, result);
    await safeScreenshot(page, "latest-autofill");
    return result;
  }

  const servicePatterns = serviceOptionPatterns(activeTarget);
  await chooseByText(page, result, [
    new RegExp(activeTarget.event, "i"),
    /england and wales/i,
    /gro index reference/i,
    ...servicePatterns
  ]);
  await fillGroIndexSearchPage(page, result);
  if (/indexes_search\.asp/i.test(page.url())) {
    await safeScreenshot(page, "latest-autofill");
    return result;
  }

  const { forenames, surname } = splitPersonName(activeTarget.person);
  await fillByLabels(page, result, [/surname/i, /last name/i, /family name/i], surname, {
    avoid: /applicant|customer|card|billing|delivery|email|password|telephone|phone|postcode|address/i
  });
  await fillByLabels(page, result, [/forename/i, /first name/i, /given name/i, /christian name/i], forenames, {
    avoid: /applicant|customer|card|billing|delivery|email|password|telephone|phone|postcode|address/i
  });
  await fillByLabels(page, result, [/year/i, /event year/i, /registration year/i], activeTarget.year, {
    avoid: /expiry|card|birth date of applicant|customer/i
  });
  await fillByLabels(page, result, [/district/i, /registration district/i], activeTarget.district, {
    avoid: /address|delivery|billing/i
  });
  await fillByLabels(page, result, [/volume/i, /vol/i], activeTarget.volume, {
    avoid: /phone|card|security/i
  });
  await fillByLabels(page, result, [/page/i, /page number/i], activeTarget.page, {
    avoid: /password|card/i
  });
  if (activeTarget.spouse) {
    const { forenames: spouseForenames, surname: spouseSurname } = splitPersonName(activeTarget.spouse);
    await fillByLabels(page, result, [/spouse.*surname/i, /partner.*surname/i, /other party.*surname/i, /bride.*surname/i, /groom.*surname/i], spouseSurname, {
      avoid: /applicant|customer|card|billing|delivery|email|password|telephone|phone|postcode|address/i
    });
    await fillByLabels(page, result, [/spouse.*forename/i, /partner.*forename/i, /other party.*forename/i, /bride.*forename/i, /groom.*forename/i], spouseForenames, {
      avoid: /applicant|customer|card|billing|delivery|email|password|telephone|phone|postcode|address/i
    });
  }

  await selectByLabels(page, result, [/quarter/i, /qtr/i], quarterPatterns(activeTarget.quarter));
  await selectByLabels(page, result, [/year/i, /registered/i], [new RegExp(`^\\s*${escapeRegExp(activeTarget.year)}\\s*$`, "i")]);
  await selectByLabels(page, result, [/event type/i, /certificate type/i, /record type/i], [new RegExp(activeTarget.event, "i")]);
  await selectByLabels(page, result, [/service option/i, /service/i], servicePatterns);

  await fillLikelyInputsByName(page, result);
  await selectLikelySelectsByName(page, result);
  await safeScreenshot(page, "latest-autofill");
  return result;
}

async function selectGroApplicationBasics(page, country, eventType) {
  const jurisdictionPattern = /england|wales/i.test(String(country || ""))
    ? /^england\s+(?:or|and)\s+wales\b/i
    : /^(?:outside|overseas|british forces|consul|high commission)\b/i;
  const eventPattern = new RegExp(`^${escapeRegExp(String(eventType || ""))}\\b`, "i");
  const observed = [];
  const selected = [];
  const matchedPurposes = new Set();

  for (const { purpose, pattern } of [
    { purpose: "registration-jurisdiction", pattern: jurisdictionPattern },
    { purpose: "event-type", pattern: eventPattern }
  ]) {
    let matched = false;
    for (let attempt = 0; attempt < 20 && !matched; attempt += 1) {
      const radios = page.locator("input[type='radio']");
      const count = await radios.count().catch(() => 0);
      for (let index = 0; index < count; index += 1) {
        const radio = radios.nth(index);
        if (!(await radio.isVisible().catch(() => false))) continue;
        const context = await radio.evaluate((control) => {
          const explicit = control.id ? document.querySelector(`label[for="${CSS.escape(control.id)}"]`)?.innerText || "" : "";
          const row = control.closest("tr")?.innerText || "";
          const parent = control.parentElement?.innerText || "";
          return `${explicit} ${row} ${parent} ${control.value || ""} ${control.name || ""}`.replace(/\s+/g, " ").trim();
        }).catch(() => "");
        const summary = context.slice(0, 160);
        observed.push(summary);
        if (!pattern.test(context)) continue;

        matchedPurposes.add(purpose);
        const wasChecked = await radio.isChecked().catch(() => false);
        if (!wasChecked) {
          await radio.check().catch(async () => radio.click());
          selected.push({ type: "radio", purpose, text: summary });
        }
        matched = true;
        break;
      }
      if (!matched) await page.waitForTimeout(500);
    }
  }

  return {
    selected,
    autoSubmitted: selected.length > 0,
    warnings: [
      ...(!matchedPurposes.has("registration-jurisdiction")
        ? [`No safe GRO registration-jurisdiction radio matched ${country || "the target country"}.`]
        : []),
      ...(!matchedPurposes.has("event-type")
        ? [`No safe GRO event-type radio matched ${eventType || "the target event"}.`]
        : [])
    ],
    observed: observed.slice(0, 10)
  };
}

async function selectGroIdentificationMethod(page) {
  if (!/app_select\.asp/i.test(page.url())) {
    return { ok: false, note: "The GRO identification-method helper only runs on app_select.asp." };
  }

  const radio = page.locator("input[type='radio']#groIndexKnownY").first();
  if (!(await radio.count().catch(() => 0)) || !(await radio.isVisible().catch(() => false))) {
    return { ok: false, note: "The exact 'I know the GRO Index Reference' choice was not visible." };
  }
  const label = await radio.evaluate((control) => {
    const explicit = control.id ? document.querySelector(`label[for="${CSS.escape(control.id)}"]`)?.innerText || "" : "";
    return `${explicit} ${control.closest("tr")?.innerText || control.parentElement?.innerText || ""}`.replace(/\s+/g, " ").trim();
  }).catch(() => "");
  if (!/^i know the gro index reference\b/i.test(label)) {
    return { ok: false, note: "The GRO index-reference choice did not have the expected exact label; refused to guess." };
  }

  const wasChecked = await radio.isChecked().catch(() => false);
  if (!wasChecked) await radio.check().catch(async () => radio.click());
  return {
    ok: true,
    changed: !wasChecked,
    selection: { type: "radio", purpose: "identification-method", text: "I know the GRO Index Reference" }
  };
}

async function fillGroQuotedCertificateApplication(page, result) {
  const { forenames, surname } = splitPersonName(activeTarget.person);
  const limit = costGuardLimitForTarget(activeTarget);
  // Marriage applications name both parties instead of one subject.
  const marriage = await page.locator("input[name='mansSurnameMarriage']").count().catch(() => 0) > 0;
  if (marriage && !activeTarget.spouse) {
    result.warnings.push("A marriage application needs the target's spouse; refused to fill one party.");
    return;
  }
  const controls = {
    ...(marriage ? {
      surname: page.locator("input[name='mansSurnameMarriage']").first(),
      forenames: page.locator("input[name='mansForenamesMarriage']").first(),
      spouseSurname: page.locator("input[name='womansSurnameMarriage']").first(),
      spouseForenames: page.locator("input[name='womansForenamesMarriage']").first()
    } : {
      surname: page.locator("input[name='subjectSurname']").first(),
      forenames: page.locator("input[name='subjectForename']").first()
    }),
    quarter: page.locator("select[name='groQuarter']").first(),
    district: page.locator("input[name='groDistrict']").first(),
    volume: page.locator("input[name='groVolNo']").first(),
    pageNumber: page.locator("input[name='groPageNo']").first(),
    standardService: page.locator("input[type='radio']#ServiceStdCert").first(),
    delivery: page.locator("select[name='CertDeliveryMethod']").first(),
    quantity: page.locator("input[name='numberOfCertificatesFull']").first()
  };

  for (const [purpose, control] of Object.entries(controls)) {
    if (!(await control.count().catch(() => 0)) || !(await control.isVisible().catch(() => false))) {
      result.warnings.push(`Required GRO quoted-application control was not uniquely visible: ${purpose}.`);
      return;
    }
  }

  const serviceLabel = await controls.standardService.evaluate((control) => {
    const explicit = control.id ? document.querySelector(`label[for="${CSS.escape(control.id)}"]`)?.innerText || "" : "";
    return `${explicit} ${control.closest("tr")?.innerText || control.parentElement?.innerText || ""}`.replace(/\s+/g, " ").trim();
  });
  const standardAmount = extractPoundAmounts(serviceLabel)[0];
  if (!/^certificate\s+standard\b/i.test(serviceLabel) || !Number.isFinite(standardAmount)) {
    result.warnings.push("The standard-certificate service did not have the expected exact label and price; refused to select it.");
    return;
  }
  if (standardAmount > limit) {
    result.warnings.push(`The standard certificate price GBP ${standardAmount.toFixed(2)} exceeds the target cost guard GBP ${limit.toFixed(2)}.`);
    return;
  }

  const fill = async (control, value, purpose) => {
    await control.fill(String(value));
    result.filled.push({ type: "input", purpose, value: String(value) });
  };
  await fill(controls.surname, surname, "subject-surname");
  await fill(controls.forenames, forenames, "subject-forenames");
  if (marriage) {
    const spouse = splitPersonName(activeTarget.spouse);
    await fill(controls.spouseSurname, spouse.surname, "spouse-surname");
    await fill(controls.spouseForenames, spouse.forenames, "spouse-forenames");
  }
  await fill(controls.district, activeTarget.groDistrict || activeTarget.district, "gro-district");
  await fill(controls.volume, activeTarget.volume, "gro-volume");
  await fill(controls.pageNumber, activeTarget.page, "gro-page");
  await fill(controls.quantity, "1", "certificate-quantity");

  const quarterPatterns = quarterPatternsForQuotedApplication(activeTarget.quarter);
  const quarterOptions = await controls.quarter.locator("option").allTextContents();
  const quarterLabel = quarterOptions.find((option) => quarterPatterns.some((pattern) => pattern.test(option.trim())));
  if (!quarterLabel) {
    result.warnings.push(`No exact GRO quarter option matched ${activeTarget.quarter}.`);
    return;
  }
  await controls.quarter.selectOption({ label: quarterLabel });
  result.selected.push({ type: "select", purpose: "gro-quarter", option: quarterLabel.trim() });

  await controls.standardService.check();
  result.selected.push({
    type: "radio",
    purpose: "certificate-service",
    text: "Certificate Standard",
    amountGbp: standardAmount
  });
  await controls.delivery.selectOption({ label: "Post" });
  result.selected.push({ type: "select", purpose: "delivery-method", option: "Post" });
}

function quarterPatternsForQuotedApplication(quarter) {
  const value = String(quarter || "").toLowerCase();
  if (/mar|march|q1|1/.test(value)) return [/^(?:jan|january),?\s*(?:feb|february),?\s*(?:mar|march)$/i];
  if (/jun|june|q2|2/.test(value)) return [/^(?:apr|april),?\s*may,?\s*(?:jun|june)$/i];
  if (/sep|sept|september|q3|3/.test(value)) return [/^(?:jul|july),?\s*(?:aug|august),?\s*(?:sep|sept|september)$/i];
  if (/dec|december|q4|4/.test(value)) return [/^(?:oct|october),?\s*(?:nov|november),?\s*(?:dec|december)$/i];
  return [];
}

async function fillGroApplicationYear(page, targetYear) {
  if (!/app_select\.asp/i.test(page.url())) {
    return { ok: false, note: "The GRO registration-year helper only runs on app_select.asp." };
  }
  if (!/^\d{4}$/.test(String(targetYear || ""))) {
    return { ok: false, note: "The GRO registration-year helper requires a four-digit target year." };
  }

  const candidates = page.locator("input:not([type]), input[type='text'], input[type='number']");
  const count = await candidates.count().catch(() => 0);
  const safe = [];
  for (let index = 0; index < Math.min(count, 30); index += 1) {
    const control = candidates.nth(index);
    if (!(await control.isVisible().catch(() => false))) continue;
    const metadata = await control.evaluate((input) => {
      const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
      const explicit = input.id
        ? document.querySelector(`label[for="${CSS.escape(input.id)}"]`)?.innerText || ""
        : "";
      const context = clean([
        explicit,
        input.closest("tr")?.innerText || "",
        input.parentElement?.innerText || "",
        input.name || "",
        input.id || "",
        input.getAttribute("aria-label") || ""
      ].join(" "));
      return { name: input.name || "", id: input.id || "", context: context.slice(0, 240) };
    }).catch(() => null);
    if (!metadata) continue;
    if (/applicant|customer|card|billing|delivery|address|postcode|security|cvv|expiry|email|password|phone|telephone/i.test(metadata.context)) continue;
    if (/year\s+in\s+which\s+the\s+event\s+was\s+registered|year.*event.*registered|event.*registration.*year/i.test(metadata.context)) {
      safe.push({ control, metadata });
    }
  }

  if (safe.length !== 1) {
    return {
      ok: false,
      note: safe.length
        ? `Found ${safe.length} possible GRO registration-year inputs; refused to guess.`
        : "No uniquely labeled GRO registration-year input was found."
    };
  }

  const { control, metadata } = safe[0];
  await control.fill("");
  await control.pressSequentially(String(targetYear), { delay: 35 });
  await control.evaluate((input) => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.blur();
  });
  return {
    ok: true,
    type: "input",
    purpose: "registration-year",
    name: metadata.name,
    id: metadata.id,
    value: String(targetYear)
  };
}

async function trySafeNext(page, { allowSearch = true } = {}) {
  const text = await page.locator("body").innerText().catch(() => "");
  if (looksLikePaymentPage(text)) {
    return { ok: false, note: "This looks like a payment/final-review page. Use p and approve manually instead." };
  }

  const hasSearchResults = /\b\d+\s+Record\(s\)\s+Found\b/i.test(text) || /Select the button by an individual result/i.test(text);
  const actionPattern = hasSearchResults
    ? /continue|next|submit|add to basket|add to cart|proceed|save and continue|order|digital image|pdf|certificate/i
    : /continue|next|search|submit|add to basket|add to cart|proceed|save and continue/i;
  const candidateSelector = hasSearchResults || !allowSearch
    ? "button, input[type='button'], input[type='submit']"
    : "a, button, input[type='button'], input[type='submit']";
  const candidates = page.locator(candidateSelector);
  const count = await candidates.count().catch(() => 0);
  for (let index = 0; index < Math.min(count, 40); index += 1) {
    const candidate = candidates.nth(index);
    if (!(await candidate.isVisible().catch(() => false))) continue;
    const label = await controlText(candidate);
    if (!allowSearch && /search/i.test(label)) continue;
    if (/online ordering|main menu|logout|search the gro online index|data quality|my details|my orders|contact us|cookie policy|faq|how to order/i.test(label)) continue;
    if (hasSearchResults && /^search$/i.test(label.trim())) continue;
    if (!actionPattern.test(label)) continue;
    if (/pay|payment|submit payment|confirm payment|place order|complete order/i.test(label)) continue;
    await Promise.all([
      page.waitForLoadState("domcontentloaded").catch(() => {}),
      candidate.click().catch(() => null)
    ]);
    return { ok: true, clicked: label || `candidate-${index}`, url: page.url() };
  }
  return { ok: false, note: "No safe non-payment continue/add button found." };
}

async function fillByLabels(page, result, labelPatterns, value, { avoid }) {
  if (!value) return;
  for (const pattern of labelPatterns) {
    const labels = page.locator("label").filter({ hasText: pattern });
    const count = await labels.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const label = labels.nth(index);
      const labelText = await label.innerText().catch(() => "");
      if (avoid?.test(labelText)) {
        result.skipped.push({ label: labelText, reason: "avoid-pattern" });
        continue;
      }

      const forAttr = await label.getAttribute("for").catch(() => null);
      const control = forAttr ? page.locator(`#${cssEscape(forAttr)}`).first() : label.locator("input, textarea").first();
      if (!(await control.count().catch(() => 0))) continue;
      if (!(await control.isVisible().catch(() => false))) continue;
      const type = (await control.getAttribute("type").catch(() => "")) || "";
      if (/password|email|tel|checkbox|radio|submit|button|hidden/i.test(type)) continue;

      await control.fill(value).catch(() => null);
      result.filled.push({ label: labelText.trim(), value });
    }
  }
}

async function selectByLabels(page, result, labelPatterns, optionPatterns) {
  for (const pattern of labelPatterns) {
    const labels = page.locator("label").filter({ hasText: pattern });
    const count = await labels.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const label = labels.nth(index);
      const labelText = await label.innerText().catch(() => "");
      const forAttr = await label.getAttribute("for").catch(() => null);
      const select = forAttr ? page.locator(`#${cssEscape(forAttr)}`).first() : label.locator("select").first();
      if (!(await select.count().catch(() => 0))) continue;
      if (!(await select.isVisible().catch(() => false))) continue;

      for (const optionPattern of optionPatterns) {
        const options = select.locator("option").filter({ hasText: optionPattern });
        if (!(await options.count().catch(() => 0))) continue;
        const value = await options.first().getAttribute("value");
        if (value == null) continue;
        await select.selectOption(value).catch(() => null);
        result.selected.push({ label: labelText.trim(), option: optionPattern.toString() });
        break;
      }
    }
  }
}

async function fillLikelyInputsByName(page, result) {
  const { forenames, surname } = splitPersonName(activeTarget.person);
  const spouse = activeTarget.spouse ? splitPersonName(activeTarget.spouse) : null;
  const entries = [
    { match: /spouse.*surname|partner.*surname|other.*party.*surname|bride.*surname|groom.*surname/i, value: spouse?.surname },
    { match: /spouse.*forename|partner.*forename|other.*party.*forename|bride.*forename|groom.*forename/i, value: spouse?.forenames },
    { match: /surname|lastname|family/i, value: surname },
    { match: /forename|firstname|given|christian/i, value: forenames },
    { match: /year/i, value: activeTarget.year },
    { match: /district/i, value: activeTarget.district },
    { match: /volume|vol/i, value: activeTarget.volume },
    { match: /page/i, value: activeTarget.page }
  ];

  const inputs = page.locator("input:visible, textarea:visible");
  const count = await inputs.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const input = inputs.nth(index);
    const type = (await input.getAttribute("type").catch(() => "")) || "";
    const name = [
      await input.getAttribute("name").catch(() => ""),
      await input.getAttribute("id").catch(() => ""),
      await input.getAttribute("aria-label").catch(() => "")
    ].join(" ");

    if (/password|email|tel|checkbox|radio|submit|button|hidden/i.test(type)) continue;
    if (/applicant|customer|card|billing|delivery|address|postcode|security|cvv|expiry|email|password|phone|telephone/i.test(name)) continue;

    const entry = entries.find((candidate) => candidate.match.test(name));
    if (!entry?.value) continue;
    const existing = await input.inputValue().catch(() => "");
    if (existing && existing !== entry.value) continue;
    await input.fill(entry.value).catch(() => null);
    result.filled.push({ name: name.trim(), value: entry.value });
  }
}

async function fillGroIndexSearchPage(page, result) {
  if (!/indexes_search\.asp/i.test(page.url())) return;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await fillGroIndexSearchPageOnce(page, result);
      return;
    } catch (error) {
      if (!isNavigationRaceError(error)) throw error;
      result.warnings.push(`GRO changed the page while filling index fields; retry ${attempt}/3.`);
      await waitForPageSettled(page);
      if (!/indexes_search\.asp/i.test(page.url())) return;
    }
  }

  result.navigationUnstable = true;
  result.warnings.push("GRO kept changing pages during index field filling. Manual review is needed before continuing.");
}

async function fillGroIndexSearchPageOnce(page, result) {
  const radioResult = await page.evaluate((eventName) => {
    const wanted = String(eventName || "").toLowerCase();
    const controls = [...document.querySelectorAll("input[type='radio']")];
    const events = [];

    for (const control of controls) {
      const id = control.id ? `label[for="${CSS.escape(control.id)}"]` : "";
      const label = id ? document.querySelector(id)?.innerText || "" : "";
      const nearby = `${control.name || ""} ${control.id || ""} ${control.value || ""} ${label} ${control.parentElement?.innerText || ""}`.toLowerCase();
      if (nearby.includes(wanted)) {
        if (!control.checked) control.click();
        events.push({ type: "radio", name: control.name, id: control.id, value: control.value, label });
        break;
      }
    }

    return events;
  }, activeTarget.event);

  if (radioResult.length) result.selected.push(...radioResult);
  await waitForPageSettled(page, 750);
  await page.locator("select[name='Year']").waitFor({ state: "visible", timeout: 15_000 });

  const selectResult = await page.evaluate((target) => {
    const events = [];
    const selects = [...document.querySelectorAll("select")].filter((select) => {
      const style = window.getComputedStyle(select);
      return style && style.visibility !== "hidden" && style.display !== "none";
    });

    const setSelect = (select, predicate, label) => {
      const options = [...select.options];
      const option = options.find(predicate);
      if (!option) return false;
      select.value = option.value;
      option.selected = true;
      select.dispatchEvent(new Event("input", { bubbles: true }));
      select.dispatchEvent(new Event("change", { bubbles: true }));
      events.push({
        type: "select",
        name: select.name || "",
        id: select.id || "",
        option: option.text.trim() || option.value,
        purpose: label
      });
      return true;
    };

    for (const select of selects) {
      const options = [...select.options];
      if (options.some((option) => option.text.trim() === String(target.year) || option.value === String(target.year))) {
        setSelect(select, (option) => option.text.trim() === String(target.year) || option.value === String(target.year), "year");
      }
    }

    for (const select of selects) {
      const alreadySet = events.some((event) => event.name === (select.name || "") && event.id === (select.id || ""));
      if (alreadySet) continue;
      const selectName = `${select.name || ""} ${select.id || ""}`;
      const options = [...select.options];
      const hasZero = options.some((option) => option.text.trim() === "0" || option.value === "0");
      const smallNumeric = options.length <= 15 && options.every((option) => option.text.trim() === "Select" || /^-?\d+$/.test(option.text.trim()) || /^-?\d+$/.test(option.value));
      if (/range|year/i.test(selectName) && hasZero && smallNumeric) {
        const range = String(target.groIndexSearch?.yearRange ?? 0);
        setSelect(select, (option) => option.text.trim() === range || option.value === range, "year-range");
      }
    }

    return events;
  }, activeTarget);

  if (selectResult.length) result.selected.push(...selectResult);
  await waitForPageSettled(page, 750);
  await page.locator("input[name='Surname']").waitFor({ state: "visible", timeout: 15_000 });

  const detailResult = await page.evaluate((target) => {
    const events = [];
    const parts = String(target.person || "").trim().split(/\s+/);
    const spouseParts = String(target.spouse || "").trim().split(/\s+/).filter(Boolean);
    const surnameOnly = target.groIndexSearch?.surnameOnly === true;
    const surname = surnameOnly ? parts.at(-1) : parts.length > 1 ? parts.at(-1) : "";
    const forename = parts.length > 1 ? parts.slice(0, -1).join(" ") : parts[0] || "";
    const firstForename = forename.split(/\s+/)[0] || forename;
    const spouseSurname = spouseParts.length > 1 ? spouseParts.at(-1) : "";
    const spouseFirstForename = spouseParts.length > 1 ? spouseParts[0] : spouseParts[0] || "";
    const groDistrict = Object.prototype.hasOwnProperty.call(target, "groDistrict") ? target.groDistrict : target.district;
    const motherMaidenSurname = target.groMotherMaidenSurname || target.nationalIndex?.motherMaidenSurname || "";

    const visible = (element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style && style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };

    const setValue = (control, value, purpose) => {
      if (!control || value == null || value === "") return false;
      control.value = String(value);
      control.dispatchEvent(new Event("input", { bubbles: true }));
      control.dispatchEvent(new Event("change", { bubbles: true }));
      events.push({ type: control.tagName.toLowerCase(), name: control.name || "", id: control.id || "", value: String(value), purpose });
      return true;
    };

    const clearValue = (control, purpose) => {
      if (!control) return false;
      control.value = "";
      control.dispatchEvent(new Event("input", { bubbles: true }));
      control.dispatchEvent(new Event("change", { bubbles: true }));
      events.push({ type: control.tagName.toLowerCase(), name: control.name || "", id: control.id || "", value: "", purpose });
      return true;
    };

    const setOrClear = (control, value, purpose) => {
      if (value == null || value === "") return clearValue(control, `${purpose}-clear`);
      return setValue(control, value, purpose);
    };

    const controls = [...document.querySelectorAll("input[type='text'], input:not([type]), select")].filter(visible);
    const byIdOrName = (wanted) => controls.find((control) => {
      const id = String(control.id || "").toLowerCase();
      const name = String(control.name || "").toLowerCase();
      return id === wanted.toLowerCase() || name === wanted.toLowerCase();
    });
    const byRowText = (pattern, exclude = null) => controls.find((control) => {
      const rowText = (control.closest("tr")?.innerText || control.parentElement?.innerText || "").toLowerCase();
      return pattern.test(rowText) && (!exclude || !exclude.test(rowText));
    });

    setValue(byIdOrName("Surname") || byRowText(/surname.*birth|surname/), surname, "surname");
    const forenameControl = byIdOrName("Forename1") || byRowText(/first.*forename|forename/, /second/);
    if (surnameOnly) clearValue(forenameControl, "first-forename-clear");
    else setValue(forenameControl, firstForename, "first-forename");
    setOrClear(byIdOrName("District") || byRowText(/district.*birth|district/), groDistrict, "district");
    const setReference = target.groIndexSearch ? setOrClear : setValue;
    setReference(byIdOrName("Volume") || byRowText(/volume/), target.volume, "volume");
    setReference(byIdOrName("Page") || byRowText(/page/), target.page, "page");
    setValue(
      byIdOrName("SpouseSurname") || byIdOrName("PartnerSurname") || byRowText(/spouse.*surname|partner.*surname|other party.*surname|bride.*surname|groom.*surname/),
      spouseSurname,
      "spouse-surname"
    );
    setValue(
      byIdOrName("SpouseForename") || byIdOrName("PartnerForename") || byRowText(/spouse.*forename|partner.*forename|other party.*forename|bride.*forename|groom.*forename/),
      spouseFirstForename,
      "spouse-first-forename"
    );
    clearValue(byIdOrName("Forename2"), "second-forename-clear");
    if (motherMaidenSurname) {
      setValue(byIdOrName("MothersSurname"), motherMaidenSurname, "mother-maiden-surname");
    } else {
      clearValue(byIdOrName("MothersSurname"), "mother-maiden-surname-clear");
    }

    const selects = [...document.querySelectorAll("select")].filter(visible);
    const selectOption = (select, predicate, purpose) => {
      if (!select) return false;
      const option = [...select.options].find(predicate);
      if (!option) return false;
      select.value = option.value;
      option.selected = true;
      select.dispatchEvent(new Event("input", { bubbles: true }));
      select.dispatchEvent(new Event("change", { bubbles: true }));
      events.push({ type: "select", name: select.name || "", id: select.id || "", option: option.text.trim() || option.value, purpose });
      return true;
    };

    if (target.sex) {
      const sex = String(target.sex).trim().toLowerCase();
      const sexSelect = selects.find((select) => [...select.options].some((option) => /male|female|\bm\b|\bf\b/i.test(`${option.text} ${option.value}`)));
      selectOption(sexSelect, (option) => {
        const optionText = `${option.text} ${option.value}`.trim().toLowerCase();
        if (/^m(ale)?$/.test(sex)) return /^male$|^m$/i.test(option.text.trim()) || /^male$|^m$/i.test(option.value.trim());
        if (/^f(emale)?$/.test(sex)) return /^female$|^f$/i.test(option.text.trim()) || /^female$|^f$/i.test(option.value.trim());
        return optionText.includes(sex);
      }, "sex");
    }

    if (target.groIndexSearch) {
      for (const select of selects) {
        selectOption(select, (option) => /^exact(?: matches)?(?: only)?$/i.test(option.text.trim()), `match-mode-${select.name || select.id}`);
      }
    }
    const quarterSelect = byRowText(/quarter/);
    if (target.groIndexSearch && quarterSelect) clearValue(quarterSelect, "quarter-clear");
    const quarter = String(target.quarter || "").toLowerCase();
    selectOption(quarterSelect, (option) => {
      const optionText = `${option.text} ${option.value}`;
      if (/mar|march|q1|1/.test(quarter)) return /mar|march|q1|\b1\b/i.test(optionText);
      if (/jun|june|q2|2/.test(quarter)) return /jun|june|q2|\b2\b/i.test(optionText);
      if (/sep|sept|september|q3|3/.test(quarter)) return /sep|sept|september|q3|\b3\b/i.test(optionText);
      if (/dec|december|q4|4/.test(quarter)) return /dec|december|q4|\b4\b/i.test(optionText);
      return quarter ? optionText.toLowerCase().includes(quarter) : false;
    }, "quarter");

    return events;
  }, activeTarget);

  if (detailResult.length) {
    for (const event of detailResult) {
      if (event.type === "select") result.selected.push(event);
      else result.filled.push(event);
    }
  }
}

async function selectLikelySelectsByName(page, result) {
  const selects = page.locator("select:visible");
  const count = await selects.count().catch(() => 0);

  for (let index = 0; index < count; index += 1) {
    const select = selects.nth(index);
    const name = [
      await select.getAttribute("name").catch(() => ""),
      await select.getAttribute("id").catch(() => ""),
      await select.getAttribute("aria-label").catch(() => "")
    ].join(" ");

    const optionsText = await select.locator("option").allInnerTexts().catch(() => []);
    const hasTargetYear = optionsText.some((text) => text.trim() === activeTarget.year);
    const looksLikeYear = /year|yyyy|birth/i.test(name) || hasTargetYear;
    if (looksLikeYear && hasTargetYear) {
      await select.selectOption({ label: activeTarget.year }).catch(async () => {
        const option = select.locator("option").filter({ hasText: new RegExp(`^\\s*${escapeRegExp(activeTarget.year)}\\s*$`) }).first();
        const value = await option.getAttribute("value").catch(() => null);
        if (value != null) await select.selectOption(value).catch(() => null);
      });
      result.selected.push({ name: name.trim() || `select-${index}`, option: activeTarget.year });
      continue;
    }

    const looksLikeRange = /\+|-|range|within|year.*s/i.test(name);
    if (looksLikeRange && optionsText.some((text) => text.trim() === "0")) {
      await select.selectOption({ label: "0" }).catch(async () => {
        const option = select.locator("option").filter({ hasText: /^\s*0\s*$/ }).first();
        const value = await option.getAttribute("value").catch(() => null);
        if (value != null) await select.selectOption(value).catch(() => null);
      });
      result.selected.push({ name: name.trim() || `select-${index}`, option: "0" });
    }
  }
}

async function chooseByText(page, result, patterns) {
  for (const pattern of patterns) {
    const controls = page.locator("label, button, input[type='radio'] + label, input[type='checkbox'] + label").filter({ hasText: pattern });
    const count = await controls.count().catch(() => 0);
    if (!count) continue;

    for (let index = 0; index < Math.min(count, 3); index += 1) {
      const control = controls.nth(index);
      if (!(await control.isVisible().catch(() => false))) continue;
      const text = await control.innerText().catch(() => "");
      if (/payment|pay now|submit|confirm/i.test(text)) continue;
      await control.click({ trial: false }).catch(() => null);
      result.selected.push({ text: text.trim() || pattern.toString() });
      break;
    }
  }
}

async function acceptCookieBanners(page) {
  await tryClick(page, [
    { role: "button", name: /allow cookies/i },
    { role: "button", name: /accept cookies/i },
    { role: "button", name: /accept additional cookies/i },
    { role: "button", name: /hide cookie message/i },
    { selector: "button:has-text('Allow cookies')" },
    { selector: "button:has-text('Accept cookies')" }
  ]).catch(() => false);
}

async function tryDownloadOnlineView(page) {
  const result = { target: activeTarget.slug, clicked: [], savedAs: null, sha256: null, note: null };
  const candidates = page.getByRole("link").or(page.getByRole("button")).filter({
    hasText: /view online view|online view|download|view image|view record|jpeg|jpg|pdf/i
  });
  const count = await candidates.count().catch(() => 0);

  if (!count) {
    result.note = "No visible Online View or download control found.";
    await safeScreenshot(page, "resume-no-download-control");
    return result;
  }

  for (let index = 0; index < Math.min(count, 5); index += 1) {
    const candidate = candidates.nth(index);
    if (!(await candidate.isVisible().catch(() => false))) continue;
    const label = await candidate.innerText().catch(() => `candidate-${index}`);
    result.clicked.push(label.trim());

    const downloadPromise = page.waitForEvent("download", { timeout: 5000 }).catch(() => null);
    await candidate.click().catch(() => null);
    const download = await downloadPromise;
    if (!download) {
      await page.waitForLoadState("domcontentloaded", { timeout: 3000 }).catch(() => {});
      continue;
    }

    const suggested = sanitizeFilename(download.suggestedFilename() || `${activeTarget.slug}-gro-download`);
    const savePath = path.join(activePaths.downloadsDir, suggested);
    await download.saveAs(savePath);
    result.savedAs = savePath;
    result.sha256 = await sha256File(savePath);
    await writeJson(path.join(activePaths.downloadsDir, `${suggested}.metadata.json`), {
      downloadedAt: new Date().toISOString(),
      target: activeTarget,
      file: savePath,
      sha256: result.sha256,
      sourceUrl: page.url()
    });
    return result;
  }

  result.note = "Clicked candidate controls, but no download event was captured. Check the browser tab for a rendered image.";
  await safeScreenshot(page, "resume-download-not-captured");
  return result;
}

async function tryClick(page, candidates) {
  for (const candidate of candidates) {
    const locator = candidate.role
      ? page.getByRole(candidate.role, { name: candidate.name }).first()
      : page.locator(candidate.selector).first();
    if (!(await locator.count().catch(() => 0))) continue;
    if (!(await locator.isVisible().catch(() => false))) continue;
    await Promise.all([
      page.waitForLoadState("domcontentloaded").catch(() => {}),
      locator.click()
    ]);
    return true;
  }
  return false;
}

async function injectPanel(page, message) {
  const payload = { message, target: activeTarget, maxOrderCostGbp: costGuardLimitForTarget(activeTarget) };
  await page.evaluate((data) => {
    const existing = document.querySelector("#gro-helper-panel");
    if (existing) existing.remove();
    const panel = document.createElement("aside");
    panel.id = "gro-helper-panel";
    panel.style.cssText = [
      "position:fixed",
      "right:16px",
      "bottom:16px",
      "z-index:2147483647",
      "max-width:440px",
      "padding:14px 16px",
      "background:#111827",
      "color:#f9fafb",
      "font:14px/1.45 system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
      "border:2px solid #f59e0b",
      "border-radius:8px",
      "box-shadow:0 12px 32px rgba(0,0,0,.35)"
    ].join(";");
    panel.innerHTML = `
      <strong style="display:block;margin-bottom:6px;">GRO helper: ${escapeHtml(data.target.person)}</strong>
      <div style="margin-bottom:8px;">${escapeHtml(data.message)}</div>
      <dl style="display:grid;grid-template-columns:auto 1fr;gap:2px 10px;margin:0;">
        <dt>Event</dt><dd>${escapeHtml(data.target.event)} / ${escapeHtml(data.target.quarter || "")} ${escapeHtml(data.target.year || "")}</dd>
        <dt>District</dt><dd>${escapeHtml(data.target.district || "")}</dd>
        <dt>Vol/Page</dt><dd>${escapeHtml(data.target.volume || "")} / ${escapeHtml(data.target.page || "")}</dd>
        <dt>Local ref</dt><dd>${escapeHtml(data.target.localIndex?.reference || "n/a")}</dd>
        <dt>Cost guard</dt><dd>Warn above GBP ${Number(data.maxOrderCostGbp).toFixed(2)}</dd>
      </dl>
      <div style="margin-top:8px;color:#fde68a;">Card details stay in Chrome/payment manager. Handle any Chrome save-card prompt manually. Final payment requires exact typed confirmation.</div>
    `;
    document.body.append(panel);

    function escapeHtml(value) {
      return String(value).replace(/[&<>"']/g, (char) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      })[char]);
    }
  }, payload).catch(() => {});
}

async function checkCostGuard(page) {
  const text = await page.locator("body").innerText().catch(() => "");
  const amounts = extractPoundAmounts(text);
  const maxAmount = amounts.length ? Math.max(...amounts) : null;
  const guardLimit = costGuardLimitForTarget(activeTarget);
  return {
    maxOrderCostGbp: guardLimit,
    amounts,
    warning: maxAmount != null && maxAmount > guardLimit
      ? `Largest detected amount GBP ${maxAmount.toFixed(2)} exceeds target cost guard GBP ${guardLimit.toFixed(2)}.`
      : null
  };
}

async function summarizePaymentState(page) {
  const url = page.url();
  const text = await page.locator("body").innerText().catch(() => "");
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const interesting = lines.find((line) =>
    /success|successful|thank you|complete|completed|receipt|declined|failed|failure|cancelled|canceled|expired|authentication|verification|authoris/i.test(line)
  );

  return {
    url,
    summary: interesting || "",
    finished: /gro\.gov\.uk\/gro\/content\/certificates\/check_out\.asp/i.test(url) ||
      /success|successful|thank you|order complete|order completed|receipt|declined|failed|failure|cancelled|canceled|expired/i.test(text)
  };
}

async function safeScreenshot(page, name) {
  const file = path.join(activePaths.screenshotsDir, `${runId}-${sanitizeFilename(name)}.png`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await page.screenshot({ path: file, fullPage: true }).catch(() => null);
  return file;
}

async function waitForPageSettled(page, timeout = 1000) {
  await page.waitForLoadState("domcontentloaded", { timeout }).catch(() => {});
  await page.waitForTimeout(timeout).catch(() => {});
}

function isNavigationRaceError(error) {
  const message = String(error?.message || error || "");
  return /execution context was destroyed|most likely because of a navigation|cannot find context|target page, context or browser has been closed/i.test(message);
}

async function setActiveTarget(target) {
  activeTarget = normalizeTarget(target);
  activePaths = pathsForTarget(activeTarget);
  await ensureTargetDirs();
  await writeJson(path.join(activePaths.evidenceRoot, "target-record.json"), {
    updatedAt: new Date().toISOString(),
    officialStartUrl,
    groFallbackUrl,
    target: activeTarget
  });
}

function pathsForTarget(target) {
  const evidenceRoot = path.join(projectRoot, "evidence", "gro", target.slug || slugify(target.person || "target"));
  return {
    evidenceRoot,
    screenshotsDir: path.join(evidenceRoot, "screenshots"),
    downloadsDir: path.join(evidenceRoot, "downloads"),
    runsDir: path.join(evidenceRoot, "runs")
  };
}

async function ensureTargetDirs() {
  await fs.mkdir(activePaths.screenshotsDir, { recursive: true });
  await fs.mkdir(activePaths.downloadsDir, { recursive: true });
  await fs.mkdir(activePaths.runsDir, { recursive: true });
}

function createRunMeta(runMode) {
  return {
    runId,
    mode: runMode,
    startedAt: new Date().toISOString(),
    officialStartUrl,
    target: activeTarget,
    steps: []
  };
}

async function writeRun(run) {
  run.updatedAt = new Date().toISOString();
  await writeJson(path.join(activePaths.runsDir, `${run.runId}-${run.mode}.json`), run);
}

async function loadSingleTarget() {
  const targetArg = getArgValue("--target");
  if (!targetArg) throw new Error("Pass --target <acquisition target JSON> (or --queue <queue file>); there is no default order.");

  const targetPath = path.resolve(projectRoot, targetArg);
  const raw = await fs.readFile(targetPath, "utf8").catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (raw != null) return JSON.parse(raw);

  if (!/^[a-z0-9][a-z0-9-]{0,127}$/.test(targetArg)) {
    throw new Error(`GRO --target must be a target JSON path or a safe queue slug: ${targetArg}`);
  }
  const queue = await loadTargetsFromFile(path.join(projectRoot, "evidence", "gro", "order-queue.json"));
  const target = queue.find((candidate) => candidate.slug === targetArg);
  if (!target) throw new Error(`No GRO order-queue target has slug ${targetArg}.`);
  return target;
}

async function loadTargetsFromFile(queuePath) {
  const resolved = path.resolve(projectRoot, queuePath);
  const raw = await fs.readFile(resolved, "utf8");
  const parsed = JSON.parse(raw);
  const targets = Array.isArray(parsed) ? parsed : parsed.targets;
  if (!Array.isArray(targets)) throw new Error(`Queue file must be an array or an object with a targets array: ${resolved}`);
  return targets.map(normalizeTarget);
}

function normalizeTarget(target) {
  const merged = { ...target };
  if (!merged.person) throw new Error("GRO target is missing person.");
  if (!merged.event) merged.event = "birth";
  if (!merged.country) merged.country = "England and Wales";
  if (!merged.slug) merged.slug = slugify(`${merged.person}-${merged.year || ""}-${merged.event}`);
  groIndexSearchBounds(merged, mode);
  return merged;
}

function isPaidTargetPaused(target) {
  return target.readyForPaidOrder === false || /^paused\b/i.test(String(target.orderStatus || ""));
}

function paidTargetPauseReason(target) {
  return target.pauseReason || target.orderStatus || "readyForPaidOrder is false";
}

function splitPersonName(person) {
  const parts = String(person).trim().split(/\s+/);
  if (parts.length === 1) return { forenames: parts[0], surname: "" };
  return { forenames: parts.slice(0, -1).join(" "), surname: parts.at(-1) };
}

function quarterPatterns(quarter) {
  const value = String(quarter || "").toLowerCase();
  if (/jun|june|q2|2/.test(value)) return [/jun/i, /june/i, /2/i, /q2/i];
  if (/mar|march|q1|1/.test(value)) return [/mar/i, /march/i, /1/i, /q1/i];
  if (/sep|sept|september|q3|3/.test(value)) return [/sep/i, /sept/i, /september/i, /3/i, /q3/i];
  if (/dec|december|q4|4/.test(value)) return [/dec/i, /december/i, /4/i, /q4/i];
  return [new RegExp(value || "jun", "i")];
}

function serviceOptionPatterns(target) {
  const service = `${target.serviceOption || ""} ${target.event || ""}`;
  if (/marriage|certificate|standard/i.test(service) && !/digital|online[\s-]*view|pdf/i.test(service)) {
    return [/standard.*certificate/i, /full.*certificate/i, /\bcertificate\b/i];
  }
  if (/online[\s-]*view/i.test(service)) return [/online[\s-]*view/i];
  if (/pdf/i.test(service)) return [/\bpdf\b/i];
  return [/online[\s-]*view/i, /digital image/i];
}

function costGuardLimitForTarget(target = activeTarget) {
  const estimated = Number(target.estimatedCostGbp);
  const estimatedLimit = Number.isFinite(estimated) && estimated > 0 ? estimated + 0.5 : 0;
  return Math.max(maxOrderCostGbp, estimatedLimit || maxOrderCostGbp);
}

function panelMessage(loopMode) {
  if (loopMode === "resume") return "Resume mode: use d once the Online View image or order history is visible.";
  return "Use a to auto-drive safe steps, f/n for manual control, and p at payment/final review for exact-confirm submit.";
}

async function printCommandHelp(loopMode) {
  console.log("");
  console.log(`${loopMode[0].toUpperCase()}${loopMode.slice(1)} mode is ready for ${describeTarget(activeTarget)}.`);
  console.log("Commands:");
  if (loopMode !== "resume") {
    console.log("  a  auto-drive safe login/order steps until manual input or payment is required");
    console.log("  f  try to autofill known record fields on the current page");
    console.log("  n  click a safe non-payment Continue/Add button");
    console.log("  p  payment checkpoint: type exact confirmation to submit, or handle/cancel manually");
  }
  if (loopMode === "resume") console.log("  d  try to click a visible View/Download Online View image control");
  console.log("  i  inspect safe page structure (URLs, headings, links, and radio labels only)");
  console.log("  s  save a screenshot");
  console.log("  q  quit");
}

function describeTarget(target) {
  return `${target.person}, ${target.event}, ${target.quarter || ""} ${target.year || ""}, ${target.district || "unknown district"}, vol ${target.volume || "?"} page ${target.page || "?"}`.replace(/\s+/g, " ").trim();
}

function paymentConfirmationPhrase(target) {
  return `PAY ${target.slug}`;
}

async function controlText(locator) {
  const text = (await locator.innerText().catch(() => "")).trim();
  if (text) return text;
  const value = ((await locator.getAttribute("value").catch(() => "")) || "").trim();
  if (value) return value;
  const aria = ((await locator.getAttribute("aria-label").catch(() => "")) || "").trim();
  if (aria) return aria;
  const title = ((await locator.getAttribute("title").catch(() => "")) || "").trim();
  if (title) return title;
  return "";
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(sanitizeLogValue(value), null, 2)}\n`, "utf8");
}

function sanitizeLogValue(value) {
  if (typeof value === "string") return /^https?:\/\//i.test(value) ? sanitizeUrl(value) : value;
  if (Array.isArray(value)) return value.map(sanitizeLogValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, sanitizeLogValue(entry)]));
}

function sanitizeUrl(value) {
  try {
    const parsed = new URL(value);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return "[invalid-url]";
  }
}

async function askQuestion(prompt, defaultValue) {
  try {
    return await rl.question(prompt);
  } catch (error) {
    if (error?.code === "ERR_USE_AFTER_CLOSE") return defaultValue;
    throw error;
  }
}

async function sha256File(file) {
  const hash = createHash("sha256");
  const data = await fs.readFile(file);
  hash.update(data);
  return hash.digest("hex");
}

function looksLikePaymentPage(text) {
  return /card number|security code|cvv|expiry date|pay now|submit payment|confirm payment|worldpay|payment details|place order|complete order/i.test(text);
}

function extractPoundAmounts(text) {
  const amounts = [];
  const regex = /£\s*([0-9]+(?:\.[0-9]{1,2})?)/g;
  for (const match of text.matchAll(regex)) {
    const amount = Number(match[1]);
    if (Number.isFinite(amount)) amounts.push(amount);
  }
  return [...new Set(amounts)].sort((a, b) => b - a);
}

function sanitizeFilename(value) {
  return String(value).replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase();
}

function slugify(value) {
  return sanitizeFilename(value).replace(/[._]+/g, "-") || "gro-target";
}

function cssEscape(value) {
  return String(value).replace(/(["\\#.;:[\],>+~*^$|=! ])/g, "\\$1");
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isWsl() {
  return Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP);
}

function getArgValue(name) {
  const index = argv.indexOf(name);
  if (index === -1) return null;
  return argv[index + 1] && !argv[index + 1].startsWith("--") ? argv[index + 1] : null;
}

function newRunId() {
  return new Date().toISOString().replaceAll(":", "-").replace(/\.\d{3}Z$/, "Z");
}

async function loadDotEnv(file) {
  const raw = await fs.readFile(file, "utf8").catch(() => null);
  if (!raw) return;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] != null) continue;
    process.env[key] = rawValue.replace(/^['"]|['"]$/g, "");
  }
}

function rejectRawPaymentEnv() {
  const forbidden = Object.keys(process.env).filter((key) => /CARD|CVV|CVC|PAN|PAYMENT/i.test(key));
  const unsafe = forbidden.filter((key) => !/^MAX_ORDER_COST_GBP$/.test(key));
  if (unsafe.length) {
    throw new Error(
      `Refusing to run with raw payment-looking env var(s): ${unsafe.join(", ")}.\n` +
      "Use Chrome, Google Pay, or a password manager for card autofill. Do not put card details in .env."
    );
  }
}

function printHelp() {
  console.log(`
GRO assisted order tool

Usage:
  node tools/gro-order-frank.mjs --profile
  node tools/gro-order-frank.mjs --dry-run [--target path/to/target.json]
  node tools/gro-order-frank.mjs --index --target path/to/target.json
  node tools/gro-order-frank.mjs --order [--target path/to/target.json]
  node tools/gro-order-frank.mjs --queue evidence/gro/order-queue.json
  node tools/gro-order-frank.mjs --resume [--target path/to/target.json]

Options:
  --shared-window --endpoint http://127.0.0.1:9226 --affinity-slot <stable-slot>
              Required shared Windows Chrome/CDP binding; the wrapper supplies these.

Safety:
  The script opens the official GOV.UK/GRO flow, records screenshots/metadata,
  and can try to fill known record fields. It refuses raw card env vars, does
  not read card details, and only clicks final payment after exact typed
  confirmation at the payment checkpoint. Queue targets marked
  readyForPaidOrder: false or orderStatus: paused-* are skipped. Standalone,
  WSL, separate-profile, and headless browser launches are disabled; use
  tools/gro-windows.ps1 so GRO receives one background task tab in the sole
  shared Windows Chrome window.
`);
}
