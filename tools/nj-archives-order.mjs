#!/usr/bin/env node

// New Jersey State Archives online copy order for one authorized request.
//
//   npm run pay:win -- -Request <request-id> -NjArchivesOrder [-Inspect]
//
// The Archives sells copies through its own database portal: a record is
// selected from a search result into a cart, the cart's "Electronic Checkout"
// asks for the requester's contact details, and "Continue Checkout" hands the
// browser to the State's payment site, where card payment adds a 2.3%
// transaction fee and a USD 0.50 convenience fee (read on the cart page,
// 19 Nov 2026). The record searched for and its exact reference come from the
// reviewed `njOrderSpecs` below. The requester's contact details are the
// user's own: Chrome's saved address fills them, or the user does, and this
// driver never types, reads or prints them. Payment is the guarded saved-card
// helper's, on the reviewed payment host only. --inspect builds the cart and
// stops at the contact form without entering anything; --no-manual goes on only
// if Chrome's saved address completes the form, and otherwise stops quietly
// instead of revealing the tab for the user.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { inspectCheckout, payOnCheckout } from "./guarded-card-payment.mjs";
import { authorizedPayment, checkoutHostAllowed, inspectionBasis } from "./payment-policy.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const portal = "https://wwwdnet-dos.nj.gov/DOS_ArchivesDBPortal/";
const portalHost = "wwwdnet-dos.nj.gov";

// One entry per request. The search terms are the public index entry; the
// reference is the Archives' own, matched exactly in the result and the cart.
export const njOrderSpecs = Object.freeze({
  "new-jersey-west-jersey-liber-aaa-p194-thomas-mercer-1701": Object.freeze({
    database: "EarlyLandRecords.aspx",
    search: Object.freeze({ txtLN: "Mercer", txtFN: "Thomas", EYear: "1700", LYear: "1702" }),
    rowMatch: /Mercer, Thomas \(Grantor\)[\s\S]*John Haynes[\s\S]*27 Feb 1701/,
    reference: "AAA (WJ) : Folio 194 (SSTSE023)",
    fee: 5
  })
});

// What the Archives' cart page says a card payment costs.
export function njCardTotal(fee) {
  const cents = Math.round(fee * 100);
  return (cents + Math.round(cents * 0.023) + 50) / 100;
}

// The cart may hold exactly the one reviewed record at its listed fee.
export function cartProblem(cartRows, spec) {
  if (cartRows.length !== 1) return `the cart holds ${cartRows.length} record(s), not exactly one`;
  if (!cartRows[0].includes(spec.reference)) return "the cart's record is not the reviewed reference";
  if (!new RegExp(`\\$\\s?${spec.fee}(?:\\.00)?\\b`).test(cartRows[0])) return `the cart's record is not priced at USD ${spec.fee}`;
  return null;
}

const field = (name) => `#ctl00_ContentPlaceHolder1_${name}`;

async function settle(page) {
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await page.waitForTimeout(2_500);
}

async function cartRows(page) {
  return page.evaluate(() => [...document.querySelectorAll("tr")].filter((row) => !row.querySelector("tr") && [...row.querySelectorAll("a")].some((link) => link.innerText.trim() === "Remove"))
    .map((row) => row.innerText.replace(/\s+/g, " ").trim()));
}

// Whether every required contact field is filled, judged inside the page and
// returned as field names only. No value leaves the page.
async function emptyContactFields(page) {
  return page.evaluate(() => ["txtFirstName", "txtLastName", "txtStreetAddress1", "txtCity", "ddlCountryList", "ddlState", "txtZip", "txtPhone", "txtEmail"]
    .filter((name) => {
      const element = document.getElementById(`ctl00_ContentPlaceHolder1_${name}`);
      if (!element) return true;
      return element.tagName === "SELECT" ? element.selectedIndex <= 0 && !element.value : !element.value.trim();
    }));
}

