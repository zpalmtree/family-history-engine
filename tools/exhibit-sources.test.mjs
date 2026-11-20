import assert from "node:assert/strict";
import test from "node:test";

import {
  CLIENT,
  commonsInfoUrl,
  commonsSearchUrl,
  createFetcher,
  geographOembedUrl,
  locItemUrl,
  parseCommonsInfo,
  parseCommonsSearch,
  parseGeographOembed,
  parseLocItem,
  parseWikipediaSummary,
  plainText,
  serviceFor,
  serviceIntervals,
  userAgentFor,
  wikipediaSummaryUrl
} from "./exhibit-sources.mjs";

const commons = (extra = {}) => ({ query: { pages: [{
  title: "File:Moreton Family Memorial Brewood.JPG",
  imageinfo: [{
    url: "https://upload.wikimedia.org/wikipedia/commons/f/f5/Moreton_Family_Memorial_Brewood.JPG?utm_source=x",
    width: 1540, height: 3256, mime: "image/jpeg",
    extmetadata: {
      Artist: { value: '<a href="//commons.wikimedia.org/wiki/User:Sjwells53" title="User:Sjwells53">Sjwells53</a>' },
      LicenseShortName: { value: "CC BY-SA 3.0" },
      LicenseUrl: { value: "https://creativecommons.org/licenses/by-sa/3.0" },
      ImageDescription: { value: "Memorial in <i>St Mary &amp; St Chad</i> church" },
      DateTimeOriginal: { value: "2011-04-16" },
      ...extra
    }
  }]
}] } });

test("only cleared sources are asked, and the contact goes to Wikimedia alone", () => {
  assert.equal(serviceFor("https://commons.wikimedia.org/w/api.php"), "wikimedia");
  assert.equal(serviceFor("https://en.wikipedia.org/api/rest_v1/page/summary/Brewood"), "wikimedia");
  assert.equal(serviceFor("https://www.wikidata.org/w/api.php"), "wikimedia");
  assert.equal(serviceFor("https://www.loc.gov/item/123/"), "loc");
  assert.equal(serviceFor("https://tile.loc.gov/image.jpg"), "loc");
  assert.equal(serviceFor("https://api.geograph.org.uk/api/oembed"), "geograph");
  assert.throws(() => serviceFor("https://www.findagrave.com/memorial/1"), /not a cleared exhibit source/);
  assert.throws(() => serviceFor("https://evilwikipedia.org/"), /not a cleared exhibit source/);

  assert.equal(userAgentFor("https://commons.wikimedia.org/w/api.php", "contact@example.org"), `${CLIENT} (contact@example.org)`);
  assert.equal(userAgentFor("https://commons.wikimedia.org/w/api.php", ""), CLIENT);
  assert.equal(userAgentFor("https://www.loc.gov/item/123/", "contact@example.org"), CLIENT, "the Library of Congress never receives the contact");
  assert.equal(userAgentFor("https://api.geograph.org.uk/api/oembed", "contact@example.org"), CLIENT);
});

test("a Commons file comes back with its author, licence and page", () => {
  assert.equal(commonsInfoUrl("Moreton Family Memorial Brewood.JPG"), commonsInfoUrl("File:Moreton Family Memorial Brewood.JPG"));
  assert.match(commonsInfoUrl("File:A B.jpg"), /titles=File%3AA%20B\.jpg&prop=imageinfo&iiprop=url%7Csize%7Cmime%7Cextmetadata/);
  const info = parseCommonsInfo(commons());
  assert.deepEqual(info, {
    title: "Moreton Family Memorial Brewood.JPG",
    pageUrl: "https://commons.wikimedia.org/wiki/File%3AMoreton_Family_Memorial_Brewood.JPG",
    fileUrl: "https://upload.wikimedia.org/wikipedia/commons/f/f5/Moreton_Family_Memorial_Brewood.JPG",
    width: 1540, height: 3256, mediaType: "image/jpeg",
    author: "Sjwells53", licence: "CC BY-SA 3.0", licenceUrl: "https://creativecommons.org/licenses/by-sa/3.0",
    description: "Memorial in St Mary & St Chad church", taken: "2011-04-16",
    usable: true, credit: "Photograph: Sjwells53, Wikimedia Commons"
  });
  assert.equal(parseCommonsInfo(commons({ LicenseShortName: { value: "Public domain" }, Artist: { value: "" } })).usable, true);
  assert.equal(parseCommonsInfo(commons({ LicenseShortName: { value: "CC BY-NC-ND 2.0" } })).usable, false, "a non-commercial, no-derivatives licence is not taken");
  assert.equal(parseCommonsInfo(commons({ LicenseShortName: { value: "Fair use" } })).usable, false);
  assert.equal(parseCommonsInfo(commons({ Artist: { value: "" } })).usable, false, "an attribution licence with no author cannot be credited");
  assert.throws(() => parseCommonsInfo({ query: { pages: [{ title: "File:Nope.jpg", missing: true }] } }), /no such Commons file/);
});

