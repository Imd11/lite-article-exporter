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

let engine, local = {}, session = {}, processor = [], native = [], contexts = [], documentId = 'doc-1', rejectCache = false;
const clone = value => structuredClone(value);
const storage = kind => ({
  get: async keys => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, clone((kind === 'local' ? local : session)[key])])),
  set: async values => {
    if (kind === 'session' && rejectCache && values['articleExporter:session']?.cache.length) throw new Error('QUOTA_BYTES');
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
const send = (type, data = {}) => engine.handle({ type, ...data });
async function reset() { local = {}; session = {}; processor = []; native = []; contexts = []; documentId = 'doc-1'; rejectCache = false; }
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
