// Pure policy for the Wuppertal Service Portal helper (Stadtarchiv register
// extracts, e.g. a 1916 Barmen death entry). Kept free of
// browser code so the guards are unit-tested.

export const portalHosts = Object.freeze([
  "serviceportal.wuppertal.de",
  "www.wuppertal.de",
  "wuppertal.de"
]);

// Controls that commit an order, send data, or start payment. Exploration
// never clicks them; only a separately authorized submit step may.
const committingControl = /\b(absenden|abschicken|senden|kostenpflichtig|zahlungspflichtig|bezahlen|zahlung|paypal|kreditkarte|bestellung\s+abschlie(?:ss|ß)en|verbindlich|einreichen|submit|pay|order now|antrag\s+stellen)\b/i;
// Controls that touch the account or identity. Sign-in is a human step.
const accountControl = /\b(anmelden|login|log in|registrieren|konto\s+anlegen|passwort|bundid|online-ausweis|abmelden|logout)\b/i;

export function assertPortalUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Pass one https Wuppertal Service Portal URL.");
  }
  if (url.protocol !== "https:" || !portalHosts.includes(url.hostname) || url.username || url.password || url.port) {
    throw new Error(`Only https URLs on ${portalHosts.join(", ")} are allowed.`);
  }
  return url;
}

// Exploration may follow a visible link or button only when its accessible
// text neither commits an order nor touches the account.
export function explorationClickRefusal(label) {
  const text = String(label || "").replace(/\s+/g, " ").trim();
  if (!text || text.length > 120) return "Pass the exact visible text (1-120 characters) of one link or button.";
  if (committingControl.test(text)) return `Refusing "${text}": it would submit, order or pay; that needs the authorized submit step.`;
  if (accountControl.test(text)) return `Refusing "${text}": sign-in and account controls are a human step.`;
  return null;
}

// Field descriptions carry labels and types only, never values.
export function describeField(field) {
  return {
    tag: field.tag,
    type: field.type || "",
    name: String(field.name || "").slice(0, 80),
    label: String(field.label || "").replace(/\s+/g, " ").trim().slice(0, 160),
    required: Boolean(field.required),
    options: Array.isArray(field.options) ? field.options.slice(0, 30).map((option) => String(option).slice(0, 80)) : undefined
  };
}
