// Accepting a provider's fee quote in its own email thread.
//
// A no-charge request that came back with a fee needs the user's exact
// `PAY <request-id>` approval of that quote before anything else happens. Once
// approved, the provider still has to be told to go ahead and asked how to
// pay; until this step existed that reply was never sent and approved quotes
// sat waiting on both sides. The reply text is generated here from the recorded
// quote, never typed freehand, and it promises payment only through a payment
// link or invoice the provider sends back.

import { deriveExternalRequest } from "./external-request-store.mjs";
import { ownerName } from "./tree-config.mjs";

const currencySymbols = { GBP: "£", USD: "$", EUR: "€" };

export function formatQuotedAmount({ amount, currency } = {}) {
  if (!Number.isFinite(amount) || amount <= 0 || !currency) throw new Error("The quote has no valid amount and currency.");
  const symbol = currencySymbols[currency];
  return symbol ? `${symbol}${amount.toFixed(2)}` : `${amount.toFixed(2)} ${currency}`;
}

// The reply follows the enquiry's language and the payment method the quote
// names: a bank-transfer quote asks for the transfer details, any other asks
// for a card-payment link or invoice.
export function quoteAcceptanceStyle(request, fee) {
  const enquiry = `${request?.spec?.subject || ""}\n${request?.spec?.body || ""}`;
  return {
    language: /\b(?:buongiorno|gentile|richiesta|cordiali saluti)\b/i.test(enquiry) ? "it" : "en",
    method: /bank transfer|bonifico/i.test(`${fee?.note || ""}`) ? "transfer" : "card"
  };
}

export function quoteAcceptanceBody(fee, { language = "en", method = "card" } = {}) {
  const amount = formatQuotedAmount(fee);
  if (language === "it") {
    return [
      "Buongiorno,",
      "",
      `grazie per la risposta. Desidero procedere con la ricerca al costo indicato di ${amount}.`,
      "",
      method === "transfer"
        ? "Potreste cortesemente indicarmi le coordinate bancarie per il bonifico (intestatario, IBAN e BIC/SWIFT)? Effettuerò il bonifico con la causale indicata e vi invierò copia della ricevuta."
        : "Potreste cortesemente inviarmi un link per il pagamento con carta o una fattura? Provvederò al pagamento al più presto.",
      "",
      "Cordiali saluti,",
      ownerName()
    ].join("\n");
  }
  return [
    `Thank you for your reply and quote. Please go ahead with the work you quoted at ${amount}.`,
    "",
    method === "transfer"
      ? "Please send the bank details for the transfer (account name, IBAN and BIC/SWIFT) and I will pay promptly and send you the receipt."
      : "Please send a card-payment link or an invoice and I will pay it promptly. If you need a postal address for the invoice, please let me know.",
    "",
    "Kind regards,",
    ownerName()
  ].join("\n");
}

// Throws unless the exact phrase approves the request's current quote and no
// acceptance has been sent for it yet. Returns the quote and the reply text.
export function planQuoteAcceptance(request, confirmation) {
  const required = `PAY ${request.id}`;
  if (confirmation !== required) throw new Error(`Accepting this quote requires exactly: ${required}`);
  const derived = deriveExternalRequest(request);
  if (derived.operationalState !== "paid-followup-authorized") {
    throw new Error(`${request.id} is ${derived.operationalState}; only an approved, unaccepted quote can be accepted.`);
  }
  const { fee, paymentAuthorization } = derived;
  if (!fee || paymentAuthorization?.feeEventId !== fee.id
      || paymentAuthorization.amount !== fee.amount || paymentAuthorization.currency !== fee.currency) {
    throw new Error(`${request.id} has no payment approval bound to its current quote.`);
  }
  return { fee, body: quoteAcceptanceBody(fee, quoteAcceptanceStyle(request, fee)), messageId: quoteGmailMessageId(fee) };
}

// A short reminder when the accepted quote's payment instructions never came,
// in the enquiry's language, asking only for what the acceptance asked.
export function paymentReminderBody(fee, { language = "en", method = "card" } = {}) {
  const amount = formatQuotedAmount(fee);
  if (language === "it") {
    return [
      "Buongiorno,",
      "",
      `mi permetto di ricordare la mia accettazione del preventivo di ${amount}, che resta valida.`,
      "",
      method === "transfer"
        ? "Per poter effettuare il bonifico attendo ancora le coordinate bancarie (intestatario, IBAN e BIC/SWIFT). Appena ricevute, effettuerò il pagamento con la causale indicata e vi invierò copia della ricevuta."
        : "Attendo ancora il link per il pagamento con carta o la fattura; provvederò al pagamento appena ricevuto.",
      "",
      "Grazie e cordiali saluti,",
      ownerName()
    ].join("\n");
  }
  return [
    `A brief reminder that my acceptance of your ${amount} quote stands.`,
    "",
    method === "transfer"
      ? "I am still waiting for the bank details for the transfer (account name, IBAN and BIC/SWIFT); as soon as they arrive I will pay and send you the receipt."
      : "I am still waiting for the card-payment link or invoice; I will pay it as soon as it arrives.",
    "",
    "Kind regards,",
    ownerName()
  ].join("\n");
}

