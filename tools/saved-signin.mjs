// Guarded saved-credential sign-in for provider accounts in the shared Chrome
// profile (AGENTS.md: the `signin-saved` helper).
//
// The helper submits a provider's own sign-in form only after Chrome's
// password manager has visibly autofilled BOTH the account and the password
// field, detected purely through the `:-webkit-autofill` CSS state. It never
// reads, copies, types, logs or screenshots either value. MFA, CAPTCHA or
// security verification, account choice, a missing saved password, or any
// other challenge returns `needs-user` so the caller can reveal the tab for
// the smallest possible human step.
import { hasConsent } from "./consents.mjs";

export const savedSignInProviders = Object.freeze({
  familysearch: {
    label: "FamilySearch",
    home: "https://www.familysearch.org/en/",
    signInUrls: ["https://ident.familysearch.org/en/identity/login/?state=https%3A%2F%2Fwww.familysearch.org%2Fen%2Fsearch%2F"],
    hosts: /(^|\.)familysearch\.org$/i,
    loginRoute: /^ident\.familysearch\.org$|\/(identity\/login|sign-?in|login)(\/|$)/i
  },
  ancestry: {
    label: "Ancestry",
    home: "https://www.ancestry.com/",
    signInUrls: ["https://www.ancestry.com/account/signin"],
    hosts: /(^|\.)ancestry\.(com|co\.uk)$/i,
    loginRoute: /\/(account\/)?(signin|sign-in|login)(\/|$)/i
  },
  findmypast: {
    label: "Findmypast",
    home: "https://www.findmypast.com/",
    signInUrls: ["https://www.findmypast.com/sign-in"],
    hosts: /(^|\.)findmypast\.(com|co\.uk)$/i,
    loginRoute: /\/(sign-?in|login)(\/|$)/i
  },
  // Discovery's /sign-in hands off to the separate secure.* login host.
  tna: {
    label: "The National Archives",
    home: "https://discovery.nationalarchives.gov.uk/",
    signInUrls: ["https://discovery.nationalarchives.gov.uk/sign-in"],
    hosts: /(^|\.)nationalarchives\.gov\.uk$/i,
    loginRoute: /^secure\.nationalarchives\.gov\.uk$|\/(sign-?in|login)(\/|$)/i
  },
  // One ASP.NET form wraps the whole page, so its first submit control is the
  // book/page "Jump" button; name the login button exactly.
  mdlandrec: {
    label: "MDLandRec",
    home: "https://landrec.msa.maryland.gov/",
    signInUrls: ["https://landrec.msa.maryland.gov/Pages/Login.aspx"],
    hosts: /^landrec\.msa\.maryland\.gov$/i,
    loginRoute: /\/Pages\/Login\.aspx$/i,
    submitSelector: "#body_btnSubmit"
  },
  // German-language site: the signed-out header shows "Jetzt anmelden" and the
  // signed-in one "Abmelden". Without a session the pass is unusable (the
  // "Digitalisat anzeigen (Viewer)" control is rendered disabled).
  archion: {
    label: "Archion",
    home: "https://www.archion.de/de/",
    signInUrls: ["https://www.archion.de/de/login"],
    hosts: /(^|\.)archion\.de$/i,
    loginRoute: /\/(login|anmelden)(\/|$)/i
  }
});

export const savedSignInProviderIds = Object.freeze(Object.keys(savedSignInProviders));

// Swept at every session start. The other providers join the sweep only while
// they hold an open sign-in gate, so a site the user rarely needs does not
// reopen a sign-in tab every session.
export const coreSavedSignInProviderIds = Object.freeze(["familysearch", "findmypast", "ancestry"]);

const challengePhrases = [
  "verify you are human",
  "checking if the site connection is secure",
  "needs to review the security of your connection",
  "press and hold",
  "are you a robot",
  "unusual activity"
];
const mfaPhrases = [
  "verification code",
  "enter the code",
  "one-time code",
  "two-step",
  "2-step",
  "two-factor",
  "authenticator app",
  "we sent a code"
];
const accountChoicePhrases = ["choose an account", "select an account", "which account"];

export function isLoginUrl(providerId, url) {
  const provider = savedSignInProviders[providerId];
  try {
    const parsed = new URL(url);
    return provider.loginRoute.test(parsed.hostname) || provider.loginRoute.test(parsed.pathname);
  } catch {
    return false;
  }
}

