#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { waasEnquiryUrl, waasReviewMatches, waasReceipt } from "./waas-contact-guards.mjs";
import { openSharedChromeTask, sharedChromeEndpoint, sharedPageInventory } from "./shared-chrome-task.mjs";
import { foreignHoldingClaims, outboundVerificationIssues } from "./holding-claims.mjs";
import { appendExternalRequestEvent, deriveExternalRequest } from "./external-request-store.mjs";
import { requireConsent } from "./consents.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const targetId = valueAfter("--target");
const confirmation = valueAfter("--confirmation");
const mode = valueAfter("--mode");
const resumeReview = process.argv.includes("--resume-review");
const endpoint = valueAfter("--endpoint") || sharedChromeEndpoint;
const affinitySlot = valueAfter("--affinity-slot") || "archive-contact-form";
const captchaWaitMs = clampSeconds(valueAfter("--captcha-wait-seconds"), 900, 60, 3600) * 1_000;
const contactProfile = process.argv.includes("--contact-profile-stdin") ? readContactProfileFromStdin() : null;
let preserveTaskTab = false;

const US_STATES = new Map([
  ["AL","Alabama"],["AK","Alaska"],["AZ","Arizona"],["AR","Arkansas"],["CA","California"],
  ["CO","Colorado"],["CT","Connecticut"],["DE","Delaware"],["DC","District of Columbia"],
  ["FL","Florida"],["GA","Georgia"],["HI","Hawaii"],["ID","Idaho"],["IL","Illinois"],
  ["IN","Indiana"],["IA","Iowa"],["KS","Kansas"],["KY","Kentucky"],["LA","Louisiana"],
  ["ME","Maine"],["MD","Maryland"],["MA","Massachusetts"],["MI","Michigan"],["MN","Minnesota"],
  ["MS","Mississippi"],["MO","Missouri"],["MT","Montana"],["NE","Nebraska"],["NV","Nevada"],
  ["NH","New Hampshire"],["NJ","New Jersey"],["NM","New Mexico"],["NY","New York"],
  ["NC","North Carolina"],["ND","North Dakota"],["OH","Ohio"],["OK","Oklahoma"],["OR","Oregon"],
  ["PA","Pennsylvania"],["RI","Rhode Island"],["SC","South Carolina"],["SD","South Dakota"],
  ["TN","Tennessee"],["TX","Texas"],["UT","Utah"],["VT","Vermont"],["VA","Virginia"],
  ["WA","Washington"],["WV","West Virginia"],["WI","Wisconsin"],["WY","Wyoming"]
]);

if (!/^[a-z0-9][a-z0-9-]{0,127}$/.test(targetId || "")) throw new Error("Pass one safe acquisition target ID.");
if (!new Set(["inspect", "submit", "diagnose", "receipt"]).has(mode)) throw new Error("Contact-form mode must be inspect, diagnose, submit, or receipt.");
if (!process.argv.includes("--shared-window") || endpoint !== sharedChromeEndpoint) {
  throw new Error(`Contact forms must use the shared Windows Chrome wrapper at ${sharedChromeEndpoint}.`);
}
// Inspecting a public form is research; filling it with the owner's details is not.
if (mode !== "inspect") requireConsent("contact-form");

const targetFile = path.join(projectRoot, "evidence", "acquisition", "targets", `${targetId}.json`);
const target = readJson(targetFile);
const route = target.routes?.find((candidate) => candidate.confirmationPhrase === confirmation)
  || target.routes?.find((candidate) => candidate.requestId === targetId);
if (!route?.requestId) throw new Error(`${targetId} has no canonical contact-form request.`);
const requestFile = path.join(projectRoot, "evidence", "acquisition", "requests", `${route.requestId}.json`);
let requestRecord = readJson(requestFile);
const request = requestRecord.spec;