async function main() {
  const { chromium } = await import("playwright-core");
  const { openSharedChromeTask, sharedChromeEndpoint } = await import("./shared-chrome-task.mjs");
  const requestId = valueAfter("--request");
  const inspect = process.argv.includes("--inspect");
  const spec = njOrderSpecs[requestId];
  if (!spec) throw new Error(`${requestId} has no reviewed New Jersey State Archives order.`);
  const request = JSON.parse(fs.readFileSync(path.join(projectRoot, "evidence", "acquisition", "requests", `${requestId}.json`), "utf8"));
  const total = njCardTotal(spec.fee);
  if (!inspect) {
    const authorization = authorizedPayment(request);
    if (authorization.currency !== "USD" || total > authorization.amount) {
      throw new Error(`Card payment of this order costs USD ${total.toFixed(2)}; the approval covers USD ${authorization.amount}. Nothing was ordered.`);
    }
  }

  const task = await openSharedChromeTask({ chromium, endpoint: sharedChromeEndpoint, taskLabel: `nj-archives-${requestId}`, affinitySlot: "nj-archives-order", reconnectExisting: true, timeoutMs: 20_000 });
  let keepOpen = false;
  try {
    const page = task.page;
    const onPortal = () => { try { return new URL(page.url()).hostname === portalHost; } catch { return false; } };
    // A run that already reached the payment site resumes there.
    if (!/^https:/.test(page.url()) || onPortal()) {
      await page.goto(`${portal}${spec.database}`, { waitUntil: "domcontentloaded", timeout: 45_000 });
      await settle(page);
      let rows = await cartRows(page);
      if (!rows.length) {
        for (const [name, value] of Object.entries(spec.search)) await page.locator(field(name)).fill(value);
        await page.locator(field("Search")).click();
        await settle(page);
        const matches = page.locator("tr").filter({ hasText: spec.reference }).filter({ has: page.getByRole("link", { name: "Select", exact: true }) });
        const candidates = [];
        for (let index = 0; index < await matches.count(); index += 1) {
          const row = matches.nth(index);
          if (await row.locator("tr").count()) continue;
          if (spec.rowMatch.test((await row.innerText()).replace(/\s+/g, " "))) candidates.push(row);
        }
        if (candidates.length !== 1) throw new Error(`The index shows ${candidates.length} record(s) for ${spec.reference}, not exactly one; nothing was ordered.`);
        await candidates[0].getByRole("link", { name: "Select", exact: true }).click();
        await settle(page);
        rows = await cartRows(page);
      }
      const problem = cartProblem(rows, spec);
      if (problem) throw new Error(`New Jersey State Archives cart: ${problem}; nothing was ordered.`);
      console.log(JSON.stringify({ stage: "cart", records: rows.length, fee: spec.fee, cardTotal: total }));

      await page.locator('input[type=submit][value="Check Out"]').first().click();
      await settle(page);
      await page.locator('input[type=submit][value="Electronic Checkout"]').first().click();
      await settle(page);
      const notice = await page.locator("body").innerText();
      if (!/additional 2\.3% transaction fee, and an additional \$ ?0\.50/i.test(notice)) {
        throw new Error("The Archives' card surcharge wording has changed; read the cart page before paying. Nothing was ordered.");
      }
      if (inspect) {
        console.log(JSON.stringify({ stage: "contact-form", status: "inspected", page: new URL(page.url()).pathname, emptyRequiredFields: (await emptyContactFields(page)).length }));
        return;
      }
      // The contact details are the user's own. Chrome's saved address is
      // offered from the first name field; anything it leaves empty is the
      // user's to complete, and so is the click that sends them.
      await page.locator(field("txtFirstName")).click();
      await page.waitForTimeout(600);
      await page.keyboard.press("ArrowDown");
      await page.waitForTimeout(1_200);
      await page.keyboard.press("Enter");
      await page.waitForTimeout(1_500);
      const empty = await emptyContactFields(page);
      if (empty.length && process.argv.includes("--no-manual")) {
        // A quiet attempt: nothing is revealed and nothing was sent.
        console.log(JSON.stringify({ stage: "contact-form", status: "needs-user", emptyRequiredFields: empty.length }));
        return;
      }
      if (empty.length) {
        await task.showForManualStep("your contact details for the New Jersey State Archives order");
        console.error(`Complete the contact form (${empty.length} required field(s) still empty), then click Continue Checkout. The card step follows.`);
      } else {
        await page.locator('input[type=submit][value="Continue Checkout"]').first().click();
      }
      const deadline = Date.now() + 600_000;
      while (Date.now() < deadline && onPortal()) await page.waitForTimeout(1_500);
      if (onPortal()) {
        keepOpen = true;
        throw new Error("The contact details were not sent; nothing was paid.");
      }
      await settle(page);
    }

    // The State's payment site. Until its host has been observed and reviewed
    // into the checkout profiles, this only reports what it is.
    const { profile } = inspectionBasis(request);
    if (!profile || !checkoutHostAllowed(profile, page.url())) {
      console.log(JSON.stringify({ stage: "payment-site", ...(await inspectCheckout(page, request)) }));
      keepOpen = true;
      console.error("The payment site is not a reviewed checkout yet: nothing was paid. Review the host above into tools/payment-policy.mjs, then run this again; the tab is left open on the payment page.");
      process.exitCode = 3;
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
