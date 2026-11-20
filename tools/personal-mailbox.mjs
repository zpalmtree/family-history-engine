#!/usr/bin/env node
// Read-only search of the user's personal mailbox (owner.personalMailbox in tree.config.json) for
// provider mail that never reaches the shared Gmail account: GRO/Worldpay
// receipts, archive replies sent to the personal address, portal notices.
// The IMAP work, credential and read-only guarantees live in
// tools/personal-mailbox-windows.ps1; this file decides what to search for and
// prints sender, date, subject and attachment names only (never bodies).
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { deriveExternalRequest } from "./external-request-store.mjs";
import { requireConsent } from "./consents.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Payment processors and portals that write to the personal address on the
// project's behalf, whatever the open requests are.
export const standingSenderTerms = Object.freeze([
  "gro.gov.uk",
  "worldpay.com",
  "paypal.com",
  "id.bund.de",
  "wuppertal.de",
]);

const openStates = new Set([
  "waiting-external",
  "awaiting-payment-instructions",
  "information-required",
  "fee-quote-hold",
  "paid-followup-authorized",
  "payment-requested",
  "payment-submitted",
  "delivery-reported",
  "conflict-hold",
]);

const genericMailDomains = new Set(["gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "yahoo.com", "aol.com", "icloud.com"]);

// One sender term per open request: the recipient's domain, or the full
// address for a mailbox on a shared consumer domain.
export function senderTermsForRequests(requests, { scope = "main" } = {}) {
  const terms = new Set(standingSenderTerms);
  for (const request of requests) {
    if ((request.researchScope || "main") !== scope) continue;
    let state = "";
    try { state = deriveExternalRequest(request).operationalState; } catch { continue; }
    if (!openStates.has(state)) continue;
    const recipient = String(request.spec?.recipient || "").trim().toLowerCase();
    const match = /^[a-z0-9._%+-]+@([a-z0-9.-]+\.[a-z]{2,})$/.exec(recipient);
    if (!match) continue;
    terms.add(genericMailDomains.has(match[1]) ? recipient : match[1]);
  }
  return [...terms].filter((term) => /^[A-Za-z0-9@._+-]{3,120}$/.test(term)).sort();
}

// RFC 2047 encoded words (=?utf-8?B?...?= and =?utf-8?Q?...?=).
export function decodeMimeWords(value) {
  return String(value || "")
    .replace(/\?=\s+=\?/g, "?==?")
    .replace(/=\?([^?]+)\?([bqBQ])\?([^?]*)\?=/g, (whole, charset, encoding, text) => {
      try {
        const bytes = encoding.toLowerCase() === "b"
          ? Buffer.from(text, "base64")
          : Buffer.from(text.replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16))), "latin1");
        return new TextDecoder(/^(utf-?8|us-ascii)$/i.test(charset) ? "utf-8" : charset.toLowerCase()).decode(bytes);
      } catch {
        return whole;
      }
    });
}

export function parseHeaderBlock(raw) {
  const fields = {};
  const unfolded = String(raw || "").replace(/\r/g, "").replace(/\n[ \t]+/g, " ");
  for (const line of unfolded.split("\n")) {
    const match = /^([A-Za-z-]+):\s*(.*)$/.exec(line);
    if (match) fields[match[1].toLowerCase()] = decodeMimeWords(match[2].trim());
  }
  return fields;
}

// Attachment names from an IMAP BODYSTRUCTURE: the "filename" disposition
// parameter, falling back to the content-type "name" parameter.
export function attachmentNames(bodystructure) {
  const names = new Set();
  for (const match of String(bodystructure || "").matchAll(/"(?:file)?name\*?"\s+"((?:[^"\\]|\\.)*)"/gi)) {
    const name = decodeMimeWords(match[1].replace(/\\(.)/g, "$1")).trim();
    if (name) names.add(name.slice(0, 160));
  }
  return [...names];
}

// Tokenize an IMAP BODYSTRUCTURE into nested arrays of strings/atoms.
export function parseBodystructure(text) {
  const source = String(text || "");
  let index = 0;
  const parseList = () => {
    const list = [];
    index += 1; // (
    while (index < source.length) {
      const char = source[index];
      if (char === ")") { index += 1; return list; }
      if (char === " ") { index += 1; continue; }
      if (char === "(") { list.push(parseList()); continue; }
      if (char === "\"") {
        let value = "";
        index += 1;
        while (index < source.length && source[index] !== "\"") {
          if (source[index] === "\\") index += 1;
          value += source[index];
          index += 1;
        }
        index += 1;
        list.push(value);
        continue;
      }
      let atom = "";
      while (index < source.length && !" ()".includes(source[index])) atom += source[index++];
      list.push(atom === "NIL" ? null : atom);
    }
    return list;
  };
  const start = source.indexOf("(");
  if (start < 0) return null;
  index = start;
  return parseList();
}

