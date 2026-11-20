import assert from "node:assert/strict";
import test from "node:test";

import { checkoutShowsPlan, invoiceTaxBasis, membershipPlan, offerLines, onAncestry, orderListLines, parseOrderList, paymentLines, paymentPageOrder, settleFromOrders } from "./ancestry-membership-order.mjs";

const plan = { tier: "World Explorer", term: "Monthly", offerId: "O-25371" };
const usd = { amount: 39.99, currency: "USD" };

test("a membership request must name a known tier, a term and an exact offer id", () => {
  assert.deepEqual(membershipPlan({ id: "r", spec: { plan } }), plan);
  assert.throws(() => membershipPlan({ id: "r", spec: {} }), /names no Ancestry plan/);
  assert.throws(() => membershipPlan({ id: "r", spec: { plan: { ...plan, tier: "Everything" } } }), /unknown Ancestry tier/);
  assert.throws(() => membershipPlan({ id: "r", spec: { plan: { tier: "World Explorer", term: "Monthly" } } }), /no exact Ancestry offer id/);
  assert.throws(() => membershipPlan({ id: "r", spec: { plan: { ...plan, offerId: "25371; drop" } } }), /no exact Ancestry offer id/);
});

test("only Ancestry's own HTTPS host counts as its site", () => {
  assert.equal(onAncestry("https://www.ancestry.com/offers/subscribe"), true);
  for (const url of ["https://secure.ancestry.com/checkout", "http://www.ancestry.com/offers/subscribe", "https://www.ancestry.com.example.org/checkout",
    "https://user@www.ancestry.com/checkout", "https://www.ancestry.com:8443/checkout", "https://www.ancestry.co.uk/checkout", "not a url"]) {
    assert.equal(onAncestry(url), false, url);
  }
});

test("a monthly order accepts only a page naming that tier alone and a monthly term", () => {
  const observedSummary = "Checkout Page\nWorld Explorer\nMonthly plan\nMonthly price\n$39.99*\n*Automatically renews at $39.99 plus applicable taxes every month beginning December 16, 2026, until you cancel.";
  const observedPayment = "Your order summary\nWorld Explorer Membership\n$39.99+ tax /month\nMonthly plan\nAdd Pro Tools for $10.00/month until you cancel.\nAutomatic Renewal: You will automatically be charged $39.99 plus applicable taxes every month beginning December 16, 2026 until you cancel.";
  assert.deepEqual(checkoutShowsPlan(observedSummary, plan), { ok: true });
  assert.deepEqual(checkoutShowsPlan(observedPayment, plan), { ok: true });
  assert.match(checkoutShowsPlan("All Access\nMonthly membership $59.99", plan).reason, /does not name World Explorer/);
  assert.match(checkoutShowsPlan("U.S. Discovery Membership\nMonthly plan\nUpgrade to World Explorer", plan).reason, /also names U\.S\. Discovery/);
  assert.match(checkoutShowsPlan("World Explorer\nMonthly plan\nOr choose All Access", plan).reason, /also names All Access/);
  for (const longer of ["6 month membership billed monthly $32.99/mo.", "Six-month commitment, per month", "6 mo. plan $29.99/mo.", "Annual membership, billed monthly",
    "1 year membership, $25 per month", "billed yearly, shown per month", "12 months at $30 a month", "3 months for $1 a month", "24 months, billed monthly",
    "18-month plan per month", "four months, then monthly", "$39.99 per month, $399 per year", "monthly or $399/yr", "billed quarterly, per month",
    "biannual plan, per month", "half-year plan, per month", "90 days, then monthly"]) {
    assert.match(checkoutShowsPlan(`World Explorer\n${longer}`, plan).reason, /longer term/, longer);
  }
  assert.match(checkoutShowsPlan("World Explorer\n$39.99", plan).reason, /does not show a monthly term/);
  assert.match(checkoutShowsPlan("World Explorer monthly", { ...plan, term: "6 month" }).reason, /no reviewed check/);
});

test("offer lines keep plan and price text and drop everything else", () => {
  const lines = offerLines("ZP\nNotifications\nWorld Explorer\nMonthly\n$39.99\nAuto Renewing. Cancel Anytime.\nSome account text");
  assert.deepEqual(lines, ["World Explorer", "Monthly", "$39.99", "Auto Renewing. Cancel Anytime."]);
});

test("payment lines hide stored-card lines whole and mask long digit runs", () => {
  const lines = paymentLines("Jane Example\n1 Example Street\nVisa ending in 4242\nExpires 08/27\nJane Example Mastercard 5555\nPayment method: card •••• 08/27\nCard 4111111111111111\nWorld Explorer Membership\n$39.99+ tax /month\nTotal due today $39.99\nPayment reference 123456789");
  assert.deepEqual(lines, ["(a stored card line)", "(a stored card line)", "(a stored card line)", "(a stored card line)", "(a stored card line)", "$39.99+ tax /month", "Total due today $39.99", "Payment reference ••••"]);
});

