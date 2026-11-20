// What the guarded saved-card payment helper may pay, where, and how much.
//
// AGENTS.md (28 Oct 2026) lets one project helper choose Chrome's saved card
// and click a checkout's exact pay control, but only for a request carrying the
// user's recorded exact PAY phrase, on that provider's allowlisted payment
// host, with every visible amount at or under the authorized amount. These are
// the pure checks behind that rule; tools/guarded-card-payment.mjs drives the
// page. A new provider joins `paymentCheckoutProfiles` only as a reviewed code
// change, after its real checkout host has been observed with --inspect.

import { deriveExternalRequest } from "./external-request-store.mjs";

export const paymentCheckoutProfiles = Object.freeze({
  gro: Object.freeze({
    provider: "General Register Office",
    hosts: Object.freeze([/^(?:payments|hpp)\.worldpay\.com$/i]),
    // AGENTS.md: certificate orders may run a small buffer over the estimate.
    buffer: 0.5,
    cardMethod: /^credit\/debit cards$/i,
    payControl: /^make payment$/i,
    confirmControl: /^complete payment$/i,
    // Where Worldpay returns the browser after the payment. An unrecognized
    // page there is settled from GRO's order history, never waited out.
    merchantHosts: Object.freeze([/^(?:www\.)?gro\.gov\.uk$/i])
  }),
  // Observed 28 Oct 2026: Discovery's checkout hands off to the same Worldpay
  // hosted page, which first asks for a payment method. No buffer: the page
  // check is a fixed, quoted £9.92.
  // Observed 28 Oct 2026: MSA's own checkout (CheckoutStep2Review.aspx)
  // takes the card on shop.msa.maryland.gov and submits with "Submit Order".
  // One approved quote covers several record orders, so no buffer.
  msa: Object.freeze({
    provider: "Maryland State Archives",
    hosts: Object.freeze([/^shop\.msa\.maryland\.gov$/i]),
    buffer: 0,
    payControl: /^submit order$/i,
    // Submit Order is enabled before the security code is entered, so its
    // state cannot show that the user is ready: the user submits, and the
    // helper records the click and its result.
    userSubmits: true
  }),
  // Observed 3 Nov 2026 with --inspect: the Norris Museum invoices through
  // Zettle; the emailed "Show invoice" link opens myinvoice.izettle.com.
  norris: Object.freeze({
    provider: "Norris Museum",
    linkHosts: Object.freeze([/^myinvoice\.izettle\.com$/i]),
    hosts: Object.freeze([/^myinvoice\.izettle\.com$/i]),
    buffer: 0,
    // "Pay by card" opens Zettle's card form (frames online.izettlepay.com);
    // "Confirm payment" is the one final control.
    cardMethod: /^pay by card$/i,
    payControl: /^confirm payment$/i
  }),
  // Observed 16 Nov 2026 with --explore: Ancestry sells memberships on its
  // own host. /offers/subscribe leads to /checkout/MLI/summary ("Get started")
  // and then /checkout/MLI ("Select Payment"), whose one final control is
  // "Start membership". No buffer: the plan price is fixed and shown.
  ancestry: Object.freeze({
    provider: "Ancestry",
    hosts: Object.freeze([/^www\.ancestry\.com$/i]),
    buffer: 0,
    // The button carries its label twice (text and accessible name).
    payControl: /^start membership(?: start membership)?$/i,
    // A returning member's checkout shows no card field: Ancestry charges the
    // payment method already stored on the user's own account.
    storedPaymentMethod: true,
    // The host check alone cannot tell which plan the cart holds: only the
    // order driver, which verifies the plan, term, single product, add-ons
    // and tax basis, may reach the pay control.
    driverOnly: "-AncestryMembership",
    // 16 Nov 2026: the page Ancestry showed after a successful order carried
    // wording the generic reader took for a decline. Page wording never
    // settles an Ancestry order; its driver settles it from the account's own
    // order history.
    settlesFromOrderRecord: true
  }),
  // Observed 19 Nov 2026 from a signed-in basket: Find a Will's "Place order"
  // hands the browser to Barclaycard's hosted page
  // (pp.ephapay.net/MOJ/pages/paypage.jsf, titled "Complete your order -
  // Barclaycard Checkout"), which shows "HMCTS Order <number>" and the amount,
  // takes the card on its own page (no frame) and submits with "Pay Now";
  // "Cancel payment" returns to probatesearch.service.gov.uk/payment/canceled.
  // No buffer: each copy is a fixed GBP 16.
  findAWill: Object.freeze({
    provider: "GOV.UK Find a Will",
    hosts: Object.freeze([/^pp\.ephapay\.net$/i]),
    buffer: 0,
    payControl: /^pay now$/i,
    // Pay Now is a plain submit, not gated on the security code, so its state
    // cannot show that the user is ready: the user submits, and the helper
    // records the click and its result.
    userSubmits: true,
    merchantHosts: Object.freeze([/^probatesearch\.service\.gov\.uk$/i]),
    // The host check cannot tell what the basket holds: only the order driver,
    // which requires the basket to hold exactly the reviewed entry, may pay.
    driverOnly: "-FindAWillOrder"
  }),
  // Observed 20 Nov 2026 with -Explore from a signed-in basket: ScotlandsPeople's
  // checkout (Billing, Review, "Continue to payment") hands the browser to
  // Worldpay's hosted page (payments.worldpay.com/app/hpp/175-2/payment/start,
  // "Select Payment Method"), which shows "Scotland's People Order" and the
  // amount and offers Credit/Debit Cards or PayPal. No buffer: a credit bundle
  // has a fixed price. The Complete Payment step is Worldpay's own second
  // confirmation as seen on GRO's use of the same page; it has not yet been
  // seen here and is clicked, if it appears, under the same host and amount
  // checks.
  scotlandspeople: Object.freeze({
    provider: "ScotlandsPeople",
    hosts: Object.freeze([/^(?:payments|hpp)\.worldpay\.com$/i]),
    buffer: 0,
    cardMethod: /^credit\/debit cards$/i,
    payControl: /^make payment$/i,
    confirmControl: /^complete payment$/i,
    merchantHosts: Object.freeze([/^www\.scotlandspeople\.gov\.uk$/i]),
    // The host check cannot tell what the basket holds: only the order driver,
    // which requires the basket to hold exactly the reviewed bundle, may pay.
    driverOnly: "-ScotlandsPeopleCredits"
  }),
  tna: Object.freeze({
    provider: "The National Archives",
    hosts: Object.freeze([/^(?:payments|hpp)\.worldpay\.com$/i]),
    buffer: 0,
    cardMethod: /^credit\/debit cards$/i,
    payControl: /^make payment$/i
  })
});

