#!/usr/bin/env node

// Ancestry membership order for one authorized request.
//
//   npm run pay:win -- -Request <request-id> -AncestryMembership [-Inspect]
//   npm run pay:win -- -Request <request-id> -AncestryMembership -PastCharges
//
// Opens Ancestry's own offers page in the signed-in shared profile, selects
// the one plan the request names, and walks to Ancestry's checkout, where the
// guarded payment helper clicks the one final control. Every step first checks
// that the page is on Ancestry's own host, names the authorized plan and term,
// and shows no amount above the approved maximum.
//
// Ancestry quotes its price "+ tax" and shows no tax figure before the order,
// so the driver also requires the account's latest invoice for the same
// membership to show zero tax and a total equal to the authorized amount.
// Without that basis nothing is ordered and the user decides.
//
// --explore reads each page's plans, prices and control labels and stops
// before the final control, which is how the checkout was first mapped.
// Before the request is authorized, --explore reads the public offers page
// only. -PastCharges reads only the latest invoice's tax basis.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { payOnCheckout, recordRequestEvent } from "./guarded-card-payment.mjs";
import { amountGuard, authorizedPayment, checkoutHostAllowed, checkoutProfileFor, classifyPaymentResult } from "./payment-policy.mjs";
import { isLoginUrl, trySavedSignInAtCurrentForm } from "./saved-signin.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const ancestryOffersUrl = "https://www.ancestry.com/offers/subscribe";
const orderHistoryUrl = "https://www.ancestry.com/order-history";
const membershipTiers = ["U.S. Discovery", "World Explorer", "All Access"];
const currencySymbols = { GBP: "£", USD: "$", EUR: "€" };
const tierPattern = (tier) => new RegExp(`\\b${tier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+")}(?![\\w])`, "i");

// The plan a request names: its tier, billing term and Ancestry's offer id,
// all read from the request the user's PAY phrase covers.
export function membershipPlan(request) {
  const plan = request?.spec?.plan;
  if (!plan?.tier || !plan?.term) throw new Error(`${request?.id || "The request"} names no Ancestry plan tier and term.`);
  if (!membershipTiers.includes(plan.tier)) throw new Error(`${request?.id || "The request"} names an unknown Ancestry tier.`);
  if (!/^O-\d{3,8}$/.test(plan.offerId || "")) throw new Error(`${request?.id || "The request"} names no exact Ancestry offer id.`);
  return { tier: String(plan.tier), term: String(plan.term), offerId: plan.offerId };
}

// Ancestry's own pages only: the offers page and its checkout share one host.
export function onAncestry(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password && !parsed.port && /^www\.ancestry\.com$/i.test(parsed.hostname);
  } catch { return false; }
}

// The checkout must name the plan's tier and no other tier, and must not
// describe a longer commitment than the one authorized. A monthly order
// refuses any page that mentions a six-month, annual or yearly term.
export function checkoutShowsPlan(text, plan) {
  const body = String(text);
  if (!tierPattern(plan.tier).test(body)) return { ok: false, reason: `the page does not name ${plan.tier}` };
  const other = membershipTiers.find((tier) => tier !== plan.tier && tierPattern(tier).test(body));
  if (other) return { ok: false, reason: `the page also names ${other}` };
  if (!/^monthly$/i.test(plan.term)) return { ok: false, reason: `the ${plan.term} term has no reviewed check` };
  // Any count of months other than one, and any yearly, quarterly or
  // day-counted term. "$10.00/month" and "December 16, 2026" do not match.
  const longer = /(?<![\d.,$])(?!1[\s-]*mo)\d{1,3}[\s-]*(?:months?\b|mos?\b\.?)|\b(?:two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|eighteen|twenty[\s-]?four)[\s-]*(?:months?|mos?)\b|\b(?:semi|bi)-?annual|\bannual(?:ly)?\b|\byearly\b|\bquarter(?:ly)?\b|\bhalf[\s-]year|\byears?\b|\/\s?yrs?\b|\byrs?\b|\b\d{2,3}[\s-]*days?\b/i.exec(body);
  if (longer) return { ok: false, reason: `the page mentions a longer term ("${longer[0]}")` };
  if (!/\bmonthly\b|\b(?:1|one)[\s-]*month\b|\/\s?mo\b|\bper month\b|\beach month\b|\bevery month\b|\ba month\b/i.test(body)) return { ok: false, reason: "the page does not show a monthly term" };
  return { ok: true };
}

