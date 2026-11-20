import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { defaultSweepProviders, parseSignInResults, signedInProviders } from "./providers-signin.mjs";
import { shouldTrySavedSignIn } from "./research-browser-batch.mjs";
import { classifySignInSurface, isLoginUrl, savedSignInProviderIds, savedSignInProviders, trySavedSignInAtCurrentForm } from "./saved-signin.mjs";

const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const surface = (overrides) => ({
  url: "https://www.findmypast.com/home",
  passwordVisible: false,
  usernameVisible: false,
  passwordAutofilled: false,
  usernameAutofilled: false,
  challenge: false,
  mfa: false,
  accountChoice: false,
  signInPromptVisible: false,
  accountIndicatorVisible: false,
  ...overrides
});

test("current-form recovery rejects unrelated routes before reading or acting", async () => {
  for (const url of ["http://auth.findmypast.com/login", "https://example.org/login", "https://user:pass@auth.findmypast.com/login", "https://auth.findmypast.com:8443/login", "https://www.findmypast.co.uk/register", "https://www.findmypast.com/home"]) {
    await assert.rejects(trySavedSignInAtCurrentForm({ url: () => url }, "findmypast"), /existing HTTPS provider login/);
  }
});

test("current-form recovery preserves the regional callback and stops for human steps or missing autofill", async () => {
  const url = "https://auth.findmypast.com/login?state=private-test-state#private-fragment";
  for (const flags of [{ challenge: true }, { mfa: true }, { accountChoice: true }, { passwordVisible: true, usernameVisible: true },
    { usernameVisible: true, usernameAutofilled: true }, { passwordVisible: true, passwordAutofilled: true }]) {
    const page = { url: () => url, frames: () => [{ evaluate: async () => surface(flags) }], waitForTimeout: async () => {} };
    const result = await trySavedSignInAtCurrentForm(page, "findmypast", { autofillTimeoutMs: 0, consentEnabled: () => true });
    assert.equal(result.status, "needs-user");
    assert.equal(JSON.stringify(result).includes("private-test-state"), false);
    assert.equal(result.surface.url, "https://auth.findmypast.com/login");
  }
});

test("current-form recovery submits only an autofilled form and follows its own return", async () => {
  let submitted = false;
  const logs = [];
  const locator = { filter() { return this; }, first() { return this; }, locator() { return this; }, count: async () => 1, evaluate: async () => true, click: async () => { submitted = true; } };
  const frame = { evaluate: async () => surface(submitted ? { accountIndicatorVisible: true } : { passwordVisible: true, usernameVisible: true, passwordAutofilled: true, usernameAutofilled: true }), locator: () => locator };
  const page = { url: () => submitted ? "https://search.findmypast.co.uk/record?id=known" : "https://auth.findmypast.com/login?state=private", frames: () => [frame], waitForTimeout: async () => {} };
  const result = await trySavedSignInAtCurrentForm(page, "findmypast", { autofillTimeoutMs: 0, completionTimeoutMs: 100, log: value => logs.push(value), consentEnabled: () => true });
  assert.equal(submitted, true);
  assert.equal(result.status, "signed-in");
  assert.match(logs[0], /Chrome-autofilled Findmypast/);
  assert.equal(logs.join(" ").includes("private"), false);
});

test("current-form recovery refuses autofill that is not verified in the same form", async () => {
  let clicks = 0;
  const locator = { filter() { return this; }, first() { return this; }, count: async () => 1, evaluate: async () => false, click: async () => { clicks++; } };
  const frame = { evaluate: async () => surface({ passwordVisible: true, usernameVisible: true, passwordAutofilled: true, usernameAutofilled: true }), locator: () => locator };
  const page = { url: () => "https://auth.findmypast.com/login", frames: () => [frame], waitForTimeout: async () => {} };
  const result = await trySavedSignInAtCurrentForm(page, "findmypast", { autofillTimeoutMs: 0, consentEnabled: () => true });
  assert.equal(result.status, "needs-user");
  assert.equal(clicks, 0);
});

test("login routes are recognised per provider", () => {
  assert.equal(isLoginUrl("familysearch", "https://ident.familysearch.org/en/identity/login/?state=x"), true);
  assert.equal(isLoginUrl("familysearch", "https://www.familysearch.org/en/search/"), false);
  assert.equal(isLoginUrl("ancestry", "https://www.ancestry.com/account/signin"), true);
  assert.equal(isLoginUrl("findmypast", "https://www.findmypast.com/sign-in"), true);
  assert.equal(isLoginUrl("findmypast", "https://www.findmypast.com/home"), false);
});

test("human steps always win over an apparently usable form", () => {
  assert.deepEqual(classifySignInSurface("findmypast", surface({ challenge: true, passwordVisible: true, passwordAutofilled: true })),
    { status: "needs-user", reason: "security-verification-or-captcha" });
  assert.deepEqual(classifySignInSurface("ancestry", surface({ mfa: true })), { status: "needs-user", reason: "multi-factor-step" });
  assert.deepEqual(classifySignInSurface("ancestry", surface({ accountChoice: true })), { status: "needs-user", reason: "account-choice" });
});

test("a visible sign-in prompt is signed out even without a form", () => {
  assert.equal(classifySignInSurface("findmypast", surface({})).status, "signed-in");
  assert.equal(classifySignInSurface("findmypast", surface({ signInPromptVisible: true })).status, "signed-out");
  assert.equal(classifySignInSurface("familysearch", surface({ url: "https://ident.familysearch.org/en/identity/login/" })).status, "sign-in-form");
  assert.equal(classifySignInSurface("familysearch", surface({ passwordVisible: true })).status, "sign-in-form");
});