if (requestRecord.kind !== "no-charge-form" || request?.channel !== "form") {
  throw new Error(`${targetId} is not a canonical no-charge contact form.`);
}
if (confirmation !== requestRecord.guard?.requiredPhrase || confirmation !== route.confirmationPhrase) {
  throw new Error(`Final submission requires the exact confirmation phrase: ${requestRecord.guard?.requiredPhrase}`);
}
if (requestRecord.guard?.costMode !== "no-charge") throw new Error("The canonical no-charge guard is missing or changed.");
// Validation catches a mis-addressed request at check time, but the send is
// where a real person's time gets spent, so refuse here too. A route citing
// another repository's own collection must record item-level proof that this
// provider holds it.
// Both halves of the request must be verified before a real institution is
// contacted: that this provider holds the item, and that the address is theirs.
for (const problem of (mode !== "submit" ? [] : outboundVerificationIssues(target, route, requestRecord))) {
  throw new Error(`${targetId}/${route.id} is not verified for sending: ${problem}`);
}
const foreignHoldings = foreignHoldingClaims(target, route, { requireOutboundStatus: false });
if (foreignHoldings.length) {
  throw new Error(`${targetId}/${route.id} cites a holding that names another repository; record item-level holdingVerification for ${route.provider} before contacting them.`);
}
const allowedUrls = new Set([
  "https://capublic.worcestershire.gov.uk/WAASPublic/EnquiryForm.aspx?ServiceCode=ARCHENQ",
  "https://mymcls.com/ask-a-librarian-form/",
  "https://lebanoncountyhistory.pastperfectonline.com/archive/3D2F2F60-B335-4EF8-834D-840852845299",
  "https://www.lebanoncountypa.gov/departments/register-of-wills/contacts/general-mailbox/register-of-wills-office"
]);
if (!allowedUrls.has(request.url)) throw new Error("The canonical contact-form URL is not approved.");

let state = deriveExternalRequest(requestRecord);
if (mode === "submit" && state.operationalState === "authorization-required") {
  persistEvent({
    type: "authorization-confirmed",
    phrase: confirmation,
    payloadSha256: requestRecord.payloadSha256,
    basis: "exact-helper-confirmation"
  });
  state = deriveExternalRequest(requestRecord);
}
if (mode === "submit" && state.operationalState !== "authorized") {
  throw new Error(`${route.requestId} is ${state.operationalState}; refusing a duplicate or unsafe submission.`);
}

const session = await openSharedChromeTask({
  chromium,
  endpoint,
  taskLabel: "authorized archive contact form",
  affinitySlot,
  reconnectExisting: resumeReview || mode === "receipt",
  timeoutMs: 20_000
});

