// Reconciles a GRO payment whose result page the guarded helper could not
// classify, from GRO's own order history (the authority for whether an order
// exists). Pure functions: the caller supplies the check-orders output, the
// request's submission-started time, its authorized amount, and every GRO
// order reference already recorded on another request.
//
// A single unexplained order of at most the authorized amount, submitted in a
// short window after the helper pressed pay, confirms the request. Anything
// else (no such order, or more than one) stays in-flight for a person to read,
// so a payment is never confirmed against the wrong order or retried twice.

const orderPattern = /Order Reference Number:(?:\\t|\s)+(COL\d+\/\d{4})(?:\\t|\s)+Order Submitted:(?:\\t|\s)+(\d{1,2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2})[\s\S]{0,400}?Order Amount:(?:\\t|\s)+(?:£|\\u00a3|GBP ?)([\d,]+(?:\.\d{2})?)/g;
const months = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

// The GRO page prints UK civil time; British Summer Time runs from 01:00 UTC on
// the last Sunday of March to 01:00 UTC on the last Sunday of October.
export function ukTimeToUtc(text) {
  const match = /^(\d{1,2}) ([A-Z][a-z]{2}) (\d{4}) (\d{2}):(\d{2})$/.exec(String(text).trim());
  if (!match || !(match[2] in months)) return null;
  const [, day, month, year, hour, minute] = match;
  const asUtc = Date.UTC(Number(year), months[month], Number(day), Number(hour), Number(minute));
  const lastSunday = (monthIndex) => {
    const last = new Date(Date.UTC(Number(year), monthIndex + 1, 0));
    return Date.UTC(Number(year), monthIndex, last.getUTCDate() - last.getUTCDay(), 1, 0);
  };
  const bstStart = lastSunday(2);
  const bstEnd = lastSunday(9);
  const summer = asUtc - 3_600_000 >= bstStart && asUtc - 3_600_000 < bstEnd;
  return new Date(summer ? asUtc - 3_600_000 : asUtc);
}

export function parseGroOrders(output) {
  const orders = new Map();
  for (const match of String(output).matchAll(orderPattern)) {
    const submittedAt = ukTimeToUtc(match[2]);
    if (!submittedAt || orders.has(match[1])) continue;
    orders.set(match[1], { reference: match[1], submitted: match[2], submittedAt, amount: Number(match[3].replaceAll(",", "")) });
  }
  return [...orders.values()];
}

// Every GRO order reference recorded on a request other than this one.
export function knownGroReferences(requests, exceptRequestId) {
  const references = new Set();
  for (const request of requests || []) {
    if (request.id === exceptRequestId) continue;
    for (const event of request.events || []) {
      for (const text of [event.basis, event.note]) {
        for (const match of String(text || "").matchAll(/COL\d+\/\d{4}/g)) references.add(match[0]);
      }
    }
  }
  return references;
}

export function reconcileGroOrder({ orders, startedAt, amount, knownReferences = new Set(), windowBeforeMs = 3 * 60_000, windowAfterMs = 5 * 60_000 }) {
  const started = new Date(startedAt);
  if (Number.isNaN(started.getTime())) return { status: "unresolved", reason: "the request has no submission-started time" };
  if (!Number.isFinite(amount) || amount <= 0) return { status: "unresolved", reason: "the request has no authorized amount" };
  const inWindow = orders.filter((order) => order.submittedAt.getTime() >= started.getTime() - windowBeforeMs
    && order.submittedAt.getTime() <= started.getTime() + windowAfterMs);
  const unexplained = inWindow.filter((order) => !knownReferences.has(order.reference));
  const matching = unexplained.filter((order) => order.amount > 0 && order.amount <= amount + 0.005);
  if (matching.length === 1 && unexplained.length === 1) return { status: "confirmed", order: matching[0] };
  if (!matching.length) {
    return { status: "unresolved", reason: `no unexplained GRO order of at most ${amount.toFixed(2)} was submitted within the payment window (${inWindow.length} order(s) in the window)` };
  }
  return { status: "unresolved", reason: `${unexplained.length} unexplained GRO orders fall in the payment window (${unexplained.map((order) => order.reference).join(", ")}); a person must match them` };
}

export function confirmationBasis(order, startedAt) {
  return `GRO My Orders (automatic reconciliation after the guarded payment): order ${order.reference}, submitted ${order.submitted} UK time, GBP ${order.amount.toFixed(2)}; the only unexplained order in the payment window after this request's guarded Worldpay submission started (${new Date(startedAt).toISOString()})`;
}
