import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

const helper = fs.readFileSync(new URL("./authorized-contact-form.mjs", import.meta.url), "utf8");
const wrapper = fs.readFileSync(new URL("./authorized-contact-form-windows.ps1", import.meta.url), "utf8");
const profile = fs.readFileSync(new URL("./archive-request-profile.ps1", import.meta.url), "utf8");

test("archive contact forms stay in the shared Windows Chrome window", () => {
  assert.match(helper, /openSharedChromeTask/);
  assert.match(helper, /sharedChromeEndpoint/);
  assert.doesNotMatch(helper, /chromium\.launch|launchPersistentContext|newContext\(/);
  assert.match(wrapper, /FamilyHistorySubscriptionChromeSharedWindow/);
  assert.match(wrapper, /127\.0\.0\.1:9226/);
  assert.match(wrapper, /subscription-cdp-windows\.ps1/);
});

test("archive contact forms require exact authorization and approved canonical URLs", () => {
  assert.match(helper, /requestRecord\.guard\?\.requiredPhrase/);
  assert.match(helper, /confirmation !== route\.confirmationPhrase/);
  assert.match(helper, /requestRecord\.guard\?\.costMode !== "no-charge"/);
  assert.match(helper, /allowedUrls\.has\(request\.url\)/);
  assert.match(helper, /operationalState !== "authorized"/);
  assert.match(helper, /type: "submission-started"/);
  assert.match(helper, /type: "submission-confirmed"/);
});

test("provider adapters verify payloads and visible success before confirmation", () => {
  assert.match(helper, /submitPastPerfectFeedback/);
  assert.match(helper, /submitLebanonCountyForm/);
  assert.match(helper, /submitMclsForm/);
  assert.match(helper, /PastPerfect-visible-confirmation-dialog/);
  assert.match(helper, /Lebanon-County-visible-confirmation/);
  assert.match(helper, /MCLS-visible-confirmation/);
  assert.match(helper, /manual \$\{label\} CAPTCHA completion/);
  assert.doesNotMatch(helper, /screenshot|console\.log\([^\n]*(identity|displayName|firstName|lastName|email)/i);
});

test("a form without a CAPTCHA widget does not wait for one", () => {
  assert.match(helper, /awaitHumanCaptchaToken/);
  assert.match(helper, /if \(!await token\.count\(\) && !await widget\.count\(\)\) return;/);
});

test("manual MCLS CAPTCHA and provider-review failures leave the shared task tab open", () => {
  assert.match(helper, /let preserveTaskTab = false/);
  assert.match(helper, /preserveTaskTab = true/);
  assert.match(helper, /session\.leaveOpen\(\)/);
  assert.match(helper, /releasing the task connection without closing it/);
  assert.match(fs.readFileSync(new URL("./shared-chrome-task.mjs", import.meta.url), "utf8"), /async leaveOpen\(\)/);
});

test("requester locality fields stay in the DPAPI profile and reach Node over stdin", () => {
  assert.match(profile, /ProtectedData\]::Protect/);
  assert.match(profile, /DataProtectionScope\]::CurrentUser/);
  assert.match(profile, /Get-TreeLocalAppDataDirectory/);
  assert.match(wrapper, /archive-request-profile\.ps1/);
  assert.match(wrapper, /--contact-profile-stdin/);
  assert.match(helper, /readContactProfileFromStdin/);
  assert.doesNotMatch(wrapper, /--city|--state|--postal/i);
  assert.doesNotMatch(helper, /console\.log\([^\n]*contactProfile/);
});

test("the multi-word confirmation phrase survives the wrapper intact", () => {
  assert.match(wrapper, /\$nodeArgs = @\(/);
  assert.match(wrapper, /& node @nodeArgs/);
});

test("the requester profile is captured by the caller, never written to the console", () => {
  // [Console]::Out.Write bypasses the PowerShell success stream, so the caller
  // captures nothing and the value lands in the terminal and any log with it.
  assert.doesNotMatch(profile, /\[Console\]::Out\.Write/);
  assert.match(profile, /Write-Output \(\[System\.Text\.Encoding\]::UTF8\.GetString/);
});

test("locality fields handle a <select> and are initialized before the top-level await", () => {
  // fill() throws on a <select>; the state control on the MCLS form is one.
  assert.match(helper, /async function fillLocalityField/);
  assert.match(helper, /tag !== "select"/);
  assert.match(helper, /selectOption\(\{ value: match\.value \}\)/);
  assert.doesNotMatch(helper, /await state\.fill\(contactProfile\.state\)/);
  // A const in the temporal dead zone throws when the submit path runs.
  const statesAt = helper.indexOf("const US_STATES");
  const awaitAt = helper.indexOf("const session = await openSharedChromeTask");
  assert.ok(statesAt > -1 && statesAt < awaitAt, "US_STATES must be initialized before the top-level await");
});
