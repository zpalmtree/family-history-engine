import assert from 'node:assert/strict';
import test from 'node:test';
import { PDFDocument, degrees } from 'pdf-lib';
import { annotatePdf, pdfRegionRectangle } from '../lib/viewer-pdf-annotations.js';

test('top-left display coordinates respect PDF crop boxes and rotations', async () => {
  const document = await PDFDocument.create();
  const page = document.addPage([600,800]);
  page.setCropBox(10,20,400,600);
  const expected = [[50,380,120,120],[90,80,80,180],[250,140,120,120],[250,380,80,180]];
  for (const [i,angle] of [0,90,180,270].entries()) {
    page.setRotation(degrees(angle));
    const actual=Object.values(pdfRegionRectangle(page,[.1,.2,.3,.2]));
    actual.forEach((value,j)=>assert.ok(Math.abs(value-expected[i][j])<1e-8));
  }
});

test('annotating a response preserves original bytes and all source pages', async () => {
  const source=await PDFDocument.create();source.addPage([300,400]);source.addPage([500,600]);
  const bytes=await source.save();const original=bytes.slice();
  const output=await annotatePdf(bytes,[{page:2,rect:[.1,.2,.3,.4]}]);
  assert.deepEqual(bytes,original);
  assert.equal((await PDFDocument.load(output)).getPageCount(),2);
  assert.notDeepEqual(output,original);
  await assert.rejects(annotatePdf(bytes,[{page:3,rect:[0,0,1,1]}]),/outside the PDF/);
});
