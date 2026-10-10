import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

async function moduleFrom(path) {
  const result = await build({ entryPoints: [path], bundle: true, platform: 'node', format: 'esm', write: false });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
}
const model = await moduleFrom('src/shared/model.ts');
test('URL matching cannot adopt a different origin, query, port or path', () => {
  for (const [a, b] of [
    ['https://a.com/a', 'http://a.com/a'], ['https://a.com/a', 'https://a.com:8443/a'],
    ['https://a.com/a?x=1', 'https://a.com/a?x=2'], ['https://a.com/a', 'https://a.com/abc'],
    ['https://a.com/a', 'https://www.a.com/a'], ['chrome://extensions', 'chrome://extensions'],
    ['https://reader@a.com/a', 'https://a.com/a']
  ]) assert.equal(model.matchUrl(a, b), false);
  assert.equal(model.matchUrl('https://twitter.com/u/status/1', 'https://x.com/u/status/1'), true);
});
test('refresh and SPA revision invalidate the same URL', () => {
  const page = { tabId: 1, documentId: 'd1', revision: 1, url: 'https://a.com/a', incognito: false };
  assert.equal(model.sameIdentity(page, { ...page, documentId: 'd2' }), false);
  assert.equal(model.sameIdentity(page, { ...page, revision: 2 }), false);
  assert.equal(model.sameIdentity(page, { ...page, incognito: true }), false);
});
test('a failed queued operation cannot block the next operation', async () => {
  const queue = new model.SerialQueue(), calls = [];
  const failed = queue.run(async () => { calls.push(1); throw new Error('expected'); });
  const next = queue.run(async () => { calls.push(2); return 3; });
  await assert.rejects(failed); assert.equal(await next, 3); assert.deepEqual(calls, [1, 2]);
});

