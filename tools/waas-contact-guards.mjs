export const waasEnquiryUrl = "https://capublic.worcestershire.gov.uk/WAASPublic/EnquiryForm.aspx?ServiceCode=ARCHENQ";

const normalize = (value) => String(value).replace(/\s+/g, " ").trim();

export function waasReviewMatches({ url, body, question, identity }) {
  if (url !== waasEnquiryUrl || !body.includes("Please confirm details of enquiry")) return false;
  const details = body.match(/Enquiry Details([\s\S]*?)\nImportant\n/);
  const contact = body.match(/Contact Details([\s\S]*?)\nServiceArchive Enquiry\n/);
  return Boolean(details && contact
    && normalize(details[1]) === normalize(question)
    && normalize(contact[1]) === normalize(`${identity.displayName} ${identity.email}`));
}

export function waasReceipt({ url, body, hasSubmitControl }) {
  body = normalize(body);
  let current;
  try { current = new URL(url); } catch { return null; }
  // This exact completed page and reference wording were observed in the
  // provider's live receipt; echoed enquiry text is never a confirmation.
  if (current.origin !== "https://capublic.worcestershire.gov.uk"
    || current.pathname !== "/WAASPublic/ConfirmationScreenFree.aspx"
    || hasSubmitControl !== false
    || /Please confirm details of enquiry|Enquiry Details|Contact Details/i.test(body)
    || !/\bConfirmation\b/.test(body)
    || !body.includes("Thank you for contacting Worcestershire Archive and Archaeology Service.")
    || !body.includes("Your enquiry has been logged, and we aim to respond within 7 working days.")) return null;
  const reference = body.match(/The reference number for your application is #(\d{6,12})\./)?.[1];
  return reference ? { reference } : null;
}