const paramValue = (params, key) => {
  if (!Array.isArray(params)) return "";
  for (let i = 0; i + 1 < params.length; i += 2) {
    if (String(params[i]).toLowerCase().replace(/\*$/, "") === key) return decodeMimeWords(String(params[i + 1] || ""));
  }
  return "";
};

// Every named leaf part with its IMAP section number ("2", "1.2", ...).
export function attachmentSections(bodystructure) {
  const root = parseBodystructure(bodystructure);
  const out = [];
  const walk = (node, prefix) => {
    if (!Array.isArray(node)) return;
    if (Array.isArray(node[0])) {
      let n = 0;
      for (const child of node) {
        if (!Array.isArray(child)) break;
        n += 1;
        walk(child, prefix ? `${prefix}.${n}` : String(n));
      }
      return;
    }
    const section = prefix || "1";
    const type = `${String(node[0] || "").toLowerCase()}/${String(node[1] || "").toLowerCase()}`;
    const disposition = node.find((item, i) => i >= 7 && Array.isArray(item) && typeof item[0] === "string" && /^(attachment|inline)$/i.test(item[0]));
    const name = paramValue(disposition?.[1], "filename") || paramValue(node[2], "name");
    if (name) out.push({ section, type, name, encoding: String(node[5] || "").toLowerCase() });
  };
  walk(root, "");
  return out;
}

// The message's own plain-text parts (never a named attachment), by section.
export function textSections(bodystructure) {
  const root = parseBodystructure(bodystructure);
  const out = [];
  const walk = (node, prefix) => {
    if (!Array.isArray(node)) return;
    if (Array.isArray(node[0])) {
      let n = 0;
      for (const child of node) {
        if (!Array.isArray(child)) break;
        n += 1;
        walk(child, prefix ? `${prefix}.${n}` : String(n));
      }
      return;
    }
    const type = `${String(node[0] || "").toLowerCase()}/${String(node[1] || "").toLowerCase()}`;
    const disposition = node.find((item, i) => i >= 7 && Array.isArray(item) && typeof item[0] === "string" && /^(attachment|inline)$/i.test(item[0]));
    const named = paramValue(disposition?.[1], "filename") || paramValue(node[2], "name");
    if (type === "text/plain" && !named) out.push(prefix || "1");
  };
  walk(root, "");
  return out;
}

