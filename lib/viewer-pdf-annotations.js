import { PDFDocument, rgb } from "pdf-lib";

// Coordinates describe the displayed CropBox, with the origin at top left.
export function pdfRegionRectangle(page, rect) {
  const box = page.getCropBox();
  const rotation = ((page.getRotation().angle % 360) + 360) % 360;
  const [x, y, w, h] = rect;
  let bounds;
  if (rotation === 0) bounds = [x, 1 - y - h, w, h];
  else if (rotation === 90) bounds = [y, x, h, w];
  else if (rotation === 180) bounds = [1 - x - w, y, w, h];
  else if (rotation === 270) bounds = [1 - y - h, 1 - x - w, h, w];
  else throw new Error("Unsupported PDF page rotation");
  return { x: box.x + bounds[0] * box.width, y: box.y + bounds[1] * box.height,
    width: bounds[2] * box.width, height: bounds[3] * box.height };
}

// Creates a response copy only. Never writes back to the source or Blob storage.
export async function annotatePdf(bytes, regions) {
  const document = await PDFDocument.load(bytes, { updateMetadata: false });
  const pages = document.getPages();
  for (const region of regions) {
    const page = pages[region.page - 1];
    if (!page) throw new Error("Annotation page is outside the PDF");
    page.drawRectangle({ ...pdfRegionRectangle(page, region.rect),
      borderColor: rgb(0.89, 0.17, 0.2), borderWidth: 1.5, borderOpacity: 1 });
  }
  return document.save();
}
