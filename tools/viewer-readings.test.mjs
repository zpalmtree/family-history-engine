import "./test-tree-config.mjs";
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { projectRecordReading, safeDisplayExcerpt } from './viewer-readings.mjs';

const record = { id: 'record', sha256: 'a'.repeat(64), viewer: { approved: true }, rights: 'family-viewer-approved', mediaType: 'image/jpeg', people: ['person'] };
const review = { recordId: 'record', sha256: record.sha256, state: 'current', method: 'original-visual', researchScope: 'main', reconciliation: { status: 'complete' }, secondReview: { status: 'complete' }, reviewedAt: '2026-10-14',
  checklist: Object.fromEntries(['sourceMasterOpened','visualAtSourceResolution','allPagesReviewed','structuredPersonLinksCompared','sourceSpellingsPreserved','neighboringMaterialExcluded','questionEffectsAssessed'].map(x=>[x,true])),
  readings: [{ id: 'line', locator: 'row 3', textAsRecorded: 'Johann [?]', interpretation: 'Private research note', note: '/private/path' }],
  participants: [{ canonicalPersonId: 'person', identificationStatus: 'confirmed', readingIds: ['line'] }, { canonicalPersonId: 'excluded', identificationStatus: 'confirmed', readingIds: ['line'] }] };
const visualIds = new Set(['person']);
const annotation = { sha256: record.sha256, reviewedAt: '2026-10-14', regions: [{ id: 'box', label: 'Row 3', rect: [.1,.2,.3,.4], readingIds: ['line'] }], translations: [{ readingId: 'line', language: 'English', text: 'John [?]' }] };

test('reviewed excerpts preserve uncertainty, limit person links, and exclude research internals', () => {
  const result=projectRecordReading(record,review,annotation,visualIds);
  assert.equal(result.status,'reviewed');
  assert.deepEqual(result.readings[0], { id:'line', locator:'row 3', text:'Johann [?]', notesPending:true, people:['person'], translation:{language:'English',text:'John [?]'} });
  assert.equal(JSON.stringify(result).includes('Private research'),false);
  assert.equal(JSON.stringify(result).includes('/private/path'),false);
  assert.deepEqual(projectRecordReading(record,{...review,participants:[{...review.participants[0],identificationStatus:'candidate'}]},annotation,visualIds).readings[0].people,[]);
});

test('stale, incomplete and dormant reviews cannot enter the viewer', () => {
  for(const patch of [{sha256:'b'.repeat(64)},{state:'stale'},{method:'index'},{researchScope:'collateral'},{secondReview:{status:'pending'}},{reconciliation:{status:'pending'}},{checklist:{}},{outcome:'refetch-required'}]) {
    assert.equal(projectRecordReading(record,{...review,...patch},null,visualIds).status,'needs-review');
    assert.throws(()=>projectRecordReading(record,{...review,...patch},annotation,visualIds),/stale or unreviewed/);
  }
  assert.equal(projectRecordReading({...record,privacy:'restricted'},review,null,visualIds),null);
  assert.equal(projectRecordReading({...record,viewer:{approved:false}},review,null,visualIds),null);
});

test('highlights and translations are hash-bound and validated against their reading', () => {
  assert.throws(()=>projectRecordReading(record,review,{...annotation,sha256:'b'.repeat(64)},visualIds),/stale/);
  for(const rect of [[-.1,0,.3,.4],[.8,0,.3,.4],[0,0,0,.4],[0,0,1,NaN]]) {
    assert.throws(()=>projectRecordReading(record,review,{...annotation,regions:[{...annotation.regions[0],rect}]},visualIds),/invalid viewer region/);
  }
  assert.throws(()=>projectRecordReading(record,review,{...annotation,regions:[{...annotation.regions[0],readingIds:['unknown']}]},visualIds),/invalid viewer region/);
  assert.throws(()=>projectRecordReading(record,review,{...annotation,translations:[{readingId:'unknown',language:'English',text:'Bad'}]},visualIds),/invalid translation/);
});

test('reading endpoint requires a session and only serves approved IDs', async () => {
  const source=fs.readFileSync(new URL('../app/api/records/[recordId]/readings/route.js',import.meta.url),'utf8').replace(/^import .*;\n/gm,'').replace(/\bexport /g,'');
  const context={Response, readings:{record:{status:'reviewed',readings:[],regions:[]}},COOKIE_NAME:'session',verifySessionToken:async value=>value==='valid'};
  vm.runInNewContext(source,context);
  const request=(recordId,authenticated)=>context.GET({cookies:{get:()=>({value:authenticated?'valid':''})}},{params:Promise.resolve({recordId})});
  for(const id of ['record','missing']) {const r=await request(id,false); assert.equal(r.status,401); assert.equal(r.headers.get('cache-control'),'private, no-store');}
  assert.equal((await request('missing',true)).status,404);
  assert.equal((await request('__proto__',true)).status,404);
  const good=await request('record',true); assert.equal(good.status,200);assert.equal(good.headers.get('vary'),'Cookie');
});

test('search normalizes diacritics and punctuation for alternate names', () => {
  const source=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
  const context={text:String};
  vm.runInNewContext(source.slice(source.indexOf('    function normalizePersonSearch('),source.indexOf('    function initPeopleSearch(')),context);
  assert.equal(context.normalizePersonSearch('  Trifirò, José-Anna '),'trifiro jose anna');
});