test("the payment page must be exactly the reviewed one: one product, the unticked add-on, one stored card", () => {
  const page = { controls: ["button: Remove Product", "button: Have a coupon?", "button: Edit", "button: Start membership"],
    inputs: ["input checkbox crossSell [unchecked]"], paymentLines: ["$39.99+ tax /month", "This card will be used for future purchases. You can update payment methods in Account Settings."] };
  assert.deepEqual(paymentPageOrder(page), { ok: true });
  assert.match(paymentPageOrder({ ...page, inputs: ["input checkbox crossSell [checked]"] }).reason, /add-on is ticked/);
  assert.match(paymentPageOrder({ ...page, inputs: [] }).reason, /not the one reviewed/);
  assert.match(paymentPageOrder({ ...page, inputs: undefined }).reason, /could not be read/);
  assert.match(paymentPageOrder({ ...page, inputs: [...page.inputs, "input radio paymentMethod [checked]"] }).reason, /not the one reviewed/);
  assert.match(paymentPageOrder({ ...page, inputs: [...page.inputs, "select  cardChoice"] }).reason, /not the one reviewed/);
  assert.match(paymentPageOrder({ ...page, inputs: [...page.inputs, "input text cc-number"] }).reason, /not the one reviewed/);
  assert.match(paymentPageOrder({ ...page, controls: [...page.controls, "button: Remove Product"] }).reason, /2 removable product/);
  assert.match(paymentPageOrder({ ...page, controls: ["button: Start membership"] }).reason, /0 removable product/);
  assert.match(paymentPageOrder({ ...page, paymentLines: ["$39.99+ tax /month"] }).reason, /stored card/);
});

test("the tax basis needs one invoice for the same tier with zero tax and the authorized total", () => {
  const observed = "Invoice\nWorld Explorer Membership\n$39.99\nDiscount\n$0.00\nTax\n$0.00\nTotal\n$39.99\nPayment method\n$39.99";
  assert.deepEqual(invoiceTaxBasis(observed, usd, "World Explorer"), { ok: true, tax: 0, total: 39.99 });
  assert.deepEqual(invoiceTaxBasis("World Explorer Membership\nTax $0.00\nTotal $39.99", usd, "World Explorer"), { ok: true, tax: 0, total: 39.99 });
  assert.match(invoiceTaxBasis("World Explorer\nTax\n$2.80\nTotal\n$42.79", usd, "World Explorer").reason, /charged \$2\.80 tax/);
  assert.match(invoiceTaxBasis("World Explorer\nTax\n$0.00\nTotal\n$32.99", usd, "World Explorer").reason, /total \$32\.99 is not the authorized \$39\.99/);
  assert.match(invoiceTaxBasis("All Access Membership\nTax\n$0.00\nTotal\n$39.99", usd, "World Explorer").reason, /does not name World Explorer/);
  assert.match(invoiceTaxBasis("World Explorer\nAll Access\nTax\n$0.00\nTotal\n$39.99", usd, "World Explorer").reason, /names another membership/);
  for (const ambiguous of ["World Explorer\nSubtotal\n$39.99\nTotal\n$39.99", "World Explorer\nTax\nincluded\nTotal\n$39.99", "World Explorer",
    "World Explorer\nTax $0.00\nTotal $39.99\nTax $2.80\nTotal $42.79", "World Explorer\nTotal before tax $39.99\nTax $0.00\nSales tax $2.80\nTotal $42.79"]) {
    assert.match(invoiceTaxBasis(ambiguous, usd, "World Explorer").reason, /exactly one tax line and one total line/, ambiguous);
  }
  assert.match(invoiceTaxBasis("Tax\n0.00\nTotal\n39.99", { amount: 39.99, currency: "CAD" }).reason, /no reviewed check/);
});

test("an order is settled from the account's order history, never from page wording", () => {
  const beforeText = "Account settingsOrder history\nOrder history\nJuly 13 , 2026\nOrder# 123456789\n$39.99\nWorld Explorer Membership\nOrders 1 - 1 of 1";
  const afterText = "Order history\nNovember 16 , 2026\nOrder# 987654321\n$39.99\nWorld Explorer Membership\nJuly 13 , 2026\nOrder# 123456789\n$39.99\nWorld Explorer Membership\nOrders 1 - 2 of 2";
  const before = parseOrderList(beforeText, "USD");
  const after = parseOrderList(afterText, "USD");
  assert.deepEqual(before, { total: 1, orders: [{ date: "July 13, 2026", amount: 39.99, product: "World Explorer Membership" }] });
  assert.equal(after.total, 2);
  assert.deepEqual(after.orders[0], { date: "November 16, 2026", amount: 39.99, product: "World Explorer Membership" });
  assert.equal(settleFromOrders(before, after, plan, usd), "placed");
  assert.equal(settleFromOrders(before, before, plan, usd), "not-placed");
  assert.equal(settleFromOrders(before, parseOrderList(afterText.replace("$39.99\nWorld Explorer Membership\nJuly", "$42.79\nWorld Explorer Membership\nJuly"), "USD"), plan, usd), "unclear", "a different amount");
  assert.equal(settleFromOrders(before, parseOrderList(afterText.replace("World Explorer Membership\nJuly", "All Access Membership\nJuly"), "USD"), plan, usd), "unclear", "a different product");
  assert.equal(settleFromOrders(before, { total: 3, orders: after.orders }, plan, usd), "unclear", "two new orders");
  assert.equal(settleFromOrders({ total: null, orders: [] }, after, plan, usd), "unclear", "the list was not read before");
  assert.equal(settleFromOrders(before, { total: null, orders: [] }, plan, usd), "unclear", "the list was not read after");
  assert.deepEqual(orderListLines(afterText), ["November 16 , 2026", "$39.99", "World Explorer Membership", "July 13 , 2026", "$39.99", "World Explorer Membership", "Orders 1 - 2 of 2"]);
});