// Throws unless the exact PAY phrase approves the request's accepted quote,
// its payment instructions are still unrecorded, and the provider was last
// asked at least `minimumDays` ago (a reminder must never pester).
export function planPaymentReminder(request, confirmation, { now = Date.now(), minimumDays = 7 } = {}) {
  const required = `PAY ${request.id}`;
  if (confirmation !== required) throw new Error(`Reminding about this quote requires exactly: ${required}`);
  const derived = deriveExternalRequest(request);
  if (derived.operationalState !== "awaiting-payment-instructions") {
    throw new Error(`${request.id} is ${derived.operationalState}; a reminder is sent only for an accepted quote whose payment instructions have not arrived.`);
  }
  const { fee, paymentAuthorization } = derived;
  if (!fee || paymentAuthorization?.feeEventId !== fee.id
      || paymentAuthorization.amount !== fee.amount || paymentAuthorization.currency !== fee.currency) {
    throw new Error(`${request.id} has no payment approval bound to its current quote.`);
  }
  const lastAsked = [...(request.events || [])].reverse()
    .find((event) => ["quote-accepted", "reminder-sent"].includes(event.type));
  const daysSince = lastAsked ? Math.floor((now - Date.parse(lastAsked.at)) / 86_400_000) : Infinity;
  if (daysSince < minimumDays) {
    throw new Error(`${request.id} was asked for its payment instructions ${daysSince} day(s) ago; a reminder waits ${minimumDays} days.`);
  }
  return { fee, body: paymentReminderBody(fee, quoteAcceptanceStyle(request, fee)), messageId: quoteGmailMessageId(fee), daysSince };
}

export function reminderSentEvent(fee, confirmation) {
  return {
    type: "reminder-sent",
    phrase: confirmation,
    feeEventId: fee.id,
    basis: "verified-Gmail-thread-reply",
    note: "Asked the provider again, in its own thread, for the payment instructions of the accepted quote."
  };
}

// The quote event records the provider's Gmail message ID. Opening that exact
// message is a tighter binding than searching for the original subject, which
// the provider's reply may not keep.
export function quoteGmailMessageId(fee) {
  const basis = `${fee?.basis || ""}`;
  if (!/gmail/i.test(basis)) return "";
  const match = /(?:^|[^0-9a-f])([0-9a-f]{16})(?![0-9a-f])/i.exec(basis);
  return match ? match[1].toLowerCase() : "";
}

export function quoteAcceptedEvent(fee, confirmation) {
  return {
    type: "quote-accepted",
    phrase: confirmation,
    feeEventId: fee.id,
    amount: fee.amount,
    currency: fee.currency,
    basis: "verified-Gmail-thread-reply"
  };
}

// After a requested payment is made, a short note in the provider's own
// thread saying so: the date, the amount and the reference the provider asked
// for, never any bank details. Bound by the request's exact SUBMIT phrase.
export function paymentNoticeBody({ amount, currency, date, beneficiary, reference }, { language = "en" } = {}) {
  const sum = formatQuotedAmount({ amount, currency });
  if (language === "it") {
    const [year, month, day] = date.split("-");
    return [
      "Buongiorno,",
      "",
      `vi informo che in data ${day}/${month}/${year} ho effettuato il bonifico di ${sum.replace(/^€/, "€ ").replace(/\.(\d\d)$/, ",$1")} a favore della ${beneficiary}, con causale "${reference}".`,
      "",
      "Resto in attesa dell'immagine del documento. Grazie ancora per la ricerca.",
      "",
      "Cordiali saluti,",
      ownerName()
    ].join("\n");
  }
  return [
    `I have today (${date}) sent the bank transfer of ${sum} to ${beneficiary}, with the reference "${reference}".`,
    "",
    "I look forward to receiving the copies. Thank you again for your search.",
    "",
    "Kind regards,",
    ownerName()
  ].join("\n");
}

// The date is the payer's own calendar day (the user is in New York).
export function planPaymentNotice(request, confirmation, { beneficiary, reference, timeZone = "America/New_York" } = {}) {
  const required = request?.guard?.requiredPhrase;
  if (!required || confirmation !== required) throw new Error(`A payment notice requires exactly: ${required}`);
  if (!beneficiary || !reference) throw new Error("A payment notice needs the reviewed beneficiary and reference.");
  const events = request.events || [];
  const paid = events.findLastIndex((event) => event.type === "payment-submitted");
  if (paid < 0) throw new Error(`${request.id} has no recorded payment; no notice was sent.`);
  if (events.slice(paid + 1).some((event) => event.type === "payment-notice-sent")) {
    throw new Error(`${request.id} already told the provider about this payment.`);
  }
  const payment = events[paid];
  if (!Number.isFinite(payment.amount) || !payment.currency) throw new Error("The recorded payment has no amount and currency.");
  const askedIndex = events.findLastIndex((event, index) => index < paid && event.type === "payment-requested");
  const messageId = /gmail-message-([0-9a-f]{16})\b/.exec(String(events[askedIndex]?.basis || ""))?.[1] || "";
  if (!messageId) throw new Error(`${request.id} has no recorded payment request message to answer.`);
  const date = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(payment.at));
  const details = { amount: payment.amount, currency: payment.currency, date, beneficiary, reference };
  return { ...details, messageId, paymentEventId: payment.id, body: paymentNoticeBody(details, quoteAcceptanceStyle(request, null)) };
}

export function paymentNoticeSentEvent(plan, confirmation) {
  return {
    type: "payment-notice-sent",
    phrase: confirmation,
    basis: "verified-Gmail-thread-reply",
    note: `Told the provider, in its own thread, that the ${formatQuotedAmount(plan)} transfer was sent on ${plan.date} with its reference.`
  };
}
