#!/usr/bin/env node

// Fetch helpers for exhibits (LIFE-STORIES-GOAL.md, build stage 5).
//
// Every picture or paragraph taken from outside the family's own records must arrive
// with its author, licence and page, so the exhibit that shows it can credit it. These
// helpers ask only the sources cleared in evidence/research/briefs/life-stories/README.md
// (section 7), at their published rates, and return the credit with the content.
//
//   npm run exhibits:fetch -- commons "File:Moreton Family Memorial Brewood.JPG" [--download <file>]
//   npm run exhibits:fetch -- commons-search "Ellastone church" [--limit 12]
//   npm run exhibits:fetch -- wikipedia en "Brewood"
//   npm run exhibits:fetch -- loc "https://www.loc.gov/item/<id>/"
//   npm run exhibits:fetch -- geograph <photo id>
//
// Privacy: no request carries the user's name or the project's. Wikimedia asks scripted
// clients for a contact; the user approved one on 17 Nov 2026 (FETCH CONTACT). It is read
// from the gitignored file .exhibit-fetch/contact, sent only to Wikimedia hosts, and never
// printed. Without that file Wikimedia is asked at its unidentified rate.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const CLIENT = "FamilyHistoryExhibits/1.0";
const WIKIMEDIA_HOST = /(^|\.)(wikimedia|wikipedia|wikidata)\.org$/;
// Seconds between requests, from each service's published guidance.
export const serviceIntervals = Object.freeze({ wikimedia: 6, "wikimedia-identified": 0.3, loc: 3, geograph: 2 });

/** Licences that let a private family viewer show the work, cropped, with credit. */
const FREE_LICENCE = /^(?:cc0|public domain|pd\b|cc by(?:-sa)? \d|no known copyright restrictions|no restrictions)/i;

export function serviceFor(url) {
  const host = new URL(url).hostname;
  if (WIKIMEDIA_HOST.test(host)) return "wikimedia";
  if (host === "loc.gov" || host.endsWith(".loc.gov")) return "loc";
  if (host === "geograph.org.uk" || host.endsWith(".geograph.org.uk")) return "geograph";
  throw new Error(`not a cleared exhibit source: ${host}`);
}

/** The User-Agent for one request. The contact goes to Wikimedia only. */
export function userAgentFor(url, contact) {
  return serviceFor(url) === "wikimedia" && contact ? `${CLIENT} (${contact})` : CLIENT;
}

export function plainText(html) {
  return String(html || "").replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
}

export function commonsInfoUrl(fileTitle) {
  const title = /^File:/i.test(fileTitle) ? fileTitle : `File:${fileTitle}`;
  return `https://commons.wikimedia.org/w/api.php?action=query&titles=${encodeURIComponent(title)}&prop=imageinfo&iiprop=url%7Csize%7Cmime%7Cextmetadata&format=json&formatversion=2`;
}

/** A Commons file with everything an exhibit must state about it. */
export function parseCommonsInfo(json) {
  const page = json?.query?.pages?.[0];
  const info = page?.imageinfo?.[0];
  if (!page || page.missing || !info) throw new Error("no such Commons file");
  const meta = info.extmetadata || {};
  const value = (key) => plainText(meta[key]?.value);
  const licence = value("LicenseShortName");
  const author = value("Artist");
  const title = page.title.replace(/^File:/, "");
  return {
    title,
    pageUrl: `https://commons.wikimedia.org/wiki/${encodeURIComponent(page.title.replace(/ /g, "_"))}`,
    fileUrl: String(info.url || "").split("?")[0],
    width: info.width, height: info.height, mediaType: info.mime,
    author,
    licence,
    ...(value("LicenseUrl") ? { licenceUrl: value("LicenseUrl") } : {}),
    description: value("ImageDescription"),
    ...(value("DateTimeOriginal") ? { taken: value("DateTimeOriginal") } : {}),
    ...(value("Restrictions") ? { restrictions: value("Restrictions") } : {}),
    usable: FREE_LICENCE.test(licence) && Boolean(author || /^(?:cc0|public domain|pd\b)/i.test(licence)),
    credit: `${author ? `Photograph: ${author}, ` : ""}Wikimedia Commons`
  };
}

/** Commons files matching a search, each with the same details as a single file. */
export function commonsSearchUrl(query, limit = 10) {
  const count = Math.min(Math.max(Number(limit) || 10, 1), 30);
  return `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(query)}&gsrnamespace=6&gsrlimit=${count}`
    + "&prop=imageinfo&iiprop=url%7Csize%7Cmime%7Cextmetadata&format=json&formatversion=2";
}

/** Photographs only, in the search's own order; anything Commons could not describe is left out. */
export function parseCommonsSearch(json) {
  return [...(json?.query?.pages || [])]
    .sort((first, second) => (first.index ?? 0) - (second.index ?? 0))
    .filter((page) => /^image\/(?:jpeg|png|tiff)$/.test(page.imageinfo?.[0]?.mime || ""))
    .map((page) => parseCommonsInfo({ query: { pages: [page] } }));
}

export function wikipediaSummaryUrl(language, title) {
  if (!/^[a-z]{2,3}$/.test(language)) throw new Error("language must be a Wikipedia language code");
  return `https://${language}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(String(title).replace(/ /g, "_"))}`;
}