let engine, local = {}, session = {}, processor = [], native = [], contexts = [], documentId = 'doc-1', rejectCache = false, rejectPins = false;
const clone = value => structuredClone(value);
const storage = kind => ({
  get: async keys => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, clone((kind === 'local' ? local : session)[key])])),
  set: async values => {
    if (kind === 'session' && rejectCache && values['articleExporter:session']?.cache.length) throw new Error('QUOTA_BYTES');
    if (kind === 'session' && rejectPins && values['articleExporter:session']?.cache.some(entry=>entry.pins.length)) throw new Error('QUOTA_BYTES');
    Object.assign(kind === 'local' ? local : session, clone(values));
  }
});
before(async () => {
  globalThis.chrome = {
    storage: { local: storage('local'), session: storage('session') },
    runtime: { id: 'test-extension', ContextType: { OFFSCREEN_DOCUMENT: 'OFFSCREEN_DOCUMENT' }, getURL: path => `chrome-extension://test-extension/${path}`, getContexts: async () => contexts, sendMessage: async message => {
      processor.push(clone(message));
      return { success: true, data: message.type === 'activity' ? { operations: [], jobs: [], blobs: 0 } : undefined };
    } },
    offscreen: { Reason: { DOM_PARSER: 'DOM_PARSER', BLOBS: 'BLOBS' }, createDocument: async () => { contexts = [{}]; }, closeDocument: async () => { contexts = []; } },
    i18n: { getMessage: key => key, getUILanguage: () => 'en' },
    tabs: { get: async id => ({ id, url: 'https://mp.weixin.qq.com/s/test', incognito: id === 2 }), query: async () => [{ id: 1, url: 'https://mp.weixin.qq.com/s/test', active: true } ] },
    webNavigation: { getFrame: async () => ({ documentId }) },
    scripting: { executeScript: async () => [{ documentId, result: { eligible: true, fingerprint: 'fingerprint', title: 'Article' } }] },
    windows: { getLastFocused: async () => ({ focused: true, id: 1 }), getAll: async () => [] },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    alarms: { create: async () => {}, clear: async () => {} },
    downloads: { download: async options => { const id = native.length + 1; native.push({ ...options, id, state: 'in_progress', byExtensionId: 'test-extension' }); return id; }, search: async query => native.filter(item => item.id === query.id || item.url === query.url), cancel: async id => { Object.assign(native.find(item => item.id === id), { state: 'interrupted', error: 'USER_CANCELED' }); } }
  };
  engine = await moduleFrom('src/background/engine.ts');
});
const article = { url: 'https://mp.weixin.qq.com/s/test', title: 'Article', contentHtml: '<p>Article body</p>', textContent: 'Article body', images: [], fetchedAt: 1 };
const send = (type, data = {}) => {
  const job = [...(local['articleExporter:jobs'] ?? []), ...(session['articleExporter:session']?.privateJobs ?? [])].find(job => job.id === data.jobId);
  return engine.handle({ type, attemptId: job?.attemptId, ...data });
};
async function reset() { local = {}; session = {}; processor = []; native = []; contexts = []; documentId = 'doc-1'; rejectCache = false; rejectPins = false; }
async function submit(formats = ['markdown'], extra = {}) { return send('submit', { requestId: crypto.randomUUID(), url: article.url, formats, tabId: 1, incognito: false, ...extra }); }
async function prepare(job) {
  const operation = session['articleExporter:session'].preparations.find(op => op.jobIds.includes(job.id));
  await send('prepared', { operationId: operation.id, article });
}
test('repeated submission is deduplicated; completion comes from native downloads', async () => {
  await reset(); const job = await submit(); const duplicate = await submit();
  assert.equal(job.id, duplicate.id); await prepare(job);
  await send('formatStarted', { jobId: job.id, format: 'markdown' });
  await send('payloadReady', { jobId: job.id, format: 'markdown', blobUrl: 'blob:chrome-extension://test-extension/abc', filename: 'article.md' });
  assert.equal((await send('getJob', { jobId: job.id })).state, 'downloading');
  assert.deepEqual(await send('getHistory'), []);
  assert.equal(native[0].conflictAction, 'uniquify');
  native[0].state = 'complete'; await engine.downloadChanged(1);
  assert.equal((await send('getJob', { jobId: job.id })).state, 'complete');
  assert.equal((await send('getHistory'))[0].verified, true);
});
test('partial failure retries only failed formats from the same snapshot', async () => {
  await reset(); const job = await submit(['markdown', 'pdf']); await prepare(job);
  await send('formatStarted', { jobId: job.id, format: 'markdown' });
  await send('payloadReady', { jobId: job.id, format: 'markdown', blobUrl: 'blob:chrome-extension://test-extension/a', filename: 'a.md' });
  native[0].state = 'complete'; await engine.downloadChanged(1);
  await send('formatStarted', { jobId: job.id, format: 'pdf' });
  await send('formatFailed', { jobId: job.id, format: 'pdf', error: 'PDF_FONT_UNAVAILABLE' });
  assert.equal((await send('getJob', { jobId: job.id })).state, 'partial');
  const retried = await send('retry', { jobId: job.id });
  assert.equal(retried.results.markdown.state, 'complete');
  assert.equal(retried.results.pdf.state, 'queued');
  assert.equal(processor.at(-1).article.title, article.title);
});
test('clear history remains clear when an older task later completes', async () => {
  await reset(); const job = await submit(); await prepare(job);
  await send('formatStarted', { jobId: job.id, format: 'markdown' });
  await send('payloadReady', { jobId: job.id, format: 'markdown', blobUrl: 'blob:chrome-extension://test-extension/a', filename: 'a.md' });
  await send('clearHistory'); native[0].state = 'complete'; await engine.downloadChanged(1);
  assert.deepEqual(await send('getHistory'), []);
});
test('cancel rejects late payloads and releases cache pins', async () => {
  await reset(); const job = await submit(); await prepare(job);
  await send('formatStarted', { jobId: job.id, format: 'markdown' });
  await send('cancel', { jobId: job.id });
  assert.equal((await send('payloadReady', { jobId: job.id, format: 'markdown', blobUrl: 'blob:chrome-extension://test-extension/a', filename: 'a.md' })).success, false);
  assert.equal(native.length, 0);
  assert.deepEqual(session['articleExporter:session'].cache[0].pins, []);
  await assert.rejects(send('formatStarted', { jobId: job.id, format: 'markdown' }), /STALE_FORMAT/);
});
test('large snapshots bypass cache while still reaching the processor intact', async () => {
  await reset(); const job = await submit();
  const operation = session['articleExporter:session'].preparations[0];
  await send('prepared', { operationId: operation.id, article: { ...article, contentHtml: 'x'.repeat(2200000) } });
  assert.equal(session['articleExporter:session'].cache.length, 0);
  assert.equal(processor.at(-1).operationId, operation.id);
  assert.equal((await send('getJob', { jobId: job.id })).state, 'building');
});
test('private jobs and legacy history writes stay out of persistent storage', async () => {
  await reset(); const job = await submit(['markdown'], { tabId: 2, incognito: true }); await prepare(job);
  assert.equal((local['articleExporter:jobs'] ?? []).length, 0);
  assert.equal(session['articleExporter:session'].privateJobs[0].id, job.id);
  await send('addRecord', { incognito: true, payload: { id: 'private' } });
  assert.deepEqual(await send('getHistory'), []);
  await engine.clearPrivateWhenClosed();
  assert.equal(session['articleExporter:session'].privateJobs.length, 0);
});
test('a changed document cannot satisfy a pending page capture', async () => {
  await reset(); const job = await submit();
  const operation = session['articleExporter:session'].preparations[0];
  documentId = 'doc-2';
  await assert.rejects(send('capturePage', { operationId: operation.id, identity: job.identity, stage: 'generic' }), /SOURCE_CHANGED/);
});
test('storage quota rejection keeps the accepted full snapshot alive', async () => {
  await reset(); const job = await submit(); rejectCache = true; await prepare(job);
  assert.equal((await send('getJob', { jobId: job.id })).state, 'building');
  assert.equal(session['articleExporter:session'].cache.length, 0);
  assert.ok(processor.at(-1).operationId);
});
test('native acceptance racing with cancellation cancels the eventual ID', async () => {
  await reset(); const job = await submit(); await prepare(job);
  await send('formatStarted', { jobId: job.id, format: 'markdown' });
  const original = chrome.downloads.download;
  let release;
  chrome.downloads.download = options => new Promise(resolve => { release = async () => resolve(await original(options)); });
  try {
    const pending = send('payloadReady', { jobId: job.id, format: 'markdown', blobUrl: 'blob:chrome-extension://test-extension/a', filename: 'a.md' });
    while (!release) await new Promise(resolve => setTimeout(resolve, 0));
    await send('cancel', { jobId: job.id }); await release(); await pending;
    assert.equal(native[0].state, 'interrupted');
    assert.equal((await send('getJob', { jobId: job.id })).state, 'cancelled');
  } finally { chrome.downloads.download = original; }
});
test('reconciliation recovers a download whose ID reply was lost', async () => {
  await reset(); const job = await submit(); await prepare(job);
  await send('formatStarted', { jobId: job.id, format: 'markdown' });
  await send('payloadReady', { jobId: job.id, format: 'markdown', blobUrl: 'blob:chrome-extension://test-extension/lost', filename: 'lost.md' });
  delete local['articleExporter:jobs'][0].results.markdown.downloadId;
  native[0].state = 'complete'; await engine.reconcile();
  assert.equal((await send('getJob', { jobId: job.id })).state, 'complete');
  assert.equal((await send('getHistory'))[0].status, 'success');
});
test('uncertain native downloads are never automatically retried', async () => {
  await reset(); const job = await submit(); await prepare(job);
  await send('formatStarted', { jobId: job.id, format: 'markdown' });
  await send('payloadReady', { jobId: job.id, format: 'markdown', blobUrl: 'blob:chrome-extension://test-extension/lost', filename: 'lost.md' });
  native = []; await engine.reconcile();
  assert.equal((await send('getJob', { jobId: job.id })).state, 'uncertain');
  await assert.rejects(send('retry', { jobId: job.id }), /DOWNLOAD_UNCERTAIN/);
});
test('simultaneous legacy history writes preserve both records', async () => {
  await reset(); await Promise.all(['a', 'b'].map(id => send('addRecord', { payload: { id, title: id, url: article.url, formats: ['markdown'], status: 'success', timestamp: 1 } })));
  assert.equal((await send('getHistory')).length, 2);
});
test('manual URL jobs can be recovered by their originating popup page', async () => {
  await reset(); const job = await submit(['markdown'], { url: 'https://example.org/manual' });
  assert.equal(job.identity, undefined);
  assert.equal((await send('view', { tabId: 1 })).job.id, job.id);
  documentId = 'different-document';
  assert.equal((await send('view', { tabId: 1 })).job, undefined);
});
test('canonical metadata cannot change the frozen request or defeat deduplication', async () => {
  await reset(); const job = await submit();
  const operation = session['articleExporter:session'].preparations[0];
  await send('prepared', { operationId: operation.id, article: { ...article, url: 'https://example.org/canonical' } });
  assert.equal((await send('getJob', { jobId: job.id })).url, article.url);
  assert.equal((await submit()).id, job.id);
});
test('popup fallback guards the actual tab URL while supporting X aliases', async () => {
  const bridge = await moduleFrom('src/utils/page-capture.ts');
  const get = chrome.tabs.get, execute = chrome.scripting.executeScript;
  try {
    chrome.tabs.get = async id => ({id,url:'https://x.com/u/status/123'});
    let expected;
    chrome.scripting.executeScript = async request => { expected=request.args[0]; return [{result:{bodyHtml:'ok'}}]; };
    await bridge.capturePage('x',1,'https://twitter.com/u/status/123');
    assert.equal(expected,'https://x.com/u/status/123');
    await assert.rejects(bridge.capturePage('x',1,'https://x.com/u/status/456'),/SOURCE_CHANGED/);
  } finally { chrome.tabs.get=get; chrome.scripting.executeScript=execute; }
});
test('fallback lookup isolates private tabs and prefers the selected normal tab', async () => {
  const bridge = await moduleFrom('src/utils/page-capture.ts'), query = chrome.tabs.query;
  try {
    chrome.tabs.query=async()=>[{id:1,url:article.url,incognito:false},{id:2,url:article.url,incognito:true},{id:3,url:article.url,incognito:false}];
    assert.deepEqual((await bridge.findTabForUrl(article.url,{incognito:true})).map(tab=>tab.id),[2]);
    assert.deepEqual((await bridge.findTabForUrl(article.url,{preferredTabId:3})).map(tab=>tab.id),[3,1]);
  } finally { chrome.tabs.query=query; }
});

