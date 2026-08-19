import test from 'node:test';
import assert from 'node:assert/strict';
import { getShazamFileLinkOrReply, SHAZAM_FILE_TOO_BIG_MESSAGE, TELEGRAM_BOT_DOWNLOAD_LIMIT_BYTES } from '../services/shazamMediaGuard.js';

function context({ link='https://telegram.test/file', error }={}) {
  const state={getFileLink:0,replies:[]};
  return {state,ctx:{telegram:{getFileLink:async()=>{state.getFileLink++;if(error)throw error;return new URL(link);}},reply:async text=>{state.replies.push(text);}}};
}

test('oversized voice is rejected before Telegram getFileLink',async()=>{
 const {ctx,state}=context();
 const result=await getShazamFileLinkOrReply(ctx,{file_id:'voice',file_size:TELEGRAM_BOT_DOWNLOAD_LIMIT_BYTES+1});
 assert.equal(result,null); assert.equal(state.getFileLink,0); assert.deepEqual(state.replies,[SHAZAM_FILE_TOO_BIG_MESSAGE]);
});

test('allowed Shazam media continues through existing getFileLink flow',async()=>{
 const {ctx,state}=context();
 const result=await getShazamFileLinkOrReply(ctx,{file_id:'voice',file_size:1024});
 assert.equal(result.href,'https://telegram.test/file'); assert.equal(state.getFileLink,1); assert.deepEqual(state.replies,[]);
});

test('Telegram file is too big error becomes an expected user-facing result',async()=>{
 const error=new Error('400: Bad Request: file is too big');
 const {ctx,state}=context({error});
 const result=await getShazamFileLinkOrReply(ctx,{file_id:'voice'});
 assert.equal(result,null); assert.equal(state.getFileLink,1); assert.deepEqual(state.replies,[SHAZAM_FILE_TOO_BIG_MESSAGE]);
});

test('oversized Shazam media never reaches critical notification boundary',async()=>{
 const {ctx}=context(); let critical=0;
 try { await getShazamFileLinkOrReply(ctx,{file_id:'voice',file_size:22344487}); }
 catch { critical++; }
 assert.equal(critical,0);
});