// Plan and price lines only: nothing from the account menu or a payment form.
export function offerLines(text) {
  return String(text).split(/\n+/).map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line && /[$£€]\s?\d|\bmonth|\bmembership|\bworld explorer|\ball access|\bdiscovery|\brenew|\btax|\bbilled|\btrial|\bsave\b/i.test(line))
    .map((line) => line.slice(0, 220)).slice(0, 80);
}

// The payment page as it was observed and reviewed: exactly one product, the
// one optional add-on present and not ticked, no other field or choice of any
// kind, and one stored card already selected. Anything else is unmapped.
export function paymentPageOrder(described) {
  const removes = (described.controls || []).filter((control) => /^button: remove product$/i.test(control)).length;
  if (removes !== 1) return { ok: false, reason: `the order holds ${removes} removable product(s), not exactly one` };
  const inputs = Array.isArray(described.inputs) ? described.inputs : null;
  if (!inputs) return { ok: false, reason: "the page's fields could not be read" };
  if (inputs.some((input) => /^input checkbox\b/.test(input) && /\[checked\]$/.test(input))) return { ok: false, reason: "an add-on is ticked" };
  if (inputs.length !== 1 || inputs[0] !== "input checkbox crossSell [unchecked]") {
    return { ok: false, reason: "the page's fields are not the one reviewed, unticked add-on box" };
  }
  if (!(described.paymentLines || []).some((line) => /^this card will be used\b/i.test(line))) return { ok: false, reason: "the page does not show one stored card already selected" };
  return { ok: true };
}

// Order and payment lines of a checkout or invoice. A line that describes a
// stored card is replaced whole, and any run of four or more digits is masked,
// so card digits and expiry never leave the page.
export function paymentLines(text) {
  return String(text).split(/\n+/).map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line && /[$£€]\s?\d|\btotal|\btax|\bdue\b|\btoday|\bcard\b|\bvisa|\bmaster|\bamex|\bamerican express|\bdiscover\b|\bending\b|\bpaypal|\bgoogle pay|\bpayment|\bcoupon|\bpro tools|\bexpir/i.test(line))
    .map((line) => (/\bending\b|\bexpir|\bexp\.?\s*\d|\bvisa\b|\bmaster\s?card|\bamex\b|\bamerican express|\bdiscover\b|\b\d{2}\s?\/\s?\d{2,4}\b|[•*x]{2,}\s?\d{2,4}\b|\bcard\b.*\d{4}/i.test(line) ? "(a stored card line)" : line.replace(/\d{4,}/g, "••••").slice(0, 200)))
    .slice(0, 40);
}

// The order list's dates, products, amounts and count; order numbers and any
// stored-card line are masked.
export function orderListLines(text) {
  return String(text).split(/\n+/).map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean)
    .filter((line) => /^[$£€]\s?\d|\b(?:19|20)\d{2}\b|\bmembership\b|^orders? \d+\s*-\s*\d+ of \d+$|\bpending\b|\bdeclined\b|\bfailed\b|\brefund/i.test(line))
    .filter((line) => !/^order\s?#/i.test(line))
    .map((line) => (/\bending\b|\bexpir|\bvisa\b|\bmaster\s?card|\bamex\b|\bcard\b/i.test(line) ? "(a stored card line)" : line.replace(/\d{5,}/g, "•••••").slice(0, 120)))
    .slice(0, 24);
}

