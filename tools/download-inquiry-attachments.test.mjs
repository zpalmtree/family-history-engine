import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

const helper = fs.readFileSync(new URL("./download-inquiry-attachments.mjs", import.meta.url), "utf8");
const wrapper = fs.readFileSync(new URL("./download-inquiry-attachments-windows.ps1", import.meta.url), "utf8");

test("inquiry downloads require a reported delivery and exact canonical attachment bindings", () => {
  assert.match(helper, /derived\.operationalState !== "delivery-reported"/);
  assert.match(helper, /itemRoute\.deliveryArtifacts/);
  assert.match(helper, /artifact\.replyMessageId/);
  assert.match(helper, /exactReplyMessage/);
  assert.match(helper, /openExactReplyThread/);
  assert.match(helper, /request\.responseBinding\?\.subjectAliases/);
  assert.match(helper, /in:anywhere -in:drafts subject:/);
  assert.match(helper, /download\.suggestedFilename\(\) !== artifact\.providerFilename/);
  assert.match(helper, /Archive collision/);
});

test("inquiry downloads use one shared Windows window and EFS archive without screenshots", () => {
  assert.match(helper, /openSharedChromeTask/);
  assert.match(helper, /cipher\.exe/);
  assert.doesNotMatch(helper, /screenshot|chromium\.launch|launchPersistentContext|newContext\(/);
  assert.match(wrapper, /FamilyHistorySubscriptionChromeSharedWindow/);
  assert.match(wrapper, /127\.0\.0\.1:9226/);
});

test("inquiry downloads support exactly filename-bound HTTPS ticket links", () => {
  assert.match(helper, /exactLinkedAttachmentUrl\(message, artifact\.providerFilename\)/);
  assert.match(helper, /text !== providerFilename/);
  assert.match(helper, /parsed\.protocol !== "https:"/);
  assert.match(helper, /matches\.length === 1/);
  assert.match(helper, /page\.context\(\)\.request\.get\(linkedAttachmentUrl/);
  assert.doesNotMatch(helper, /console\.log\([^\n]*linkedAttachmentUrl/);
});

test("inquiry downloads can reopen generic provider threads safely", () => {
  assert.match(helper, /responseSubjectQueries/);
  assert.match(helper, /matchTerms/);
  assert.match(helper, /alias without safe request-specific match terms/);
});

test("a batch request collects artifacts from every canonical item target", () => {
  // One provider thread can answer several targets at once; binding only a
  // target named for the request would strand every other item in the batch.
  assert.match(helper, /request\.items \|\| \[\]\)\.map\(\(item\) => item\.targetId\)/);
  assert.match(helper, /for \(const targetId of targetIds\)/);
  assert.match(helper, /\^\[a-z0-9\]\[a-z0-9-\]\{0,127\}\$/);
});

test("a provider filename may carry diacritics but never a path", () => {
  // The Hauptstaatsarchiv Stuttgart's scan arrived as "E 146_Bü 1790.pdf" and
  // was refused by an ASCII-only rule. German and Italian archives send
  // diacritics routinely; traversal must still be impossible.
  assert.match(helper, /\\p\{L\}/);
  assert.match(helper, /path\.basename\(value\) === value/);
  assert.match(helper, /jpe\?g\|pdf/);
});

test("a provider filename's extension is matched without regard to case", () => {
  // The Norris Museum's camera photographs arrived as "IMG_2224.JPG" and were
  // refused by a lowercase-only extension rule.
  const source = helper.match(/function safeFilename\(value\) \{[\s\S]*?&& \/(.+)\/([a-z]+)\.test\(value\);/);
  assert.ok(source, "safeFilename regex not found");
  const rule = new RegExp(source[1], source[2]);
  for (const ok of ["IMG_2224.JPG", "scan.Pdf", "E 146_Bü 1790.pdf", "letter.jpeg"]) assert.ok(rule.test(ok), ok);
  for (const bad of ["../x.jpg", "x.png", ".jpg", "a/b.JPG"]) assert.ok(!rule.test(bad) || bad.includes("/"), bad);
});

test("inquiry downloads read each same-subject conversation but take attachments only from the bound message", () => {
  // Gmail split the Hunts Archives correspondence into two conversations with
  // one subject (19 Nov 2026); the downloader must try each, not refuse.
  assert.doesNotMatch(helper, /More than one exact response thread matched/);
  assert.match(helper, /for \(let ordinal = 0; ordinal < matchCount; ordinal \+= 1\)/);
  assert.match(helper, /matches\.length !== matchCount/);
  assert.match(helper, /const message = await exactReplyMessage\(page, messageId\);\n\s+if \(message\) return message;/);
});
