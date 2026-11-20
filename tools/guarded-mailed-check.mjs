#!/usr/bin/env node

// Guarded mailed cheque (AGENTS.md, 19 Nov 2026).
//
//   npm run cheque:win -- --request <request-id>            post the approved cheque
//   npm run cheque:win -- --request <request-id> --preview  show what would be posted; sends nothing
//   npm run cheque:win -- --status                          what the bridge has configured
//   npm run cheque:win -- --save-key                        store the Lob API key now on the clipboard
//   npm run cheque:win -- --configure [--bank-account bank_...] [--from-address adr_...]
//
// Has one cheque printed and posted through Lob for a canonical request whose
// provider takes payment only by post and whose exact PAY phrase is already
// recorded. The payee, the memo and the covering letter come only from the
// reviewed entries in tools/mailed-check-policy.mjs; the amount is exactly what
// the approval has left; the idempotency key is the request plus its approval
// event, so no retry can ever post a second cheque for the same approval. The
// Lob API key, the bank account and the sender's name, email and address stay
// inside tools/guarded-mailed-check-windows.ps1: this file never sees them and
// prints only the payee, the amount, the cheque number and Lob's delivery date.
// With a test_ key stored, the same request is rehearsed: Lob renders the cheque
// and posts nothing, and no payment is recorded.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { requireConsent } from "./consents.mjs";
import { classifyBridgeResult, lobCheckRequest } from "./mailed-check-policy.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readRequest(requestId) {
  if (!/^[a-z0-9][a-z0-9-]{0,127}$/.test(requestId || "")) throw new Error("Pass one safe request ID.");
  return JSON.parse(fs.readFileSync(path.join(projectRoot, "evidence", "acquisition", "requests", `${requestId}.json`), "utf8"));
}

// Runs the Windows bridge and returns its one JSON line, whether it succeeded
// or refused. The bridge prints no secrets, so its output is safe to parse here.
export function runBridge(args, input = "") {
  const script = execFileSync("wslpath", ["-w", path.join(projectRoot, "tools", "guarded-mailed-check-windows.ps1")], { encoding: "utf8" }).trim();
  let output;
  try {
    output = execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, ...args], {
      input, encoding: "utf8", timeout: 240_000, maxBuffer: 4 * 1024 * 1024, stdio: ["pipe", "pipe", "inherit"]
    });
  } catch (error) {
    output = String(error.stdout || "");
    if (!output.trim()) return { error: "the bridge did not answer", httpStatus: 0 };
  }
  const line = output.split(/\r?\n/).map((text) => text.trim()).filter((text) => text.startsWith("{")).at(-1);
  try {
    return JSON.parse(line);
  } catch {
    return { error: "the bridge returned nothing readable", httpStatus: 0 };
  }
}

// What a person may be shown before anything is sent.
export function previewOf(prepared) {
  const to = prepared.check.to;
  return {
    requestId: prepared.requestId,
    payTo: to.name,
    postTo: [to.address_line2, to.address_line1, `${to.address_city}, ${to.address_state} ${to.address_zip}`].filter(Boolean).join("; "),
    amount: `$${prepared.authorization.amount.toFixed(2)}`,
    memo: prepared.check.memo,
    letter: prepared.check.attachment.replace(/<style>[\s\S]*?<\/style>/, "").replace(/<br>/g, " / ").replace(/<[^>]+>/g, "\n").split("\n").map((line) => line.trim()).filter(Boolean)
  };
}