// The order list as Ancestry prints it: for each order a date line, an
// amount line and a product line, then "Orders 1 - N of M".
export function parseOrderList(text, currency) {
  const symbol = currencySymbols[currency] || "$";
  const lines = String(text).split(/\n+/).map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean);
  const count = /^orders? \d+\s*-\s*\d+ of (\d+)$/i.exec(lines.find((line) => /^orders? \d+\s*-\s*\d+ of \d+$/i.test(line)) || "");
  const orders = [];
  let current = null;
  for (const line of lines) {
    if (/^(?:january|february|march|april|may|june|july|august|september|october|november|december) \d{1,2} ?, ?(?:19|20)\d{2}$/i.test(line)) {
      current = { date: line.replace(/\s+,/g, ","), amount: null, product: "" };
      orders.push(current);
    } else if (current && current.amount === null && new RegExp(`^\\${symbol}\\s?\\d{1,6}(?:\\.\\d{2})?$`).test(line)) {
      current.amount = Number(line.replace(/[^\d.]/g, ""));
    } else if (current && !current.product && /\bmembership\b/i.test(line)) {
      current.product = line.slice(0, 80);
    }
  }
  return { total: count ? Number(count[1]) : null, orders };
}

// Whether the account's order record shows this order placed: exactly one
// more order than before the click, the newest one being this membership at
// the authorized amount. No change means it was not placed; anything else is
// left for a person to read.
export function settleFromOrders(before, after, plan, { amount }) {
  if (!Number.isInteger(before?.total) || !Number.isInteger(after?.total)) return "unclear";
  if (after.total === before.total) return "not-placed";
  const newest = after.orders?.[0];
  if (after.total === before.total + 1 && newest && tierPattern(plan.tier).test(newest.product) && newest.amount === amount
      && !(before.orders?.[0] && before.orders[0].date === newest.date && before.orders.length === after.orders.length)) return "placed";
  return "unclear";
}

async function readOrders(page, currency) {
  await page.goto(orderHistoryUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page.waitForTimeout(5_000);
  if (!onAncestry(page.url()) || new URL(page.url()).pathname !== "/order-history") return { total: null, orders: [] };
  return parseOrderList(await page.locator("main").innerText({ timeout: 8_000 }).catch(() => ""), currency);
}

// Whether an invoice shows zero tax and a total equal to the authorized
// amount. Ancestry prints each label on one line and its figure on the next.
export function invoiceTaxBasis(text, { amount, currency }, tier = "") {
  const symbol = currencySymbols[currency];
  if (!symbol) return { ok: false, reason: `invoices in ${currency} have no reviewed check` };
  const lines = String(text).split(/\n+/).map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean);
  if (tier && !lines.some((line) => tierPattern(tier).test(line))) return { ok: false, reason: `the latest invoice does not name ${tier}` };
  if (tier && membershipTiers.some((other) => other !== tier && lines.some((line) => tierPattern(other).test(line)))) return { ok: false, reason: "the latest invoice names another membership" };
  const figure = new RegExp(`\\${symbol}\\s?(\\d{1,6}(?:\\.\\d{2})?)$`);
  const after = (label) => {
    // One charge only: a second tax or total line makes the invoice ambiguous.
    if (lines.filter((line) => label.test(line)).length !== 1) return null;
    const index = lines.findIndex((line) => label.test(line));
    if (index < 0) return null;
    const match = figure.exec(lines[index]) || (lines[index + 1] && new RegExp(`^${figure.source}`).exec(lines[index + 1]));
    return match ? Number(match[1]) : null;
  };
  const tax = after(/\btax(?:es)?\b/i);
  const total = after(/\btotal\b/i);
  if (tax === null || total === null) return { ok: false, reason: "the latest invoice does not show exactly one tax line and one total line with figures" };
  if (tax !== 0) return { ok: false, reason: `the latest invoice charged ${symbol}${tax.toFixed(2)} tax` };
  if (total !== amount) return { ok: false, reason: `the latest invoice total ${symbol}${total.toFixed(2)} is not the authorized ${symbol}${amount.toFixed(2)}` };
  return { ok: true, tax, total };
}