test('raw reports, local paths, and structured packets are never published as readings', () => {
  for (const text of ['{"rootInitial":{"reviewerId":"private"}}', '/mnt/c/private/source.jpg', 'C:\\Users\\private.jpg', 'source.json', '[{"name":"Inventory"}]']) assert.equal(safeDisplayExcerpt(text), false);
  assert.equal(safeDisplayExcerpt('[surname unclear] | Johann'), true);
  const projected=projectRecordReading(record,{...review,readings:[{id:'report',locator:'review',textAsRecorded:'{"rootInitial":{"reviewerId":"private"}}'}]},null,visualIds);
  assert.equal(projected.status,'needs-review');
  assert.deepEqual(projected.readings,[]);
});

test('visually verified display excerpts cover sources without a publishable extraction', () => {
  const curated = { ...annotation, visualReview: { method: 'original-visual', status: 'complete', sourceMasterOpened: true }, readings: [{ id:'line', locator:'Entry 3', text:'Johann [?]', people:['person'] }] };
  const result = projectRecordReading(record,null,curated,visualIds);
  assert.equal(result.status,'reviewed');
  assert.equal(result.reviewedAt,curated.reviewedAt);
  assert.equal(result.readings[0].translation.text,'John [?]');
  assert.throws(()=>projectRecordReading(record,null,{...curated,visualReview:undefined},visualIds),/unreviewed/);
  const dormant=projectRecordReading(record,{...review,researchScope:'collateral',readings:[{id:'private',textAsRecorded:'Dormant extraction'}]},curated,visualIds);
  assert.deepEqual(dormant.readings.map(reading=>reading.id),['line']);
  assert.throws(()=>projectRecordReading(record,null,{...curated,readings:[{...curated.readings[0],people:['outsider']}]},visualIds),/invalid display/);
  assert.throws(()=>projectRecordReading(record,null,{...curated,translations:[{readingId:'line',language:'English',text:'/mnt/c/private'}]},visualIds),/invalid translation/);
});

test('PDF highlights require an explicit one-based page', () => {
  const pdf = {...record,mediaType:'application/pdf'};
  for (const page of [undefined,0,-1,1.5]) assert.throws(()=>projectRecordReading(pdf,review,{...annotation,regions:[{...annotation.regions[0],page}]},visualIds),/invalid viewer region/);
  const result = projectRecordReading(pdf,review,{...annotation,regions:[{...annotation.regions[0],page:3}]},visualIds);
  assert.equal(result.regions[0].page,3);
});


test('only outlined excerpts enter the protected response, excluding neighboring people', () => {
  const withNeighbors={...review,readings:[...review.readings,{id:'entry1501',locator:'entry1501',textAsRecorded:'Maria Bates; unrelated neighboring baptism'},{id:'entry1502',locator:'entry1502',textAsRecorded:'Harriet Lester; unrelated neighboring baptism'}]};
  const projected=projectRecordReading(record,withNeighbors,annotation,visualIds);
  assert.deepEqual(projected.readings.map(r=>r.id),['line']);
  assert.doesNotMatch(JSON.stringify(projected),/Maria|Harriet|entry1501|entry1502/);
  assert.deepEqual(projectRecordReading(record,withNeighbors,null,visualIds),{status:'needs-review',readings:[],regions:[]});
});

test('selected passage displays only its transcription and translation without internal entry labels', () => {
  const source=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
  const elements=new Map();
  const element=selector=>{if(!elements.has(selector))elements.set(selector,{value:'0',textContent:'',innerHTML:'',scrollTop:40});return elements.get(selector);};
  const context={document:{querySelector:element},html:s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;'),drawRecordHighlight(){},activeReading:{
    regions:[{label:'John Example baptism',readingIds:['family']},{label:'Second family passage',readingIds:['second']}],
    readings:[{id:'neighbor',locator:'entry1501',text:'Maria Bates',people:[]},{id:'family',locator:'entry1510',text:'John; John and Sophia Example',people:['person'],translation:{language:'English',text:'Family translation'}},{id:'second',text:'Second passage text',people:[]}]
  }};
  vm.runInNewContext(source.slice(source.indexOf('    function renderRecordReadings()'),source.indexOf('    async function loadRecordReadings(')),context);
  context.renderRecordReadings();
  const content=element('#tree-record-reading-content');
  assert.equal(element("#tree-record-reading-heading").textContent,"English translation");
  assert.ok(content.innerHTML.indexOf("Family translation") < content.innerHTML.indexOf("Original transcription"));
  assert.match(content.innerHTML, /<details class="tree-reading-original">/);
  assert.match(content.innerHTML,/John and Sophia/);assert.doesNotMatch(content.innerHTML,/Maria|entry1501|entry1510|Second passage text/);
  assert.equal(content.scrollTop,0);
  element('#tree-record-region').value='1';context.renderRecordReadings();
  assert.equal(element('#tree-record-reading-heading').textContent,'Transcription');
  assert.match(content.innerHTML,/Second passage text/);assert.doesNotMatch(content.innerHTML,/John and Sophia|Family translation|Maria/);
});
