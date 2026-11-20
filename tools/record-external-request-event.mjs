#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  appendExternalRequestEvent,
  deriveExternalRequest,
  externalRequestEventTypes
} from "./external-request-store.mjs";
import { projectRoot, readJson, serializeJson } from "./research-store.mjs";

const requestId = valueAfter("--request");
const type = valueAfter("--type");
const expectedRevision = Number(valueAfter("--expected-revision"));
if (!/^[a-z0-9][a-z0-9-]*$/.test(requestId || "")) throw new Error("Pass a safe --request ID.");
if (!externalRequestEventTypes.has(type)) throw new Error("Pass a supported --type.");
if (!Number.isInteger(expectedRevision) || expectedRevision < 0) throw new Error("Pass the current --expected-revision.");

const file = path.join(projectRoot, "evidence", "acquisition", "requests", `${requestId}.json`);
const request = readJson(file);
const event = {
  type,
  ...(valueAfter("--at") ? { at: valueAfter("--at") } : {}),
  ...(valueAfter("--note") ? { note: valueAfter("--note") } : {}),
  ...(valueAfter("--basis") ? { basis: valueAfter("--basis") } : {}),
  ...(valueAfter("--item") ? { itemId: valueAfter("--item") } : {}),
  ...(valueAfter("--route-status") ? { routeStatus: valueAfter("--route-status") } : {})
};
if (type === "authorization-confirmed") {
  const phrase = valueAfter("--phrase");
  if (phrase !== request.guard.requiredPhrase) throw new Error(`Authorization requires exactly: ${request.guard.requiredPhrase}`);
  event.phrase = phrase;
  event.payloadSha256 = request.payloadSha256;
}
if (type === "fee-quoted") {
  const amount = Number(valueAfter("--amount"));
  const currency = valueAfter("--currency");
  if (!Number.isFinite(amount) || amount <= 0 || !currency) throw new Error("fee-quoted requires --amount and --currency");
  event.amount = amount;
  event.currency = currency;
}
if (type === "payment-authorized") {
  const amount = Number(valueAfter("--amount"));
  const currency = valueAfter("--currency");
  const phrase = valueAfter("--phrase");
  const requiredPhrase = `PAY ${request.id}`;
  if (phrase !== requiredPhrase) throw new Error(`Paying a quoted fee requires exactly: ${requiredPhrase}`);
  const quote = [...(request.events || [])].reverse().find((existing) => existing.type === "fee-quoted");
  if (!quote) throw new Error("payment-authorized requires a recorded provider fee quote");
  if (!Number.isFinite(amount) || amount <= 0 || !currency) throw new Error("payment-authorized requires --amount and --currency");
  if (amount !== quote.amount || currency !== quote.currency) {
    throw new Error(`The quoted fee is ${quote.amount} ${quote.currency}; approve exactly that amount or record a new quote first`);
  }
  event.phrase = phrase;
  event.amount = amount;
  event.currency = currency;
  event.feeEventId = quote.id;
}
if (type === "provider-reply-received") {
  const match = /^gmail-message-([0-9a-f]{12,20})$/.exec(event.basis || "");
  if (!match) throw new Error("provider-reply-received requires --basis gmail-message-<hex id>");
  event.messageId = match[1];
}
if (type === "delivery-item-imported" && !event.itemId) throw new Error("delivery-item-imported requires --item");
if (event.routeStatus && type !== "delivery-item-imported") {
  throw new Error("--route-status is supported only for delivery-item-imported");
}

const updated = appendExternalRequestEvent(request, event, { expectedRevision });
atomicWrite(file, serializeJson(updated));
execFileSync(process.execPath, ["tools/sync-external-request-projections.mjs"], {
  cwd: projectRoot,
  stdio: "inherit"
});
const derived = deriveExternalRequest(updated);
console.log(`${requestId} revision ${updated.revision}: ${derived.operationalState}`);

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  return index < 0 ? "" : process.argv[index + 1] || "";
}

function atomicWrite(fileName, contents) {
  const temporary = `${fileName}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, contents, { flag: "wx" });
  fs.renameSync(temporary, fileName);
}
