import "./test-tree-config.mjs";
import fs from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";

import { externalRequestPayloadSha256 } from "./external-request-store.mjs";
import { canonicalSubject, planInboxTidy, requestTidyStatus, senderAddress } from "./inbox-tidy-lib.mjs";

function request(id, events, { subject = "Availability and quote: one register entry, 1803", kind = "no-charge-email", scope } = {}) {
  const record = {
    schemaVersion: 1, id, provider: "Record Office", kind,
    items: [{ id, targetId: id, routeId: id }],
    spec: { channel: "email", recipient: "office@example.gov.uk", subject, body: "Hello" },
    guard: { requiredPhrase: `SUBMIT ${id}`, costMode: "no-charge" },
    revision: events.length,
    events: [],
    ...(scope ? { researchScope: scope } : {}),
  };
  record.payloadSha256 = externalRequestPayloadSha256(record);
  record.events = events.map((event, index) => ({ id: `event-${index}`, ...event,
    ...(event.type === "authorization-confirmed" ? { phrase: `SUBMIT ${id}`, payloadSha256: record.payloadSha256 } : {}) }));
  return record;
}

const sent = [
  { type: "authorization-confirmed", at: "2026-11-15T11:31:00Z" },
  { type: "submission-started", at: "2026-11-15T11:32:00Z" },
  { type: "submission-confirmed", at: "2026-11-15T11:33:00Z" },
];

test("subjects match across reply, auto-reply and dash variants", () => {
  assert.equal(canonicalSubject("RE: Re: Availability and quote: Castle Donington – 1803"), "availability and quote: castle donington - 1803");
  assert.equal(canonicalSubject("Automatic reply: AW: [Extern] Anfrage"), "anfrage");
  assert.equal(senderAddress('"Hunts Archives" <Hunts.Archives@cambridgeshire.gov.uk>'), "hunts.archives@cambridgeshire.gov.uk");
});

test("a classified reply is archived; an unclassified or newer one stays", () => {
  const acknowledged = request("r1", [...sent, { type: "provider-acknowledged", at: "2026-11-16T10:14:00Z", basis: "gmail-message-1a1e3bdd240233a2" }]);
  assert.equal(requestTidyStatus(acknowledged).archivable, true);
  const reply = { id: "a", subject: "RE: Availability and quote: one register entry, 1803", senderEmail: "office@example.gov.uk", dateMs: Date.parse("2026-11-16T09:00:00Z") };
  const later = { ...reply, id: "b", dateMs: Date.parse("2026-11-17T14:31:00Z") };
  const plan = planInboxTidy({ messages: [reply, later], requests: [acknowledged] });
  assert.deepEqual(plan.archive.map((m) => m.id), ["a"]);
  assert.deepEqual(plan.keep.map((m) => [m.id, m.reason]), [["b", "newer than the request's last recorded event"]]);

  const untriaged = request("r2", [...sent, { type: "provider-reply-received", at: "2026-11-16T10:07:00Z", basis: "gmail-message-1a1e3bdd240233a2", messageId: "1a1e3bdd240233a2" }]);
  const kept = planInboxTidy({ messages: [reply], requests: [untriaged] });
  assert.equal(kept.archive.length, 0);
  assert.equal(kept.keep[0].reason, "untriaged provider reply");
});

test("mail waiting on the user's decision and other scopes stay in the inbox", () => {
  const asked = request("r3", [...sent, { type: "provider-information-required", at: "2026-11-16T10:00:00Z", basis: "gmail-message-1a1e3bdd240233a2" }]);
  const message = { id: "c", subject: "Re: Availability and quote: one register entry, 1803", senderEmail: "office@example.gov.uk", dateMs: Date.parse("2026-11-16T09:00:00Z") };
  assert.match(planInboxTidy({ messages: [message], requests: [asked] }).keep[0].reason, /waiting on the user \(information-required\)/);
  const detailed = request("r4", [...sent, { type: "provider-acknowledged", at: "2026-11-16T10:00:00Z" }], { scope: "collateral" });
  assert.equal(planInboxTidy({ messages: [message], requests: [detailed] }).archive.length, 0);
});

test("unmatched mail is never touched; receipts need a recorded payment", () => {
  const paid = request("r5", [...sent]);
  const personal = { id: "d", subject: "Dinner on Friday", senderEmail: "friend@example.com", dateMs: Date.parse("2026-11-16T09:00:00Z") };
  const receipt = { id: "e", subject: "WorldPay Card Transaction Confirmation - GRO", senderEmail: "do-not-reply@worldpay.com", dateMs: Date.parse("2026-11-15T12:00:00Z") };
  const strayReceipt = { ...receipt, id: "f", dateMs: Date.parse("2026-11-01T12:00:00Z") };
  const download = { id: "g", subject: "Your order from The National Archives. Transaction reference: C/1", senderEmail: "digitaldownloads@nationalarchives.gov.uk", dateMs: Date.parse("2026-11-15T12:00:00Z") };
  const pageCheck = { id: "h", subject: "Page check RC8610175 successful", senderEmail: "recordcopying@nationalarchives.gov.uk", dateMs: Date.parse("2026-11-11T12:00:00Z") };
  const plan = planInboxTidy({ messages: [personal, receipt, strayReceipt, download, pageCheck], requests: [paid], now: Date.parse("2026-11-18T12:00:00Z") });
  assert.deepEqual(plan.archive.map((m) => m.id).sort(), ["e", "g"]);
  assert.deepEqual(plan.keep.map((m) => m.id), ["f"]);
});

test("both tidy tools mark processed mail read before moving it", () => {
  const imap = fs.readFileSync(new URL("./personal-mailbox-tidy-windows.ps1", import.meta.url), "utf8");
  const gmail = fs.readFileSync(new URL("./gmail-inbox-tidy.mjs", import.meta.url), "utf8");
  assert.ok(imap.indexOf("+FLAGS.SILENT (\\Seen)") > 0 && imap.indexOf("+FLAGS.SILENT (\\Seen)") < imap.indexOf("UID MOVE"));
  assert.ok(gmail.indexOf('[act="1"]') > 0 && gmail.indexOf('[act="1"]') < gmail.indexOf('const act = action === "archive"'));
});

test("mail archived before it was marked read can be found and marked read, never moved", () => {
  const imap = fs.readFileSync(new URL("./personal-mailbox-tidy-windows.ps1", import.meta.url), "utf8");
  const gmail = fs.readFileSync(new URL("./gmail-inbox-tidy.mjs", import.meta.url), "utf8");
  const markreadImap = imap.slice(imap.indexOf('if ($Mode -eq "markread")'), imap.indexOf("move needs"));
  assert.match(markreadImap, /SELECT "INBOX\.Archive"/);
  assert.match(markreadImap, /message-id mismatch or gone/);
  assert.doesNotMatch(markreadImap, /UID MOVE|UID COPY|EXPUNGE|Deleted/);
  assert.match(imap, /\[ValidateSet\("INBOX", "INBOX\.Archive"\)\]/);
  const markreadGmail = gmail.slice(gmail.indexOf('mode === "markread"'), gmail.indexOf("--mode must be"));
  assert.match(markreadGmail, /\[act="1"\]/);
  assert.doesNotMatch(markreadGmail, /act="7"|act="10"/);
  assert.match(markreadGmail, /#inbox/);
  assert.match(gmail, /-in%3Ainbox\+is%3Aunread\+-in%3Aspam\+-in%3Atrash/);
});