test("a Commons search returns photographs in order, each with its licence", () => {
  assert.match(commonsSearchUrl("Ellastone church"), /generator=search&gsrsearch=Ellastone%20church&gsrnamespace=6&gsrlimit=10&prop=imageinfo/);
  assert.match(commonsSearchUrl("x", 500), /gsrlimit=30&/, "a search is a lookup, not a harvest");
  const page = (title, index, mime, licence) => ({ title, index, imageinfo: [{ url: `https://upload.wikimedia.org/${index}.jpg`, width: 800, height: 600, mime,
    extmetadata: { Artist: { value: "A. Photographer" }, LicenseShortName: { value: licence } } }] });
  const found = parseCommonsSearch({ query: { pages: [
    page("File:Second.jpg", 2, "image/jpeg", "CC BY-SA 2.0"),
    page("File:Plan.pdf", 3, "application/pdf", "Public domain"),
    page("File:First.jpg", 1, "image/jpeg", "CC BY-NC 2.0"),
    { title: "File:Broken.jpg", index: 4 }
  ] } });
  assert.deepEqual(found.map((file) => [file.title, file.usable]), [["First.jpg", false], ["Second.jpg", true]]);
  assert.equal(found[1].credit, "Photograph: A. Photographer, Wikimedia Commons");
  assert.deepEqual(parseCommonsSearch({}), []);
});

test("a Wikipedia summary carries its licence and is refused when it is a disambiguation page", () => {
  assert.equal(wikipediaSummaryUrl("en", "Abbots Bromley"), "https://en.wikipedia.org/api/rest_v1/page/summary/Abbots_Bromley");
  assert.throws(() => wikipediaSummaryUrl("en.evil", "x"), /language code/);
  const summary = parseWikipediaSummary({ title: "Brewood", extract: "Brewood is a village in Staffordshire.", type: "standard",
    content_urls: { desktop: { page: "https://en.wikipedia.org/wiki/Brewood" } }, wikibase_item: "Q2004040", coordinates: { lat: 52.677, lon: -2.174 } });
  assert.deepEqual(summary, { title: "Brewood", extract: "Brewood is a village in Staffordshire.", pageUrl: "https://en.wikipedia.org/wiki/Brewood",
    wikidataId: "Q2004040", coordinates: { lat: 52.677, lon: -2.174 }, licence: "CC BY-SA 4.0", credit: 'Wikipedia, "Brewood"' });
  assert.throws(() => parseWikipediaSummary({ title: "Rose", type: "disambiguation", extract: "Rose may refer to" }), /disambiguation/);
});

