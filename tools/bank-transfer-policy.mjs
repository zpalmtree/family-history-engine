// What the guarded Wise transfer helper may send, to whom, and how much.
//
// AGENTS.md (3 Nov 2026) lets tools/guarded-bank-transfer.mjs prepare a Wise
// transfer for a request whose provider takes only bank transfer. These are
// the pure checks behind that rule. Payee bank details are read from the
// provider's own payment instructions and held only in memory: nothing here
// returns them in a form meant for printing except the masked summary.

import zlib from "node:zlib";

import { deriveExternalRequest } from "./external-request-store.mjs";
import { ownerSurnameOrNull } from "./tree-config.mjs";

export const bankTransferProfiles = Object.freeze({
  // Reviewed 3 Nov 2026 from "Huntingdon Archives Payment Information_.docx",
  // attached to Hunts Archives' 29 Oct 2026 reply: NatWest, account name
  // Cambridgeshire County Council, reference "HAArchives then your surname".
  huntingdonshire: Object.freeze({
    provider: "Huntingdonshire Archives",
    beneficiaryName: "Cambridgeshire County Council",
    bankName: /\bnatwest\b/i,
    gmailQuery: 'subject:"Locator and quote enquiry: Wright-Arnold marriage licence" from:cambridgeshire.gov.uk',
    instructionsAttachment: "Huntingdon Archives Payment Information_.docx",
    referenceRule: /use\s+HAArchives\s+then\s+your\s+surname/i,
    // "HAArchives then your surname": the owner's surname from tree.config.json.
    // Without an owner name the reference cannot match, and the transfer
    // helper refuses before typing anything.
    get reference() { return `HAArchives ${ownerSurnameOrNull() || "OWNER-NAME-NOT-SET"}`; },
    currency: "GBP",
    maxFee: 1,
    // Wise asks for the recipient's address on a cross-border transfer. The
    // account holder's published head office (cambridgeshire.gov.uk, checked
    // 3 Nov 2026); the instructions list only the bank's own addresses.
    beneficiaryAddress: Object.freeze({
      country: "United Kingdom",
      city: "Huntingdon",
      line: "New Shire Hall, Emery Crescent, Enterprise Campus, Alconbury Weald",
      postcode: "PE28 4YE"
    })
  }),
  // Reviewed 18 Nov 2026 from the director's reply of that day in the bound
  // Gmail thread (message 1a1ee6ed86e8ffa2): "Il bonifico di 50 € va
  // accreditato a IBAN IT…, Banca G. Toniolo, Ag. di Monreale, beneficiario
  // Diocesi di Monreale, causale: ricerche genealogiche personale Archivio,
  // Codice BIC …". The IBAN and BIC are read from that message in memory.
  monreale: Object.freeze({
    provider: "Archivio Storico Diocesano di Monreale",
    payeeKind: "iban",
    beneficiaryName: "Diocesi di Monreale",
    bankName: /\bbanca\s+g\.?\s*toniolo\b/i,
    instructionsMessageId: "1a1ee6ed86e8ffa2",
    ibanCountry: "IT",
    referenceRule: /causale\s*:?\s*ricerche genealogiche personale archivio\b/i,
    reference: "ricerche genealogiche personale Archivio",
    referenceMaxLength: 140,
    currency: "EUR",
    maxFee: 1.14 /* AGENTS.md cap is GBP 1 "or its equivalent"; GBP 1 is about EUR 1.14-1.18 */,
    // Used only if Wise asks for an address. diocesimonreale.it publishes no
    // street address (checked 18 Nov 2026); the Curia and the diocesan museum
    // sit in the archbishop's palace, Via Arcivescovado, 90046 Monreale.
    beneficiaryAddress: Object.freeze({
      country: "Italy",
      city: "Monreale",
      line: "Palazzo Arcivescovile, Via Arcivescovado",
      postcode: "90046"
    })
  })
});