try {
  const page = session.page;
  page.setDefaultTimeout(15_000);

  if (mode === "receipt") {
    preserveTaskTab = session.reused;
    if (!session.reused || request.url !== waasEnquiryUrl || !state.authorizationValid) throw new Error("Only the authorized parked WAAS receipt may be reconciled.");
    const body = await page.locator("body").innerText();
    const submit = page.getByRole("button", { name: "Submit", exact: true }).or(page.getByRole("link", { name: "Submit", exact: true }));
    const receipt = waasReceipt({ url: page.url(), body, hasSubmitControl: await submit.isVisible().catch(() => false) });
    if (!receipt) throw new Error("The parked WAAS page has no verified receipt; no action taken.");
    if (!requestRecord.events.some(event => event.type === "submission-started" && event.basis === "verified-WAAS-final-review")) throw new Error("No verified final WAAS action binds this receipt to the request.");
    const previousReceipt = requestRecord.events.findLast(event => event.type === "submission-confirmed");
    if (previousReceipt && previousReceipt.reference !== receipt.reference) throw new Error("WAAS receipt differs from the recorded confirmation; no action taken.");
    if (state.operationalState !== "waiting-external") persistEvent({ type: "submission-confirmed", basis: "WAAS-live-ConfirmationScreenFree-receipt", reference: receipt.reference });
    console.log(JSON.stringify({ targetId, outcome: "waiting-external", reference: receipt.reference }));
    preserveTaskTab = false;
  } else if (resumeReview && mode === "inspect") {
    preserveTaskTab = session.reused;
    if (!session.reused || request.url !== waasEnquiryUrl || page.url() !== waasEnquiryUrl) throw new Error("The exact parked WAAS contact-form tab is missing or changed.");
    console.log(JSON.stringify({ controls: await safeControlInventory(page), captcha: await page.locator('.g-recaptcha, iframe[src*="recaptcha"]').evaluateAll(elements => elements.map(e => ({ tag: e.tagName, title: e.title, size: e.getAttribute("data-size"), visible: !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length), width: e.offsetWidth, height: e.offsetHeight }))) }));
    await session.showForManualStep("Worcestershire enquiry CAPTCHA");
  } else if (resumeReview) {
    preserveTaskTab = session.reused;
    if (!session.reused || mode !== "submit" || !request.url.includes("/WAASPublic/EnquiryForm.aspx")) throw new Error("Only the existing authorized WAAS review tab may resume.");
    const identitySession = await openSharedChromeTask({ chromium, endpoint, taskLabel: "authorized archive requester identity", affinitySlot: "waas-requester-identity" });
    let identity;
    try { identity = await readGmailIdentity(identitySession.page, identitySession); } finally { await sharedPageInventory(identitySession.context); await identitySession.close(); }
    await finishWaasReview(page, session, identity, request.question);
  } else if (mode === "inspect") {
    await openCanonicalForm(page, request.url);
    console.log(JSON.stringify({ targetId, url: canonicalPageUrl(page.url()), controls: await safeControlInventory(page) }, null, 2));
  } else {
    const dryRun = mode === "diagnose";
    const identity = await readGmailIdentity(page, session);
    await openCanonicalForm(page, request.url);
    if (request.url.startsWith("https://lebanoncountyhistory.pastperfectonline.com/")) {
      await submitPastPerfectFeedback(page, identity, request.question, dryRun);
    } else if (request.url.startsWith("https://www.lebanoncountypa.gov/")) {
      await submitLebanonCountyForm(page, session, identity, request.question, dryRun);
    } else if (request.url === "https://mymcls.com/ask-a-librarian-form/") {
      await submitMclsForm(page, session, identity, request.question, dryRun);
    } else if (request.url === "https://capublic.worcestershire.gov.uk/WAASPublic/EnquiryForm.aspx?ServiceCode=ARCHENQ") {
      await submitWaasForm(page, session, identity, request.question, dryRun);
    } else {
      throw new Error("The approved form has no provider-specific submit adapter.");
    }
    console.log(JSON.stringify({ targetId, outcome: dryRun ? "verified-not-submitted" : "waiting-external", checkedAt: new Date().toISOString() }));
  }
} finally {
  if (preserveTaskTab) {
    console.log("Leaving the shared-window contact-form tab open for the manual/provider step; releasing the task connection without closing it.");
    await session.leaveOpen();
  } else {
    await sharedPageInventory(session.context);
    await session.close();
  }
  if (["submit", "receipt"].includes(mode)) execFileSync(process.execPath, ["tools/sync-external-request-projections.mjs"], { cwd: projectRoot, stdio: "inherit" });
}

async function openCanonicalForm(page, url) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(2_000);
}