test("a Library of Congress item is usable only when its rights say so", () => {
  assert.equal(locItemUrl("https://www.loc.gov/item/sn83035526/1913-05-22/ed-1/"), "https://www.loc.gov/item/sn83035526/1913-05-22/ed-1/?fo=json");
  assert.throws(() => locItemUrl("https://example.org/item/1/"), /not a cleared exhibit source/);
  const item = parseLocItem({ item: { title: "Main Street, Waterville", date: "1909", id: "https://www.loc.gov/item/2001/", call_number: ["HABS OH-1"],
    rights: ["<p>No known restrictions on publication.</p>"], image_url: ["https://tile.loc.gov/a_150px.jpg#h=150", "https://tile.loc.gov/a.jpg#h=2000"] } });
  assert.deepEqual(item, { title: "Main Street, Waterville", date: "1909", pageUrl: "https://www.loc.gov/item/2001/", rights: "No known restrictions on publication.",
    fileUrl: "https://tile.loc.gov/a.jpg", usable: true, credit: "Library of Congress, HABS OH-1" });
  assert.equal(parseLocItem({ item: { title: "A portrait", rights: "Rights status not evaluated." } }).usable, false);
  assert.throws(() => parseLocItem({}), /no such Library of Congress item/);
});

test("a Geograph photograph is credited to its photographer under CC BY-SA 2.0", () => {
  assert.match(geographOembedUrl(1234567), /^https:\/\/api\.geograph\.org\.uk\/api\/oembed\?url=https%3A%2F%2Fwww\.geograph\.org\.uk%2Fphoto%2F1234567&format=json$/);
  assert.throws(() => geographOembedUrl("12; rm"), /photo id is a number/);
  const photo = parseGeographOembed({ title: "St Peter, Ellastone", author_name: "A. Photographer", url: "https://s0.geograph.org.uk/geophotos/01/23/45/1234567_abc.jpg", width: 640, height: 480 }, 1234567);
  assert.equal(photo.credit, "Photograph: © A. Photographer, Geograph Britain and Ireland");
  assert.equal(photo.licence, "CC BY-SA 2.0");
  assert.equal(photo.pageUrl, "https://www.geograph.org.uk/photo/1234567");
  assert.throws(() => parseGeographOembed({}, 1), /no such Geograph photograph/);
});

test("markup is reduced to plain text", () => {
  assert.equal(plainText('<span class="x">Own  work</span> &amp; &quot;more&quot; &#39;x&#039;&nbsp;'), "Own work & \"more\" 'x'");
});

test("requests keep to each service's interval and carry the right identity", async () => {
  const calls = [];
  const sleeps = [];
  let clock = 1_000_000;
  const fetcher = createFetcher({
    contact: "contact@example.org",
    now: () => clock,
    sleep: async (ms) => { sleeps.push(ms); clock += ms; },
    fetchImpl: async (url, options) => { calls.push([url, options.headers["User-Agent"]]); return { ok: !url.includes("missing"), status: 404, json: async () => ({ ok: true }), arrayBuffer: async () => new Uint8Array([1, 2]).buffer }; }
  });
  await fetcher.json("https://commons.wikimedia.org/w/api.php?a=1");
  await fetcher.json("https://commons.wikimedia.org/w/api.php?a=2");
  await fetcher.json("https://www.loc.gov/item/1/?fo=json");
  await fetcher.json("https://www.loc.gov/item/2/?fo=json");
  assert.deepEqual(sleeps, [serviceIntervals["wikimedia-identified"] * 1000, serviceIntervals.loc * 1000], "the first request to a service does not wait; the second does");
  assert.deepEqual(calls.map(([, agent]) => agent), [`${CLIENT} (contact@example.org)`, `${CLIENT} (contact@example.org)`, CLIENT, CLIENT]);
  assert.deepEqual([...await fetcher.bytes("https://upload.wikimedia.org/x.jpg")], [1, 2]);
  await assert.rejects(fetcher.json("https://www.loc.gov/item/missing/?fo=json"), /loc answered 404/);

  const anonymous = createFetcher({ now: () => clock, sleep: async (ms) => { sleeps.push(ms); clock += ms; }, fetchImpl: async () => ({ ok: true, json: async () => ({}) }) });
  await anonymous.json("https://en.wikipedia.org/api/rest_v1/page/summary/A");
  await anonymous.json("https://en.wikipedia.org/api/rest_v1/page/summary/B");
  assert.equal(sleeps.at(-1), serviceIntervals.wikimedia * 1000, "without a contact Wikimedia is asked at its unidentified rate");
});
