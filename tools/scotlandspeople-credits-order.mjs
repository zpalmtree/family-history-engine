#!/usr/bin/env node

// ScotlandsPeople credit purchase for one authorized request.
//
//   npm run pay:win -- -Request <request-id> -ScotlandsPeopleCredits [-Inspect]
//   node tools/scotlandspeople-credits-order.mjs --request <request-id> --explore
//
// ScotlandsPeople (scotlandspeople.gov.uk) sells images for credits, and
// credits only in bundles: 30 for GBP 7.50 is the smallest (read from the
// signed-in Buy credits page, 20 Nov 2026). The reviewed bundle for a request
// comes from `scotlandsPeopleCreditSpecs`. The basket must hold exactly that
// one bundle, once, before "Checkout".
//
// The checkout has three steps on the site itself: Billing, Review, Complete.
// The billing address is the user's own: Chrome's saved address fills it, or
// the user does in the revealed tab; this driver never reads or types it. From
// the review step the site hands the browser to its payment page, where the
// guarded saved-card helper takes over. Until that payment host has been
// observed and reviewed into the checkout profiles, the driver only reports
// what it is and stops.
//
// --inspect checks the basket and stops before "Checkout". --explore goes on
// through billing and review without any authorization and reports the review
// page and the payment page it leads to; it never touches a payment page.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { payOnCheckout } from "./guarded-card-payment.mjs";
import { amountGuard, authorizedPayment, checkoutHostAllowed, checkoutProfileFor } from "./payment-policy.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const service = "https://www.scotlandspeople.gov.uk";
const serviceHost = new URL(service).hostname;

// One reviewed bundle per request.
export const scotlandsPeopleCreditSpecs = Object.freeze({
  // The Dundee baptism of Isabel McDonald, 27 April 1797 (OPR 282, ref 80/176),
  // costs 6 credits to view; the smallest bundle on sale is 30 credits.
  "scotlandspeople-isabel-mcdonald-baptism-dundee-1797": Object.freeze({ bundle: "30 credits", price: 7.5 })
});

const pounds = (amount) => `£${amount.toFixed(2)}`;

// The basket may hold exactly the one reviewed bundle, once, and total its price.
export function basketProblem(basket, spec) {
  const rows = basket?.rows || [];
  if (rows.length !== 1) return `the basket holds ${rows.length} line(s), not exactly one`;
  const [row] = rows;
  if (row.item !== spec.bundle) return "the basket's line is not the reviewed bundle";
  if (row.quantity !== "1") return `the basket holds the bundle ${row.quantity || "an unread number of"} times, not once`;
  if (row.price !== pounds(spec.price) || row.lineTotal !== pounds(spec.price)) return "the bundle's price is not the reviewed price";
  if (basket.total !== pounds(spec.price)) return "the basket total is not the reviewed price";
  return null;
}

// The one control that moves a checkout step forward. "Go back", basket and
// coupon controls never count; more than one candidate is refused.
export function forwardControl(labels) {
  const forward = labels.filter((label) => !/^(?:go )?back\b|basket|remove|update|apply|cancel/i.test(label));
  return forward.length === 1 ? forward[0] : null;
}

// The review step may be left only through a control that plainly pays or
// continues to payment.
export function reviewControlAllowed(label) {
  return /^(?:pay and complete purchase|continue to payment|proceed to payment|pay now|complete purchase)$/i.test(String(label || "").trim());
}

async function settle(page, ms = 2_500) {
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await page.waitForTimeout(ms);
}

const onService = (page) => {
  try { return new URL(page.url()).hostname === serviceHost; } catch { return false; }
};
const checkoutStep = (page) => (/^\/checkout\/\d+\/([a-z_]+)/.exec(new URL(page.url()).pathname) || [])[1] || "";
const signedIn = async (page) => (await page.locator('a[href="/my-account"]').count()) > 0;