// A provider's words with the contact details a reply carries taken out, as
// the shared-mailbox inspector does: what is printed is about the payment or
// the record, never an address book.
export function redactedExcerpt(text, limit = 1800) {
  return String(text || "")
    .replace(/\r/g, "")
    // A link in a provider's message can carry a one-time key (an activation
    // link, a receipt download): only its host is shown.
    .replace(/https?:\/\/([a-z0-9.-]+)[^\s<>"')\]]*/gi, "[link to $1]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email redacted]")
    .replace(/(?<![\w/])\(?\+?\d[\d\s().-]{7,}\d(?![\w/])/g, "[phone redacted]")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, limit);
}

export function summarizeMessages(messages) {
  const seen = new Set();
  const out = [];
  for (const message of messages || []) {
    const header = parseHeaderBlock(message.header);
    const key = header["message-id"] || `${message.folder}/${message.uid}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const date = Date.parse(header.date || "");
    out.push({
      folder: message.folder,
      uid: message.uid,
      term: message.term,
      date: Number.isFinite(date) ? new Date(date).toISOString() : header.date || "",
      from: header.from || "",
      subject: header.subject || "",
      messageId: header["message-id"] || "",
      attachments: attachmentNames(message.bodystructure),
    });
  }
  return out.sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

function loadRequests() {
  const dir = path.join(projectRoot, "evidence", "acquisition", "requests");
  return fs.readdirSync(dir).filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")));
}

function runWindows(args) {
  requireConsent("mailbox-read");
  const script = execFileSync("wslpath", ["-w", path.join(projectRoot, "tools", "personal-mailbox-windows.ps1")], { encoding: "utf8" }).trim();
  const output = execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 300_000,
  });
  const jsonLine = output.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.startsWith("{")).at(-1);
  if (!jsonLine) throw new Error(`No result from the mailbox reader:\n${output.slice(0, 2000)}`);
  return JSON.parse(jsonLine);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const argv = process.argv.slice(2);
  const value = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
  const mode = argv.includes("--setup") ? "setup" : argv.includes("--status") ? "status" : argv.includes("--attachment") ? "attachment" : argv.includes("--text") ? "text" : "search";
  const trash = argv.includes("--include-trash") ? ["-IncludeTrash"] : [];
  if (mode === "text") {
    // --text --from <provider domain or address> [--subject <text>] [--include-trash] [--since-days <n>]
    // One provider message's own words, redacted. The sender term must be a
    // provider's own domain or address, never a whole public mail service.
    const terms = String(value("--from") || "").split(",").map((term) => term.trim().toLowerCase()).filter(Boolean);
    if (terms.length !== 1 || !terms[0].includes(".") || genericMailDomains.has(terms[0].replace(/^.*@/, "")) && !terms[0].includes("@")) {
      throw new Error("--text needs exactly one --from provider domain or address.");
    }
    const args = ["-Mode", "search", "-From", terms[0], "-SinceDays", String(Number(value("--since-days")) || 60), ...trash];
    if (value("--subject")) args.push("-Subject", value("--subject"));
    const found = summarizeMessages(runWindows(args).messages || []);
    if (!found.length) {
      console.log(JSON.stringify({ found: 0, from: terms[0] }));
    } else {
      const raw = (runWindows(args).messages || []);
      for (const message of found.slice(0, 3)) {
        const source = raw.find((item) => item.folder === message.folder && String(item.uid) === String(message.uid));
        const sections = textSections(source?.bodystructure);
        const text = sections.length
          ? runWindows(["-Mode", "text", "-Folder", message.folder, "-Uid", String(message.uid), "-Section", sections[0]]).text
          : "";
        console.log(JSON.stringify({ folder: message.folder, date: message.date, from: message.from.replace(/<[^>]*>/g, "").trim(), subject: message.subject, attachments: message.attachments, excerpt: redactedExcerpt(text) }, null, 1));
      }
    }
  } else if (mode === "attachment") {
    // --attachment --from <term> --subject <text> --name <exact attachment file name> --out <safe-name>
    const terms = String(value("--from") || "").split(",").map((term) => term.trim()).filter(Boolean);
    const wanted = value("--name");
    const outName = value("--out");
    if (!terms.length || !wanted || !/^[a-z0-9][a-z0-9._-]{0,120}$/.test(outName || "")) throw new Error("--attachment needs --from, --name and a safe lowercase --out file name.");
    const args = ["-Mode", "search", "-From", terms.join(","), "-SinceDays", String(Number(value("--since-days")) || 60)];
    if (value("--subject")) args.push("-Subject", value("--subject"));
    const found = runWindows(args).messages || [];
    const hits = [];
    for (const message of found) {
      for (const part of attachmentSections(message.bodystructure)) if (part.name === wanted) hits.push({ message, part });
    }
    const unique = [...new Map(hits.map((hit) => [`${hit.message.folder}/${hit.message.uid}/${hit.part.section}`, hit])).values()];
    if (unique.length !== 1) throw new Error(`Expected exactly one attachment named "${wanted}"; found ${unique.length}.`);
    const { message, part } = unique[0];
    const saved = runWindows(["-Mode", "attachment", "-Folder", message.folder, "-Uid", String(message.uid), "-Section", part.section, "-OutName", outName]);
    const header = parseHeaderBlock(message.header);
    console.log(JSON.stringify({ saved: saved.path, bytes: saved.bytes, type: part.type, from: header.from, date: header.date, subject: header.subject, messageId: header["message-id"] }));
  } else if (mode !== "search") {
    console.log(JSON.stringify(runWindows(["-Mode", mode])));
  } else {
    const explicit = value("--from");
    const terms = explicit ? explicit.split(",").map((term) => term.trim()).filter(Boolean)
      : senderTermsForRequests(loadRequests(), { scope: value("--scope") || "main" });
    const args = ["-Mode", "search", "-From", terms.join(","), "-SinceDays", String(Number(value("--since-days")) || 30), ...trash];
    if (value("--subject")) args.push("-Subject", value("--subject"));
    const result = runWindows(args);
    const messages = summarizeMessages(result.messages);
    if (argv.includes("--json")) {
      console.log(JSON.stringify({ since: result.since, folders: result.folders, terms, messages }, null, 1));
    } else {
      console.log(`personal mailbox: ${messages.length} message(s) since ${result.since} from ${terms.length} sender term(s) in ${result.folders.join(", ")}`);
      for (const message of messages) {
        const files = message.attachments.length ? `  [${message.attachments.join("; ")}]` : "";
        console.log(`${message.date.slice(0, 16)}  ${message.from.slice(0, 60)}  ${message.subject.slice(0, 90)}${files}`);
      }
    }
  }
}