// The newest order must be the same membership, and its invoice must show the
// zero-tax basis. Read-only; the invoice opens in a popup of this page, which
// is closed again. Nothing of the invoice but the verdict is reported.
async function latestInvoiceBasis(page, plan, authorization) {
  await page.goto(orderHistoryUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page.waitForTimeout(5_000);
  if (!onAncestry(page.url()) || new URL(page.url()).pathname !== "/order-history") return { ok: false, reason: "the order history did not open" };
  const main = await page.locator("main").innerText({ timeout: 8_000 }).catch(() => "");
  const product = String(main).split(/\n+/).map((line) => line.replace(/\s+/g, " ").trim()).find((line) => /\bmembership\b/i.test(line)) || "";
  if (!tierPattern(plan.tier).test(product)) return { ok: false, reason: `the newest order is not a ${plan.tier} membership` };
  const invoice = page.locator("main a").filter({ hasText: /^\s*Invoice\s*$/i }).first();
  if (!(await invoice.isVisible().catch(() => false))) return { ok: false, reason: "the newest order has no invoice link" };
  const popupPromise = page.waitForEvent("popup", { timeout: 12_000 }).catch(() => null);
  await invoice.click({ timeout: 8_000 });
  const popup = await popupPromise;
  if (!popup) return { ok: false, reason: "the invoice did not open" };
  try {
    await popup.waitForLoadState("domcontentloaded").catch(() => {});
    await popup.waitForTimeout(3_000);
    if (!onAncestry(popup.url())) return { ok: false, reason: "the invoice opened off Ancestry's own host" };
    return invoiceTaxBasis(await popup.locator("body").innerText({ timeout: 8_000 }).catch(() => ""), authorization, plan.tier);
  } finally {
    await popup.close().catch(() => {});
  }
}

const visibleFields = () => [...document.querySelectorAll("input:not([type=hidden]), select, textarea")]
  .filter((element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  })
  .map((element) => `${element.tagName.toLowerCase()} ${element.type || ""} ${(element.getAttribute("autocomplete") || element.name || element.id || element.getAttribute("aria-label") || "").slice(0, 40)}`
    + (/^(checkbox|radio)$/.test(element.type) ? (element.checked ? " [checked]" : " [unchecked]") : ""))
  .slice(0, 30);

async function describePage(page) {
  const described = await page.evaluate(() => {
    const visible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const label = (element) => clean(element.innerText || element.value || element.getAttribute("aria-label")).slice(0, 90);
    return {
      url: `${location.origin}${location.pathname}`,
      title: document.title,
      headings: [...document.querySelectorAll("h1, h2, h3")].filter(visible).map(label).filter(Boolean).slice(0, 16),
      offers: [...document.querySelectorAll("input[type=radio]")].map((radio) => {
        const container = radio.closest("label, li, [class*=offer i], [class*=plan i], [class*=card i]") || radio.parentElement;
        return { value: clean(radio.value).slice(0, 24), name: clean(radio.name).slice(0, 40), checked: radio.checked, visible: visible(radio) || (container ? visible(container) : false),
          text: clean(container?.innerText).slice(0, 260) };
      }).slice(0, 24),
      controls: [...document.querySelectorAll("button, input[type=submit], a")]
        .filter((element) => element.tagName !== "A" || /membership|upgrade|continue|start|checkout|order|options|terms|pay/i.test(element.innerText || ""))
        .filter(visible).map((element) => `${element.tagName.toLowerCase()}: ${label(element)}${element.tagName === "A" ? ` -> ${(element.getAttribute("href") || "").split("?")[0].slice(0, 90)}` : ""}`)
        .filter((line) => !/: $/.test(line)).slice(0, 40),
      frameHosts: []
    };
  });
  described.frameHosts = [...new Set(page.frames().map((frame) => { try { return new URL(frame.url()).hostname; } catch { return ""; } }).filter(Boolean))];
  const body = await page.locator("body").innerText({ timeout: 8_000 });
  described.lines = offerLines(body);
  described.paymentLines = paymentLines(body);
  // Field names and states only: no value is ever read. The page's own frame
  // must answer; a third-party frame that will not is skipped.
  described.inputs = await page.mainFrame().evaluate(visibleFields);
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    described.inputs.push(...await frame.evaluate(visibleFields).catch(() => []));
  }
  return described;
}