test('cancel then retry ignores every report from the old build attempt', async () => {
  await reset(); const job = await submit(['word']); await prepare(job);
  const old = (await send('getJob', {jobId:job.id})).attemptId;
  await send('formatStarted', {jobId:job.id,format:'word'});
  await send('cancel', {jobId:job.id});
  const retry = await send('retry', {jobId:job.id});
  assert.notEqual(retry.attemptId, old);
  for (const type of ['buildFinished','buildFailed','formatFailed']) await send(type, {jobId:job.id,attemptId:old,format:'word',aborted:true,error:'old failure'});
  await assert.rejects(send('formatStarted',{jobId:job.id,attemptId:old,format:'word'}),/STALE_FORMAT/);
  assert.equal((await send('payloadReady',{jobId:job.id,attemptId:old,format:'word',blobUrl:'blob:chrome-extension://test-extension/old',filename:'old.docx'})).success,false);
  assert.equal((await send('getJob',{jobId:job.id})).results.word.state,'queued');
  await send('formatStarted',{jobId:job.id,format:'word'});
  assert.equal((await send('getJob',{jobId:job.id})).results.word.state,'building');
});
test('accepted native download survives a tracking query failure and later completes', async () => {
  await reset(); const job=await submit(); await prepare(job);
  await send('formatStarted',{jobId:job.id,format:'markdown'});
  const original=chrome.downloads.search;
  try {
    chrome.downloads.search=async()=>{throw new Error('temporary API failure');};
    assert.equal((await send('payloadReady',{jobId:job.id,format:'markdown',blobUrl:'blob:chrome-extension://test-extension/tracking',filename:'tracking.md'})).success,true);
    const current=await send('getJob',{jobId:job.id});
    assert.equal(current.results.markdown.downloadId,1);
    assert.equal(current.results.markdown.state,'downloading');
    assert.equal(processor.some(message=>message.type==='release'),false);
  } finally {chrome.downloads.search=original;}
  native[0].state='complete'; await engine.reconcile();
  assert.equal((await send('getJob',{jobId:job.id})).state,'complete');
  assert.equal(native.length,1);
});
test('repeated reconciliation preserves uncertainty while failing only unbuilt formats', async () => {
  await reset(); const job=await submit(['markdown','word']); await prepare(job);
  await send('formatStarted',{jobId:job.id,format:'markdown'});
  await send('payloadReady',{jobId:job.id,format:'markdown',blobUrl:'blob:chrome-extension://test-extension/unknown',filename:'unknown.md'});
  const download=native[0]; native=[];
  await engine.reconcile(); await engine.reconcile();
  const current=await send('getJob',{jobId:job.id});
  assert.equal(current.results.markdown.state,'uncertain');
  assert.equal(current.results.word.state,'error');
  await assert.rejects(send('retry',{jobId:job.id}),/DOWNLOAD_UNCERTAIN/);
  native=[{...download,state:'complete'}]; await engine.reconcile();
  assert.equal((await send('getJob',{jobId:job.id})).results.markdown.state,'complete');
});
test('last private window closure cancels an eventual native ID without retaining article data', async () => {
  await reset(); const job=await submit(['markdown'],{tabId:2,incognito:true}); await prepare(job);
  await send('formatStarted',{jobId:job.id,format:'markdown'});
  const original=chrome.downloads.download; let release;
  chrome.downloads.download=options=>new Promise(resolve=>{release=async()=>resolve(await original(options));});
  try {
    const pending=send('payloadReady',{jobId:job.id,format:'markdown',blobUrl:'blob:chrome-extension://test-extension/private-late',filename:'private.md'});
    while (!release) await new Promise(resolve=>setTimeout(resolve,0));
    await engine.clearPrivateWhenClosed();
    const state=session['articleExporter:session'];
    assert.equal(state.privateJobs.length,0);
    assert.equal(state.cache.length,0);
    assert.equal(state.cancelledDownloads.length,1);
    assert.equal(JSON.stringify(state).includes('https://mp.weixin'),false);
    await release(); assert.equal((await pending).success,true);
    assert.equal(native[0].state,'interrupted');
    assert.equal(session['articleExporter:session'].cancelledDownloads.length,0);
    assert.deepEqual(await send('getHistory'),[]);
  } finally {chrome.downloads.download=original;}
});
test('private native cleanup also runs when the processor document has disappeared', async () => {
  await reset(); const job=await submit(['markdown'],{tabId:2,incognito:true}); await prepare(job);
  await send('formatStarted',{jobId:job.id,format:'markdown'});
  await send('payloadReady',{jobId:job.id,format:'markdown',blobUrl:'blob:chrome-extension://test-extension/private',filename:'private.md'});
  contexts=[]; await engine.clearPrivateWhenClosed();
  assert.equal(native[0].state,'interrupted');
  assert.equal(session['articleExporter:session'].cancelledDownloads.length,0);
});
test('a cancelled native intent cannot be retried before its eventual ID is confirmed', async () => {
  await reset(); const job=await submit(); await prepare(job);
  await send('formatStarted',{jobId:job.id,format:'markdown'});
  const original=chrome.downloads.download; let release;
  chrome.downloads.download=options=>new Promise(resolve=>{release=async()=>resolve(await original(options));});
  try {
    const pending=send('payloadReady',{jobId:job.id,format:'markdown',blobUrl:'blob:chrome-extension://test-extension/pending',filename:'pending.md'});
    while (!release) await new Promise(resolve=>setTimeout(resolve,0));
    await send('cancel',{jobId:job.id});
    await assert.rejects(send('retry',{jobId:job.id}),/DOWNLOAD_UNCERTAIN/);
    await release(); await pending;
    assert.equal((await send('retry',{jobId:job.id})).results.markdown.state,'queued');
  } finally {chrome.downloads.download=original;}
});
test('busy automatic preparation coalesces the latest focused page and resumes only once', async () => {
  await reset();
  const originalGet=chrome.tabs.get, originalQuery=chrome.tabs.query;
  let active=1;
  chrome.tabs.get=async id=>({id,url:`https://mp.weixin.qq.com/s/${id}`,incognito:false});
  chrome.tabs.query=async()=>[await chrome.tabs.get(active)];
  try {
    await engine.prepareActive(); const first=session['articleExporter:session'].preparations[0];
    active=3; await engine.prepareActive(); await engine.prepareActive();
    assert.equal(session['articleExporter:session'].autoPending,true);
    await send('prepared',{operationId:first.id,article}); await engine.cleanIdle();
    assert.equal(session['articleExporter:session'].preparations[0].identity.tabId,3);
    const next=session['articleExporter:session'].preparations[0];
    await send('prepareFailed',{operationId:next.id,error:'expected failure'}); await engine.cleanIdle();
    assert.equal(session['articleExporter:session'].preparations.length,0,'failed automatic extraction must not loop');
    assert.equal(processor.filter(message=>message.type==='prepare').length,2);
  } finally {chrome.tabs.get=originalGet;chrome.tabs.query=originalQuery;}
});
test('canonical sources are separately pinned, partitioned and verified before fresh cache reuse', async () => {
  await reset(); const originalGet=chrome.tabs.get,originalQuery=chrome.tabs.query;
  const wrapper='https://substack.com/home/post/p-1', canonical='https://demo.substack.com/p/full';
  chrome.tabs.get=async id=>({id,url:id===1?wrapper:canonical,incognito:id===2});
  chrome.tabs.query=async()=>[await chrome.tabs.get(1),await chrome.tabs.get(2),await chrome.tabs.get(3)];
  try {
    const job=await submit(['markdown'],{url:wrapper});
    const operation=session['articleExporter:session'].preparations[0];
    const identity=await send('resolveCanonical',{operationId:operation.id,identity:job.identity,url:canonical});
    assert.equal(identity.tabId,3);
    assert.equal(session['articleExporter:session'].preparations[0].dependencies[0].identity.tabId,3);
    await send('capturePage',{operationId:operation.id,identity,stage:'generic'});
    await assert.rejects(send('capturePage',{operationId:operation.id,identity:{...identity,tabId:2,incognito:true},stage:'generic'}),/SOURCE_CHANGED/);
    await prepare(job);
    assert.equal((await send('getJob',{jobId:job.id})).url,wrapper);
    assert.equal((await send('view',{tabId:1,validate:true})).status,'ready');
    const originalScript=chrome.scripting.executeScript;
    try {
      chrome.scripting.executeScript=async options=>options.target.tabId===3?[{documentId,result:{eligible:true,fingerprint:'changed canonical body'}}]:originalScript(options);
      assert.equal((await send('view',{tabId:1,validate:true})).status,'idle');
    } finally {chrome.scripting.executeScript=originalScript;}
  } finally {chrome.tabs.get=originalGet;chrome.tabs.query=originalQuery;}
});