// One step of the account helper in this exact tab. It enters the account's
// sign-in name or its stored password itself; neither passes through here.
async function accountStep(page, mode, selector) {
  const session = await page.context().newCDPSession(page);
  const { targetInfo } = await session.send("Target.getTargetInfo");
  await session.detach().catch(() => {});
  execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(projectRoot, "tools", "site-account-windows.ps1"),
    "-Mode", mode, "-Site", "scotlandspeople", "-TargetId", targetInfo.targetId, "-ExpectedHost", serviceHost, "-InputSelectors", selector],
  { stdio: ["ignore", "ignore", "inherit"], timeout: 60_000 });
}

// Signs the account in with its stored password (the account was registered
// at the user's request on 20 Nov 2026; AGENTS.md, 13 Nov 2026).
async function signIn(page) {
  await page.goto(`${service}/user/login`, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await settle(page, 1_500);
  await accountStep(page, "fill-account-email", "#edit-name");
  await accountStep(page, "fill-password", "#edit-pass");
  await page.locator("#user-login-form #edit-submit").click();
  await settle(page, 4_000);
  if (!(await signedIn(page))) throw new Error("ScotlandsPeople did not sign in with the stored password; nothing was ordered.");
}

async function readBasket(page) {
  await page.goto(`${service}/cart`, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await settle(page, 1_500);
  if (!(await signedIn(page))) {
    await signIn(page);
    await page.goto(`${service}/cart`, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await settle(page, 1_500);
  }
  return page.evaluate(() => {
    const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const main = document.querySelector("main") || document.body;
    const rows = [...main.querySelectorAll("table tbody tr")].map((row) => {
      const cells = [...row.querySelectorAll("td")].map((cell) => clean(cell.innerText));
      return { item: cells[0] || "", price: cells[1] || "", quantity: (row.querySelector('input[type=number], input[name*="quantity"]') || {}).value || "", lineTotal: cells.at(-1) || "" };
    });
    const total = /Total:\s*(£[0-9]+\.[0-9]{2})/.exec(clean(main.innerText.replace(/Subtotal:\s*£[0-9.]+/g, "")));
    return { rows, total: total ? total[1] : "" };
  });
}

async function addBundle(page, spec) {
  await page.goto(`${service}/buy-credits`, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await settle(page, 1_500);
  const buttons = page.locator("main button[type=submit]").filter({ hasText: new RegExp(`^\\s*Buy ${spec.bundle}\\s*$`, "i") });
  if (await buttons.count() !== 1) throw new Error(`The Buy credits page offers ${await buttons.count()} "${spec.bundle}" control(s), not exactly one; nothing was ordered.`);
  await buttons.first().click();
  await settle(page, 3_000);
}

// Required billing fields that are still empty or invalid, by label only.
const emptyBillingFields = (page) => page.evaluate(() => [...document.querySelectorAll('main [name^="payment_information[billing_information]"]')]
  .filter((element) => element.offsetParent && element.required && (element.matches(":invalid") || !String(element.value || "").trim()))
  .map((element) => { const label = element.id && document.querySelector(`label[for="${element.id}"]`); return (label ? label.innerText : element.name).replace(/\s+/g, " ").trim(); }));

const visibleSubmitLabels = (page) => page.evaluate(() => [...document.querySelectorAll("main button, main input[type=submit], main a.button, main a.btn")]
  .filter((element) => element.offsetParent && !element.disabled)
  .map((element) => (element.innerText || element.value || "").replace(/\s+/g, " ").trim()).filter(Boolean));

const submitByLabel = (page, label) => page.locator("main button, main input[type=submit], main a.button, main a.btn")
  .filter({ hasText: new RegExp(`^\\s*${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i") }).first();

// The billing step. The address is the user's own: Chrome's saved address is
// offered from the first name field once the window has focus; whatever it
// leaves empty is the user's to complete in the revealed tab.
async function completeBilling(page, task, log) {
  if (!(await emptyBillingFields(page)).length) return;
  const first = page.locator('main input[name$="[given_name]"]').first();
  const focused = () => page.evaluate(() => document.hasFocus()).catch(() => false);
  await page.bringToFront().catch(() => {});
  if (!(await focused())) {
    await task.showForManualStep("your billing address on the ScotlandsPeople checkout");
    log("Click into the shared Chrome window; your saved address is chosen once it has focus.");
    const focusDeadline = Date.now() + 300_000;
    while (Date.now() < focusDeadline && !(await focused())) await page.waitForTimeout(1_000);
  }
  if (await focused()) {
    await first.click({ timeout: 5_000 });
    await page.waitForTimeout(600);
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(1_200);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1_500);
  }
  let empty = await emptyBillingFields(page);
  if (empty.length) {
    await task.showForManualStep("your billing address on the ScotlandsPeople checkout");
    log(`Complete the billing address in the revealed tab (${empty.length} required field(s) still empty: ${empty.join(", ")}); the checkout continues when it is complete.`);
    const deadline = Date.now() + 600_000;
    while (Date.now() < deadline && onService(page) && checkoutStep(page) === "billing" && (empty = await emptyBillingFields(page)).length) await page.waitForTimeout(1_500);
    if (empty.length && checkoutStep(page) === "billing") throw new Error("The billing address was not completed; nothing was ordered.");
  }
}

async function main() {
  const { chromium } = await import("playwright-core");
  const { openSharedChromeTask, sharedChromeEndpoint } = await import("./shared-chrome-task.mjs");
  const requestId = valueAfter("--request");
  const inspect = process.argv.includes("--inspect");
  const explore = process.argv.includes("--explore");
  const spec = scotlandsPeopleCreditSpecs[requestId];
  if (!spec) throw new Error(`${requestId} has no reviewed ScotlandsPeople credit purchase.`);
  // The request exists once the user has typed its PAY phrase; before that only
  // --inspect and --explore may run, against the provider alone.
  const requestPath = path.join(projectRoot, "evidence", "acquisition", "requests", `${requestId}.json`);
  if (!fs.existsSync(requestPath) && !inspect && !explore) throw new Error(`${requestId} has no recorded PAY authorization; nothing was ordered.`);
  const request = fs.existsSync(requestPath) ? JSON.parse(fs.readFileSync(requestPath, "utf8")) : { id: requestId, provider: "ScotlandsPeople" };
  // No profile exists until the payment host has been observed and reviewed.
  let profile = null;
  try { profile = checkoutProfileFor(request); } catch { profile = null; }
  const expected = { amount: spec.price, currency: "GBP" };
  if (!inspect && !explore) {
    const authorization = authorizedPayment(request);
    if (authorization.currency !== "GBP" || spec.price > authorization.amount) {
      throw new Error(`The bundle costs GBP ${spec.price.toFixed(2)}; the approval covers ${authorization.currency} ${authorization.amount}. Nothing was ordered.`);
    }
  }
  const log = (message) => console.error(message);

  const task = await openSharedChromeTask({ chromium, endpoint: sharedChromeEndpoint, taskLabel: `scotlandspeople-credits-${requestId}`, affinitySlot: "scotlandspeople-order", reconnectExisting: true, timeoutMs: 20_000 });
  let keepOpen = false;
  try {
    const page = task.page;
    // A run that already reached the reviewed payment page resumes there.
    const onPaymentPage = () => Boolean(profile) && checkoutHostAllowed(profile, page.url());
    if (!onPaymentPage()) {
      // A parked run that stopped on the billing or review step continues from
      // there, so an address the user has entered is not thrown away. The review
      // step still checks the bundle and every amount before going on.
      const resumed = !inspect && onService(page) && ["billing", "review"].includes(checkoutStep(page));
      if (resumed) console.log(JSON.stringify({ stage: "resumed", step: checkoutStep(page) }));
      else {
        let basket = await readBasket(page);
        if (!basket.rows.length) {
          await addBundle(page, spec);
          basket = await readBasket(page);
        }
        const problem = basketProblem(basket, spec);
        if (problem) throw new Error(`ScotlandsPeople basket: ${problem}; nothing was ordered.`);
        console.log(JSON.stringify({ stage: "basket", bundle: spec.bundle, total: basket.total }));
        if (inspect) return;

        await page.locator("#edit-checkout").click();
        await settle(page, 3_000);
        if (!onService(page) || !checkoutStep(page)) throw new Error("Checkout did not open the ScotlandsPeople checkout; nothing was ordered.");
      }
      if (checkoutStep(page) === "billing") {
        await completeBilling(page, task, log);
        if (checkoutStep(page) === "billing") {
          const next = forwardControl(await visibleSubmitLabels(page));
          if (next !== "Continue") { keepOpen = true; throw new Error("The billing step's Continue control was not found; nothing was ordered."); }
          await submitByLabel(page, next).click();
          // The step can take a while to answer on a busy machine.
          const stepDeadline = Date.now() + 25_000;
          while (Date.now() < stepDeadline && onService(page) && checkoutStep(page) === "billing") await page.waitForTimeout(1_000);
          await settle(page, 2_000);
        }
        if (checkoutStep(page) === "billing") {
          keepOpen = true;
          // What the page objects to, by its own messages and field labels only.
          const objection = await page.evaluate(() => {
            const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
            const messages = [...document.querySelectorAll('main [role="alert"], main .messages, main .form-item--error-message, main .invalid-feedback, main .error')]
              .filter((element) => element.offsetParent).map((element) => clean(element.innerText).slice(0, 200)).filter(Boolean);
            const flagged = [...document.querySelectorAll('main [name^="payment_information"]')]
              .filter((element) => element.offsetParent && (element.matches(".error, [aria-invalid=true], :invalid") || (element.required && !String(element.value || "").trim())))
              .map((element) => { const label = element.id && document.querySelector(`label[for="${element.id}"]`); return clean(label ? label.innerText : element.name); });
            return { messages: [...new Set(messages)].slice(0, 6), flagged: [...new Set(flagged)] };
          });
          console.log(JSON.stringify({ stage: "billing", status: "not-accepted", ...objection }));
          throw new Error("ScotlandsPeople did not accept the billing step; nothing was ordered.");
        }
      }
      if (checkoutStep(page) !== "review") { keepOpen = true; throw new Error(`The checkout is on an unexpected step (${checkoutStep(page) || new URL(page.url()).pathname}); nothing was ordered.`); }

      const reviewText = await page.locator("main").innerText();
      const guard = amountGuard(reviewText, expected, 0);
      const labels = await visibleSubmitLabels(page);
      const next = forwardControl(labels);
      console.log(JSON.stringify({ stage: "review", amounts: guard.amounts, amountsOk: guard.ok, controls: labels, forward: next, holdsBundle: reviewText.includes(spec.bundle) }));
      if (!guard.ok) { keepOpen = true; throw new Error(`Review step refused: ${guard.reason}; nothing was ordered.`); }
      if (!reviewText.includes(spec.bundle)) { keepOpen = true; throw new Error("The review step does not show the reviewed bundle; nothing was ordered."); }
      if (!reviewControlAllowed(next)) { keepOpen = true; throw new Error(`The review step's forward control (${next || "none or several"}) is not a reviewed one; nothing was ordered.`); }
      await submitByLabel(page, next).click();
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline && onService(page) && checkoutStep(page) === "review") await page.waitForTimeout(1_000);
      await settle(page, 3_000);
    }

    // The payment page. Until its host has been observed and reviewed into the
    // checkout profiles, this only reports what it is.
    if (explore || !onPaymentPage()) {
      const url = new URL(page.url());
      const report = await page.evaluate(() => ({
        title: document.title,
        frames: [...document.querySelectorAll("iframe")].map((frame) => { try { return new URL(frame.src).hostname; } catch { return ""; } }).filter(Boolean),
        controls: [...document.querySelectorAll("button, input[type=submit], a.button, a.btn")].filter((element) => element.offsetParent)
          .map((element) => (element.innerText || element.value || "").replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 12),
        cardFields: [...document.querySelectorAll('input[autocomplete~="cc-number"], input[name*="card" i][name*="number" i], input[id*="card" i][id*="number" i]')].filter((element) => element.offsetParent).length,
        summary: (document.body.innerText || "").replace(/\s+/g, " ").trim().slice(0, 400)
      }));
      keepOpen = true;
      console.log(JSON.stringify({ stage: "payment-page", status: explore ? "explored" : "needs-reviewed-profile", host: url.hostname, path: url.pathname, ...report }));
      return;
    }
    const outcome = await payOnCheckout(page, { requestId, task, fromDriver: profile.id });
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