export function bankTransferProfileFor(request) {
  const entry = Object.entries(bankTransferProfiles).find(([, profile]) => profile.provider === request?.provider);
  if (!entry) throw new Error(`${request?.provider || "This provider"} has no reviewed bank-transfer beneficiary.`);
  return { id: entry[0], ...entry[1] };
}

// The exact amount the payee must receive: the approved, accepted, invoiced
// and still unpaid quote.
export function authorizedTransfer(request) {
  const derived = deriveExternalRequest(request);
  if (derived.operationalState !== "paid-followup-authorized" || !derived.paymentRequested) {
    throw new Error(`${request.id} is ${derived.operationalState}; it has no invoiced, approved and unpaid quote.`);
  }
  const { fee, paymentAuthorization } = derived;
  if (!fee || paymentAuthorization?.feeEventId !== fee.id || paymentAuthorization.amount !== fee.amount) {
    throw new Error(`${request.id} has no PAY approval of its current quote.`);
  }
  return { requestId: request.id, amount: fee.amount, currency: fee.currency };
}

// Text of a .docx (word/document.xml), one line per paragraph. A minimal
// reader over the ZIP central directory; only stored and deflated entries.
export function docxText(buffer) {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) throw new Error("The payment instructions are not a readable .docx file.");
  const entries = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  for (let index = 0; index < entries; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error("Malformed .docx central directory.");
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength);
    offset += 46 + nameLength + extraLength + commentLength;
    if (name !== "word/document.xml") continue;
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const data = buffer.subarray(start, start + compressedSize);
    const xml = (method === 0 ? data : zlib.inflateRawSync(data)).toString("utf8");
    return [...xml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)]
      .map(([paragraph]) => [...paragraph.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((match) => decodeXml(match[1])).join("").trim())
      .filter(Boolean)
      .join("\n");
  }
  throw new Error("The .docx has no document body.");
}

function decodeXml(value) {
  return value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

// UK payee details from the provider's own instructions. Fails closed unless
// exactly one account name, sort code and account number are stated and the
// account name and bank match the reviewed beneficiary.
export function parsePayee(text, profile) {
  const lines = String(text || "").split(/\r?\n/).map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean);
  const valueFor = (label) => {
    const matches = lines.map((line) => new RegExp(`^${label}\\s*:?\\s*(.+)$`, "i").exec(line)).filter(Boolean);
    if (matches.length !== 1) throw new Error(`The payment instructions state ${matches.length} "${label}" lines; nothing was prepared.`);
    return matches[0][1].trim();
  };
  const accountName = valueFor("Account Name");
  const sortCode = valueFor("Sort Code").replace(/[\s-]/g, "");
  const accountNumber = valueFor("Account Number").replace(/\s/g, "");
  const bank = valueFor("Bank");
  if (accountName.toLowerCase() !== profile.beneficiaryName.toLowerCase()) {
    throw new Error("The instructions name a different account holder than the reviewed beneficiary; nothing was prepared.");
  }
  if (!profile.bankName.test(bank)) throw new Error("The instructions name a different bank than the reviewed beneficiary.");
  if (!/^\d{6}$/.test(sortCode) || !/^\d{8}$/.test(accountNumber)) {
    throw new Error("The instructions do not give a valid UK sort code and account number.");
  }
  if (!profile.referenceRule.test(lines.join(" "))) throw new Error("The instructions no longer state the reviewed reference rule.");
  return { accountName, sortCode, accountNumber };
}

// IBAN payee details from the provider's own message text, which states them
// in prose. Fails closed unless exactly one IBAN (valid ISO 13616 checksum, in
// the reviewed country), one BIC and the reviewed beneficiary, bank, causale
// and amount are stated.
export function ibanIsValid(iban) {
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(iban)) return false;
  const digits = `${iban.slice(4)}${iban.slice(0, 4)}`.replace(/[A-Z]/g, (letter) => String(letter.charCodeAt(0) - 55));
  let remainder = 0;
  for (const digit of digits) remainder = (remainder * 10 + Number(digit)) % 97;
  return remainder === 1;
}

