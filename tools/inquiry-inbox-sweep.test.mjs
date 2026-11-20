import "./test-tree-config.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  appendExternalRequestEvent,
  deriveExternalRequest,
  externalRequestPayloadSha256,
  projectExternalRequestOntoRoute,
  untriagedReplyIds,
  validateExternalRequest
} from "./external-request-store.mjs";
import { gmailMessageTime, inboxStatus, newReplies, recordedMessageIds, replyReceivedEvent, sweepEligible } from "./inquiry-inbox-sweep-lib.mjs";
import { reconcileAcquisitionTarget } from "./research-acquisition.mjs";

function waitingRequest() {
  let request = {
    schemaVersion: 1,
    id: "test-request",
    provider: "Test archive",
    kind: "no-charge-email",
    items: [{ id: "item", targetId: "target", routeId: "route" }],
    spec: { channel: "email", recipient: "archive@example.test", subject: "Lookup", body: "Please check." },
    guard: { requiredPhrase: "SUBMIT test-request", costMode: "no-charge" },
    payloadSha256: "",
    revision: 0,
    events: []
  };
  request.payloadSha256 = externalRequestPayloadSha256(request);
  for (const event of [
    { type: "authorization-confirmed", phrase: request.guard.requiredPhrase, payloadSha256: request.payloadSha256, at: "2026-11-01T00:00:00.000Z" },
    { type: "submission-started", at: "2026-11-01T00:00:01.000Z" },
    { type: "submission-confirmed", at: "2026-11-01T00:00:02.000Z", basis: "gmail-message-1a0000000000aaaa" }
  ]) request = appendExternalRequestEvent(request, event);
  return request;
}

const reply = (messageId, extra = {}) => ({ messageId, senderName: "Archivist", attachmentLabels: [], ...extra });

test("the sweep reads only open email or form requests in scope", () => {
  const request = waitingRequest();
  assert.equal(sweepEligible(request), true);
  assert.equal(sweepEligible({ ...request, researchScope: "collateral" }), false);
  assert.equal(sweepEligible({ ...request, kind: "paid-order" }), false);
  let complete = request;
  for (const event of [
    { type: "delivery-reported", at: "2026-11-02T00:00:00.000Z" },
    { type: "delivery-item-imported", itemId: "item", routeStatus: "not-found", at: "2026-11-02T00:00:01.000Z" },
    { type: "delivery-complete", at: "2026-11-02T00:00:02.000Z" }
  ]) complete = appendExternalRequestEvent(complete, event);
  assert.equal(sweepEligible(complete), false);
});

// Gmail legacy ids encode the send time: ms << 20.
const idAt = (iso) => (BigInt(Date.parse(iso)) << 20n).toString(16);

test("a Gmail legacy message id dates its message", () => {
  assert.equal(gmailMessageTime("1a1d0dec9a2dd5a8").toISOString(), "2026-11-12T17:47:03.970Z");
  assert.equal(gmailMessageTime(idAt("2026-11-02T00:00:00.000Z")).toISOString(), "2026-11-02T00:00:00.000Z");
  assert.equal(gmailMessageTime("not-hex"), null);
});

test("a reply is new only when uncited and sent after the latest classification event", () => {
  const cited = idAt("2026-11-05T00:00:00.000Z");
  const request = appendExternalRequestEvent(waitingRequest(), {
    type: "provider-acknowledged", at: "2026-11-05T00:00:00.000Z",
    note: `Acknowledged in gmail-message-${cited}.`
  });
  assert.equal(recordedMessageIds(request).has(cited), true);
  const olderUncited = idAt("2026-11-04T00:00:00.000Z");
  const withinTolerance = idAt("2026-11-05T00:01:30.000Z");
  const fresh = idAt("2026-11-06T00:00:00.000Z");
  const inspection = { replies: [reply(cited), reply(olderUncited), reply(withinTolerance), reply(fresh), reply("not-a-hex-id")] };
  assert.deepEqual(newReplies(request, inspection).map((item) => item.messageId), [fresh]);
  // A reminder is neutral: it does not mark a later-arriving reply as read.
  const reminded = appendExternalRequestEvent(request, { type: "reminder-sent", at: "2026-11-07T00:00:00.000Z" });
  assert.deepEqual(newReplies(reminded, inspection).map((item) => item.messageId), [fresh]);
});

test("the recorded event names the message, sender and attachments but never the body", () => {
  const event = replyReceivedEvent(reply("1A0000000000DDDD", { attachmentLabels: ["Will.pdf"], responseExcerpt: "secret body text" }), "2026-11-03T00:00:00.000Z");
  assert.equal(event.type, "provider-reply-received");
  assert.equal(event.messageId, "1a0000000000dddd");
  assert.equal(event.basis, "gmail-message-1a0000000000dddd");
  assert.match(event.note, /Archivist replied.*1 attachment\(s\): Will\.pdf/);
  assert.doesNotMatch(JSON.stringify(event), /secret body text/);
});