const currencySymbols = { GBP: "£", USD: "$", EUR: "€" };

export function checkoutProfileFor(request) {
  const entry = Object.entries(paymentCheckoutProfiles).find(([, profile]) => profile.provider === request?.provider);
  if (!entry) throw new Error(`${request?.provider || "This provider"} has no allowlisted payment checkout.`);
  return { id: entry[0], ...entry[1] };
}

// A paid order whose price rose after it was authorized. The guard's maximum is
// fixed with the order (its hash is what the PAY phrase confirmed), so a higher
// total is approved the way a quote is: the provider's new total is recorded as
// fee-quoted, and the user's approval of exactly that total as
// payment-authorized bound to it, under the same PAY phrase. Returns that
// approval, or null when the order stands at its original maximum. An approval
// of anything but the latest quote, in another currency, or for less than the
// guard does not count.
export function raisedOrderApproval(request) {
  if (!request?.kind?.startsWith("paid-")) return null;
  const events = request.events || [];
  const authorizedAt = events.map((event) => event.type).lastIndexOf("authorization-confirmed");
  if (authorizedAt < 0) return null;
  const later = events.slice(authorizedAt + 1);
  const quote = [...later].reverse().find((event) => event.type === "fee-quoted");
  if (!quote) return null;
  const approval = [...later].reverse().find((event) => event.type === "payment-authorized");
  if (!approval || approval.feeEventId !== quote.id || approval.amount !== quote.amount || approval.currency !== quote.currency) return null;
  if (approval.phrase !== `PAY ${request.id}` || approval.currency !== request.guard?.currency || !(approval.amount > request.guard.maxAmount)) return null;
  return { amount: approval.amount, currency: approval.currency, eventId: approval.id };
}

// The amount the user approved for this exact request, or a refusal.
export function authorizedPayment(request) {
  const derived = deriveExternalRequest(request);
  const events = request.events || [];
  if (request.kind?.startsWith("paid-")) {
    if (!derived.authorizationValid || derived.operationalState !== "authorized") {
      throw new Error(`${request.id} is ${derived.operationalState}; it has no unused PAY authorization.`);
    }
    if (request.guard?.requiredPhrase !== `PAY ${request.id}`) throw new Error(`${request.id} is not guarded by its own PAY phrase.`);
    const raised = raisedOrderApproval(request);
    return {
      requestId: request.id, mode: "paid-order", currency: request.guard.currency,
      amount: raised ? raised.amount : request.guard.maxAmount,
      ...(raised ? { raisedFrom: request.guard.maxAmount } : {})
    };
  }
  const { fee, paymentAuthorization } = derived;
  const quoteState = ["paid-followup-authorized", "awaiting-payment-instructions", "waiting-external"].includes(derived.operationalState);
  if (!quoteState || !fee || paymentAuthorization?.feeEventId !== fee.id) {
    throw new Error(`${request.id} is ${derived.operationalState}; it has no approved, unpaid quote.`);
  }
  // One approval can cover several provider checkouts (MSA prices each record
  // on its own form). Each payment spends from what the approval has left.
  const authorizationIndex = events.findIndex((event) => event.id === paymentAuthorization.id);
  const spent = events.slice(authorizationIndex + 1)
    .filter((event) => event.type === "payment-submitted")
    .reduce((total, event) => total + (Number(event.amount) || paymentAuthorization.amount), 0);
  const remaining = Math.round((paymentAuthorization.amount - spent) * 100) / 100;
  if (remaining <= 0) throw new Error(`${request.id} has already paid its approved ${paymentAuthorization.currency} ${paymentAuthorization.amount}.`);
  return { requestId: request.id, mode: "quote", amount: remaining, approvedAmount: paymentAuthorization.amount, currency: paymentAuthorization.currency };
}

