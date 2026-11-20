#!/usr/bin/env node

// Reach a provider's payment link from the provider's own Gmail message.
//
// Invoice and card-payment links carry provider tokens. They are checkout
// state, so they never pass through chat, argv, logs or Git: the helper finds
// the link inside the exact Gmail message and follows it in the same leased
// tab. Only the link's host and visible label are ever reported.
//
//   npm run pay:win -- -Request <id> -GmailQuery "<exact search>" -ListLinks
//   npm run pay:win -- -Request <id> -GmailQuery "<exact search>" -LinkText "<label regex>" [-Inspect]

// The reportable shape of one anchor: its label and host, never its path or query.
export function describeLink(href, label) {
  let parsed;
  try { parsed = new URL(href); } catch { return null; }
  if (!["https:", "http:"].includes(parsed.protocol)) return null;
  return {
    host: parsed.hostname.toLowerCase(),
    protocol: parsed.protocol.replace(/:$/, ""),
    label: String(label || "").replace(/\s+/g, " ").trim().slice(0, 80)
  };
}

// Gmail rewrites outbound links through google.com/url?q=...; the payment
// host is the target, not Google's redirector.
export function unwrapGmailRedirect(href) {
  try {
    const parsed = new URL(href);
    if (/^(?:www\.)?google\.com$/i.test(parsed.hostname) && parsed.pathname === "/url") {
      const target = parsed.searchParams.get("q") || parsed.searchParams.get("url");
      if (target) return target;
    }
  } catch {}
  return href;
}

// Exactly one HTTPS anchor whose label matches and whose host the provider's
// profile allows as an invoice-link host. Anything else is refused: a link
// that cannot be told apart is never followed.
export function choosePaymentLink(anchors, { labelPattern, linkHosts }) {
  if (!(labelPattern instanceof RegExp)) throw new Error("A payment-link label pattern is required.");
  if (!Array.isArray(linkHosts) || !linkHosts.length) throw new Error("This provider has no allowlisted invoice-link host.");
  const candidates = [];
  for (const anchor of anchors) {
    const href = unwrapGmailRedirect(anchor.href);
    const described = describeLink(href, anchor.label);
    if (!described || !labelPattern.test(described.label)) continue;
    candidates.push({ href, ...described });
  }
  const unique = [...new Map(candidates.map((candidate) => [candidate.href, candidate])).values()];
  if (!unique.length) throw new Error("No link with that label was found in the message; nothing was opened.");
  if (unique.length > 1) throw new Error(`${unique.length} different links share that label; nothing was opened.`);
  const [link] = unique;
  if (link.protocol !== "https") throw new Error("The payment link is not HTTPS; nothing was opened.");
  if (!linkHosts.some((pattern) => pattern.test(link.host))) {
    throw new Error(`${link.host} is not an allowlisted invoice-link host for this provider; nothing was opened.`);
  }
  return link;
}

// Opens the newest Gmail conversation matching the exact query and returns
// the visible anchors (href, label) and attachment labels of its messages.
export async function readGmailConversation(page, query, { log = console.error } = {}) {
  await page.goto("https://mail.google.com/mail/u/0/#inbox", { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page.waitForTimeout(2_000);
  const search = page.locator('input[aria-label="Search mail"], input[placeholder="Search mail"]').first();
  if (!await search.isVisible().catch(() => false)) throw new Error("Gmail is not signed in; no payment link was read.");
  await search.fill(query);
  await search.press("Enter");
  await page.waitForTimeout(3_000);
  const row = page.locator("tr.zA:visible").first();
  if (!await row.isVisible().catch(() => false)) throw new Error("No Gmail conversation matched the exact query.");
  const subjectCell = row.locator("span.bog").first();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await page.locator("div.adn.ads").first().isVisible().catch(() => false)) break;
    if (attempt) await page.keyboard.press("Escape").catch(() => {});
    await (await subjectCell.isVisible().catch(() => false) ? subjectCell : row).click({ timeout: 10_000 }).catch(() => {});
    await page.locator("div.adn.ads").first().waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
  }
  if (!await page.locator("div.adn.ads").first().isVisible().catch(() => false)) {
    throw new Error("The matching Gmail conversation did not open.");
  }
  const expandAll = page.locator('[aria-label*="Expand all"], [data-tooltip*="Expand all"]').first();
  if (await expandAll.isVisible().catch(() => false)) {
    await expandAll.click().catch(() => {});
    await page.waitForTimeout(1_500);
  }
  const messages = page.locator("div.adn.ads");
  const result = [];
  for (let index = 0; index < await messages.count(); index += 1) {
    const message = messages.nth(index);
    const anchors = await message.locator("div.a3s a[href]").evaluateAll((nodes) =>
      nodes.map((node) => ({ href: node.href, label: node.innerText || node.getAttribute("aria-label") || "" }))).catch(() => []);
    const attachments = await message.locator("span.aV3").evaluateAll((nodes) =>
      nodes.map((node) => (node.innerText || "").trim()).filter(Boolean)).catch(() => []);
    result.push({ anchors, attachments });
  }
  log(`Read ${result.length} message(s) in the matching conversation.`);
  return result;
}

// Read-only listing for observing a new provider: labels and hosts only.
export function summarizeConversation(messages) {
  return messages.map((message, index) => ({
    message: index + 1,
    links: [...new Map(message.anchors
      .map((anchor) => describeLink(unwrapGmailRedirect(anchor.href), anchor.label))
      .filter(Boolean)
      .map((link) => [`${link.host}\n${link.label}`, link])).values()],
    attachments: message.attachments.map((label) => label.slice(0, 80))
  }));
}

// Saves one exactly named attachment from the already-open conversation into
// a task-local temporary folder (never the source archive or the repository),
// for reading a provider's payment instructions. The caller deletes it.
export async function saveConversationAttachment(page, attachmentName, directory) {
  const { default: fs } = await import("node:fs");
  const { default: path } = await import("node:path");
  if (!/^[^\\/:*?"<>|]{1,120}$/.test(attachmentName || "")) throw new Error("Pass one plain attachment name.");
  const chips = page.locator("span.aV3").filter({ hasText: attachmentName });
  if (await chips.count() < 1) throw new Error("That attachment is not in the conversation; nothing was saved.");
  const card = chips.last().locator("xpath=ancestor::*[contains(@class,'aQH') or @role='listitem' or contains(@class,'aZo')][1]");
  const target = await card.count() ? card : chips.last();
  await target.hover().catch(() => {});
  await page.waitForTimeout(800);
  const button = target.locator('[aria-label^="Download attachment"], [data-tooltip^="Download"]').first();
  if (!await button.isVisible().catch(() => false)) throw new Error("Gmail showed no download control for that attachment.");
  const [download] = await Promise.all([page.waitForEvent("download", { timeout: 30_000 }), button.click()]);
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `payment-instructions-${process.pid}${path.extname(attachmentName).slice(0, 8)}`);
  await download.saveAs(file);
  return file;
}
