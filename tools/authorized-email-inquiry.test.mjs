import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

const helper = fs.readFileSync(new URL("./submit-authorized-email-inquiry.mjs", import.meta.url), "utf8");
const wrapper = fs.readFileSync(new URL("./authorized-email-inquiry-windows.ps1", import.meta.url), "utf8");

test("archive inquiries stay in the shared Windows Chrome window", () => {
  assert.match(helper, /openSharedChromeTask/);
  assert.match(helper, /sharedChromeEndpoint/);
  assert.match(helper, /taskLabel: "authorized archive email inquiry"/);
  assert.doesNotMatch(helper, /chromium\.launch|launchPersistentContext|newContext\(/);
  assert.match(wrapper, /FamilyHistorySubscriptionChromeSharedWindow/);
  assert.match(wrapper, /127\.0\.0\.1:9226/);
  assert.match(wrapper, /subscription-cdp-windows\.ps1/);
});

test("archive inquiries require exact authorization and refuse duplicate state", () => {
  assert.match(helper, /deriveExternalRequest\(requestRecord\)/);
  assert.match(helper, /requestState\.operationalState !== "authorized"/);
  assert.match(helper, /requestRecord\.guard\.requiredPhrase/);
  assert.match(helper, /confirmation !== route\.confirmationPhrase/);
  assert.match(helper, /type: "submission-started"/);
  assert.match(helper, /type: "submission-confirmed"/);
  assert.match(helper, /type: "provider-information-supplied"/);
  assert.match(helper, /--information-reply-stdin/);
  assert.match(helper, /readRequesterInformation/);
  assert.match(helper, /in:anywhere/);
  assert.match(helper, /in:anywhere -in:drafts subject:/);
  assert.match(helper, /@cambridgeshire\\\.gov\\\.uk/);
  assert.match(helper, /racine_reference@racinelibrary\\\.info/);
  assert.match(helper, /cac@libanswers\\\.bgsu\\\.edu/);
  assert.match(helper, /Kuester\\\.Grimme@gmail\\\.com/);
  assert.match(helper, /Wolfenbuettel@nla\\\.niedersachsen\\\.de/);
  assert.match(helper, /watervillehistory@outlook\\\.com/);
  assert.match(helper, /genealogy@slcl\\\.org/);
  assert.match(helper, /recordscenter@co\\\.delaware\\\.oh\\\.us/);
  assert.match(helper, /paula@walkerfuneralhomes\\\.com/);
  assert.match(helper, /archive@cuyahogacounty\\\.gov/);
  assert.match(helper, /norwalk@norwalk\\\.lib\\\.oh\\\.us/);
  assert.match(helper, /archives@uwp\\\.edu/);
  assert.match(helper, /archiviomonreale@archiviomonreale\\\.sicilia\\\.it/);
  assert.match(helper, /refdesk@history\\\.pcusa\\\.org/);
  assert.match(helper, /eamspacker@mifflincountypa\\\.gov/);
  assert.match(helper, /approvedProviderRecipients\.some/);
  assert.match(helper, /data-hovercard-id/);
  assert.match(helper, /getByText\(request\.recipient, \{ exact: true \}\)/);
  assert.match(helper, /composeUrl\.searchParams\.set\("to", request\.recipient\)/);
  assert.match(helper, /composeUrl\.searchParams\.set\("su", request\.subject\)/);
  assert.match(helper, /composeUrl\.searchParams\.set\("body", request\.body\)/);
  assert.match(helper, /normalizedVerificationText\(await body\.innerText\(\)\)/);
  assert.match(helper, /message sent/i);
  assert.match(wrapper, /InformationReply/);
  assert.match(wrapper, /Read-Host .* -AsSecureString/);
  assert.match(wrapper, /ZeroFreeBSTR/);
  assert.ok(
    wrapper.indexOf('Read-Host "Enter the authorized requester information" -AsSecureString')
      < wrapper.indexOf("$browserMutex.WaitOne(180000)"),
    "requester information must be collected before the shared-browser mutex is acquired"
  );
  assert.match(wrapper, /RedirectStandardInput = \$null -ne \$StandardInputValue/);
  assert.match(wrapper, /StandardInput\.Close\(\)/);
  assert.match(wrapper, /WaitForExit\(\$TimeoutMilliseconds\)/);
  assert.doesNotMatch(wrapper, /--requester-information/);
});

test("archive inquiry automation does not capture account or contact screenshots", () => {
  assert.doesNotMatch(helper, /screenshot|inputValue\(.*email|password|token|secret/i);
  assert.doesNotMatch(helper, /console\.log\([^\n]*requesterInformation/);
  assert.match(helper, /await session\.close\(\)/);
});

test("a clarification reply answers a provider question without composing a new message", () => {
  // Monroe County asked us a question about a citation we got wrong. Answering
  // must stay possible after the request is withdrawn, must never type an
  // address, and must not be mistaken for a fresh submission.
  assert.match(helper, /clarification-reply-stdin/);
  assert.match(helper, /replyInBoundThread/);
  assert.match(helper, /has no outstanding provider question/);
  assert.match(helper, /const replyOnly = informationReply \|\| clarificationReply/);
  assert.match(helper, /!replyOnly && requestState\.operationalState !== "authorized"/);
  assert.match(helper, /!replyOnly && !approvedProviderRecipients/);
  // The holding guard protects new outbound requests; a reply is exactly what
  // you owe someone when the citation was wrong.
  assert.match(helper, /replyOnly \? \[\] : foreignHoldingClaims/);
  // The reply is bound by thread and provider sender, never by a typed address.
  assert.match(helper, /Expected exactly one bound thread/);
  assert.match(helper, /The bound thread holds no provider message/);
  assert.doesNotMatch(helper, /clarification[\s\S]{0,80}recipient:/i);
});