// What an inspection may go on. Inspecting is how a new provider's checkout is
// first observed, so it must work before there is a profile to check the host
// against, and before the user has decided to pay: with no profile nothing is
// allowlisted and no pay control is known, and with no usable authorization
// the amounts are read against the request's own guard or latest quote. It
// reads the page and nothing else; paying still needs both.
export function inspectionBasis(request) {
  let profile = null;
  try {
    profile = checkoutProfileFor(request);
  } catch {
    profile = null;
  }
  let authorization = null;
  try {
    authorization = authorizedPayment(request);
  } catch {
    authorization = null;
  }
  const fee = deriveExternalRequest(request).fee;
  const expected = authorization
    || (Number.isFinite(request.guard?.maxAmount) && request.guard.currency
      ? { requestId: request.id, amount: request.guard.maxAmount, currency: request.guard.currency }
      : fee ? { requestId: request.id, amount: fee.amount, currency: fee.currency } : null);
  return { profile, authorized: Boolean(authorization), expected };
}

// Where the card comes from on this checkout: Chrome's saved card chosen in
// the one card field, or the payment method the provider already holds on the
// user's own account (no field, nothing chosen or typed). Anything else is an
// unmapped or ambiguous checkout and is refused.
export function cardSource(profile, cardNumberFieldCount) {
  if (cardNumberFieldCount === 1) return "chrome-saved-card";
  if (cardNumberFieldCount === 0 && profile?.storedPaymentMethod === true) return "provider-stored-method";
  throw new Error(`Expected one visible card-number field; found ${cardNumberFieldCount}. Nothing was paid.`);
}

// A driver-only checkout may be paid only from its own order driver, never
// from a bare checkout URL.
export function driverAllowed(profile, fromDriver) {
  return !profile?.driverOnly || fromDriver === profile.id;
}

// The provider's own site, where the checkout hands the browser back.
export function merchantHostReached(profile, url) {
  let parsed;
  try { parsed = new URL(url); } catch { return false; }
  return parsed.protocol === "https:" && (profile.merchantHosts || []).some((pattern) => pattern.test(parsed.hostname));
}

export function checkoutHostAllowed(profile, url) {
  let parsed;
  try { parsed = new URL(url); } catch { return false; }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port) return false;
  return profile.hosts.some((pattern) => pattern.test(parsed.hostname));
}

// Every amount the page shows in the authorized currency, by symbol or code.
export function visibleAmounts(text, currency) {
  const symbol = currencySymbols[currency];
  const patterns = [new RegExp(`\\b${currency}\\s*([0-9]{1,6}(?:[.,][0-9]{2})?)`, "g")];
  if (symbol) patterns.push(new RegExp(`${symbol.replace(/[$]/, "\\$")}\\s*([0-9]{1,6}(?:[.,][0-9]{2})?)`, "g"));
  const amounts = new Set();
  for (const pattern of patterns) {
    for (const match of String(text).matchAll(pattern)) {
      const amount = Number(match[1].replace(",", "."));
      if (Number.isFinite(amount)) amounts.add(amount);
    }
  }
  return [...amounts];
}

// The page must show at least one amount, and none above the limit.
export function amountGuard(text, { amount, currency }, buffer = 0) {
  const amounts = visibleAmounts(text, currency);
  const limit = Math.round((amount + buffer) * 100) / 100;
  if (!amounts.length) return { ok: false, reason: `no visible ${currency} amount`, amounts, limit };
  const highest = Math.max(...amounts);
  if (highest > limit) return { ok: false, reason: `visible ${currency} ${highest.toFixed(2)} exceeds the authorized ${limit.toFixed(2)}`, amounts, limit };
  return { ok: true, amounts, limit, highest };
}

const successText = /payment (?:was )?(?:successful|complete|received|accepted)|thank you for your (?:order|payment)|order (?:number|reference|confirmed)|your order has been (?:placed|received|submitted|accepted)|checkout complete|payment confirmation number/i;
const failureText = /payment (?:was )?(?:declined|failed|unsuccessful|cancelled|canceled)|card (?:was )?declined|transaction (?:failed|declined)/i;
const verificationText = /3-?d ?secure|verify (?:it'?s you|your (?:identity|payment))|authenticat|approve (?:this|the) (?:payment|purchase)|banking app|one-time (?:pass)?code|security code sent/i;

// What the page says after the pay click. A bank check is a human step.
export function classifyPaymentResult(text) {
  if (failureText.test(text)) return "declined";
  if (successText.test(text)) return "succeeded";
  if (verificationText.test(text)) return "needs-bank-verification";
  return "pending";
}
