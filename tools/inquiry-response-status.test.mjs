import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

const helper = fs.readFileSync(new URL("./inquiry-response-status.mjs", import.meta.url), "utf8");
const wrapper = fs.readFileSync(new URL("./inquiry-response-status-windows.ps1", import.meta.url), "utf8");

test("inquiry response checks stay read-only in the shared Windows Chrome window", () => {
  assert.match(helper, /openSharedChromeTask/);
  assert.match(helper, /sharedChromeEndpoint/);
  // Monitoring covers a plain external wait and an accepted quote still owed
  // its payment instructions; nothing else may poll a provider's thread.
  assert.match(helper, /!\["waiting-external", "awaiting-payment-instructions"\]\.includes\(derived\.operationalState\)/);
  assert.match(helper, /subject:\"\$\{responseSubject/);
  assert.match(helper, /in:inbox subject:/);
  assert.match(helper, /getByText\(responseSubject, \{ exact: false \}\)/);
  assert.doesNotMatch(helper, /from:\(\$\{request\.spec\.recipient\}\)/);
  assert.doesNotMatch(helper, /-from:\(me\)|-in:sent|span\.bqe/);
  assert.doesNotMatch(helper, /screenshot|innerText|textContent|download|click\(|submission-|appendExternalRequestEvent/);
  assert.doesNotMatch(helper, /chromium\.launch|launchPersistentContext|newContext\(/);
  assert.match(wrapper, /FamilyHistorySubscriptionChromeSharedWindow/);
  assert.match(wrapper, /127\.0\.0\.1:9226/);
  assert.match(wrapper, /subscription-cdp-windows\.ps1/);
});

test("inquiry response checks do not assume that replies use the original recipient address", () => {
  assert.match(helper, /staff member, ticketing system, or alternate institutional/);
  assert.match(helper, /original submitted[\s\S]*lives in Sent/);
  assert.doesNotMatch(helper, /const query = `from:|innerText|textContent/);
});

test("inquiry response checks disclose only state and match count", () => {
  assert.match(helper, /state: "manual-signin-required", matchCount: 0/);
  assert.match(helper, /state: matchCount > 0 \? "response-present" : "no-response"/);
  assert.doesNotMatch(helper, /snippet|messageBody|senderName|attachmentName/);
});

test("inquiry response checks bind generic ticket subjects with request-specific terms", () => {
  assert.match(helper, /responseBinding\?\.subjectAliases/);
  assert.match(helper, /responseBinding\?\.matchTerms/);
  assert.match(helper, /responseStatusQueries/);
  assert.match(helper, /subject:\s*alias/);
});

test("a form-channel request is monitored through its canonical response subject", () => {
  // A provider replies by email whether the request left as an email or a web
  // form, so the outbound channel must not decide whether a reply can be seen.
  assert.match(helper, /"no-charge-email", "no-charge-form"/);
  assert.match(helper, /request\.spec\?\.subject \|\| request\.responseBinding\?\.subject/);
  assert.match(helper, /requestChannel === "email" && !request\.spec\.recipient/);
  assert.match(helper, /request\.kind === "no-charge-form" \? "form" : "email"/);
});