test('private cleanup cancels older-API popup downloads with an ID but no offscreen blob', async () => {
  await reset();
  const downloadId=await chrome.downloads.download({url:'blob:chrome-extension://test-extension/legacy-private',filename:'legacy.txt'});
  await send('legacyDownload',{incognito:true,downloadId,format:'text',record:{id:'legacy-private',url:article.url,title:'private title',timestamp:Date.now(),formats:['text']}});
  contexts=[]; await engine.clearPrivateWhenClosed();
  assert.equal(native[0].state,'interrupted');
  assert.equal(session['articleExporter:session'].privateJobs.length,0);
  assert.equal(session['articleExporter:session'].cancelledDownloads.length,0);
});

test('post-acceptance storage failure preserves a searchable native intent', async () => {
  await reset(); const job=await submit(); await prepare(job);
  await send('formatStarted',{jobId:job.id,format:'markdown'});
  const original=chrome.storage.local.set;
  try {
    chrome.storage.local.set=async values=>{
      if (values['articleExporter:jobs']?.some(job=>job.results.markdown?.downloadId!==undefined)) throw new Error('temporary storage failure');
      return original(values);
    };
    assert.equal((await send('payloadReady',{jobId:job.id,format:'markdown',blobUrl:'blob:chrome-extension://test-extension/store-failure',filename:'store-failure.md'})).success,true);
    const current=await send('getJob',{jobId:job.id});
    assert.equal(current.results.markdown.state,'downloading');
    assert.equal(current.results.markdown.downloadId,undefined);
    assert.equal(processor.some(message=>message.type==='release'),false);
  } finally {chrome.storage.local.set=original;}
  native[0].state='complete'; await engine.reconcile();
  assert.equal((await send('getJob',{jobId:job.id})).state,'complete');
  assert.equal(native.length,1);
});
test('private cancellation tombstones survive worker replacement and find a late ID by blob', async () => {
  await reset(); const job=await submit(['markdown'],{tabId:2,incognito:true}); await prepare(job);
  await send('formatStarted',{jobId:job.id,format:'markdown'});
  await send('payloadReady',{jobId:job.id,format:'markdown',blobUrl:'blob:chrome-extension://test-extension/private-restart',filename:'private-restart.md'});
  delete session['articleExporter:session'].privateJobs[0].results.markdown.downloadId;
  const download=native.pop(); await engine.clearPrivateWhenClosed();
  assert.equal(session['articleExporter:session'].cancelledDownloads.length,1);
  native.push(download);
  const replacement=await moduleFrom('src/background/engine.ts'); await replacement.reconcile();
  assert.equal(native[0].state,'interrupted');
  assert.equal(session['articleExporter:session'].cancelledDownloads.length,0);
  assert.equal(session['articleExporter:session'].privateJobs.length,0);
});
test('canonical SPA invalidation is persisted and rejects the previously pinned source', async () => {
  await reset(); const originalGet=chrome.tabs.get,originalQuery=chrome.tabs.query;
  const wrapper='https://substack.com/home/post/p-2',canonical='https://demo.substack.com/p/spa';
  chrome.tabs.get=async id=>({id,url:id===1?wrapper:canonical,incognito:false});
  chrome.tabs.query=async()=>[await chrome.tabs.get(1),await chrome.tabs.get(3)];
  try {
    const job=await submit(['markdown'],{url:wrapper});
    const operation=session['articleExporter:session'].preparations[0];
    const identity=await send('resolveCanonical',{operationId:operation.id,identity:job.identity,url:canonical});
    await engine.invalidate(3);
    assert.ok(session['articleExporter:session'].revisions[3]>identity.revision);
    const replacement=await moduleFrom('src/background/engine.ts');
    await assert.rejects(replacement.handle({type:'capturePage',operationId:operation.id,identity,stage:'generic'}),/SOURCE_CHANGED/);
  } finally {chrome.tabs.get=originalGet;chrome.tabs.query=originalQuery;}
});