test("an untriaged reply changes no operational state until a classification event answers it", () => {
  const waiting = waitingRequest();
  const before = deriveExternalRequest(waiting);
  let request = appendExternalRequestEvent(waiting, replyReceivedEvent(reply("1a0000000000eeee"), "2026-11-03T00:00:00.000Z"));
  request = appendExternalRequestEvent(request, { type: "reminder-sent", at: "2026-11-03T01:00:00.000Z" });
  const after = deriveExternalRequest(request);
  assert.equal(after.operationalState, before.operationalState);
  assert.equal(after.routeStatus, before.routeStatus);
  assert.deepEqual(after.untriagedReplyIds, ["1a0000000000eeee"]);
  assert.deepEqual(validateExternalRequest(request), []);
  const classified = appendExternalRequestEvent(request, {
    type: "provider-acknowledged", at: "2026-11-03T02:00:00.000Z", basis: "gmail-message-1a0000000000eeee"
  });
  assert.deepEqual(untriagedReplyIds(classified), []);
  assert.deepEqual(deriveExternalRequest(classified).untriagedReplyIds, []);
});

test("a malformed reply event is refused when appended", () => {
  assert.throws(() => appendExternalRequestEvent(waitingRequest(), {
    type: "provider-reply-received", at: "2026-11-03T00:00:00.000Z", messageId: "1a0000000000ffff", basis: "gmail-message-1a0000000000aaaa"
  }), /provider-reply-received requires a Gmail hex messageId and its matching basis/);
});

test("an untriaged reply makes its acquisition target a reply-triage item while the route keeps its status", () => {
  const request = appendExternalRequestEvent(waitingRequest(), replyReceivedEvent(reply("1a0000000000abcd"), "2026-11-03T00:00:00.000Z"));
  const route = { id: "route", targetId: "target", status: "pending-external-delivery" };
  projectExternalRequestOntoRoute(route, request);
  assert.equal(route.status, "pending-external-delivery");
  assert.deepEqual(route.requestProjection.untriagedReplyIds, ["1a0000000000abcd"]);
  const target = { id: "target", sourceId: "source", routes: [route] };
  const reconciled = reconcileAcquisitionTarget(target, { recordsById: new Map(), recordsBySourceId: new Map(), sourcesById: new Map() });
  assert.equal(reconciled.state, "actionable");
  assert.equal(reconciled.status, "reply-triage");
  assert.deepEqual(reconciled.untriagedReplyIds, ["1a0000000000abcd"]);
});

test("session inbox status is stale when never swept or older than the threshold and lists untriaged replies", () => {
  const request = appendExternalRequestEvent(waitingRequest(), replyReceivedEvent(reply("1a0000000000abcd"), "2026-11-03T00:00:00.000Z"));
  const now = new Date("2026-11-03T12:00:00.000Z");
  assert.equal(inboxStatus({ requests: [request], sweepState: null, now }).stale, true);
  const fresh = inboxStatus({ requests: [request], sweepState: { lastSweptAt: "2026-11-03T10:00:00.000Z" }, now });
  assert.equal(fresh.stale, false);
  assert.equal(fresh.ageHours, 2);
  assert.deepEqual(fresh.untriaged, [{ requestId: "test-request", messageIds: ["1a0000000000abcd"] }]);
  assert.equal(inboxStatus({ requests: [request], sweepState: { lastSweptAt: "2026-11-02T00:00:00.000Z" }, now }).stale, true);
});

test("the sweep reads Gmail only through the read-only inspector in the shared window and writes no message body", () => {
  const runner = fs.readFileSync(new URL("./inquiry-inbox-sweep.mjs", import.meta.url), "utf8");
  const wrapper = fs.readFileSync(new URL("./inquiry-inbox-sweep-windows.ps1", import.meta.url), "utf8");
  assert.match(wrapper, /FamilyHistorySubscriptionChromeSharedWindow/);
  assert.match(wrapper, /tools\/inspect-inquiry-response\.mjs/);
  assert.match(wrapper, /127\.0\.0\.1:9226/);
  assert.doesNotMatch(wrapper, /SendKeys|chrome\.exe|--remote-debugging/);
  assert.match(runner, /replyReceivedEvent/);
  assert.doesNotMatch(runner, /responseExcerpt/);
  assert.doesNotMatch(runner, /chromium|playwright/);
  assert.match(fs.readFileSync(new URL("../.gitignore", import.meta.url), "utf8"), /^\.inbox-sweep\/$/m);
});

test("a pinned revision survives reply-neutral events but not a classification", async () => {
  const { externalRequestRevisionWindow, pinnedRevisionMatches } = await import("./external-request-store.mjs");
  const waiting = waitingRequest();
  const pinned = waiting.revision;
  let request = appendExternalRequestEvent(waiting, replyReceivedEvent(reply("1a0000000000abcd"), "2026-11-03T00:00:00.000Z"));
  request = appendExternalRequestEvent(request, { type: "reminder-sent", at: "2026-11-03T01:00:00.000Z" });
  assert.equal(pinnedRevisionMatches(externalRequestRevisionWindow(request), pinned), true);
  assert.equal(pinnedRevisionMatches(externalRequestRevisionWindow(request), request.revision), true);
  const route = { id: "route", targetId: "target", status: "pending-external-delivery" };
  projectExternalRequestOntoRoute(route, request);
  assert.equal(route.requestProjection.classifiedRevision, pinned);
  const classified = appendExternalRequestEvent(request, { type: "provider-acknowledged", at: "2026-11-03T02:00:00.000Z", basis: "gmail-message-1a0000000000abcd" });
  assert.equal(pinnedRevisionMatches(externalRequestRevisionWindow(classified), pinned), false);
});
