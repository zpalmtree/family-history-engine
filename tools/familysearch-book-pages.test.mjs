import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { bookImageTemplate, bookItemId, bookPageImagePath, bookPageNumbers, bookViewerPageUrl } from "./familysearch-book-pages.mjs";

test("book-page accepts only Digital Library viewer or item URLs on familysearch.org", () => {
  assert.equal(bookItemId("https://www.familysearch.org/library/books/viewer/988694/?offset=0#page=1"), "988694");
  assert.equal(bookItemId("https://www.familysearch.org/library/books/records/item/988694-wills-of-mifflin-county"), "988694");
  for (const bad of ["http://www.familysearch.org/library/books/viewer/1/", "https://evil.example/library/books/viewer/1/", "https://www.familysearch.org/ark:/61903/3:1:X", "not a url"]) {
    assert.throws(() => bookItemId(bad));
  }
});

test("book-page page lists are bounded, unique and positive", () => {
  assert.deepEqual(bookPageNumbers("28,30,44"), [28, 30, 44]);
  for (const bad of ["", "0", "1,1", "a", Array.from({ length: 31 }, (_, index) => index + 1).join(",")]) {
    assert.throws(() => bookPageNumbers(bad));
  }
  assert.equal(bookViewerPageUrl("988694", 3), "https://www.familysearch.org/library/books/viewer/988694/?offset=0#page=3&viewer=picture");
});

test("the page-image template comes from a viewer tile path and builds full pages by sequence", () => {
  const tiles = ["/library/books/assets/images/viewer2/close.png", "/53/6a/74/24/536a7424-9b42-4ba7-8a28-6d8ba71e48cb/iiif/138280_01_000001.tif/0,1024,1024,1024/256,/0/default.png"];
  const template = bookImageTemplate(tiles);
  assert.deepEqual(template, { prefix: "/53/6a/74/24/536a7424-9b42-4ba7-8a28-6d8ba71e48cb/iiif/138280_01_", suffix: ".tif" });
  assert.equal(bookPageImagePath(template, 30), "/53/6a/74/24/536a7424-9b42-4ba7-8a28-6d8ba71e48cb/iiif/138280_01_000030.tif/full/full/0/default.jpg");
  assert.equal(bookImageTemplate(["/library/books/assets/x.png"]), null);
  assert.throws(() => bookPageImagePath(template, 0));
});

test("the book-page browser mode stays temporary, session-bound and JPEG-checked", () => {
  const source = fs.readFileSync(new URL("./familysearch-film.mjs", import.meta.url), "utf8");
  const block = source.slice(source.indexOf('if (mode === "book-page")'), source.indexOf('if (mode === "capture" && !recordUrl && imageNumber)'));
  assert.match(block, /FAMILYSEARCH_CAPTURE_PATH must be set/);
  assert.match(block, /page\.context\(\)\.request\.get\(`https:\/\/www\.familysearch\.org\$\{source\}`/);
  assert.match(block, /bytes\[0\] === 0xff && bytes\[1\] === 0xd8/);
  assert.match(block, /for \(let visit = 0; visit < 3 && !template; visit \+= 1\)/);
  assert.doesNotMatch(block, /archive|manifest|records-manifest/i);
  const dispatch = fs.readFileSync(new URL("./familysearch-cdp-dispatch-windows.ps1", import.meta.url), "utf8");
  assert.match(dispatch, /"book-page" \{[\s\S]*-Images must be 1 through 30 comma-separated positive page numbers/);
  const wrapper = fs.readFileSync(new URL("./familysearch-windows.ps1", import.meta.url), "utf8");
  assert.match(wrapper, /"capture", "book-page"/);
});