async function main() {
  const { chromium } = await import("playwright-core");
  const { openSharedChromeTask, sharedChromeEndpoint } = await import("./shared-chrome-task.mjs");
  const requestId = valueAfter("--request");
  const explore = process.argv.includes("--explore");
  const pastCharges = process.argv.includes("--past-charges");
  if (!/^[a-z0-9][a-z0-9-]{0,127}$/.test(requestId || "")) throw new Error("Pass one safe request ID.");
  const file = path.join(projectRoot, "evidence", "acquisition", "requests", `${requestId}.json`);
  const request = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
  if (request && request.provider !== "Ancestry") throw new Error(`${requestId} is not an Ancestry request.`);
  let authorized = false;
  if (request) { try { authorizedPayment(request); authorized = true; } catch (error) { if (!explore) throw error; } }
  if (!explore && !authorized) throw new Error(`${requestId} has no recorded PAY authorization; nothing was opened.`);
  if (pastCharges && !request) throw new Error(`${requestId} does not exist; nothing was opened.`);

  const task = await openSharedChromeTask({ chromium, endpoint: sharedChromeEndpoint, taskLabel: `ancestry-membership-${requestId}`, affinitySlot: "ancestry-membership", timeoutMs: 20_000 });
  let keepOpen = false;
  try {
    const page = task.page;
    if (pastCharges) {
      const guard = request.guard || {};
      // The order list itself (dates, products, amounts, the count), for
      // settling an order whose result was not recognized.
      await page.goto(orderHistoryUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
      await page.waitForTimeout(5_000);
      const listed = await page.locator("main").innerText({ timeout: 8_000 }).catch(() => "");
      console.log(JSON.stringify({ stage: "order-list", lines: orderListLines(listed) }));
      console.log(JSON.stringify({ stage: "tax-basis", basis: await latestInvoiceBasis(page, membershipPlan(request), { amount: guard.maxAmount, currency: guard.currency }) }));
      return;
    }
    if (!authorized) {
      await page.goto(ancestryOffersUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
      await page.waitForTimeout(4_000);
      console.log(JSON.stringify({ stage: "offers", authorized, page: await describePage(page) }));
      return;
    }
    const outcome = await runAuthorized(page, { request, task, explore });
    keepOpen = ["needs-user", "uncertain"].includes(outcome?.status) && !outcome?.tabClosed;
    if (outcome) console.log(JSON.stringify(outcome));
  } finally {
    if (keepOpen) await task.leaveOpen().catch(() => {});
    else await task.close().catch(() => {});
  }
}

// Selects the one authorized offer and walks to Ancestry's checkout. Nothing
// here can order: the only final control is clicked by payOnCheckout, on the
// allowlisted checkout page, after its own amount check.
async function runAuthorized(page, { request, task, explore }) {
  const authorization = authorizedPayment(request);
  const plan = membershipPlan(request);
  const ordersBefore = await readOrders(page, authorization.currency);
  console.log(JSON.stringify({ stage: "orders-before", total: ordersBefore.total }));
  const basis = await latestInvoiceBasis(page, plan, authorization);
  console.log(JSON.stringify({ stage: "tax-basis", basis }));
  if (!explore && !Number.isInteger(ordersBefore.total)) throw new Error("The account's order history could not be read, so the order could not be settled afterwards; nothing was ordered.");
  if (!explore && !basis.ok) throw new Error(`Ancestry quotes its price "+ tax" with no figure, and ${basis.reason}; nothing was ordered.`);

  await page.goto(ancestryOffersUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page.waitForTimeout(4_000);
  if (!onAncestry(page.url()) || new URL(page.url()).pathname !== "/offers/subscribe") throw new Error("Ancestry's membership page did not open; nothing was ordered.");
  const radios = page.locator(`input[type=radio][name="offers"][value="${plan.offerId}"]`);
  const count = await radios.count();
  let radio = null;
  for (let index = 0; index < count; index += 1) {
    const candidate = radios.nth(index);
    const text = await candidate.evaluate((element) => (element.closest("label, li, [class*=offer i], [class*=plan i], [class*=card i]") || element.parentElement)?.innerText || "").catch(() => "");
    const guard = amountGuard(text, authorization);
    if (guard.ok && /\/\s?mo\b/i.test(text) && !/\bfor\s+\d+\s+months\b/i.test(text)) { radio = candidate; break; }
  }
  if (!radio) throw new Error(`Offer ${plan.offerId} is not shown as a monthly plan at or under ${authorization.currency} ${authorization.amount.toFixed(2)}; nothing was ordered.`);
  await radio.check({ force: true, timeout: 8_000 });
  await page.waitForTimeout(1_000);
  if (!(await radio.isChecked())) throw new Error("The authorized offer did not stay selected; nothing was ordered.");
  const selected = await page.locator('input[type=radio][name="offers"]:checked').evaluateAll((elements) => [...new Set(elements.map((element) => element.value))]);
  if (selected.length !== 1 || selected[0] !== plan.offerId) throw new Error(`The page has ${selected.join(", ") || "no offer"} selected, not ${plan.offerId}; nothing was ordered.`);
  console.log(JSON.stringify({ stage: "offer-selected", offerId: plan.offerId }));

  let proceed = null;
  for (const candidate of await page.getByRole("button", { name: /^become a member/i }).all()) {
    if (await candidate.isVisible().catch(() => false)) { proceed = candidate; break; }
  }
  if (!proceed) throw new Error("The offers page shows no 'Become a member' control; nothing was ordered.");
  if (new URL(page.url()).pathname !== "/offers/subscribe") throw new Error("The membership page changed before the order began; nothing was ordered.");
  await proceed.click({ timeout: 8_000 });
  for (let step = 0; step < 4; step += 1) {
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    await page.waitForTimeout(4_000);
    const described = await describePage(page);
    console.log(JSON.stringify({ stage: `checkout-${step}`, url: described.url, title: described.title, headings: described.headings, controls: described.controls, inputs: described.inputs, lines: described.paymentLines.slice(0, 14) }));
    if (isLoginUrl("ancestry", page.url())) {
      const signIn = await trySavedSignInAtCurrentForm(page, "ancestry");
      console.log(JSON.stringify({ stage: `checkout-${step}-signin`, status: signIn.status, reason: signIn.reason || null }));
      if (!["signed-in", "already-signed-in"].includes(signIn.status)) {
        await task.showForManualStep("Ancestry checkout sign-in");
        return { requestId: request.id, status: "needs-user", reason: "ancestry-checkout-sign-in" };
      }
      continue;
    }
    if (!onAncestry(page.url())) throw new Error(`The checkout left Ancestry's own host (${described.url}); nothing was ordered.`);
    const profile = checkoutProfileFor(request);
    const text = await page.locator("body").innerText({ timeout: 8_000 });
    const shows = checkoutShowsPlan(text, plan);
    const guard = amountGuard(text, authorization, profile.buffer || 0);
    const pathname = new URL(page.url()).pathname;
    console.log(JSON.stringify({ stage: `checkout-${step}-checks`, plan: shows, amounts: guard.amounts, amountGuardOk: guard.ok }));
    // Observed 16 Nov 2026: the offers page leads to /checkout/MLI/summary
    // ("Membership Highlights": the plan, its term and price, and one "Get
    // started" control), which orders nothing and leads to the payment page.
    if (/^\/checkout\/MLI\/summary\/?$/.test(pathname)) {
      if (!shows.ok) throw new Error(`Ancestry plan summary refused: ${shows.reason}; nothing was ordered.`);
      if (!guard.ok) throw new Error(`Ancestry plan summary refused: ${guard.reason}; nothing was ordered.`);
      const started = page.getByRole("button", { name: /^get started$/i });
      if ((await started.count()) !== 1 || !(await started.isVisible().catch(() => false))) throw new Error("The plan summary shows no single 'Get started' control; nothing was ordered.");
      await started.click({ timeout: 8_000 });
      continue;
    }
    const order = paymentPageOrder(described);
    if (explore) {
      console.log(JSON.stringify({ stage: `checkout-${step}-order`, order }));
      if (checkoutHostAllowed(profile, page.url())) console.log(JSON.stringify({ stage: "payment-inspection", ...(await payOnCheckout(page, { requestId: request.id, task, inspect: true })) }));
      return null;
    }
    // Observed 16 Nov 2026: /checkout/MLI ("Select Payment") is the one page
    // that carries the final control, "Start membership".
    if (!checkoutHostAllowed(profile, page.url()) || !/^\/checkout\/MLI\/?$/.test(pathname)) throw new Error(`Unmapped Ancestry checkout page ${described.url}; nothing was ordered.`);
    if (!shows.ok) throw new Error(`Ancestry checkout refused: ${shows.reason}; nothing was ordered.`);
    if (!guard.ok) throw new Error(`Ancestry checkout refused: ${guard.reason}; nothing was ordered.`);
    if (!order.ok) throw new Error(`Ancestry checkout refused: ${order.reason}; nothing was ordered.`);
    const outcome = await payOnCheckout(page, { requestId: request.id, task, fromDriver: profile.id, resultTimeoutMs: 150_000 });
    if (outcome.status !== "uncertain" || page.isClosed()) return outcome;
    // The click was made. Ancestry's own page afterwards is reported, and the
    // result is settled from the account's order history, never from wording.
    const afterPage = await describePage(page).catch(() => null);
    if (afterPage) console.log(JSON.stringify({ stage: "after-payment", url: afterPage.url, title: afterPage.title, headings: afterPage.headings, pageResult: outcome.pageResult }));
    const stillVerifying = classifyPaymentResult(await page.locator("body").innerText({ timeout: 8_000 }).catch(() => "")) === "needs-bank-verification";
    if (stillVerifying) {
      await task.showForManualStep("bank verification for an authorized payment");
      return outcome;
    }
    await page.waitForTimeout(6_000);
    const ordersAfter = await readOrders(page, authorization.currency);
    const settled = settleFromOrders(ordersBefore, ordersAfter, plan, authorization);
    console.log(JSON.stringify({ stage: "settled-from-order-history", settled, before: ordersBefore.total, after: ordersAfter.total }));
    if (settled === "placed") {
      recordRequestEvent(request.id, { type: "submission-confirmed", basis: `Ancestry order history after the click: ${ordersAfter.total} orders (was ${ordersBefore.total}); newest ${ordersAfter.orders[0].date}, ${ordersAfter.orders[0].product}, ${authorization.currency} ${ordersAfter.orders[0].amount.toFixed(2)}` });
      return { requestId: request.id, status: "paid", amount: ordersAfter.orders[0].amount, currency: authorization.currency, checkout: outcome.checkout, settledFrom: "order-history" };
    }
    if (settled === "not-placed" && outcome.pageResult === "declined") {
      recordRequestEvent(request.id, { type: "submission-retryable", basis: "Ancestry showed a decline and its order history holds no new order" });
      return { requestId: request.id, status: "declined", checkout: outcome.checkout, settledFrom: "order-history", tabClosed: true };
    }
    // Held for review: the started event stays unmatched, so nothing can be ordered again.
    return { ...outcome, settled, tabClosed: true };
  }
  throw new Error("The Ancestry checkout was not reached; nothing was ordered.");
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
