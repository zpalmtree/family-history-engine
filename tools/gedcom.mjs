// GEDCOM 5.5.1 / 7.0 line format: parse to a node tree and write it back.
//
// This module knows only the file format. The mapping to and from the canonical
// evidence store lives in tools/gedcom-export.mjs and tools/gedcom-import.mjs.

const LINE = /^\s*(\d+)\s+(?:(@[^@\s]+@)\s+)?([A-Za-z0-9_]+)(?:\s(.*))?$/;

export function parseGedcom(text) {
  const source = String(text).replace(/^﻿/, "");
  const roots = [];
  const stack = [];
  const lines = source.split(/\r\n|\r|\n/);
  lines.forEach((raw, index) => {
    if (!raw.trim()) return;
    const match = LINE.exec(raw);
    if (!match) throw new Error(`GEDCOM line ${index + 1} is malformed: ${raw.slice(0, 80)}`);
    const level = Number(match[1]);
    const node = { level, xref: match[2] || null, tag: match[3].toUpperCase(), value: match[4] ?? "", children: [] };
    if (level === 0) {
      roots.push(node);
      stack.length = 0;
      stack.push(node);
      return;
    }
    while (stack.length && stack.at(-1).level >= level) stack.pop();
    const parent = stack.at(-1);
    if (!parent || parent.level !== level - 1) throw new Error(`GEDCOM line ${index + 1} skips a level`);
    if (node.tag === "CONC" || node.tag === "CONT") {
      parent.value += (node.tag === "CONT" ? "\n" : "") + node.value;
      return;
    }
    parent.children.push(node);
    stack.push(node);
  });
  return roots;
}

export function child(node, tag) {
  return node?.children.find((entry) => entry.tag === tag) || null;
}

export function children(node, tag) {
  return node?.children.filter((entry) => entry.tag === tag) || [];
}

export function childValue(node, tag) {
  return child(node, tag)?.value?.trim() || "";
}

export function indexRecords(roots) {
  const byXref = new Map();
  for (const node of roots) if (node.xref) byXref.set(node.xref, node);
  return {
    byXref,
    individuals: roots.filter((node) => node.tag === "INDI"),
    families: roots.filter((node) => node.tag === "FAM"),
    sources: roots.filter((node) => node.tag === "SOUR"),
    header: roots.find((node) => node.tag === "HEAD") || null
  };
}

// "John /Smith/ Jr" -> { given: "John", surname: "Smith", suffix: "Jr", full: "John Smith Jr" }
export function parseName(value) {
  const text = String(value || "").trim();
  const match = /^(.*?)\/(.*?)\/(.*)$/.exec(text);
  const given = (match ? match[1] : text).trim();
  const surname = match ? match[2].trim() : "";
  const suffix = match ? match[3].trim() : "";
  const full = [given, surname, suffix].filter(Boolean).join(" ").replace(/\s+/g, " ");
  return { given, surname, suffix, full };
}

export function formatName({ given = "", surname = "", suffix = "" }) {
  return [given.trim(), `/${surname.trim()}/`, suffix.trim()].filter((part) => part && part !== "//").join(" ") || "//";
}

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

// GEDCOM date phrase -> { value: ISO-ish (YYYY, YYYY-MM or YYYY-MM-DD), qualifier, text }
// Qualifiers: exact, about, before, after, between, estimated, calculated, phrase.
export function parseGedcomDate(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  const upper = text.toUpperCase().replace(/\s+/g, " ");
  const toIso = (part) => {
    const tokens = part.trim().split(" ").filter(Boolean);
    let day = null;
    let month = null;
    let year = null;
    for (const token of tokens) {
      if (/^\d{3,4}(\/\d{1,2})?$/.test(token)) year = Number(token.slice(0, 4).replace("/", ""));
      else if (MONTHS.includes(token)) month = MONTHS.indexOf(token) + 1;
      else if (/^\d{1,2}$/.test(token)) day = Number(token);
      else return null;
    }
    if (!year) return null;
    const yyyy = String(year).padStart(4, "0");
    if (!month) return yyyy;
    const mm = String(month).padStart(2, "0");
    return day ? `${yyyy}-${mm}-${String(day).padStart(2, "0")}` : `${yyyy}-${mm}`;
  };
  const prefixes = [["ABT ", "about"], ["CAL ", "calculated"], ["EST ", "estimated"], ["BEF ", "before"], ["AFT ", "after"]];
  for (const [prefix, qualifier] of prefixes) {
    if (upper.startsWith(prefix)) {
      const iso = toIso(upper.slice(prefix.length));
      return iso ? { value: iso, qualifier, text } : { value: null, qualifier: "phrase", text };
    }
  }
  const between = /^BET (.+) AND (.+)$/.exec(upper) || /^FROM (.+) TO (.+)$/.exec(upper);
  if (between) {
    const from = toIso(between[1]);
    const to = toIso(between[2]);
    return from && to ? { value: from, to, qualifier: "between", text } : { value: null, qualifier: "phrase", text };
  }
  const iso = toIso(upper);
  return iso ? { value: iso, qualifier: "exact", text } : { value: null, qualifier: "phrase", text };
}

// ISO-ish date (YYYY, YYYY-MM, YYYY-MM-DD) + qualifier -> GEDCOM date phrase.
export function formatGedcomDate(value, qualifier = "exact", to = null) {
  const one = (iso) => {
    const match = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(String(iso || ""));
    if (!match) return null;
    const [, yyyy, mm, dd] = match;
    return [dd ? String(Number(dd)) : null, mm ? MONTHS[Number(mm) - 1] : null, yyyy].filter(Boolean).join(" ");
  };
  const main = one(value);
  if (!main) return null;
  switch (qualifier) {
    case "about": return `ABT ${main}`;
    case "estimated": return `EST ${main}`;
    case "calculated": return `CAL ${main}`;
    case "before": return `BEF ${main}`;
    case "after": return `AFT ${main}`;
    case "between": return one(to) ? `BET ${main} AND ${one(to)}` : `ABT ${main}`;
    default: return main;
  }
}

// Node tree -> GEDCOM text. Long values are split with CONC at 200 characters,
// embedded newlines with CONT.
export function writeGedcom(roots) {
  const out = [];
  const emit = (node, level) => {
    const head = [String(level), node.xref, node.tag].filter(Boolean).join(" ");
    const parts = String(node.value ?? "").split("\n");
    const first = parts.shift();
    const chunks = (text) => {
      const pieces = [];
      for (let start = 0; start < text.length; start += 200) pieces.push(text.slice(start, start + 200));
      return pieces.length ? pieces : [""];
    };
    const [head0, ...rest0] = chunks(first);
    out.push(head0 ? `${head} ${head0}` : head);
    for (const piece of rest0) out.push(`${level + 1} CONC ${piece}`);
    for (const part of parts) {
      const [p0, ...pRest] = chunks(part);
      out.push(p0 ? `${level + 1} CONT ${p0}` : `${level + 1} CONT`);
      for (const piece of pRest) out.push(`${level + 1} CONC ${piece}`);
    }
    for (const entry of node.children || []) emit(entry, level + 1);
  };
  for (const node of roots) emit(node, 0);
  return `${out.join("\n")}\n`;
}

export function node(tag, value = "", childNodes = [], xref = null) {
  return { tag, value, xref, children: childNodes.filter(Boolean) };
}