async function readGmailIdentity(page, session) {
  await page.goto("https://mail.google.com/mail/u/0/#inbox", { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page.waitForTimeout(2_000);
  let compose = page.getByRole("button", { name: /compose/i }).first();
  if (!await compose.isVisible().catch(() => false)) {
    await session.showForManualStep("Gmail sign-in required before authorized contact-form submission");
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline && !await compose.isVisible().catch(() => false)) await page.waitForTimeout(1_000);
  }
  if (!await compose.isVisible().catch(() => false)) throw new Error("Gmail is not signed in; no contact form was submitted.");
  const account = page.locator('[aria-label^="Google Account"], [aria-label*="Google Account:"]').first();
  const label = String(await account.getAttribute("aria-label").catch(() => "") || "").replace(/\s+/g, " ").trim();
  const emailMatch = label.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  if (!emailMatch) throw new Error("The signed-in Gmail identity could not be verified; no contact form was submitted.");
  const email = emailMatch[0];
  let displayName = label
    .replace(/^Google Account:?\s*/i, "")
    .replace(emailMatch[0], "")
    .replace(/[()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const nameParts = displayName.split(" ").filter(Boolean);
  if (nameParts.length < 2) throw new Error("The signed-in Gmail display name could not be verified; no contact form was submitted.");
  return { email, displayName, firstName: nameParts[0], lastName: nameParts.at(-1) };
}

async function submitWaasForm(page, session, identity, question, dryRun = false) {
  const expectedUrl = "https://capublic.worcestershire.gov.uk/WAASPublic/EnquiryForm.aspx?ServiceCode=ARCHENQ";
  if (page.url() !== expectedUrl) throw new Error("WAAS form URL changed; no request was submitted.");
  const fields = [
    [page.locator('textarea[id$="wtEnquiryArchive_Details"]'), question],
    [page.locator('input[id$="wtCustomerRequest_FirstName"]'), identity.firstName],
    [page.locator('input[id$="wtCustomerRequest_LastName"]'), identity.lastName],
    [page.locator('input[id$="wtCustomerRequest_Email"]'), identity.email]
  ];
  for (const [field, value] of fields) await field.fill(value);
  const accuracy = page.getByLabel("Please confirm the information you are submitting is accurate to the best of your knowledge", { exact: true });
  await accuracy.check();
  for (const [field, value] of fields) {
    if (await field.inputValue() !== value) throw new Error("WAAS form payload verification failed; no request was submitted.");
  }
  if (!await accuracy.isChecked()) throw new Error("WAAS accuracy confirmation was not retained.");
  if (dryRun) {
    console.log(JSON.stringify({ outcome: "verified-not-submitted", form: await describeFormState(page, "form") }));
    return;
  }
  preserveTaskTab = true;
  await awaitHumanCaptchaToken(page, session, "Worcestershire archive enquiry");
  await page.getByRole("link", { name: "Next", exact: true }).click();
  await page.waitForTimeout(3_000);
  await finishWaasReview(page, session, identity, question);
}

async function finishWaasReview(page, session, identity, question) {
  preserveTaskTab = true;
  const body = await page.locator("body").innerText();
  if (!waasReviewMatches({ url: page.url(), body, question, identity })) {
    throw new Error("WAAS review does not match the authorized enquiry and requester; task tab preserved.");
  }
  const submit = page.getByRole("button", { name: "Submit", exact: true }).or(page.getByRole("link", { name: "Submit", exact: true }));
  if (await submit.count() !== 1) throw new Error("WAAS review has no unique final Submit control.");
  const captcha = page.locator('textarea[name="g-recaptcha-response"]');
  const captchaAnchor = page.locator('iframe[src*="recaptcha"][src*="anchor"]');
  if (await captcha.count() && !await captcha.inputValue()
    && (body.includes("Please confirm you are not a robot") || await captchaAnchor.first().isVisible().catch(() => false))) {
    await session.showForManualStep("Worcestershire enquiry CAPTCHA");
    console.log(`NEEDS USER ${targetId} — complete the visible CAPTCHA; the verified enquiry resumes automatically.`);
    const deadline = Date.now() + captchaWaitMs;
    while (Date.now() < deadline && !await captcha.inputValue()) await page.waitForTimeout(1_000);
    if (!await captcha.inputValue()) throw new Error("WAAS CAPTCHA remains pending; verified task tab preserved.");
    if (!waasReviewMatches({ url: page.url(), body: await page.locator("body").innerText(), question, identity })) {
      throw new Error("WAAS review changed while CAPTCHA was pending; no request was submitted.");
    }
  }
  persistEvent({ type: "submission-started", basis: "verified-WAAS-final-review" });
  await submit.click();
  const deadline = Date.now() + captchaWaitMs;
  let shown = false;
  while (Date.now() < deadline) {
    const current = await page.locator("body").innerText();
    const receipt = waasReceipt({ url: page.url(), body: current, hasSubmitControl: await submit.isVisible().catch(() => false) });
    if (receipt) {
      const { reference } = receipt;
      persistEvent({ type: "submission-confirmed", basis: "WAAS-visible-submission-confirmation", ...(reference ? { reference } : {}) });
      console.log(JSON.stringify({ stage: "WAAS-confirmed", ...(reference ? { reference } : {}) }));
      preserveTaskTab = false;
      return;
    }
    const challenge = page.locator('iframe[src*="recaptcha"][src*="bframe"]');
    if (!shown && await challenge.first().isVisible().catch(() => false)) {
      shown = true;
      await session.showForManualStep("Worcestershire enquiry CAPTCHA");
      console.log(`NEEDS USER ${targetId} — complete the visible CAPTCHA in the preserved archive tab; submission resumes automatically.`);
    }
    if (!shown && Date.now() > deadline - captchaWaitMs + 20_000) {
      console.log(JSON.stringify({ stage: "WAAS-provider-result", url: canonicalPageUrl(page.url()), reviewPresent: current.includes("Please confirm details of enquiry"), captchaRequired: current.includes("Please confirm you are not a robot") }));
      throw new Error("WAAS receipt requires inspection; no repeat submit permitted, task tab preserved.");
    }
    await page.waitForTimeout(1_000);
  }
  throw new Error("WAAS CAPTCHA remains pending; verified task tab preserved.");
}

async function submitPastPerfectFeedback(page, identity, question, dryRun = false) {
  const consent = page.getByRole("button", { name: "I Agree", exact: true });
  if (await consent.isVisible().catch(() => false)) await consent.click();
  const open = page.locator("#cmdSendFeedback2");
  await open.waitFor({ state: "visible" });
  await open.click();
  const name = page.locator("#feedbackViewModel_FeedBack_name");
  const email = page.locator("#feedbackViewModel_FeedBack_emailaddress");
  const comments = page.locator("#feedbackViewModel_FeedBack_feedbackfield");
  await name.waitFor({ state: "visible" });
  await name.fill(identity.displayName);
  await email.fill(identity.email);
  await comments.fill(question);
  if (await name.inputValue() !== identity.displayName
    || await email.inputValue() !== identity.email
    || normalized(await comments.inputValue()) !== normalized(question)) {
    throw new Error("PastPerfect contact-form payload verification failed; no request was submitted.");
  }
  if (dryRun) {
    console.log(JSON.stringify(await describeFormState(page, "form"), null, 2));
    return;
  }
  persistEvent({ type: "submission-started", basis: "verified-PastPerfect-feedback-form" });
  await page.locator("#saveFeedBackButton").click();
  const confirmation = page.getByRole("button", { name: "OK", exact: true });
  await confirmation.waitFor({ state: "visible", timeout: 30_000 });
  const providerMessage = await page.locator("#feedbackViewModel_FeedbackConfirmationMessage").getAttribute("value").catch(() => "");
  if (!/(thank|received|sent|submitted|feedback)/i.test(providerMessage || "")) {
    throw new Error("PastPerfect exposed no unambiguous submission confirmation; request state remains uncertain.");
  }
  persistEvent({ type: "submission-confirmed", basis: "PastPerfect-visible-confirmation-dialog" });
}

async function submitLebanonCountyForm(page, session, identity, question, dryRun = false) {
  const firstName = page.locator('[name$="FirstName.Value"]');
  const lastName = page.locator('[name$="LastName.Value"]');
  const email = page.locator('[name$="EmailInput.Email"]');
  const requestField = page.locator('[name$="Request.Value"]');
  await firstName.fill(identity.firstName);
  await lastName.fill(identity.lastName);
  await email.fill(identity.email);
  await requestField.fill(question);
  const preferenceInput = page.locator('input[type="radio"][name$="ContactPreference.SelectedValue"]').nth(1);
  await preferenceInput.check();
  if (await firstName.inputValue() !== identity.firstName
    || await lastName.inputValue() !== identity.lastName
    || await email.inputValue() !== identity.email
    || normalized(await requestField.inputValue()) !== normalized(question)
    || !await preferenceInput.isChecked()) {
    throw new Error("Lebanon County contact-form payload verification failed; no request was submitted.");
  }
  const form = requestField.locator("xpath=ancestor::form[1]");
  const submit = form.locator('input[type="submit"], button[type="submit"]').last();
  if (dryRun) {
    console.log(JSON.stringify(await describeFormState(page, "form"), null, 2));
    return;
  }
  persistEvent({ type: "submission-started", basis: "verified-Lebanon-County-contact-form" });
  await submit.click();
  await resolveCaptchaIfRequired(page, session, "Lebanon County contact form");
  const confirmation = page.locator("body").getByText(/thank you|successfully submitted|has been submitted|message has been sent/i).first();
  // On timeout, capture what the provider actually rendered before the session
  // tears the tab down; otherwise the failure is indistinguishable from a
  // delivered request and the state machine can only record uncertainty.
  try {
    await confirmation.waitFor({ state: "visible", timeout: 45_000 });
  } catch (error) {
    const rendered = await describeFormState(page, "#gform_2").catch(() => null);
    throw new Error(
      "MCLS returned no confirmation after submit. Provider page state: "
      + JSON.stringify(rendered)
    );
  }
  persistEvent({ type: "submission-confirmed", basis: "Lebanon-County-visible-confirmation" });
}

async function submitMclsForm(page, session, identity, question, dryRun = false) {
  const firstName = page.locator("#input_2_6_3");
  const lastName = page.locator("#input_2_6_6");
  const email = page.locator("#input_2_2");
  const city = page.locator("#input_2_4_3");
  const state = page.locator("#input_2_4_4");
  const questionField = page.locator("#input_2_5");
  await firstName.click();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(750);
  await firstName.fill(identity.firstName);
  await lastName.fill(identity.lastName);
  await email.fill(identity.email);
  await questionField.fill(question);
  // The signed-in Gmail identity supplies name and email but not locality, so
  // city/state come from the DPAPI requester profile when one is configured.
  // Chrome autofill remains the fallback when it is not.
  if (contactProfile && (!await city.inputValue() || !await state.inputValue())) {
    await fillLocalityField(city, contactProfile.city, "city");
    await fillLocalityField(state, contactProfile.state, "state");
  }
  if (!await city.inputValue() || !await state.inputValue()) {
    await session.showForManualStep("Chrome contact autofill for the required city/state");
    const contactDeadline = Date.now() + 300_000;
    while (Date.now() < contactDeadline && (!await city.inputValue() || !await state.inputValue())) await page.waitForTimeout(1_000);
  }
  if (!await city.inputValue() || !await state.inputValue()) {
    throw new Error("MCLS still lacks required city/state contact fields; no request was submitted.");
  }
  if (await firstName.inputValue() !== identity.firstName
    || await lastName.inputValue() !== identity.lastName
    || await email.inputValue() !== identity.email
    || normalized(await questionField.inputValue()) !== normalized(question)) {
    throw new Error("MCLS contact-form payload verification failed; no request was submitted.");
  }
  // Everything else is filled and verified by this point, so the remaining
  // human step is one checkbox. Submission proceeds the moment the token
  // appears rather than after a fixed wait.
  if (dryRun) {
    console.log(JSON.stringify(await describeFormState(page, "#gform_2"), null, 2));
    return;
  }
  // Keep this exact task tab alive if the human CAPTCHA or the provider's
  // post-submit response needs attention. The wrapper releases the mutex but
  // must not close the only visible form before the user can act.
  preserveTaskTab = true;
  await awaitHumanCaptchaToken(page, session, "MCLS");
  persistEvent({ type: "submission-started", basis: "verified-MCLS-form-and-manual-CAPTCHA" });
  await page.locator("#gform_submit_button_2").click();
  const confirmation = page.locator(
    "#gform_confirmation_message_2, [id^=\"gform_confirmation_message\"], .gform_confirmation_message"
  ).first();
  await confirmation.waitFor({ state: "visible", timeout: 45_000 });
  if (!/(thank|received|submitted|contact)/i.test(await confirmation.innerText())) {
    throw new Error("MCLS exposed no unambiguous submission confirmation; request state remains uncertain.");
  }
  persistEvent({ type: "submission-confirmed", basis: "MCLS-visible-confirmation" });
  preserveTaskTab = false;
}

// Waits for a human-completed reCAPTCHA token on forms that actually render
// one. A form with no CAPTCHA widget returns immediately instead of burning the
// whole wait window against an element that will never exist.
// Reports what a filled form currently looks like without submitting it, so a
// failing submission can be diagnosed without sending another request to a
// provider. Field values are summarized, never echoed verbatim.
async function describeFormState(page, formSelector) {
  return await page.evaluate((selector) => {
    const form = document.querySelector(selector);
    const controls = Array.from(form ? form.querySelectorAll("input, select, textarea") : [])
      .filter((element) => element.type !== "hidden")
      .map((element) => ({
        id: element.id || null,
        tag: element.tagName.toLowerCase(),
        required: element.required || element.getAttribute("aria-required") === "true",
        invalid: element.getAttribute("aria-invalid") === "true",
        filled: Boolean(String(element.value || "").trim()),
        length: String(element.value || "").trim().length
      }));
    const validation = Array.from(document.querySelectorAll(
      ".gfield_error, .validation_message, .gform_validation_errors, [id^='validation_message']"
    )).map((node) => (node.textContent || "").replace(/\s+/g, " ").trim()).filter(Boolean);
    const submit = form ? form.querySelector('input[type="submit"], button[type="submit"]') : null;
    return {
      formFound: Boolean(form),
      url: location.href,
      controls,
      unfilledRequired: controls.filter((c) => c.required && !c.filled).map((c) => c.id),
      invalidFields: controls.filter((c) => c.invalid).map((c) => c.id),
      validationMessages: validation,
      submitDisabled: submit ? Boolean(submit.disabled) : null
    };
  }, formSelector);
}

async function awaitHumanCaptchaToken(page, session, label) {
  const token = page.locator("#g-recaptcha-response");
  const widget = page.locator('.g-recaptcha, iframe[src*="recaptcha"]');
  if (!await token.count() && !await widget.count()) return;

  const read = async () => await token.inputValue().catch(() => "");

  // A token already present right after a fresh navigation is a restored value
  // from an earlier attempt, not a solve for this one. Google rejects it at
  // verification ("The reCAPTCHA was invalid"), so clear it and require a real
  // solve rather than submitting something the server will refuse.
  if (await read()) {
    await page.evaluate(() => {
      const field = document.querySelector("#g-recaptcha-response");
      if (field) field.value = "";
      if (window.grecaptcha && typeof window.grecaptcha.reset === "function") window.grecaptcha.reset();
    }).catch(() => {});
  }

  await session.showForManualStep(`manual ${label} CAPTCHA completion`);
  const deadline = Date.now() + captchaWaitMs;
  while (Date.now() < deadline) {
    await page.waitForTimeout(1_000);
    if (await read()) return;
  }
  throw new Error(
    `${label} CAPTCHA was not completed within ${Math.round(captchaWaitMs / 60_000)} minute(s); no request was submitted. `
    + "The verified payload was discarded rather than left half-submitted; re-run the same command to refill it."
  );
}

async function resolveCaptchaIfRequired(page, session, label) {
  const challenge = page.locator('iframe[src*="recaptcha"]:visible, iframe[title*="challenge" i]:visible');
  if (!await challenge.count()) return;
  await session.showForManualStep(`manual CAPTCHA completion for ${label}`);
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline && await challenge.count()) await page.waitForTimeout(1_000);
  if (await challenge.count()) throw new Error(`${label} CAPTCHA was not completed; submission state is uncertain.`);
}

function normalized(value) {
  return String(value || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

// Accepts either an abbreviation or a full state name so the stored profile does
// not have to match a particular provider form's option set.
function stateAliases(value) {
  const raw = normalized(value).toLowerCase();
  const aliases = new Set([raw]);
  const upper = raw.toUpperCase();
  if (US_STATES.has(upper)) aliases.add(US_STATES.get(upper).toLowerCase());
  for (const [abbreviation, name] of US_STATES) {
    if (name.toLowerCase() === raw) aliases.add(abbreviation.toLowerCase());
  }
  return aliases;
}

// A locality control may be a text input on one provider form and a <select> on
// another, and fill() throws on a <select>.
async function fillLocalityField(locator, value, label) {
  const tag = await locator.evaluate((element) => element.tagName.toLowerCase());
  if (tag !== "select") {
    await locator.fill(value);
    return;
  }
  const options = await locator.evaluate((element) => Array.from(element.options)
    .map((option) => ({ value: option.value, text: (option.textContent || "").trim() })));
  const aliases = label === "state"
    ? stateAliases(value)
    : new Set([normalized(value).toLowerCase()]);
  const match = options.find((option) => aliases.has(normalized(option.value).toLowerCase())
    || aliases.has(normalized(option.text).toLowerCase()));
  if (!match) {
    throw new Error("The configured " + label + " does not match any option on this form; no request was submitted.");
  }
  await locator.selectOption({ value: match.value });
}

function clampSeconds(raw, fallback, minimum, maximum) {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.max(Math.round(parsed), minimum), maximum);
}

// Reads the DPAPI-held requester locality fields piped in by the Windows
// wrapper. The values fill the form and are never logged, echoed, written to
// the repository, or placed on a command line.
function readContactProfileFromStdin() {
  let raw = "";
  try {
    raw = fs.readFileSync(0, "utf8");
  } catch {
    return null;
  }
  if (!raw.trim()) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("The archive requester profile on standard input was not valid JSON.");
  }
  const city = String(parsed?.city ?? "").trim();
  const state = String(parsed?.state ?? "").trim();
  if (!city || !state) return null;
  return { city, state };
}

async function safeControlInventory(page) {
  return page.locator("input,textarea,select,button").evaluateAll((elements) => elements.slice(0, 160).map((element) => {
    const id = element.getAttribute("id") || "";
    const labels = id
      ? [...document.querySelectorAll(`label[for="${CSS.escape(id)}"]`)].map((label) => label.textContent || "")
      : [];
    return {
      tag: element.tagName.toLowerCase(),
      type: element.getAttribute("type") || "",
      name: element.getAttribute("name") || "",
      id,
      ariaLabel: element.getAttribute("aria-label") || "",
      placeholder: element.getAttribute("placeholder") || "",
      autocomplete: element.getAttribute("autocomplete") || "",
      required: element.matches(":required"),
      label: labels.join(" ").replace(/\s+/g, " ").trim().slice(0, 160),
      text: element.tagName === "BUTTON" ? (element.textContent || "").replace(/\s+/g, " ").trim().slice(0, 120) : "",
      providerConfirmation: /ConfirmationMessage$/.test(element.getAttribute("name") || "")
        ? String(element.getAttribute("value") || "").replace(/\s+/g, " ").trim().slice(0, 240)
        : ""
    };
  }));
}

function canonicalPageUrl(value) {
  const url = new URL(value);
  return `${url.origin}${url.pathname}`;
}

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  return index < 0 ? "" : process.argv[index + 1] || "";
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function persistEvent(event) {
  requestRecord = appendExternalRequestEvent(requestRecord, event, { expectedRevision: requestRecord.revision });
  const temporary = `${requestFile}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(requestRecord, null, 2)}\n`, { flag: "wx" });
  fs.renameSync(temporary, requestFile);
  // Authorization precedes browser creation, which can fail before finally.
  // Keep existing providers' immediate projections; WAAS final events sync in
  // finally so projection I/O cannot expire a freshly completed CAPTCHA.
  if (request.url !== waasEnquiryUrl || event.type === "authorization-confirmed") {
    execFileSync(process.execPath, ["tools/sync-external-request-projections.mjs"], { cwd: projectRoot, stdio: "inherit" });
  }
}