export function parseIbanPayee(text, profile, authorization) {
  const flat = String(text || "").replace(/\s+/g, " ");
  const ibans = [...flat.matchAll(/\bIBAN\s*:?\s*([A-Z]{2}\s?\d{2}(?:\s?[A-Z0-9]){10,30})\b/gi)]
    .map((match) => match[1].replace(/\s/g, "").toUpperCase());
  if (new Set(ibans).size !== 1) throw new Error(`The payment instructions state ${new Set(ibans).size} IBANs; nothing was prepared.`);
  const iban = ibans[0];
  if (!iban.startsWith(profile.ibanCountry) || !ibanIsValid(iban)) throw new Error("The instructions' IBAN fails its checksum or country; nothing was prepared.");
  const bics = [...new Set([...flat.matchAll(/\b(?:BIC|SWIFT)(?:\s*\/\s*SWIFT)?\s*:?\s*([A-Z]{6}[A-Z0-9]{2}(?:[A-Z0-9]{3})?)\b/gi)].map((match) => match[1].toUpperCase()))];
  if (bics.length !== 1 || bics[0].slice(4, 6) !== profile.ibanCountry) throw new Error("The instructions do not state exactly one BIC of the reviewed country.");
  const holder = /\bbeneficiari[oa]\s*:?\s*([^,;\n]+?)\s*(?:[,;]|$)/i.exec(flat)?.[1]?.trim() || "";
  if (holder.toLowerCase() !== profile.beneficiaryName.toLowerCase()) {
    throw new Error("The instructions name a different account holder than the reviewed beneficiary; nothing was prepared.");
  }
  if (!profile.bankName.test(flat)) throw new Error("The instructions name a different bank than the reviewed beneficiary.");
  if (!profile.referenceRule.test(flat)) throw new Error("The instructions no longer state the reviewed causale.");
  const stated = [...flat.matchAll(/\bbonifico\s+di\s+(?:€\s*)?([0-9]+(?:[.,][0-9]{2})?)\s*(?:€|euro|EUR)?/gi)].map((match) => Number(match[1].replace(",", ".")));
  if (authorization && (stated.length !== 1 || stated[0] !== authorization.amount)) {
    throw new Error(`The instructions ask for ${stated.join(", ") || "no stated amount"}, not the authorized ${authorization.currency} ${authorization.amount}; nothing was prepared.`);
  }
  return { accountName: holder, iban, bic: bics[0] };
}

// The only payee summary that may be printed or recorded.
export function maskedPayee(payee) {
  return `${payee.accountName}, ${payee.iban ? "IBAN" : "account"} ending ${(payee.iban || payee.accountNumber).slice(-3)}`;
}

// Wise's review must show the payee receiving exactly the authorized amount,
// a total sent no more than that plus the fee cap, and no other currency.
export function reviewGuard(text, authorization, profile) {
  const symbol = { GBP: "£", USD: "\\$", EUR: "€" }[authorization.currency] || "";
  const amountPattern = new RegExp(`(?:${symbol ? `${symbol}\\s*` : "(?!)"}([0-9][0-9,]*(?:\\.[0-9]{1,2})?)|([0-9][0-9,]*(?:\\.[0-9]{1,2})?)\\s*${authorization.currency})`, "g");
  const amounts = [...String(text || "").matchAll(amountPattern)]
    .map((match) => Number((match[1] || match[2]).replace(/,/g, "")))
    .filter((value) => Number.isFinite(value) && value > 0);
  const otherCurrency = authorization.currency === "GBP" && /\b(?:USD|EUR|CAD|AUD)\b|[$€]/.test(String(text || ""));
  if (otherCurrency) return { ok: false, reason: "the review shows another currency", amounts };
  if (!amounts.includes(authorization.amount)) {
    return { ok: false, reason: `the review does not show the payee receiving ${authorization.currency} ${authorization.amount}`, amounts };
  }
  const ceiling = Math.round((authorization.amount + profile.maxFee) * 100) / 100;
  const over = amounts.filter((value) => value > ceiling);
  if (over.length) return { ok: false, reason: `the review shows ${over.join(", ")} above the ${ceiling} ceiling`, amounts };
  return { ok: true, amounts, ceiling };
}

