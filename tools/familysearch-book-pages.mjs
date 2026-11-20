// Bounded page reads from the FamilySearch Digital Library book viewer.
//
// Digital Library books (https://www.familysearch.org/library/books/...) are
// served page by page as images from the /library/books/i/ IIIF endpoint.
// These helpers validate the requested item and pages and pick the page
// image out of the viewer; the browser mode in familysearch-film.mjs does the
// navigation and saves each page image as a temporary capture.

export const MAX_BOOK_PAGES = 30;

export function bookItemId(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("book-page requires an https://www.familysearch.org/library/books URL.");
  }
  if (url.protocol !== "https:" || url.hostname !== "www.familysearch.org") {
    throw new Error("book-page accepts only https://www.familysearch.org/library/books URLs.");
  }
  const match = url.pathname.match(/^\/library\/books\/(?:viewer|records\/item)\/(\d+)(?:[-/][^/]*)?\/?$/);
  if (!match) throw new Error("book-page requires a Digital Library viewer or item URL with a numeric item id.");
  return match[1];
}

export function bookPageNumbers(rawPages) {
  const pages = String(rawPages || "").split(",").map((value) => Number(value.trim()));
  if (!pages.length || pages.length > MAX_BOOK_PAGES
      || pages.some((page) => !Number.isInteger(page) || page < 1 || page > 5000)
      || new Set(pages).size !== pages.length) {
    throw new Error(`book-page requires 1 through ${MAX_BOOK_PAGES} unique comma-separated positive page numbers.`);
  }
  return pages;
}

export function bookViewerPageUrl(itemId, page) {
  if (!/^\d+$/.test(String(itemId))) throw new Error("book item id must be numeric.");
  if (!Number.isInteger(page) || page < 1) throw new Error("book page must be a positive integer.");
  return `https://www.familysearch.org/library/books/viewer/${itemId}/?offset=0#page=${page}&viewer=picture`;
}

// The page-image identifier, taken from any IIIF tile path the viewer
// requested: ".../<book>_<volume>_<6-digit sequence>.tif". Returns the path
// split around the sequence number, or null when no tile matches.
export function bookImageTemplate(tilePaths) {
  for (const tilePath of tilePaths || []) {
    const match = String(tilePath).match(/^(\/[0-9a-f/-]+\/iiif\/[A-Za-z0-9]+_[A-Za-z0-9]+_)(\d{6})(\.tif)\//);
    if (match) return { prefix: match[1], suffix: match[3] };
  }
  return null;
}

// The whole page image for one sequence number, at full size.
export function bookPageImagePath(template, sequence) {
  if (!template?.prefix || !template?.suffix) throw new Error("A Digital Library image template is required.");
  if (!Number.isInteger(sequence) || sequence < 1 || sequence > 999999) throw new Error("Digital Library sequence must be a positive integer.");
  return `${template.prefix}${String(sequence).padStart(6, "0")}${template.suffix}/full/full/0/default.jpg`;
}
