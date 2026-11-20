// Per-tree consent for outward-facing helpers.
//
// Every helper that spends money, sends a message, submits a form, signs in or
// registers on a site, or reads a mailbox acts as the tree's owner. Each one is
// off until that owner switches it on in the tree's consents file (named by
// `consentsFile` in tree.config.json, `consents.json` by default). A tree with
// no consents file can research, build and publish its viewer, but none of
// these helpers will act.
//
// A consent never replaces a helper's own gates: the exact `PAY <request-id>` and
// `SUBMIT <target>` phrases, amount guards, allowlisted hosts and every human
// step (CVV, MFA, CAPTCHA, the final Wise send) still apply on top of it.

import fs from "node:fs";
import path from "node:path";
import { engineRoot, loadTreeConfig } from "./tree-config.mjs";

export const CONSENTS_SCHEMA_VERSION = 1;

// The capabilities a consents file may grant, with the reason each is gated.
export const CAPABILITIES = Object.freeze({
  "card-payment": "Pays a provider with a card already saved in the owner's browser.",
  "bank-transfer": "Prepares a bank transfer from the owner's Wise account (the owner presses Send).",
  "mailed-check": "Has a cheque drawn on the owner's bank account printed and posted through the owner's Lob account.",
  "email-enquiry": "Sends email enquiries, reminders and quote acceptances from the owner's mailbox.",
  "contact-form": "Submits archive and provider contact forms with the owner's details.",
  "saved-signin": "Submits sign-in forms using credentials the owner's browser has saved.",
  "account-registration": "Registers a new account on a site the owner names.",
  "mailbox-read": "Reads the owner's mailboxes (provider replies, attachments, one-time email codes).",
  "inbox-tidy": "Archives processed research mail in the owner's mailboxes (never deletes).",
  "life-stories": "Writes and verifies life stories through the owner's Claude Code plan."
});

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export class ConsentRequiredError extends Error {
  constructor(capability, file, reason) {
    super(`${capability} is not switched on for this tree (${reason}). The tree's owner can enable it in ${file}; see TREE-SETUP.md.`);
    this.name = "ConsentRequiredError";
    this.capability = capability;
    this.code = "CONSENT_REQUIRED";
  }
}

export function validateConsents(consents) {
  const errors = [];
  if (!consents || typeof consents !== "object" || Array.isArray(consents)) return ["consents must be a JSON object"];
  if (consents.schemaVersion !== CONSENTS_SCHEMA_VERSION) errors.push(`schemaVersion must be ${CONSENTS_SCHEMA_VERSION}`);
  const grants = consents.capabilities;
  if (!grants || typeof grants !== "object" || Array.isArray(grants)) {
    errors.push("capabilities must be an object keyed by capability");
    return errors;
  }
  for (const [name, grant] of Object.entries(grants)) {
    if (!Object.hasOwn(CAPABILITIES, name)) {
      errors.push(`unknown capability ${name}`);
      continue;
    }
    if (!grant || typeof grant !== "object") {
      errors.push(`${name} must be an object`);
      continue;
    }
    if (typeof grant.enabled !== "boolean") errors.push(`${name}.enabled must be true or false`);
    if (grant.enabled) {
      if (typeof grant.grantedOn !== "string" || !DATE.test(grant.grantedOn)) errors.push(`${name}.grantedOn must be a YYYY-MM-DD date`);
      if (typeof grant.grantedBy !== "string" || !grant.grantedBy.trim()) errors.push(`${name}.grantedBy must name who switched it on`);
    }
  }
  return errors;
}

export function consentsPath({ root = engineRoot, env = process.env } = {}) {
  const config = loadTreeConfig({ root, env });
  return path.join(root, config.consentsFile);
}

export function loadConsents({ root = engineRoot, env = process.env } = {}) {
  const file = consentsPath({ root, env });
  if (!fs.existsSync(file)) return { file, consents: null, errors: [] };
  let consents;
  try {
    consents = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    return { file, consents: null, errors: [`not valid JSON: ${error.message}`] };
  }
  return { file, consents, errors: validateConsents(consents) };
}

export function consentStatus(capability, options = {}) {
  if (!Object.hasOwn(CAPABILITIES, capability)) throw new Error(`Unknown capability ${capability}`);
  const { file, consents, errors } = loadConsents(options);
  if (errors.length) return { enabled: false, file, reason: `${path.basename(file)} is invalid: ${errors.join("; ")}` };
  if (!consents) return { enabled: false, file, reason: `no ${path.basename(file)}` };
  const grant = consents.capabilities[capability];
  if (!grant) return { enabled: false, file, reason: "not listed" };
  if (!grant.enabled) return { enabled: false, file, reason: "switched off" };
  return { enabled: true, file, grant };
}

export function hasConsent(capability, options = {}) {
  return consentStatus(capability, options).enabled;
}

// Throws ConsentRequiredError unless the tree's owner has switched the
// capability on. Call it at the helper's single entry point, before any
// browser, mailbox or network action.
export function requireConsent(capability, options = {}) {
  const status = consentStatus(capability, options);
  if (!status.enabled) throw new ConsentRequiredError(capability, path.relative(options.root || engineRoot, status.file) || status.file, status.reason);
  return status.grant;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { file, consents, errors } = loadConsents();
  if (errors.length) {
    console.error(`${file} is invalid:\n- ${errors.join("\n- ")}`);
    process.exit(1);
  }
  const check = process.argv.includes("--check");
  if (!check) console.log(`Consents file: ${file}${consents ? "" : " (absent: every helper is off)"}`);
  for (const name of Object.keys(CAPABILITIES)) {
    const status = consentStatus(name);
    if (!check) console.log(`${status.enabled ? "ON " : "off"}  ${name.padEnd(22)} ${status.enabled ? `since ${status.grant.grantedOn}` : status.reason}`);
  }
  if (check) console.log(`consents ok: ${Object.keys(CAPABILITIES).filter((name) => hasConsent(name)).length} of ${Object.keys(CAPABILITIES).length} capabilities on`);
}