// Posts the cheque. `bridge` and `record` are injected so the order of events
// is tested without Windows, Lob or the request store.
export function sendMailedCheck(request, { bridge = runBridge, record, log = console.error } = {}) {
  requireConsent("mailed-check");
  const prepared = lobCheckRequest(request);
  const status = bridge(["-Mode", "status"]);
  if (!status.keyStored) throw new Error("No Lob API key is stored yet: copy it and run npm run cheque:win -- --save-key. Nothing was sent.");
  if (!status.bankAccount || !status.fromAddress) throw new Error("The bank account and return address are not chosen yet: run npm run cheque:win -- --configure. Nothing was sent.");
  const live = status.environment === "live";
  const { authorization } = prepared;
  const basis = `guarded-mailed-check lob ${prepared.payeeId} key ${prepared.idempotencyKey}`;
  // A live cheque is bracketed by canonical events, like a card payment: an
  // interrupted run is held for review and its approval cannot be spent twice.
  if (live) {
    record(request.id, authorization.mode === "quote"
      ? { type: "payment-started", amount: authorization.amount, currency: authorization.currency, basis }
      : { type: "submission-started", basis });
  }
  const outcome = classifyBridgeResult(bridge(["-Mode", "send"], JSON.stringify({ idempotencyKey: prepared.idempotencyKey, check: prepared.check })), prepared);
  const payee = prepared.check.to.name;
  if (outcome.status === "sent") {
    const receipt = `guarded-mailed-check lob ${outcome.checkId}${outcome.checkNumber ? ` cheque no. ${outcome.checkNumber}` : ""} to ${payee}${outcome.expectedDelivery ? `, expected delivery ${outcome.expectedDelivery}` : ""}`;
    record(request.id, authorization.mode === "quote"
      ? { type: "payment-submitted", amount: authorization.amount, currency: authorization.currency, basis: receipt }
      : { type: "submission-confirmed", basis: receipt });
    log(`Posted: $${authorization.amount.toFixed(2)} to ${payee}${outcome.expectedDelivery ? `, expected ${outcome.expectedDelivery}` : ""}.`);
  } else if (outcome.status === "refused") {
    // Lob created nothing, so the approval is still whole.
    if (live) record(request.id, { type: authorization.mode === "quote" ? "payment-retryable" : "submission-retryable", basis: `Lob refused the cheque: ${outcome.reason}` });
    log(`Lob refused the cheque (${outcome.reason}); nothing was posted.`);
  } else if (outcome.status === "rehearsed") {
    log(`Rehearsed with the test key: Lob rendered a $${authorization.amount.toFixed(2)} cheque to ${payee} and posted nothing. No payment was recorded.`);
  } else {
    log(live
      ? `The result is uncertain (${outcome.reason}). The request is held as started; look the cheque up in Lob by its idempotency key before anything is retried.`
      : `The rehearsal's result is uncertain (${outcome.reason}); nothing was posted or recorded.`);
  }
  return { requestId: request.id, payee, amount: authorization.amount, ...outcome };
}

async function main() {
  const args = process.argv.slice(2);
  const value = (flag) => {
    const index = args.indexOf(flag);
    return index < 0 ? "" : args[index + 1] || "";
  };
  if (args.includes("--status")) return console.log(JSON.stringify(runBridge(["-Mode", "status"])));
  if (args.includes("--save-key")) return console.log(JSON.stringify(runBridge(["-Mode", "save-clipboard"])));
  if (args.includes("--configure")) {
    const bridgeArgs = ["-Mode", "configure"];
    if (value("--bank-account")) bridgeArgs.push("-BankAccount", value("--bank-account"));
    if (value("--from-address")) bridgeArgs.push("-FromAddress", value("--from-address"));
    return console.log(JSON.stringify(runBridge(bridgeArgs)));
  }
  const request = readRequest(value("--request"));
  if (args.includes("--preview")) return console.log(JSON.stringify(previewOf(lobCheckRequest(request)), null, 2));
  const { recordRequestEvent } = await import("./guarded-card-payment.mjs");
  const outcome = sendMailedCheck(request, { record: recordRequestEvent });
  console.log(JSON.stringify(outcome));
  if (!["sent", "rehearsed"].includes(outcome.status)) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`cheque: ${error.message}`);
    process.exitCode = 1;
  });
}