// Pure classification of what a page currently shows; exported for tests.
export function classifySignInSurface(providerId, surface) {
  if (surface.challenge) return { status: "needs-user", reason: "security-verification-or-captcha" };
  if (surface.mfa) return { status: "needs-user", reason: "multi-factor-step" };
  if (surface.accountChoice) return { status: "needs-user", reason: "account-choice" };
  const onLogin = isLoginUrl(providerId, surface.url);
  if (!surface.passwordVisible && !surface.usernameVisible && !onLogin && !surface.signInPromptVisible) return { status: "signed-in" };
  if (!surface.passwordVisible && !surface.usernameVisible && surface.signInPromptVisible) return { status: "signed-out" };
  return { status: "sign-in-form" };
}

export async function readSignInSurface(page) {
  const frames = page.frames();
  const surface = {
    url: page.url(),
    passwordVisible: false,
    usernameVisible: false,
    passwordAutofilled: false,
    usernameAutofilled: false,
    challenge: false,
    mfa: false,
    accountChoice: false,
    signInPromptVisible: false,
    accountIndicatorVisible: false
  };
  for (const frame of frames) {
    const facts = await frame.evaluate(({ challengeWords, mfaWords, choiceWords }) => {
      const visible = (element) => {
        if (!element) return false;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      const usernameSelector = 'input[autocomplete="username"], input[autocomplete="email"], input[type="email"], input[name*="user" i], input[name*="email" i], input[id*="user" i], input[id*="email" i]';
      const passwords = [...document.querySelectorAll('input[type="password"]')].filter(visible);
      const usernames = [...document.querySelectorAll(usernameSelector)].filter((element) => element.type !== "password" && element.type !== "hidden" && visible(element));
      const text = (document.body?.innerText || "").slice(0, 6_000).toLocaleLowerCase();
      const challengeFrame = [...document.querySelectorAll("iframe")].some((element) => /captcha|challenges\.cloudflare|turnstile|arkose|funcaptcha/i.test(element.src || "") && visible(element));
      return {
        passwordVisible: passwords.length > 0,
        usernameVisible: usernames.length > 0,
        // CSS autofill state only; field values are never read.
        passwordAutofilled: passwords.some((element) => element.matches(":-webkit-autofill")),
        usernameAutofilled: usernames.some((element) => element.matches(":-webkit-autofill")),
        challenge: challengeFrame || Boolean(document.querySelector("#challenge-error-text, #challenge-form, .cf-turnstile"))
          || challengeWords.some((phrase) => text.includes(phrase)),
        mfa: mfaWords.some((phrase) => text.includes(phrase)) && !passwords.length,
        accountChoice: choiceWords.some((phrase) => text.includes(phrase)),
        // A visible "Sign in"/"Log in" control means the visitor is signed out
        // even when no form is on this page.
        signInPromptVisible: [...document.querySelectorAll("a, button")].some((element) =>
          /^(sign in|log in|login|sign in \/ register|sign in or register|anmelden|jetzt anmelden)$/i.test((element.innerText || element.textContent || "").trim()) && visible(element)),
        accountIndicatorVisible: [...document.querySelectorAll("a, button, [role=menuitem]")].some((element) =>
          /^(my account|account|account settings|sign out|log out|logout|abmelden|mein konto)$/i.test((element.innerText || element.textContent || element.getAttribute("aria-label") || "").trim()) && visible(element))
          || Boolean(document.querySelector('a[href$="/messaging"], [data-testid*="account" i], [aria-label*="account menu" i], [aria-label*="my account" i], a[href*="signout" i], a[href*="logout" i], a[href*="sign-out" i]'))
      };
    }, { challengeWords: challengePhrases, mfaWords: mfaPhrases, choiceWords: accountChoicePhrases }).catch(() => null);
    if (!facts) continue;
    for (const [key, value] of Object.entries(facts)) surface[key] = surface[key] || value;
  }
  return surface;
}

async function settle(page, ms = 1_500) {
  await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(ms);
}

async function waitForAutofill(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let surface = await readSignInSurface(page);
  while (Date.now() < deadline && !(surface.passwordVisible ? surface.passwordAutofilled && surface.usernameAutofilled : surface.usernameAutofilled)) {
    await page.waitForTimeout(400);
    surface = await readSignInSurface(page);
  }
  return surface;
}

// Click the submit control of the form that owns the visible password (or,
// on a username-first step, the account) field. Playwright clicks dispatch
// trusted input events, which is what releases Chrome's autofilled values.
async function submitAutofilledForm(page, fieldSelector, { requireBothFields = false, submitSelector = null } = {}) {
  for (const frame of page.frames()) {
    const field = frame.locator(fieldSelector).filter({ visible: true }).first();
    if (!(await field.count().catch(() => 0))) continue;
    const form = frame.locator("form").filter({ has: field }).first();
    if (requireBothFields) {
      if (!(await form.count().catch(() => 0))) continue;
      const bothAutofilled = await form.evaluate(element => {
        const visible = node => {
          const style = getComputedStyle(node), bounds = node.getBoundingClientRect();
          return style.display !== "none" && style.visibility !== "hidden" && bounds.width > 0 && bounds.height > 0;
        };
        const passwords = [...element.querySelectorAll('input[type="password"]')].filter(visible);
        const usernames = [...element.querySelectorAll('input[autocomplete="username"], input[autocomplete="email"], input[type="email"], input[name*="user" i], input[name*="email" i], input[id*="user" i], input[id*="email" i]')]
          .filter(node => node.type !== "password" && node.type !== "hidden" && visible(node));
        return element.isConnected && passwords.length === 1 && usernames.length === 1 &&
          passwords[0].matches(":-webkit-autofill") && usernames[0].matches(":-webkit-autofill");
      }).catch(() => false);
      if (!bothAutofilled) continue;
    }
    const scope = (await form.count().catch(() => 0)) ? form : frame.locator("body");
    const submit = scope.locator(submitSelector || 'button[type="submit"], input[type="submit"], button:not([type])')
      .filter({ visible: true }).first();
    if (submitSelector && !(await submit.count().catch(() => 0))) return false;
    if (await submit.count().catch(() => 0)) {
      await submit.click({ noWaitAfter: true, timeout: 10_000 });
      return true;
    }
    if (await form.count().catch(() => 0)) {
      await form.evaluate((element) => element.requestSubmit());
      return true;
    }
  }
  return false;
}

export async function probeSavedSignIn(page, providerId, { log = () => {} } = {}) {
  const provider = requireProvider(providerId);
  const session = await providerSessionState(page, providerId);
  if (session.state === "signed-in" || session.state === "needs-user") {
    log(`${provider.label} probe: ${session.state}${session.reason ? ` (${session.reason})` : ""}`);
    return { provider: providerId, status: session.state, ...(session.reason ? { reason: session.reason } : {}), surface: redactSurface(session.surface) };
  }
  await page.goto(provider.signInUrls[0], { waitUntil: "domcontentloaded", timeout: 45_000 });
  await settle(page, 2_500);
  const surface = await readSignInSurface(page);
  const classification = classifySignInSurface(providerId, surface);
  log(`${provider.label} probe: ${classification.status}${classification.reason ? ` (${classification.reason})` : ""}`);
  return { provider: providerId, ...classification, surface: redactSurface(surface) };
}

// Session state from the provider's home page: a visible sign-in prompt or
// form means signed out; an account control means signed in. Some login
// pages (FamilySearch's) render their form even for a signed-in visitor, so
// the home page is checked before the login form is ever opened.
export async function providerSessionState(page, providerId) {
  const provider = requireProvider(providerId);
  await page.goto(provider.home, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await settle(page, 2_500);
  const surface = await readSignInSurface(page);
  if (surface.challenge) return { state: "needs-user", reason: "security-verification-or-captcha", surface };
  if (surface.signInPromptVisible || surface.passwordVisible || isLoginUrl(providerId, surface.url)) return { state: "signed-out", surface };
  if (surface.accountIndicatorVisible) return { state: "signed-in", surface };
  return { state: "unknown", surface };
}

export async function trySavedSignIn(page, providerId, { log = () => {}, autofillTimeoutMs = 8_000, completionTimeoutMs = 25_000 } = {}) {
  const provider = requireProvider(providerId);
  const session = await providerSessionState(page, providerId);
  if (session.state === "signed-in") return result(providerId, "already-signed-in", null, session.surface, log);
  if (session.state === "needs-user") return result(providerId, "needs-user", session.reason, session.surface, log);
  let entry = null;
  for (const url of provider.signInUrls) {
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => null);
    if (response && response.status() < 400) { entry = url; break; }
  }
  if (!entry) {
    await page.goto(provider.home, { waitUntil: "domcontentloaded", timeout: 45_000 });
    const link = page.getByRole("link", { name: /^(sign in|log in)$/i }).first();
    if (await link.isVisible().catch(() => false)) await link.click({ timeout: 10_000 });
  }
  await settle(page, 2_000);

  return submitCurrentSavedSignIn(page, providerId, { log, autofillTimeoutMs, completionTimeoutMs });
}

// Preserve the provider's live redirect state in an explicitly owned login
// target instead of starting a new regional login flow through the home page.
export async function trySavedSignInAtCurrentForm(page, providerId, options = {}) {
  const provider = requireProvider(providerId);
  const route = new URL(page.url());
  if (route.protocol !== "https:" || route.username || route.password || route.port ||
      !provider.hosts.test(route.hostname) || !isLoginUrl(providerId, route.href)) {
    throw new Error("Saved sign-in recovery requires an existing HTTPS provider login route.");
  }
  return submitCurrentSavedSignIn(page, providerId, { ...options, requireBothFields: true });
}

async function submitCurrentSavedSignIn(page, providerId, { log = () => {}, autofillTimeoutMs = 8_000, completionTimeoutMs = 25_000, requireBothFields = false, consentEnabled = () => hasConsent("saved-signin") } = {}) {
  const provider = requireProvider(providerId);
  // Without the owner's consent the form is left for them to submit.
  if (!consentEnabled()) return result(providerId, "needs-user", "saved-signin-not-enabled", { url: page.url() }, log);
  let surface = await readSignInSurface(page);
  let classification = classifySignInSurface(providerId, surface);
  if (classification.status === "signed-out") {
    // The sign-in URL bounced to a page that only links to the form.
    const link = page.getByRole("link", { name: /^(sign in|log in|login)$/i }).or(page.getByRole("button", { name: /^(sign in|log in|login)$/i })).first();
    if (await link.isVisible().catch(() => false)) await link.click({ timeout: 10_000 });
    await settle(page, 2_000);
    surface = await readSignInSurface(page);
    classification = classifySignInSurface(providerId, surface);
  }
  if (classification.status === "signed-in") return result(providerId, "already-signed-in", null, surface, log);
  if (classification.status === "signed-out") return result(providerId, "needs-user", "sign-in-form-not-found", surface, log);
  if (classification.status === "needs-user") return result(providerId, "needs-user", classification.reason, surface, log);

  // Username-first flows: submit the autofilled account step, then wait for
  // the password step and its own autofill.
  if (!requireBothFields && !surface.passwordVisible && surface.usernameVisible) {
    surface = await waitForAutofill(page, autofillTimeoutMs);
    if (!surface.usernameAutofilled) return result(providerId, "needs-user", "no-saved-credentials-autofilled", surface, log);
    await submitAutofilledForm(page, 'input[autocomplete="username"], input[type="email"], input[name*="user" i], input[name*="email" i]');
    await settle(page, 2_000);
  }

  surface = await waitForAutofill(page, autofillTimeoutMs);
  classification = classifySignInSurface(providerId, surface);
  if (classification.status !== "sign-in-form") {
    return result(providerId, classification.status === "signed-in" ? "signed-in" : "needs-user", classification.reason || null, surface, log);
  }
  if (!surface.passwordVisible || !surface.passwordAutofilled ||
      (requireBothFields ? !surface.usernameVisible || !surface.usernameAutofilled : !(surface.usernameAutofilled || !surface.usernameVisible))) {
    return result(providerId, "needs-user", "no-saved-credentials-autofilled", surface, log);
  }
  log(`Submitting only the Chrome-autofilled ${provider.label} sign-in form.`);
  if (!(await submitAutofilledForm(page, 'input[type="password"]', { requireBothFields, submitSelector: provider.submitSelector }))) {
    return result(providerId, "needs-user", "no-submit-control", surface, log);
  }

  const deadline = Date.now() + completionTimeoutMs;
  while (Date.now() < deadline) {
    await page.waitForTimeout(1_000);
    surface = await readSignInSurface(page);
    classification = classifySignInSurface(providerId, surface);
    if (classification.status === "signed-in") return result(providerId, "signed-in", null, surface, log);
    if (classification.status === "needs-user") return result(providerId, "needs-user", classification.reason, surface, log);
  }
  return result(providerId, "needs-user", "sign-in-did-not-complete", surface, log);
}

function result(providerId, status, reason, surface, log) {
  const label = savedSignInProviders[providerId].label;
  log(`${label}: ${status}${reason ? ` (${reason})` : ""}`);
  return { provider: providerId, status, ...(reason ? { reason } : {}), surface: redactSurface(surface) };
}

// URLs can carry account or session tokens in their query; keep only origin
// and path, plus booleans that describe the form state.
function redactSurface(surface) {
  let url = "";
  try {
    const parsed = new URL(surface.url);
    url = `${parsed.origin}${parsed.pathname}`;
  } catch {}
  const { url: _url, ...facts } = surface;
  return { url, ...facts };
}

function requireProvider(providerId) {
  const provider = savedSignInProviders[providerId];
  if (!provider) throw new Error(`Saved sign-in is not available for provider ${providerId}. Supported: ${savedSignInProviderIds.join(", ")}.`);
  return provider;
}
