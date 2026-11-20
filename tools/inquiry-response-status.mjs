#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { deriveExternalRequest } from "./external-request-store.mjs";
import { openSharedChromeTask, sharedChromeEndpoint } from "./shared-chrome-task.mjs";
import { requireConsent } from "./consents.mjs";
requireConsent("mailbox-read");

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requestId = valueAfter("--request");
const endpoint = valueAfter("--endpoint") || sharedChromeEndpoint;
const affinitySlot = valueAfter("--affinity-slot") || "inquiry-response";
const sharedWindow = process.argv.includes("--shared-window");

if (!requestId || !/^[a-z0-9][a-z0-9-]{0,127}$/.test(requestId)) {
  throw new Error("Pass one safe external request ID with --request.");
}
if (!sharedWindow || endpoint !== sharedChromeEndpoint) {
  throw new Error(`Inquiry response checks must use the shared Windows Chrome wrapper at ${sharedChromeEndpoint}.`);
}

const requestFile = path.join(projectRoot, "evidence", "acquisition", "requests", `${requestId}.json`);
const request = JSON.parse(fs.readFileSync(requestFile, "utf8"));
const derived = deriveExternalRequest(request);
// A provider answers by email whether the request left here as an email or as a
// web form, so reply monitoring is bound to the canonical response subject rather
// than to the outbound channel. Refusing form requests here only forced the same
// inbox check to be done by hand.
// Cart-style form submissions record only a summary, so fall back to the kind
// rather than refusing a request whose reply is sitting in the inbox.
const requestChannel = request.spec?.channel || (request.kind === "no-charge-form" ? "form" : "email");
if (!new Set(["no-charge-email", "no-charge-form"]).has(request.kind)
  || !new Set(["email", "form"]).has(requestChannel)) {
  throw new Error(`${requestId} is not a canonical no-charge inquiry.`);
}
// An accepted quote whose payment instructions have not arrived is also a
// wait on the provider's reply, so its thread is monitored the same way.
if (!["waiting-external", "awaiting-payment-instructions"].includes(derived.operationalState)) {
  throw new Error(`${requestId} is ${derived.operationalState}; response monitoring is only valid while waiting externally.`);
}
const responseSubject = request.spec?.subject || request.responseBinding?.subject;
if (typeof responseSubject !== "string" || !responseSubject || /[\r\n]/.test(responseSubject) || responseSubject.length > 240) {
  throw new Error(`${requestId} has no safe canonical response subject binding.`);
}
if (requestChannel === "email" && !request.spec.recipient) {
  throw new Error(`${requestId} has no canonical provider recipient.`);
}

const session = await openSharedChromeTask({
  chromium,
  endpoint,
  taskLabel: "inquiry response check",
  affinitySlot,
  timeoutMs: 20_000
});

try {
  const page = session.page;
  page.setDefaultTimeout(15_000);
  await page.goto("https://mail.google.com/mail/u/0/#inbox", {
    waitUntil: "domcontentloaded",
    timeout: 45_000
  });
  await page.waitForTimeout(2_000);

  const search = page.locator('input[aria-label="Search mail"], input[placeholder="Search mail"]').first();
  if (!await search.isVisible().catch(() => false)) {
    console.log(JSON.stringify({ requestId, state: "manual-signin-required", matchCount: 0 }));
    process.exitCode = 2;
  } else {
    // Replies often come from a staff member, ticketing system, or alternate institutional
    // mailbox rather than the address that received the original inquiry. Search the Inbox
    // for the exact canonical subject without a sender restriction. The original submitted
    // message lives in Sent and cannot satisfy this query; an incoming reply can, regardless
    // of which staff alias or ticketing mailbox sent it.
    const query = `in:inbox subject:"${responseSubject.replaceAll('"', '')}"`;
    let matchCount = 0;
    for (const candidate of responseStatusQueries(request, query)) {
      await search.fill(candidate.query);
      await search.press("Enter");
      await page.waitForTimeout(3_000);
      const matches = candidate.subject === responseSubject
        ? page.getByText(responseSubject, { exact: false })
        : page.getByText(candidate.subject, { exact: false });
      // Gmail renders the same thread subject in several nested nodes. Report a
      // boolean thread-presence count so callers do not mistake DOM nodes for replies.
      if (await matches.count() > 0) {
        matchCount = 1;
        break;
      }
    }
    console.log(JSON.stringify({
      requestId,
      state: matchCount > 0 ? "response-present" : "no-response",
      matchCount
    }));
  }
} finally {
  await session.close();
}

function responseStatusQueries(request, primaryQuery) {
  const primary = request.spec?.subject || request.responseBinding?.subject;
  const aliases = request.responseBinding?.subjectAliases || [];
  const terms = request.responseBinding?.matchTerms || [];
  if (!Array.isArray(aliases) || !Array.isArray(terms) || aliases.length > 5 || terms.length > 8
    || aliases.some((value) => typeof value !== "string" || !value || /[\r\n]/.test(value) || value.length > 240)
    || terms.some((value) => typeof value !== "string" || !value.trim() || /[\r\n]/.test(value) || value.length > 120)) {
    throw new Error(`${requestId} has invalid response subject aliases or match terms.`);
  }
  const queries = [{ query: primaryQuery, subject: primary }];
  for (const alias of [...new Set(aliases)]) {
    if (!terms.length) continue;
    const quotedTerms = terms.map((term) => `"${term.trim().replaceAll('"', "")}"`).join(" ");
    queries.push({ query: `in:inbox subject:"${alias.replaceAll('"', "")}" ${quotedTerms}`, subject: alias });
  }
  return queries;
}

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  return index < 0 ? "" : process.argv[index + 1] || "";
}