export function parseWikipediaSummary(json) {
  if (!json?.title || json.type === "disambiguation" || !json.extract) throw new Error("no usable Wikipedia summary (missing or a disambiguation page)");
  return {
    title: json.title,
    extract: json.extract,
    pageUrl: json.content_urls?.desktop?.page,
    ...(json.wikibase_item ? { wikidataId: json.wikibase_item } : {}),
    ...(json.coordinates ? { coordinates: { lat: json.coordinates.lat, lon: json.coordinates.lon } } : {}),
    licence: "CC BY-SA 4.0",
    credit: `Wikipedia, "${json.title}"`
  };
}

export function locItemUrl(itemUrl) {
  const url = new URL(itemUrl);
  if (serviceFor(itemUrl) !== "loc") throw new Error("not a Library of Congress address");
  url.searchParams.set("fo", "json");
  return url.toString();
}

export function parseLocItem(json) {
  const item = json?.item;
  if (!item?.title) throw new Error("no such Library of Congress item");
  const text = (value) => plainText(Array.isArray(value) ? value.join(" ") : value);
  const rights = text(item.rights || item.rights_advisory || item.rights_information);
  const images = (item.image_url || []).filter((value) => /^https:/.test(value));
  return {
    title: text(item.title),
    ...(item.date ? { date: text(item.date) } : {}),
    pageUrl: item.id || item.url,
    rights,
    ...(images.length ? { fileUrl: images.at(-1).split("#")[0] } : {}),
    usable: /no known (?:copyright )?restrictions|public domain|not subject to copyright|no copyright/i.test(rights),
    credit: `Library of Congress${item.call_number ? `, ${text(item.call_number)}` : ""}`
  };
}

export function geographOembedUrl(photoId) {
  if (!/^\d+$/.test(String(photoId))) throw new Error("a Geograph photo id is a number");
  return `https://api.geograph.org.uk/api/oembed?url=${encodeURIComponent(`https://www.geograph.org.uk/photo/${photoId}`)}&format=json`;
}

export function parseGeographOembed(json, photoId) {
  if (!json?.author_name || !json?.url) throw new Error("no such Geograph photograph");
  return {
    title: plainText(json.title),
    pageUrl: `https://www.geograph.org.uk/photo/${photoId}`,
    fileUrl: json.url,
    width: json.width, height: json.height,
    author: plainText(json.author_name),
    licence: "CC BY-SA 2.0",
    licenceUrl: "https://creativecommons.org/licenses/by-sa/2.0/",
    usable: true,
    credit: `Photograph: © ${plainText(json.author_name)}, Geograph Britain and Ireland`
  };
}

/** A fetcher that keeps to each service's interval and identifies itself as allowed. */
export function createFetcher({ contact = "", fetchImpl = globalThis.fetch, now = () => Date.now(), sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  const last = new Map();
  async function request(url) {
    const service = serviceFor(url);
    const interval = (service === "wikimedia" && contact ? serviceIntervals["wikimedia-identified"] : serviceIntervals[service]) * 1000;
    const wait = (last.get(service) ?? -Infinity) + interval - now();
    if (wait > 0) await sleep(wait);
    last.set(service, now());
    const response = await fetchImpl(url, { headers: { "User-Agent": userAgentFor(url, contact), Accept: "application/json" }, redirect: "follow" });
    if (!response.ok) throw new Error(`${service} answered ${response.status}`);
    return response;
  }
  return {
    json: async (url) => (await request(url)).json(),
    bytes: async (url) => Buffer.from(await (await request(url)).arrayBuffer())
  };
}

export function readContact(root) {
  const file = path.join(root, ".exhibit-fetch", "contact");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim() : "";
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const { projectRoot } = await import("./research-store.mjs");
  const [kind, ...rest] = process.argv.slice(2);
  const fetcher = createFetcher({ contact: readContact(projectRoot) });
  const download = rest.includes("--download") ? rest[rest.indexOf("--download") + 1] : null;
  let result;
  if (kind === "commons-search") {
    const limit = rest.includes("--limit") ? rest[rest.indexOf("--limit") + 1] : 10;
    for (const file of parseCommonsSearch(await fetcher.json(commonsSearchUrl(rest[0], limit)))) {
      console.log(`${file.usable ? "USABLE" : "NO    "} File:${file.title} | ${file.width}x${file.height} | ${file.licence || "no licence stated"} | ${file.author || "no author"}${file.taken ? ` | ${file.taken.slice(0, 10)}` : ""}`);
      if (file.description) console.log(`       ${file.description.slice(0, 200)}`);
    }
    process.exit(0);
  }
  if (kind === "commons") result = parseCommonsInfo(await fetcher.json(commonsInfoUrl(rest[0])));
  else if (kind === "wikipedia") result = parseWikipediaSummary(await fetcher.json(wikipediaSummaryUrl(rest[0], rest[1])));
  else if (kind === "loc") result = parseLocItem(await fetcher.json(locItemUrl(rest[0])));
  else if (kind === "geograph") result = parseGeographOembed(await fetcher.json(geographOembedUrl(rest[0])), rest[0]);
  else {
    console.error('usage: exhibit-sources.mjs commons "File:..." | commons-search "<words>" [--limit n] | wikipedia <lang> <title> | loc <item url> | geograph <photo id>  [--download <file>]');
    process.exit(1);
  }
  console.log(JSON.stringify(result, null, 2));
  if (download) {
    if (!result.fileUrl) throw new Error("this item has no file to download");
    if (!result.usable) throw new Error("the licence does not clearly allow showing this file; read the page before downloading");
    fs.writeFileSync(download, await fetcher.bytes(result.fileUrl));
    console.log(`saved ${download}`);
  }
}