test("the helper decides from CSS autofill state and never reads field values", () => {
  const source = fs.readFileSync(path.join(toolsDir, "saved-signin.mjs"), "utf8");
  assert.ok(source.includes(":-webkit-autofill"));
  for (const forbidden of [/\.value\b/, /inputValue\(/, /\.fill\(/, /\.type\(/, /keyboard\./, /screenshot\(/]) {
    assert.equal(forbidden.test(source), false, `saved-signin.mjs must not use ${forbidden}`);
  }
});

test("sweep output parsing keeps only provider results", () => {
  const results = parseSignInResults([
    "noise",
    JSON.stringify({ type: "signin-result", provider: "familysearch", status: "signed-in" }),
    JSON.stringify({ type: "signin-result", provider: "ancestry", status: "already-signed-in" }),
    JSON.stringify({ type: "signin-result", provider: "findmypast", status: "needs-user", reason: "multi-factor-step" }),
    "{not json"
  ].join("\n"));
  assert.equal(results.length, 3);
  assert.deepEqual(signedInProviders(results), ["familysearch", "ancestry"]);
});

test("the browser batch tries saved sign-in once, and never on a security challenge", () => {
  const gated = { status: "needs-user", reason: "sign-in-or-challenge-route" };
  assert.equal(shouldTrySavedSignIn(gated, "findmypast", false), true);
  assert.equal(shouldTrySavedSignIn(gated, "findmypast", true), false);
  assert.equal(shouldTrySavedSignIn(gated, "antenati", false), false);
  assert.equal(shouldTrySavedSignIn({ status: "needs-user", reason: "visible-security-verification-challenge" }, "familysearch", false), false);
  assert.equal(shouldTrySavedSignIn({ status: "completed" }, "familysearch", false), false);
  assert.deepEqual(savedSignInProviderIds, ["familysearch", "ancestry", "findmypast", "tna", "mdlandrec", "archion"]);
});

test("Archion sign-in is recognised by its German login route and labels, and stays out of the core sweep", () => {
  assert.equal(isLoginUrl("archion", "https://www.archion.de/de/login"), true);
  assert.equal(isLoginUrl("archion", "https://www.archion.de/de/login?redirect_url=%2Fde%2Fviewer"), true);
  assert.equal(isLoginUrl("archion", "https://www.archion.de/de/alle-archive/baden-wuerttemberg"), false);
  assert.equal(isLoginUrl("archion", "https://www.archion.de/de/viewer/churchRegister/82764"), false);
  assert.equal(savedSignInProviders.archion.hosts.test("www.archion.de"), true);
  assert.equal(savedSignInProviders.archion.hosts.test("archion.de.example.org"), false);
  assert.equal(savedSignInProviders.archion.signInUrls.every((url) => url.startsWith("https://www.archion.de/")), true);
  const source = fs.readFileSync(new URL("./saved-signin.mjs", import.meta.url), "utf8");
  assert.match(source, /sign in or register\|anmelden\|jetzt anmelden\)\$/);
  assert.match(source, /log out\|logout\|abmelden\|mein konto\)\$/);
  assert.deepEqual(defaultSweepProviders([]), ["familysearch", "ancestry", "findmypast"]);
});

test("TNA and MDLandRec login routes are recognised, and MDLandRec names its exact login button", () => {
  assert.equal(isLoginUrl("tna", "https://discovery.nationalarchives.gov.uk/sign-in"), true);
  assert.equal(isLoginUrl("tna", "https://secure.nationalarchives.gov.uk/Login?wa=wsignin1.0"), true);
  assert.equal(isLoginUrl("tna", "https://discovery.nationalarchives.gov.uk/details/r/D152934"), false);
  assert.equal(isLoginUrl("mdlandrec", "https://landrec.msa.maryland.gov/Pages/Login.aspx"), true);
  assert.equal(isLoginUrl("mdlandrec", "https://landrec.msa.maryland.gov/Pages/Search.aspx"), false);
  assert.equal(savedSignInProviders.mdlandrec.submitSelector, "#body_btnSubmit");
  assert.equal(savedSignInProviders.mdlandrec.hosts.test("landrec.msa.maryland.gov"), true);
  assert.equal(savedSignInProviders.mdlandrec.hosts.test("msa.maryland.gov"), false);
});

test("the session sweep adds a non-core provider only while it holds an open sign-in gate", () => {
  const gate = (provider, status) => ({ id: `t-${provider}`, provider, routes: [{ id: "r", provider, status }] });
  assert.deepEqual(defaultSweepProviders([]), ["familysearch", "ancestry", "findmypast"]);
  assert.deepEqual(defaultSweepProviders([
    gate("Maryland State Archives Land Records", "needs-interactive-sign-in"),
    gate("The National Archives", "ready-download")
  ]), ["familysearch", "ancestry", "findmypast", "mdlandrec"]);
  assert.deepEqual(defaultSweepProviders([gate("The National Archives", "needs-interactive-sign-in")]),
    ["familysearch", "ancestry", "findmypast", "tna"]);
});

test("without the tree owner's saved-signin consent the form is left untouched for the user", async () => {
  const url = "https://auth.findmypast.com/login?state=private-test-state";
  let read = false;
  const page = { url: () => url, frames: () => { read = true; return []; }, waitForTimeout: async () => {} };
  const result = await trySavedSignInAtCurrentForm(page, "findmypast", { autofillTimeoutMs: 0, consentEnabled: () => false });
  assert.equal(result.status, "needs-user");
  assert.equal(result.reason, "saved-signin-not-enabled");
  assert.equal(read, false);
  assert.equal(JSON.stringify(result).includes("private-test-state"), false);
});
