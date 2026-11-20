import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

const helper = fs.readFileSync(new URL("./inspect-inquiry-response.mjs", import.meta.url), "utf8");
const wrapper = fs.readFileSync(new URL("./inspect-inquiry-response-windows.ps1", import.meta.url), "utf8");

test("response inspection is bound to a reported canonical request in the shared Windows window", () => {
  assert.match(helper, /\["waiting-external", "awaiting-payment-instructions", "delivery-reported", "information-required", "fee-quote-hold", "paid-followup-authorized", "complete"\]/);
  assert.match(helper, /later reply in the same/);
  assert.match(helper, /openSharedChromeTask/);
  // A recorded Gmail hex message id opens the exact conversation read-only when
  // the bound subject no longer finds it (a retitled or pre-recorded binding).
  assert.match(helper, /valueAfter\("--message-id"\)/);
  assert.match(helper, /\/\^\[0-9a-f\]\{12,20\}\$\/\.test\(messageIdArg\)/);
  assert.match(helper, /#all\/\$\{messageIdArg\}/);
  assert.match(wrapper, /\[string\]\$MessageId = ""/);
  assert.match(wrapper, /"--message-id", \$MessageId/);
  assert.doesNotMatch(helper, /chromium\.launch|launchPersistentContext|newContext\(/);
  assert.match(wrapper, /FamilyHistorySubscriptionChromeSharedWindow/);
  assert.match(wrapper, /127\.0\.0\.1:9226/);
});

test("response inspection supports exact-subject replies to canonical contact forms", () => {
  assert.match(helper, /"no-charge-email", "no-charge-form", "paid-library-request"/);
  assert.match(helper, /request\.spec\?\.subject \|\| request\.responseBinding\?\.subject/);
  assert.match(helper, /request\.responseBinding\?\.subjectAliases/);
  assert.match(helper, /subjectBinding/);
  assert.match(helper, /uniqueEntries/);
  assert.match(helper, /has no safe canonical response subject binding/);
  assert.match(helper, /canonicalBodyPrefix && body/);
});

test("response inspection supports paid archive inquiries after guarded submission", () => {
  assert.match(helper, /"paid-library-request"/);
  assert.match(helper, /canonical email or form inquiry/);
});

test("response inspection does not capture screenshots or disclose contact coordinates", () => {
  assert.doesNotMatch(helper, /screenshot/);
  assert.match(helper, /\[email redacted\]/);
  assert.match(helper, /\[phone redacted\]/);
  assert.match(helper, /attachmentCount/);
  assert.match(helper, /replyCount/);
  assert.match(helper, /embeddedForwardCount/);
  assert.match(helper, /messageCount/);
  assert.match(helper, /requesterMessageCount/);
  assert.match(helper, /in:anywhere/);
  assert.match(helper, /in:anywhere -in:drafts subject:/);
  assert.doesNotMatch(helper, /`in:anywhere subject:/);
  assert.match(helper, /canonicalizeSubject/);
  assert.match(helper, /subjectSearchTerms/);
  assert.match(helper, /re\|fw\|fwd/);
  // Every exact-subject conversation is opened by thread id and read, since
  // Gmail can split one correspondence into several (Hunts, 19 Nov 2026).
  assert.match(helper, /searchForCanonicalThreads/);
  assert.match(helper, /data-legacy-thread-id/);
  assert.match(helper, /for \(const \[threadIndex, threadId\] of threadIds\.entries\(\)\)/);
  assert.match(helper, /data-legacy-thread-id="\$\{threadId\}"/);
  assert.match(helper, /state: "hidden"/);
  assert.doesNotMatch(helper, /inboundCandidates/);
  assert.match(helper, /senderName/);
  assert.match(helper, /canonicalBodyPrefix/);
  assert.match(helper, /Expand all/);
  assert.match(helper, /expandClippedMessage\(message\)/);
  assert.match(helper, /View entire message/);
  assert.match(helper, /Show trimmed content/);
  assert.match(helper, /senderEmail === requesterEmail/);
  assert.match(helper, /currentAccountEmail/);
  assert.match(helper, /messageId/);
  assert.match(helper, /\[postal address redacted\]/);
});

test("response inspection counts filename-bound HTTPS ticket-system attachments", () => {
  assert.match(helper, /exactLinkedAttachmentLabels\(message\)/);
  assert.match(helper, /message\.locator\("a\[href\]"\)/);
  assert.match(helper, /safeAttachmentLabel/);
  assert.match(helper, /parsed\.protocol !== "https:"/);
  assert.doesNotMatch(helper, /attachmentLabels[^\n]*href/);
});

test("response inspection binds generic provider subjects with request-specific terms", () => {
  assert.match(helper, /responseSubjectQueries/);
  assert.match(helper, /responseMatchTerms/);
  assert.match(helper, /request-specific match terms/);
});

test("response inspection rejects Gmail preview labels that repeat one attachment filename", () => {
  assert.match(helper, /value\.match\(\/\\\.\(\?:jpe\?g\|png\|tiff\?\|pdf\)\\b\/gi\)/);
  assert.match(helper, /never manufacture duplicate delivery artifacts from preview UI/);
});

test("a missing subject alias is not treated as a missing reply", () => {
  // Ticket systems sometimes retitle a thread, so a request can carry alias
  // subjects. BGSU answered on 27 Jul 2026 under the original subject while an
  // alias went unused; demanding a thread for every alias discarded a reply
  // that had already been found.
  assert.match(helper, /An alias is an alternative title/);
  assert.match(helper, /matchedSubjects/);
  assert.match(helper, /subjectIndex < canonicalSubjects\.length - 1 \|\| matchedSubjects/);
});
