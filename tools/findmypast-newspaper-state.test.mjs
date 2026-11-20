import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { assertNewspaperStateRoute, inspectNewspaperSearchDom, readNewspaperSearchState } from "./findmypast-newspaper-state.mjs";

const route = "https://www.findmypast.com/search-newspapers/results?keywords=Walker%20Example&exactKeywords=false&startdate=1848-02-01&enddate=1848-03-31";
const expected = { keywords: "Walker Example", exactKeywords: false, startdate: "1848-02-01", enddate: "1848-03-31" };
function fixture() {
  const reads = [];
  const fields = [
    ["keywords", "Keywords", "text", "Walker Example"],
    ["exactKeywords", "Exact phrase", "checkbox", false],
    ["startdate", "From", "date", "1848-02-01"],
    ["enddate", "To", "date", "1848-03-31"],
    ["account", "Account", "text", "PRIVATE"],
  ].map(([id, label, type, value]) => ({
    id, name: id, type, labels: [{ textContent: label }],
    hidden: false, excluded: false, autocomplete: "",
    getClientRects() { return this.hidden ? [] : [{ width: 100, height: 20 }]; },
    getAttribute: () => null,
    closest() { return this.excluded ? {} : null; },
    get value() { reads.push(id); return value; },
    get checked() { reads.push(id); return value; },
  }));
  const heading = { textContent: "Newspaper PRIVATE", getClientRects: () => [{ width: 10, height: 10 }], closest: () => null };
  const main = { querySelectorAll: (selector) => selector === "input" ? fields : [heading] };
  const state = { sensitive: false, challenge: false, main: true };
  const document = {
    querySelector: () => state.sensitive ? {} : null,
    querySelectorAll: (selector) => selector === 'main,[role="main"]' ? (state.main ? [main] : []) : (state.challenge ? [{ tagName: "IFRAME", getClientRects: () => [{ width: 1, height: 1 }] }] : []),
  };
  return { fields, reads, state, run: () => vm.runInNewContext(`(${inspectNewspaperSearchDom.toString()})(expected)`, {
    document, expected, getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
  }) };
}

test("newspaper state reads only four historical values, never claiming editable controls are applied evidence", () => {
  const f = fixture(); const result = f.run();
  assert.deepEqual(f.reads, ["keywords", "exactKeywords", "startdate", "enddate"]);
  assert.equal(result.controls[1].matchesExpected, true);
  assert.equal(result.appliedFiltersVerified, false);
  assert.equal(result.interactionPerformed, false);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
});

test("missing, duplicate, hidden, unexpected and sensitive controls are not read", () => {
  for (const mutate of [
    (f) => f.fields.shift(),
    (f) => f.fields.push(f.fields[0]),
    (f) => { f.fields[0].hidden = true; },
    (f) => { f.fields[0].excluded = true; },
    (f) => { f.fields[0].labels = [{ textContent: "Email" }]; },
    (f) => { f.fields[0].type = "email"; },
    (f) => { f.fields[0].autocomplete = "username"; },
    (f) => { f.state.main = false; },
  ]) {
    const f = fixture(); mutate(f); const result = f.run();
    assert.equal(result.appliedFiltersVerified, false);
    assert.equal(f.reads.includes("keywords"), false);
  }
  for (const gate of ["sensitive", "challenge"]) {
    const f = fixture(); f.state[gate] = true;
    assert.throws(f.run); assert.equal(f.reads.length, 0);
  }
});

test("mismatching values and headings never disclose their contents", () => {
  const f = fixture(); Object.defineProperty(f.fields[0], "value", { get: () => "PRIVATE prior search" });
  const result = f.run();
  assert.equal(result.controls[0].matchesExpected, false);
  assert.equal(result.newspaperHeadingPresent, true);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|prior search/);
});

test("route checks reject account, external, lookalike and changing pages before accepting state", async () => {
  assert.doesNotThrow(() => assertNewspaperStateRoute(route));
  assert.doesNotThrow(() => assertNewspaperStateRoute(route.replace(".com/", ".co.uk/")));
  for (const url of [route.replace("https:", "http:"), route.replace("www.findmypast.com", "www.findmypast.com.evil.test"), route.replace("/search-newspapers/results", "/account"), `${route}#x`, route.replace("www.", "user@www.")]) {
    assert.throws(() => assertNewspaperStateRoute(url));
  }
  let current = route;
  await assert.rejects(readNewspaperSearchState({ url: () => current, evaluate: async () => { current = route.replace("Example", "Other"); return {}; } }, route), /changed/);
});
