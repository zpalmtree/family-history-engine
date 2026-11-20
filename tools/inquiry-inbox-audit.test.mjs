import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const helper = fs.readFileSync(new URL("./inquiry-inbox-audit.mjs", import.meta.url), "utf8");
const wrapper = fs.readFileSync(new URL("./inquiry-inbox-audit-windows.ps1", import.meta.url), "utf8");

test("sender-level inbox audits stay bounded in the one shared Windows Chrome window", () => {
  assert.match(helper, /openSharedChromeTask/);
  assert.match(helper, /sharedChromeEndpoint/);
  assert.match(helper, /Math\.min\(await page\.locator\("tr\.zA:visible"\)\.count\(\), 20\)/);
  assert.match(helper, /includeReplies/);
  assert.match(helper, /redact/);
  assert.match(helper, /new Set\(\["inbox", "anywhere"\]\)/);
  assert.doesNotMatch(helper, /chromium\.launch|launchPersistentContext|newContext\(|screenshot|download/);
  assert.match(wrapper, /FamilyHistorySubscriptionChromeSharedWindow/);
  assert.match(wrapper, /127\.0\.0\.1:9226/);
  assert.match(wrapper, /subscription-cdp-windows\.ps1/);
  assert.match(wrapper, /IncludeReplies/);
});

test("misidentified-record cleanup supports the generated public queue with verified-byte safeguards", () => {
  const cleanup = fs.readFileSync(new URL("./reject-misidentified-subscription-record.mjs", import.meta.url), "utf8");
  assert.match(cleanup, /public:[\s\S]*record-recovery-queue\.json/);
  assert.match(cleanup, /pendingStatus: "needs-alternate-route"/);
  assert.match(cleanup, /sha256 !== target\.sha256 \|\| contents\.length !== target\.length/);
  assert.match(cleanup, /fs\.unlinkSync/);
});

test("reply inspection opens the conversation through its subject, never the attachment preview", () => {
  const inspect = helper.slice(helper.indexOf("async function inspectThread"), helper.indexOf("function redact"));
  assert.match(inspect, /data-legacy-thread-id/);
  assert.match(inspect, /mail\.google\.com\/mail\/u\/0\/#all\/\$\{threadId\}/);
  assert.match(inspect, /\^\[0-9a-f\]\{8,32\}\$/);
  assert.match(inspect, /projector=/);
  assert.match(inspect, /locator\("div\.adn"\)/);
  assert.match(inspect, /locator\("div\.a3s"\)/);
  assert.match(inspect, /diagnostic/);
});