export function referenceIsValid(reference, profile) {
  return reference === profile.reference && reference.length <= (profile.referenceMaxLength || 18);
}

// Wise's quote for a transfer funded in another currency. The payee must get
// exactly the authorized amount; the converted sum, the fee and the total sent
// are each checked at Wise's own guaranteed rate against the fee cap.
export function crossCurrencyGuard(lines, authorization, profile, inputs = {}) {
  const text = lines.join("\n");
  const rate = /1\s+([A-Z]{3})\s*=\s*([0-9.]+)\s+([A-Z]{3})/.exec(text);
  if (!rate || rate[3] !== authorization.currency) return { ok: false, reason: "no guaranteed rate into the authorized currency" };
  const source = rate[1];
  const perUnit = Number(rate[2]);
  const after = (label) => {
    const index = lines.findIndex((line) => label.test(line));
    if (index < 0) return null;
    // Wise prints whole amounts without decimals ("1 USD") and others with two.
    const match = new RegExp(`(?<![0-9.,])([0-9][0-9,]*(?:\\.[0-9]{1,2})?)\\s*${source}\\b`).exec(lines.slice(index, index + 2).join(" "));
    return match ? Number(match[1].replace(/,/g, "")) : null;
  };
  // Wise shows the amounts either as text lines or only inside its From/To
  // inputs (with the fee as "Fees included" / the breakdown's "Total").
  const fee = after(/^total fees \(included\)/i) ?? after(/^fees included$/i) ?? after(/^total$/i);
  const send = Number.isFinite(inputs.send) ? inputs.send : null;
  const total = send ?? after(/gets exactly/i);
  const converted = send !== null && Number.isFinite(fee) ? Math.round((send - fee) * 100) / 100 : after(/^total amount we'll convert/i);
  if (Number.isFinite(inputs.receive) && Math.abs(inputs.receive - authorization.amount) > 0.001) {
    return { ok: false, reason: `the recipient amount reads ${inputs.receive}, not ${authorization.amount}` };
  }
  if ([fee, converted, total].some((value) => !Number.isFinite(value))) {
    return { ok: false, reason: "the quote does not state its total, fee and converted amount" };
  }
  const round = (value) => Math.round(value * 100) / 100;
  const received = round(converted * perUnit);
  if (Math.abs(received - authorization.amount) > 0.01) {
    return { ok: false, reason: `the payee would get ${received}, not ${authorization.amount} ${authorization.currency}` };
  }
  if (Math.abs(round(converted + fee) - total) > 0.01) return { ok: false, reason: "the total is not the converted sum plus the fee" };
  if (round(fee * perUnit) > profile.maxFee) {
    return { ok: false, reason: `the fee is about ${round(fee * perUnit)} ${authorization.currency}, above the ${profile.maxFee} cap` };
  }
  return { ok: true, source, perUnit, fee, converted, total, received, feeInTarget: round(fee * perUnit) };
}

// Wise's activity row for a just-sent transfer, e.g.
// "Cambridgeshire County Council Sent · Today 18 GBP 25.18 USD".
export function sentActivityMatches(row, authorization) {
  const match = /\bSent\b.*\bToday\b\s+([0-9][0-9,]*(?:\.[0-9]{1,2})?)\s+([A-Z]{3})\b/.exec(String(row || ""));
  return Boolean(match) && Number(match[1].replace(/,/g, "")) === authorization.amount && match[2] === authorization.currency;
}
