import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CAPABILITIES, ConsentRequiredError, consentStatus, hasConsent, requireConsent, validateConsents } from "./consents.mjs";

function treeWith(consents, config) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "consents-test-"));
  if (config) fs.writeFileSync(path.join(root, "tree.config.json"), JSON.stringify(config));
  if (consents !== undefined) {
    const file = path.join(root, config?.consentsFile || "consents.json");
    fs.writeFileSync(file, typeof consents === "string" ? consents : JSON.stringify(consents));
  }
  return { root, env: {} };
}

const grant = { enabled: true, grantedOn: "2026-11-19", grantedBy: "tree owner" };

test("every helper is off when the tree has no consents file", () => {
  const options = treeWith(undefined);
  for (const name of Object.keys(CAPABILITIES)) assert.equal(hasConsent(name, options), false);
  assert.throws(() => requireConsent("card-payment", options), (error) => error instanceof ConsentRequiredError && error.code === "CONSENT_REQUIRED" && /no consents\.json/.test(error.message));
});

test("only listed, enabled capabilities are on", () => {
  const options = treeWith({ schemaVersion: 1, capabilities: { "email-enquiry": grant, "card-payment": { enabled: false } } });
  assert.equal(requireConsent("email-enquiry", options).grantedBy, "tree owner");
  assert.equal(consentStatus("card-payment", options).reason, "switched off");
  assert.equal(consentStatus("bank-transfer", options).reason, "not listed");
});

test("an invalid consents file switches everything off", () => {
  assert.equal(hasConsent("email-enquiry", treeWith("{oops")), false);
  const options = treeWith({ schemaVersion: 1, capabilities: { "email-enquiry": { enabled: true } } });
  assert.match(consentStatus("email-enquiry", options).reason, /grantedOn/);
  assert.deepEqual(validateConsents({ schemaVersion: 1, capabilities: { "teleport": grant } }), ["unknown capability teleport"]);
});

test("the consents file name comes from tree.config.json", () => {
  const options = treeWith({ schemaVersion: 1, capabilities: { "mailbox-read": grant } }, { schemaVersion: 1, consentsFile: "owner-consents.json" });
  assert.equal(hasConsent("mailbox-read", options), true);
});

test("unknown capability names are a programming error", () => {
  assert.throws(() => hasConsent("teleport", treeWith(undefined)), /Unknown capability/);
});
