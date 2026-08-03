import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { removeAdCampaignMediaSafely, uploadAdCampaignMedia, validateAdCampaignMedia } from '../services/adCampaignMediaService.js';

const fixtures = {
  jpeg:Buffer.from([0xff,0xd8,0xff,0xdb,0,0,0,0]),
  png:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nAAAAABJRU5ErkJggg==','base64'),
  webp:Buffer.from('RIFF0000WEBPVP8 ','ascii')
};

for (const [format,buffer] of Object.entries(fixtures)) test(`accepts actual ${format.toUpperCase()} content`,async()=>{
  const result=await validateAdCampaignMedia(buffer);
  assert.equal(result.mediaType,'image');
  assert.match(result.mimeType,/^image\//);
});

test('rejects SVG even when browser labels it as an image',async()=>{
  await assert.rejects(()=>validateAdCampaignMedia(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')),/JPG/);
});

test('rejects an image over 10 MB',async()=>{
  const oversized=Buffer.concat([fixtures.jpeg,Buffer.alloc(10*1024*1024)]);
  await assert.rejects(()=>validateAdCampaignMedia(oversized),/10 МБ/);
});

test('storage failure does not return media metadata for a campaign',async()=>{
  const storage={upload:async()=>({error:new Error('storage down')})};
  await assert.rejects(()=>uploadAdCampaignMedia({storage,buffer:fixtures.png,originalName:'card.png'}),/storage down/);
});

test('replacement cleanup preserves shared files and removes unused files',async()=>{
  const removed=[];const storage={remove:async paths=>{removed.push(...paths);return {error:null}}};
  assert.equal(await removeAdCampaignMediaSafely({storage,storagePath:'shared.png',isInUse:async()=>true}),false);
  assert.equal(await removeAdCampaignMediaSafely({storage,storagePath:'old.png',isInUse:async()=>false}),true);
  assert.deepEqual(removed,['old.png']);
});

test('admin form supports preview, replacement, removal and drag-and-drop',async()=>{
  const view=await readFile(new URL('../views/promo-campaigns.ejs',import.meta.url),'utf8');
  for(const token of ['enctype="multipart/form-data"','promo-media-drop','promo-media-preview','remove_media','dragover','DataTransfer'])assert.match(view,new RegExp(token));
  assert.match(view,/\/promos\/media\/<%= c\.id %>/);
});

test('delivery uses photo, video, text fallback and separate long-text message',async()=>{
  const source=await readFile(new URL('../services/downloadManager.js',import.meta.url),'utf8');
  assert.match(source,/sendPhoto/);assert.match(source,/sendVideo/);assert.match(source,/campaign\.message_text\.length > 900/);
  assert.match(source,/sent = longText \? await bot\.telegram\.sendMessage/);
  assert.match(source,/else \{\s*sent = await bot\.telegram\.sendMessage/);
  const recordAt=source.indexOf('await db.recordPromoImpression');
  assert.ok(recordAt>source.indexOf('sendPhoto')&&recordAt>source.indexOf('sent = longText'));
});

test('media upload and preview routes authenticate before processing',async()=>{
  const source=await readFile(new URL('../index.js',import.meta.url),'utf8');
  assert.match(source,/app\.post\('\/promos\/save', requireAuth, handlePromoMediaUpload/);
  assert.match(source,/app\.get\('\/promos\/media\/:id', requireAuth/);
  assert.doesNotMatch(source,/service[_-]?role/i);
});
