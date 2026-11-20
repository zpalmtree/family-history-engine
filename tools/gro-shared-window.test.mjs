import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

const gro = fs.readFileSync(new URL("./gro-order-frank.mjs", import.meta.url), "utf8");
const orderCheck = fs.readFileSync(new URL("./gro-check-orders.mjs", import.meta.url), "utf8");
const wrapper = fs.readFileSync(new URL("./gro-windows.ps1", import.meta.url), "utf8");
const savedCardAssist = fs.readFileSync(new URL("./gro-saved-card-assist.mjs", import.meta.url), "utf8");
const savedCardWrapper = fs.readFileSync(new URL("./gro-saved-card-windows.ps1", import.meta.url), "utf8");
const paymentRecovery = fs.readFileSync(new URL("./gro-payment-recover.mjs", import.meta.url), "utf8");

test("GRO has no standalone Chrome launch or TLS bypass path", () => {
  assert.doesNotMatch(gro, /launchPersistentContext|GRO_BROWSER_PROFILE_DIR|ignoreHTTPSErrors|acceptInsecureCerts/);
  assert.match(gro, /openSharedChromeTask/);
  assert.match(gro, /standalone profile and direct Chrome launches are disabled/);
  assert.match(gro, /JSON\.stringify\(sanitizeLogValue\(autoResult\)/);
  assert.match(gro, /parsed\.search = ""/);
  assert.match(gro, /parsed\.hash = ""/);
});

test("GRO order-status checks use the same shared-window task lifecycle", () => {
  assert.doesNotMatch(orderCheck, /launchPersistentContext|GRO_BROWSER_PROFILE_DIR|ignoreHTTPSErrors|acceptInsecureCerts/);
  assert.match(orderCheck, /openSharedChromeTask/);
  assert.match(orderCheck, /showForManualStep\("manual GRO sign-in"\)/);
  assert.match(orderCheck, /loadOrderTarget\(requestedTarget\)/);
  assert.match(orderCheck, /Standard-certificate target: no Online View control was inspected or clicked/);
  assert.match(orderCheck, /standalone profile and direct Chrome launches are disabled/);
});

test("GRO order search strips the printed COL prefix before filling the number field", () => {
  assert.match(orderCheck, /replace\(\/\^COL\\s\*\/i, ""\)\.split\("\/"\)/);
  const parts = "COL100001/2026".trim().replace(/^COL\s*/i, "").split("/");
  assert.deepEqual(parts, ["100001", "2026"]);
  assert.deepEqual("100005/2026".trim().replace(/^COL\s*/i, "").split("/"), ["100005", "2026"]);
});

test("GRO wrapper serializes against the sole shared Chrome window", () => {
  assert.match(wrapper, /FamilyHistorySubscriptionChromeSharedWindow/);
  assert.match(wrapper, /127\.0\.0\.1:9226/);
  assert.match(wrapper, /subscription-cdp-windows\.ps1/);
  assert.match(wrapper, /--shared-window/);
  assert.doesNotMatch(wrapper, /GRO_BROWSER_PROFILE_DIR|CHROME_PATH/);
});

test("GRO slug resumes and standard-certificate targets cannot enter the digital-image route", () => {
  assert.match(gro, /candidate\.slug === targetArg/);
  assert.match(gro, /targetWantsStandardCertificate\(activeTarget\)/);
  assert.match(gro, /order\\s\+a\\s\+digital\\s\+image/);
  assert.match(gro, /isCertificateRoute/);
  assert.match(gro, /selectGroApplicationBasics\(page, activeTarget\.country, activeTarget\.event\)/);
  assert.match(gro, /fillGroApplicationYear\(page, activeTarget\.year\)/);
  assert.match(gro, /purpose: "registration-year"/);
  assert.match(gro, /pressSequentially\(String\(targetYear\)/);
  assert.match(gro, /selectGroIdentificationMethod\(page\)/);
  assert.match(gro, /I know the GRO Index Reference/);
  assert.match(gro, /fill\.autoSubmitted/);
  assert.match(gro, /fillGroQuotedCertificateApplication\(page, result\)/);
  assert.match(gro, /#ServiceStdCert/);
  assert.match(gro, /Certificate Standard/);
  assert.match(gro, /certificate-quantity/);
  assert.match(gro, /isFinalPaymentControlLabel\(label\)/);
  assert.match(gro, /privacy\|policy\|terms\|help\|contact\|cancel\|back\|worldpay/);
  assert.match(gro, /tryRecoverUnavailableBasket\(page\)/);
  assert.match(gro, /basket-unavailable/);
  assert.match(gro, /tryCompleteWorldpayConfirmation\(page, costGuard\)/);
  assert.match(gro, /authorizedCostGuard\?\.amounts\?\.length/);
  assert.match(gro, /\^complete payment\$/);
  assert.match(gro, /year\\s\+in\\s\+which\\s\+the\\s\+event/);
  assert.match(gro, /fill-submit-no-advance/);
  assert.match(gro, /registration-jurisdiction/);
  assert.match(gro, /event-type/);
});

test("GRO saved-card assist is exact-target, cost-guarded, and cannot read or type card data", () => {
  assert.match(savedCardAssist, /deriveExternalRequest\(request\)/);
  assert.match(savedCardAssist, /requestState\.operationalState !== "authorized"/);
  assert.match(savedCardAssist, /request\.guard\.maxAmount/);
  assert.match(savedCardAssist, /Saved-card authorization/);
  assert.match(savedCardAssist, /worldpayPages\.length !== 1/);
  assert.match(savedCardAssist, /\(\?:payments\|hpp\)\\\.worldpay/);
  assert.match(savedCardAssist, /maxAmount > costGuardGbp/);
  assert.match(savedCardAssist, /cardFields\.length !== 1/);
  assert.match(savedCardAssist, /keyboard\.press\("ArrowDown"\)/);
  assert.match(savedCardAssist, /previewEnabledPayment/);
  assert.match(savedCardAssist, /if \(!previewState\.enabled\)/);
  assert.match(savedCardAssist, /inspectOnly/);
  assert.match(savedCardAssist, /keyboard\.press\("Enter"\)/);
  assert.match(savedCardAssist, /matches\(":-webkit-autofill"\)/);
  assert.doesNotMatch(savedCardAssist, /inputValue\(|\.fill\(|\.type\(|screenshot|SendKeys|mouse\./);
  assert.match(savedCardWrapper, /Get-CimInstance Win32_Process/);
  assert.match(savedCardWrapper, /gro-order-frank/);
  assert.match(savedCardWrapper, /FamilyHistoryGroSavedCardAssist/);
  assert.doesNotMatch(savedCardWrapper, /SendKeys|UIAutomation|mouse_event/);
});

test("GRO payment recovery can only finish a cost-guarded already-paid confirmation page", () => {
  assert.match(paymentRecovery, /\["authorized", "conflict-hold"\]\.includes/);
  assert.match(paymentRecovery, /requestState\.authorizationValid/);
  assert.match(paymentRecovery, /candidate\.paymentResult\?\.clicked === "Make Payment"/);
  assert.match(paymentRecovery, /candidate\.paymentResult\?\.ok === true/);
  assert.match(paymentRecovery, /Payment-recovery authorization/);
  assert.match(paymentRecovery, /Control\+Shift\+T/);
  assert.match(paymentRecovery, /worldpay-complete-payment/);
  assert.match(paymentRecovery, /Restored page looked like a new payment form; recovery click refused/);
  assert.match(paymentRecovery, /\^complete payment\$/);
  assert.doesNotMatch(paymentRecovery, /\.fill\(|\.type\(|inputValue\(|screenshot|SendKeys|mouse\./);
});