test('unresolved native ownership survives pruning of old completed job metadata', async () => {
  await reset(); const job=await submit(); await prepare(job);
  await send('formatStarted',{jobId:job.id,format:'markdown'});
  await send('payloadReady',{jobId:job.id,format:'markdown',blobUrl:'blob:chrome-extension://test-extension/prune',filename:'prune.md'});
  native=[]; await engine.reconcile();
  const template=await send('getJob',{jobId:job.id});
  for(let index=0;index<21;index++) local['articleExporter:jobs'].push({...clone(template),id:`complete-${index}`,requestId:`complete-${index}`,state:'complete',createdAt:Date.now()+index,results:{markdown:{state:'complete'}}});
  await submit(['text']);
  assert.equal((await send('getJob',{jobId:job.id})).results.markdown.state,'uncertain');
  await assert.rejects(send('retry',{jobId:job.id}),/DOWNLOAD_UNCERTAIN/);
});
test('canonical HTTP fallback remains allowed but cannot advertise an unverifiable fresh cache', async () => {
  await reset(); const originalGet=chrome.tabs.get,originalQuery=chrome.tabs.query;
  const wrapper='https://substack.com/home/post/p-http',canonical='https://example.org/canonical';
  chrome.tabs.get=async id=>({id,url:wrapper,incognito:false});
  chrome.tabs.query=async()=>[await chrome.tabs.get(1)];
  try {
    const job=await submit(['markdown'],{url:wrapper});
    const operation=session['articleExporter:session'].preparations[0];
    assert.equal(await send('resolveCanonical',{operationId:operation.id,identity:job.identity,url:canonical}),undefined);
    assert.deepEqual(await send('findTab',{operationId:operation.id,url:canonical}),[]);
    await prepare(job);
    assert.equal((await send('view',{tabId:1,validate:true})).status,'idle');
    assert.ok((await send('getJob',{jobId:job.id})).articleKey,'captured snapshot remains available to retry failed formats');
  } finally {chrome.tabs.get=originalGet;chrome.tabs.query=originalQuery;}
});

test('a cached export continues with its full snapshot when cache pinning exceeds session quota', async () => {
  await reset(); const first=await submit(); await prepare(first);
  await send('formatStarted',{jobId:first.id,format:'markdown'});
  await send('payloadReady',{jobId:first.id,format:'markdown',blobUrl:'blob:chrome-extension://test-extension/cache-first',filename:'first.md'});
  native[0].state='complete'; await engine.downloadChanged(1);
  rejectPins=true;
  const second=await submit(['text']);
  assert.equal(second.state,'building');
  assert.equal(second.articleKey,undefined);
  assert.equal(session['articleExporter:session'].cache.length,0);
  assert.equal(processor.at(-1).article.contentHtml,article.contentHtml);
});
