import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import JSZip from 'jszip';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const profile = await mkdtemp(path.join(tmpdir(), 'article-exporter-test-'));
const downloads = await mkdtemp(path.join(tmpdir(), 'article-exporter-downloads-'));
const extension = path.resolve('dist');
await mkdir(path.join(profile, 'Default'));
await writeFile(path.join(profile, 'Default', 'Preferences'), JSON.stringify({ download: { default_directory: downloads, prompt_for_download: false }, extensions: { ui: { developer_mode: true } } }));
const context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, ignoreDefaultArgs: ['--disable-extensions'], downloadsPath: downloads, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--remote-debugging-port=0'] });
console.log('Browser started', context.pages().length, context.serviceWorkers().length);
const errors = [], requests = [];
context.on('page', page => { page.on('pageerror', error => errors.push(error.message)); });
context.on('request', request => requests.push(request.url()));
const paragraph = '这是一篇用于验证导出功能的文章。它包含足够长的正文，检查后台预提取、文件下载和中文内容是否正常。'.repeat(12);
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>回归文章</title><meta property="og:type" content="article"></head><body><h1 id="activity-name">回归文章</h1><div id="js_content" class="rich_media_content"><p>${paragraph}</p><p>Second paragraph with <strong>bold text</strong> and a <a href="https://example.org">link</a>.</p><img data-src="https://mmbiz.qpic.cn/original.png" alt="原始图片"></div></body></html>`;
function imageFixture() {
  const chunk = (type, data) => {
    const payload = Buffer.concat([Buffer.from(type), data]);
    let crc = -1;
    for (const byte of payload) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
    const size = Buffer.alloc(4), checksum = Buffer.alloc(4);
    size.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ -1) >>> 0);
    return Buffer.concat([size, payload, checksum]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(32, 0); header.writeUInt32BE(24, 4); header[8] = 8; header[9] = 6;
  const row = Buffer.alloc(129); for (let index=1; index<row.length; index+=4) row.set([190,130,70,255],index);
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.concat(Array.from({length:24},()=>row)))), chunk('IEND', Buffer.alloc(0))]);
}
const png = imageFixture();
let releaseCancellationImage;
const cancellationImageGate=new Promise(resolve=>{releaseCancellationImage=resolve;});
// Offscreen documents are OTHER CDP targets, so Playwright's page routing does
// not intercept their fetches. Intercept those targets before their scripts run.
const [debugPort, debugPath] = (await readFile(path.join(profile,'DevToolsActivePort'),'utf8')).trim().split('\n');
const socket = new WebSocket(`ws://127.0.0.1:${debugPort}${debugPath}`);
await new Promise((resolve,reject) => { socket.onopen=resolve; socket.onerror=reject; });
const pending = new Map(), otherTargets = new Map(); let sequence = 0;
function targetCommand(sessionId, method, params = {}) {
  const commandId = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(commandId); reject(new Error(`CDP timeout: ${method}`)); }, 10000);
    pending.set(commandId, {resolve, reject, timer});
    socket.send(JSON.stringify({id:commandId, method, params, ...(sessionId ? {sessionId} : {})}));
  });
}
socket.onmessage = event => {
  const message = JSON.parse(event.data);
  if (message.id !== undefined) {
    const handler = pending.get(message.id);
    if (handler) { clearTimeout(handler.timer); pending.delete(message.id); message.error ? handler.reject(new Error(message.error.message)) : handler.resolve(message.result); }
  } else if (message.method === 'Network.requestWillBeSent') requests.push(message.params.request.url);
  else if (message.method === 'Fetch.requestPaused') {
    const {requestId, request} = message.params;
    const url = new URL(request.url);
    void (async () => {
      let contentType, body;
      if (url.hostname === 'images.weserv.nl' || url.hostname === 'mmbiz.qpic.cn') { if(request.url.includes('cancel-retry.png')) await cancellationImageGate; contentType='image/png'; body=png; }
      else if (url.hostname === 'mp.weixin.qq.com' && url.pathname === '/s/private-close') {contentType='text/html;charset=utf-8';body=Buffer.from(html.replaceAll('回归文章','PRIVATE_ONLY_TITLE'));}
      else if (url.hostname === 'example.org') {
        if (url.pathname === '/slow-export') await new Promise(resolve => setTimeout(resolve,1500));
        contentType='text/html;charset=utf-8'; body=Buffer.from(html);
      } else { await targetCommand(message.sessionId, 'Fetch.failRequest', {requestId,errorReason:'BlockedByClient'}); return; }
      await targetCommand(message.sessionId, 'Fetch.fulfillRequest', {requestId,responseCode:200,responseHeaders:[{name:'content-type',value:contentType},{name:'access-control-allow-origin',value:'*'}],body:body.toString('base64')});
    })().catch(error => { if (!/Invalid InterceptionId|Session with given id not found|Target closed/i.test(error.message)) errors.push(error.message); });
  } else if (message.method === 'Target.attachedToTarget') {
    otherTargets.set(message.params.targetInfo.targetId, {sessionId:message.params.sessionId, ...message.params.targetInfo});
    void (async () => {
      await targetCommand(message.params.sessionId, 'Network.enable');
      await targetCommand(message.params.sessionId, 'Fetch.enable', {patterns:[{urlPattern:'http*',requestStage:'Request'}]});
      await targetCommand(message.params.sessionId, 'Runtime.runIfWaitingForDebugger');
    })().catch(error => errors.push(error.message));
  }
};
await targetCommand(undefined, 'Target.setAutoAttach', {autoAttach:true,waitForDebuggerOnStart:true,flatten:true,filter:[{type:'other'}, {exclude:true}]});
await context.route('https://**/*', route => route.abort());
await context.route('https://mp.weixin.qq.com/**', route => route.fulfill({ contentType: 'text/html', body: html }));
await context.route('https://mmbiz.qpic.cn/**', route => route.fulfill({ contentType: 'image/png', body: png }));
await context.route('https://images.weserv.nl/**', route => route.fulfill({ contentType: 'image/png', body: png }));
await context.route('https://example.org/**', route => route.fulfill({ contentType: 'text/html', body: html.replaceAll('js_content', 'article-body') }));
let worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: 15000 });
const id = new URL(worker.url()).host;
const source = context.pages()[0];
const state = () => worker.evaluate(async () => (await chrome.storage.session.get('articleExporter:session'))['articleExporter:session']);
const wait = async (fn, description, timeout = 60000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await fn(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 100)); }
  console.log('DIAGNOSTICS', await worker.evaluate(async () => ({ session: await chrome.storage.session.get(null), jobs: await chrome.storage.local.get('articleExporter:jobs'), window: await chrome.windows.getLastFocused(), tabs: await chrome.tabs.query({}), contexts: await chrome.runtime.getContexts({}) })));
  throw new Error(`Timed out: ${description}`);
};
let popup, sourceTabId;
async function openPopup() {
  const tab = { id: sourceTabId, url: source.url(), incognito: false };
  popup = await context.newPage();
  // Chromium exposes toolbar popups as OTHER CDP targets. Use the same extension HTML
  // in a disposable tab, supplying the source tab solely for its active-tab lookup.
  await popup.addInitScript(tab => {
    const query = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = options => options.active && options.currentWindow ? Promise.resolve([tab]) : query(options);
  }, tab);
  await popup.goto(`chrome-extension://${id}/popup/index.html`);
  await popup.waitForSelector('#url-input');
  return popup;
}
const send = (type, data = {}) => popup.evaluate(message => chrome.runtime.sendMessage({ target: 'background', ...message }), { type, ...data });
const getJob = jobId => worker.evaluate(async id => (await chrome.storage.local.get('articleExporter:jobs'))['articleExporter:jobs']?.find(job => job.id === id), jobId);
try {
  await source.goto('https://mp.weixin.qq.com/s/test');
  await source.bringToFront();
  await wait(async () => (await state())?.cache?.length, 'automatic preparation before opening popup');
  assert.equal(requests.some(url => url.includes('/assets/fonts/') || url.includes('/exporters.js') || url.includes('mmbiz.qpic.cn')), false, 'automatic preparation must not fetch export assets/images');
  const cached = (await state()).cache[0];
  console.log('Prepared fixture bytes:', Buffer.byteLength(JSON.stringify(cached.article)));
  sourceTabId = cached.identity.tabId;
  assert.equal(new URL(cached.article.images[0].url).searchParams.get('url'), 'https://mmbiz.qpic.cn/original.png');
  console.log('PASS automatic article preparation; raw WeChat images; no image/font/export requests');
  await openPopup();
  await wait(() => popup.locator('#export-button').isEnabled(), 'popup initialized');
  if (process.env.ARTICLE_EXPORTER_SCREENSHOT) await popup.screenshot({path: process.env.ARTICLE_EXPORTER_SCREENSHOT, animations:'disabled'});
  const view = await send('view', { tabId: cached.identity.tabId, validate: true });
  assert.equal(view.success, true); assert.equal(view.data.status, 'ready');
  await popup.locator('#url-input').fill('https://example.org/new');
  assert.equal(await popup.locator('#export-button').isEnabled(), true);
  assert.equal((await popup.locator('#status').innerText()).includes('Extracted'), false);
  console.log('PASS edited URL remains downloadable with accurate status');
  const submission = { tabId: cached.identity.tabId, url: cached.identity.url, formats: ['markdown', 'text', 'word', 'pdf'], incognito: false, requestId: crypto.randomUUID() };
  const [first, duplicate] = await Promise.all([send('submit', submission), send('submit', submission)]);
  assert.equal(first.success, true, JSON.stringify(first)); assert.equal(duplicate.data.id, first.data.id);
  const jobId = first.data.id;
  await popup.close();
  const job = await wait(async () => { const job = await getJob(jobId); return job && ['complete', 'partial', 'error'].includes(job.state) && job; }, 'all format downloads', 180000);
  assert.equal(job.state, 'complete', JSON.stringify(job));
  const native = await worker.evaluate(async () => chrome.downloads.search({}));
  assert.equal(native.filter(item => item.state === 'complete').length, 4);
  assert.equal(Object.values(job.results).every(result => result.state === 'complete'), true);
  assert.equal(Object.values(job.results).some(result => result.warnings?.length), false, 'fixture images must embed without warnings');
  const records = await worker.evaluate(async () => (await chrome.storage.local.get('downloadHistory')).downloadHistory);
  assert.equal(records[0].status, 'success'); assert.equal(records[0].verified, true);
  console.log('PASS duplicate submit; popup closes; Markdown/TXT/Word/PDF finish; verified history');
  for (const download of native) {
    assert.equal(download.filename.startsWith(downloads + path.sep), true, download.filename);
    const bytes = await readFile(download.filename);
    if (/\.(md|txt)$/.test(download.filename)) assert.match(bytes.toString('utf8'), /用于验证导出功能/);
    if (download.filename.endsWith('.docx')) {
      const zip = await JSZip.loadAsync(bytes);
      assert.match(await zip.file('word/document.xml').async('string'), /用于验证导出功能/);
      assert.equal(Object.values(zip.files).some(file => !file.dir && file.name.startsWith('word/media/')), true);
    }
    if (download.filename.endsWith('.pdf')) {
      const document = await getDocument({data: new Uint8Array(bytes), useSystemFonts:false}).promise;
      const content = await (await document.getPage(1)).getTextContent();
      assert.match(content.items.map(item => item.str).join(''), /用于验证导出功能/);
      await document.destroy();
    }
  }
  console.log('PASS downloaded files contain Chinese text; Word contains an embedded image');
  await source.bringToFront(); await openPopup();
  await wait(async () => (await popup.locator('#status').innerText()).includes('complete'), 'completed job displayed on reopening');
  console.log('PASS reopened popup UI displays completed job');
  await source.evaluate(() => { const image=document.querySelector('#js_content img'); image.setAttribute('src','https://mmbiz.qpic.cn/lazy-loaded.png'); image.setAttribute('style','width:300px;height:200px'); image.setAttribute('class','lazyloaded'); });
  assert.equal((await send('view', {tabId:sourceTabId,validate:true})).data.status, 'ready', 'lazy image loading must preserve a valid article snapshot');
  console.log('PASS lazy image display changes preserve ready cache');
  await source.evaluate(() => { document.querySelector('#js_content a').setAttribute('href', 'https://example.org/changed-link'); });
  assert.equal((await send('view', { tabId: cached.identity.tabId, validate: true })).data.status, 'idle', 'link-only edits invalidate cache');
  console.log('PASS content fingerprint catches link edits without text changes');
  const pageHtml = (title, body, extra = '') => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><meta property="og:type" content="article"></head><body><main>${body}</main>${extra}</body></html>`;
  const fixtures = [
    { name: 'ChatGPT', url: 'https://chatgpt.com/c/test', marker: 'CHAT_BODY', body: `<div data-message-author-role="user"><div class="markdown"><p>请解释一下这个问题应该如何解决？</p></div></div><div data-message-author-role="assistant"><div class="markdown"><p>CHAT_BODY ${paragraph}</p><pre><code>const value = 42;</code></pre></div></div>` },
    { name: 'Gemini', url: 'https://gemini.google.com/app/test', marker: 'GEMINI_BODY', body: `<section><h2>You said</h2><div>请解释这个问题的解决方式，并保留完整的文章内容。</div></section><section><h2>Gemini said</h2><div><p>GEMINI_BODY ${paragraph}</p></div></section>` },
    { name: 'Grok', url: 'https://grok.com/c/test', marker: 'GROK_BODY', body: `<div style="width:50%;margin-left:auto">请帮我解释一下这个问题，给出详细的答案？</div><div style="width:80%"><p>GROK_BODY ${paragraph}</p><p>Answer with a second structured paragraph.</p></div>` },
    { name: 'X', url: 'https://x.com/i/article/123', marker: 'X_ARTICLE_BODY', body: `<article data-testid="article-body"><h1>X Article</h1><p>X_ARTICLE_BODY ${paragraph}</p><p>Additional article content.</p></article>` },
    { name: 'Medium', url: 'https://medium.com/@test/article', marker: 'MEDIUM_BODY', body: `<article><h1>Medium Article</h1><p>MEDIUM_BODY ${paragraph}</p><p>${paragraph}</p><p>${paragraph}</p></article>` },
    { name: 'Telegraph', url: 'https://www.telegraph.co.uk/news/test/', marker: 'TELEGRAPH_BODY', body: `<article><h1>Telegraph Article</h1><div itemprop="articleBody"><p>TELEGRAPH_BODY ${paragraph}</p><p>${paragraph}</p><p>${paragraph}</p></div></article>`, extra: `<script type="application/ld+json">${JSON.stringify({'@type':'NewsArticle',headline:'Telegraph Article',articleBody:`TELEGRAPH_BODY ${paragraph}\n\n${paragraph}\n\n${paragraph}`})}</script>` },
    { name: 'Substack MAIN', url: 'https://substack.com/home/post/p-42', marker: 'MAIN_WORLD_BODY', body: `<article class="body markup"><p>${paragraph}</p></article>`, extra: `<script>window._preloads=${JSON.stringify({post:{id:42,title:'Substack runtime article',canonical_url:'https://demo.substack.com/p/test',body_html:`<p>MAIN_WORLD_BODY ${paragraph}</p><p>${paragraph}</p><p>${paragraph}</p>`}})};</script>` },
    { name: 'Generic', url: 'https://example.org/generic', marker: 'GENERIC_BODY', body: `<article><h1>Generic Article</h1><p>GENERIC_BODY ${paragraph}</p><ul><li>First item</li><li>Second item</li></ul></article>` }
  ];
  await send('setAuto', { enabled: false });
  for (const fixture of fixtures) {
    await context.route(fixture.url, route => route.fulfill({ contentType: 'text/html', body: pageHtml(fixture.name, fixture.body, fixture.extra) }));
    const page = await context.newPage(); await page.goto(fixture.url);
    const fixtureTabId = await worker.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url).id, fixture.url);
    const submitted = await send('submit', { requestId: crypto.randomUUID(), tabId: fixtureTabId, url: fixture.url, formats: ['markdown'], incognito: false });
    assert.equal(submitted.success, true, JSON.stringify(submitted));
    const result = await wait(async () => { const job = await getJob(submitted.data.id); return ['complete','error','partial'].includes(job?.state) && job; }, fixture.name);
    assert.equal(result.state, 'complete', JSON.stringify(result));
    assert.match((await readFile(result.results.markdown.filename, 'utf8')).replaceAll('\\_', '_'), new RegExp(fixture.marker));
    if (fixture.name === 'ChatGPT') {
      await page.evaluate(() => { const turn = document.createElement('div'); turn.dataset.messageAuthorRole = 'assistant'; turn.innerHTML = '<div class="markdown"><p>NEW_STREAMED_RESPONSE 这是追加的新消息。</p></div>'; document.querySelector('main').appendChild(turn); });
      const second = await send('submit', { requestId: crypto.randomUUID(), tabId: fixtureTabId, url: fixture.url, formats: ['markdown'], incognito: false });
      const updated = await wait(async () => { const job = await getJob(second.data.id); return ['complete','error'].includes(job?.state) && job; }, 'fresh conversation');
      assert.equal(updated.state, 'complete');
      assert.match((await readFile(updated.results.markdown.filename, 'utf8')).replaceAll('\\_', '_'), /NEW_STREAMED_RESPONSE/);
    }
    if (fixture.name === 'Telegraph') {
      await page.evaluate(() => { const script=document.querySelector('script[type="application/ld+json"]'); const data=JSON.parse(script.textContent); data.articleBody+='\n\nNEW_STRUCTURED_BODY'; script.textContent=JSON.stringify(data); });
      assert.equal((await send('view',{tabId:fixtureTabId,validate:true})).data.status,'idle');
      const second=await send('submit',{requestId:crypto.randomUUID(),tabId:fixtureTabId,url:fixture.url,formats:['markdown'],incognito:false});
      const updated=await wait(async()=>{const job=await getJob(second.data.id);return ['complete','error'].includes(job?.state)&&job;},'fresh structured article');
      assert.equal(updated.state,'complete');
      assert.match((await readFile(updated.results.markdown.filename,'utf8')).replaceAll('\\_','_'),/NEW_STRUCTURED_BODY/);
    }
    await page.close(); console.log(`PASS existing ${fixture.name} adapter${fixture.name === 'ChatGPT' ? ' and fresh conversation messages' : ''}`);
  }
  // No open tab: static HTTP extraction remains available, while dynamic sites explain the requirement.
  const http = await send('submit', { requestId: crypto.randomUUID(), url: 'https://example.org/http-only', formats: ['text'], incognito: false });
  const httpJob = await wait(async () => { const job = await getJob(http.data.id); return ['complete','error'].includes(job?.state) && job; }, 'HTTP fallback');
  assert.equal(httpJob.state, 'complete', JSON.stringify(httpJob));
  const missing = await send('submit', { requestId: crypto.randomUUID(), url: 'https://medium.com/@test/missing', formats: ['markdown'], incognito: false });
  const missingJob = await wait(async () => { const job = await getJob(missing.data.id); return job?.state === 'error' && job; }, 'dynamic page requirement');
  assert.match(missingJob.error, /OPEN_PAGE_REQUIRED/);
  console.log('PASS HTTP fallback and missing dynamic-page error');

  // The source changes during capture: the accepted task must fail instead of exporting the replacement.
  const changing = await send('submit', { requestId: crypto.randomUUID(), tabId: sourceTabId, url: source.url(), formats: ['markdown'], incognito: false });
  await source.goto('https://mp.weixin.qq.com/s/replacement');
  const changed = await wait(async () => { const job = await getJob(changing.data.id); return job?.state === 'error' && job; }, 'source document guard');
  assert.match(changed.error, /SOURCE_CHANGED/);
  await source.goto('https://mp.weixin.qq.com/s/test');
  console.log('PASS navigation during capture rejects the replacement document');

  // Hold HTTP extraction open while forcibly stopping the service worker.
  await context.route('https://example.org/slow-export', async route => { await new Promise(resolve => setTimeout(resolve, 1500)); await route.fulfill({contentType:'text/html', body: html}).catch(() => undefined); });
  const cdp = await context.newCDPSession(source);
  let versions = [];
  cdp.on('ServiceWorker.workerVersionUpdated', event => { versions = event.versions; });
  await cdp.send('ServiceWorker.enable');
  const version = await wait(() => Promise.resolve(versions.find(item => item.scriptURL === worker.url() && item.status === 'activated' && item.runningStatus === 'running')), 'service worker version');
  const asleep = await send('submit', { requestId: crypto.randomUUID(), tabId: sourceTabId, url: 'https://example.org/slow-export', formats: ['text'], incognito: false });
  assert.equal(asleep.success, true);
  const oldWorker = worker;
  await worker.evaluate(() => { globalThis.__testWorkerMarker = 'before-restart'; });
  await popup.close(); await cdp.send('ServiceWorker.stopWorker', {versionId: version.versionId});
  await new Promise(resolve => setTimeout(resolve,1800));
  worker = context.serviceWorkers().find(item => item.url() === oldWorker.url()) ?? oldWorker;
  assert.equal(await worker.evaluate(() => globalThis.__testWorkerMarker), undefined, 'service worker globals must have been reset');
  const resumed = await wait(async () => { const job = await getJob(asleep.data.id); return ['complete','error'].includes(job?.state) && job; }, 'continued job after worker restart');
  assert.equal(resumed.state, 'complete', JSON.stringify(resumed));
  await openPopup();
  await wait(async () => (await popup.locator('#status').innerText()).includes('complete'), 'manual URL task restored');
  assert.equal(await popup.locator('#url-input').inputValue(), 'https://example.org/slow-export');
  await cdp.detach();
  console.log('PASS worker restart and closed panel; manual URL task restored with its frozen URL');

  const beforeCancel = (await worker.evaluate(() => chrome.downloads.search({}))).length;
  const cancelling = await send('submit', { requestId: crypto.randomUUID(), tabId: sourceTabId, url: 'https://example.org/slow-export', formats: ['text'], incognito: false });
  await send('cancel', {jobId: cancelling.data.id});
  assert.equal((await getJob(cancelling.data.id)).state, 'cancelled');
  await new Promise(resolve => setTimeout(resolve, 1800));
  assert.equal((await worker.evaluate(() => chrome.downloads.search({}))).length, beforeCancel);
  console.log('PASS cancelled preparation creates no late download');
  // Simulate an older browser lacking getContexts and exercise the repaired popup fallback.
  await popup.locator('input[name="formats"][value="word"]').check();
  await popup.close();
  await worker.evaluate(() => { globalThis.__getContexts = chrome.runtime.getContexts; chrome.runtime.getContexts = undefined; });
  await openPopup();
  await wait(async () => (await popup.locator('#status').innerText()).includes('Keep this panel open'), 'fallback disclosure');
  assert.equal(await popup.locator('input[name="formats"][value="word"]').isChecked(), true);
  await popup.locator('#export-button').click();
  await wait(async () => (await popup.locator('#status').innerText()).includes('Export complete'), 'fallback real export', 60000);
  assert.equal((await popup.locator('#history-list').innerText()).includes('In progress'), false);
  await worker.evaluate(() => { chrome.runtime.getContexts = globalThis.__getContexts; });
  console.log('PASS unavailable-API fallback; remembered formats; accurate completed history');
  const historyPage = context.waitForEvent('page');
  await popup.locator('#version-history-link').click();
  const changelog = await historyPage; await changelog.waitForLoadState();
  assert.match(await changelog.locator('body').innerText(), /v1\.1\.0/);
  await changelog.close();
  await popup.locator('#history-search').fill('回归');
  assert.equal(await popup.locator('.history-item').count() > 0, true);
  popup.once('dialog', dialog => dialog.accept());
  await popup.locator('#history-clear').click();
  await wait(async () => (await worker.evaluate(async () => (await chrome.storage.local.get('downloadHistory')).downloadHistory)).length === 0, 'clear history');
  console.log('PASS changelog, history search and clear');
  const largeUrl = 'https://mp.weixin.qq.com/s/large';
  const largeHtml = `<!doctype html><html><head><meta charset="utf-8"><title>Large article</title></head><body><h1 id="activity-name">Large article</h1><div id="js_content"><p>LARGE_BEGIN ${paragraph.repeat(1000)} LARGE_END</p></div></body></html>`;
  await context.route(largeUrl, route => route.fulfill({contentType:'text/html;charset=utf-8',body:largeHtml}));
  const largePage=await context.newPage(); await largePage.goto(largeUrl);
  const largeTabId=await worker.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url===url).id, largeUrl);
  const large=await send('submit',{requestId:crypto.randomUUID(),tabId:largeTabId,url:largeUrl,formats:['markdown'],incognito:false});
  const largeJob=await wait(async()=>{const job=await getJob(large.data.id); return ['complete','error'].includes(job?.state)&&job;},'large uncached article');
  assert.equal(largeJob.state,'complete',JSON.stringify(largeJob));
  assert.equal(largeJob.articleKey,undefined);
  const largeOutput=await readFile(largeJob.results.markdown.filename,'utf8');
  assert.equal((largeOutput.match(/用于验证导出功能/g)??[]).length,12000);
  assert.match(largeOutput.replaceAll('\\_','_'),/LARGE_END/);
  await largePage.close();
  console.log('PASS large snapshot bypasses cache without truncation:',Buffer.byteLength(largeOutput),'downloaded bytes');
  // Exercise the actual toolbar popup, including its unmodified active-tab lookup.
  await popup.close(); await source.bringToFront();
  await worker.evaluate(()=>chrome.storage.local.set({'articleExporter:jobs':[]}));
  const toolbarStart=Date.now();
  await worker.evaluate(async()=>{await chrome.action.openPopup();});
  const toolbarTarget=await wait(async()=>(await targetCommand(undefined,'Target.getTargets')).targetInfos.find(target=>target.url===`chrome-extension://${id}/popup/index.html`),'native toolbar target');
  const toolbar={...toolbarTarget, sessionId:otherTargets.get(toolbarTarget.targetId)?.sessionId ?? (await targetCommand(undefined,'Target.attachToTarget',{targetId:toolbarTarget.targetId,flatten:true})).sessionId};
  const toolbarEval=async expression=>{
    const result=await targetCommand(toolbar.sessionId,'Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
    if(result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  await wait(()=>toolbarEval('!!document.querySelector("#url-input")?.value'),'native toolbar initialized');
  assert.equal(await toolbarEval('document.querySelector("#url-input").value'),source.url());
  await toolbarEval(`document.querySelectorAll('input[name="formats"]').forEach(input=>{input.checked=input.value==='text';input.dispatchEvent(new Event('change',{bubbles:true}));});document.querySelector('#export-button').click();`);
  const toolbarJob=await wait(async()=>worker.evaluate(async since=>(await chrome.storage.local.get('articleExporter:jobs'))['articleExporter:jobs'].find(job=>job.createdAt>=since),toolbarStart),'native toolbar accepted task');
  await targetCommand(undefined,'Target.closeTarget',{targetId:toolbar.targetId});
  const toolbarDone=await wait(async()=>{const job=await getJob(toolbarJob.id);return ['complete','error'].includes(job?.state)&&job;},'native toolbar closed during export');
  assert.equal(toolbarDone.state,'complete',JSON.stringify(toolbarDone));
  assert.equal(toolbarDone.url,source.url());
  assert.match(await readFile(toolbarDone.results.text.filename,'utf8'),/用于验证导出功能/);
  console.log('PASS real toolbar popup active-page lookup and export after closing it');
  await openPopup();
  await send('setAuto',{enabled:false});
  {
  const p='SUBSTACK_ARTICLE_TEXT 这是正文内容，需要足够长来验证导出是否完整。'.repeat(35);
  const wrapper='https://substack.com/home/post/p-991';
  const bodyHtml='<p>RUNTIME_ORIGINAL '+p+'</p><p>'+p+'</p><p>'+p+'</p>';
  await context.route(wrapper,route=>route.fulfill({contentType:'text/html;charset=utf-8',body:'<!doctype html><html><head><meta charset="utf-8"><title>Runtime Review</title></head><body><article class="body markup"><p>'+p+'</p></article><script>window._preloads='+JSON.stringify({post:{id:991,title:'Runtime Review',canonical_url:'https://demo.substack.com/p/review',body_html:bodyHtml}})+';</script></body></html>'}));
  const runtimePage=await context.newPage();await runtimePage.goto(wrapper);
  const runtimeTabId=await worker.evaluate(async url=>(await chrome.tabs.query({})).find(t=>t.url===url).id,wrapper);
  const first=await send('submit',{requestId:crypto.randomUUID(),tabId:runtimeTabId,url:wrapper,formats:['markdown']});
  const firstJob=await wait(async()=>{const j=await getJob(first.data.id);return ['complete','error'].includes(j?.state)&&j;},'first runtime');
  assert.equal(firstJob.state,'complete',JSON.stringify(firstJob));assert.ok(firstJob.articleKey);
  await runtimePage.evaluate(()=>window._preloads.post.body_html+='<p>NEW_RUNTIME_CONTENT_AFTER_CACHE</p>');
  const second=await send('submit',{requestId:crypto.randomUUID(),tabId:runtimeTabId,url:wrapper,formats:['markdown']});
  const secondJob=await wait(async()=>{const j=await getJob(second.data.id);return ['complete','error'].includes(j?.state)&&j;},'second runtime');
  assert.equal(secondJob.state,'complete');
  const secondFile=(await readFile(secondJob.results.markdown.filename,'utf8')).replaceAll('\\_','_');
  assert.equal(secondFile.includes('NEW_RUNTIME_CONTENT_AFTER_CACHE'),true);
  console.log('PASS runtime-only Substack changes invalidate the cached body');
  await runtimePage.close();

  const canonical='https://demo.substack.com/p/canonical-review', wrapper2='https://substack.com/home/post/p-992';
  await context.route(canonical,route=>route.fulfill({contentType:'text/html;charset=utf-8',body:'<!doctype html><html><head><meta charset="utf-8"><title>Full Canonical</title></head><body><article class="body markup"><p>FULL_CANONICAL_ARTICLE '+p+'</p><p>'+p+'</p><p>'+p+'</p></article></body></html>'}));
  await context.route(wrapper2,route=>route.fulfill({contentType:'text/html;charset=utf-8',body:'<!doctype html><html><head><meta charset="utf-8"><title>Preview Wrapper</title><link rel="canonical" href="'+canonical+'"></head><body><article><p>WRAPPER_PREVIEW '+p+'</p><p>'+p+'</p><p>'+p+'</p></article></body></html>'}));
  const canonicalPage=await context.newPage();await canonicalPage.goto(canonical);
  const wrapperPage=await context.newPage();await wrapperPage.goto(wrapper2);
  const wrapperTabId=await worker.evaluate(async url=>(await chrome.tabs.query({})).find(t=>t.url===url).id,wrapper2);
  const current=await send('submit',{requestId:crypto.randomUUID(),tabId:wrapperTabId,url:wrapper2,formats:['markdown']});
  const currentJob=await wait(async()=>{const j=await getJob(current.data.id);return ['complete','error'].includes(j?.state)&&j;},'canonical fallback');
  assert.equal(currentJob.state,'complete',JSON.stringify(currentJob));
  const currentFile=(await readFile(currentJob.results.markdown.filename,'utf8')).replaceAll('\\_','_');
  assert.ok(currentFile.includes('FULL_CANONICAL_ARTICLE')); assert.equal(currentFile.includes('WRAPPER_PREVIEW'),false);
  assert.equal(currentJob.url,wrapper2);
  await canonicalPage.evaluate(()=>document.querySelector('article').insertAdjacentHTML('beforeend','<p>NEW_CANONICAL_CONTENT</p>'));
  const freshCanonical=await send('submit',{requestId:crypto.randomUUID(),tabId:wrapperTabId,url:wrapper2,formats:['markdown']});
  const freshCanonicalJob=await wait(async()=>{const j=await getJob(freshCanonical.data.id);return ['complete','error'].includes(j?.state)&&j;},'fresh canonical document');
  assert.equal(freshCanonicalJob.state,'complete',JSON.stringify(freshCanonicalJob));
  assert.match((await readFile(freshCanonicalJob.results.markdown.filename,'utf8')).replaceAll('\\_','_'),/NEW_CANONICAL_CONTENT/);
  console.log('PASS canonical full body, frozen request URL and fresh canonical content');
  await canonicalPage.close();await wrapperPage.close();

  await source.goto('about:blank');await source.bringToFront();
  await send('setAuto',{enabled:true});
  const a='https://mp.weixin.qq.com/s/auto-A',b='https://mp.weixin.qq.com/s/auto-B';
  await context.route(a,async route=>{if(route.request().resourceType()==='fetch')await new Promise(r=>setTimeout(r,3000));await route.fulfill({contentType:'text/html;charset=utf-8',body:html});});
  const pageA=await context.newPage();await pageA.goto(a);await pageA.bringToFront();
  await wait(async()=>(await state()).preparations.some(op=>op.url===a),'A preparing');
  const existingPages=new Set(context.pages());
  const secondWindow=await worker.evaluate(()=>chrome.windows.create({url:'about:blank',focused:true}));
  const pageB=await wait(async()=>context.pages().find(page=>!existingPages.has(page)),'second window page');
  await pageB.goto(b);
  await worker.evaluate(async windowId=>chrome.windows.update(windowId,{focused:true}),secondWindow.id);
  assert.equal((await worker.evaluate(()=>chrome.windows.getLastFocused())).id,secondWindow.id);
  await wait(async()=>(await state()).cache.some(entry=>entry.identity.url===a),'A finishes');
  await wait(async()=>(await state()).cache.some(entry=>entry.identity.url===b),'B automatically resumes after A');
  const bId=await worker.evaluate(async url=>(await chrome.tabs.query({})).find(t=>t.url===url).id,b);
  const bView=await send('view',{tabId:bId,validate:true});
  assert.equal(bView.data.status,'ready');assert.equal((await state()).cache.some(entry=>entry.identity.url===b),true);
  console.log('PASS busy preparation resumes the latest article in the focused second window');
  await worker.evaluate(async windowId=>chrome.windows.remove(windowId),secondWindow.id); await pageA.close();
  }
  await send('setAuto',{enabled:false});
  const cancellationUrl='https://mp.weixin.qq.com/s/cancel-building';
  await context.route(cancellationUrl,route=>route.fulfill({contentType:'text/html;charset=utf-8',body:html.replaceAll('original.png','cancel-retry.png')}));
  const cancellationPage=await context.newPage();await cancellationPage.goto(cancellationUrl);
  const cancellationTabId=await worker.evaluate(async url=>(await chrome.tabs.query({})).find(tab=>tab.url===url).id,cancellationUrl);
  const nativeCount=(await worker.evaluate(()=>chrome.downloads.search({}))).length;
  const toCancel=await send('submit',{requestId:crypto.randomUUID(),tabId:cancellationTabId,url:cancellationUrl,formats:['word'],incognito:false});
  await wait(async()=>(await getJob(toCancel.data.id))?.results.word?.state==='building'&&requests.some(url=>url.includes('cancel-retry.png')),'word conversion waiting on image');
  const oldAttempt=(await getJob(toCancel.data.id)).attemptId;
  await send('cancel',{jobId:toCancel.data.id});
  const retried=await send('retry',{jobId:toCancel.data.id});
  assert.equal(retried.success,true,JSON.stringify(retried));assert.notEqual(retried.data.attemptId,oldAttempt);
  releaseCancellationImage();
  const retriedJob=await wait(async()=>{const job=await getJob(toCancel.data.id);return ['complete','error'].includes(job?.state)&&job;},'cancelled word conversion retried');
  assert.equal(retriedJob.state,'complete',JSON.stringify(retriedJob));
  assert.equal((await worker.evaluate(()=>chrome.downloads.search({}))).length,nativeCount+1);
  await cancellationPage.close();
  console.log('PASS real Word conversion cancellation and immediate retry; one native download');
  // Enable incognito access only in this disposable test profile.
  await send('setAuto',{enabled:false});
  await popup.close();
  const settings=await context.newPage(); await settings.goto(`chrome://extensions/?id=${id}`);
  await settings.evaluate(()=>chrome.developerPrivate.updateProfileConfiguration({inDeveloperMode:true}));
  const restartedWorker=context.waitForEvent('serviceworker',{predicate:item=>item.url()===worker.url(),timeout:15000}).catch(()=>undefined);
  await settings.evaluate(async extensionId=>new Promise((resolve,reject)=>chrome.developerPrivate.updateExtensionConfiguration({extensionId,incognitoAccess:true},()=>chrome.runtime.lastError?reject(new Error(chrome.runtime.lastError.message)):resolve())),id);
  await settings.close();
  if(!popup.isClosed()) await popup.close(); await openPopup();
  worker=(await restartedWorker) ?? context.serviceWorkers().find(item=>item.url()===worker.url());
  assert.ok(worker,'extension worker must restart after changing incognito access');
  assert.equal(await worker.evaluate(()=>new Promise(resolve=>chrome.extension.isAllowedIncognitoAccess(resolve))),true);
  const targetsBeforePrivate=(await targetCommand(undefined,'Target.getTargets')).targetInfos.map(target=>target.targetId);
  const privateWindow=await worker.evaluate(()=>chrome.windows.create({incognito:true,url:'about:blank',focused:true}));
  const privateTabId=privateWindow.tabs[0].id;
  const privateTarget=await wait(async()=>(await targetCommand(undefined,'Target.getTargets')).targetInfos.find(target=>target.type==='page'&&!targetsBeforePrivate.includes(target.targetId)),'private window target');
  const privateSession=(await targetCommand(undefined,'Target.attachToTarget',{targetId:privateTarget.targetId,flatten:true})).sessionId;
  await targetCommand(privateSession,'Fetch.enable',{patterns:[{urlPattern:'http*',requestStage:'Request'}]});
  const privateUrl='https://mp.weixin.qq.com/s/private-close';
  await targetCommand(privateSession,'Page.navigate',{url:privateUrl});
  await wait(async()=>worker.evaluate(async tabId=>{const tab=await chrome.tabs.get(tabId);return tab.url==='https://mp.weixin.qq.com/s/private-close'&&tab.status==='complete';},privateTabId),'private article loaded');
  await worker.evaluate(()=>{
    globalThis.__nativeDownload=chrome.downloads.download;globalThis.__nativeCancel=chrome.downloads.cancel;globalThis.__cancelledIds=[];
    chrome.downloads.download=options=>new Promise(resolve=>{globalThis.__releasePrivateDownload=async()=>resolve(await globalThis.__nativeDownload(options));});
    chrome.downloads.cancel=async id=>{globalThis.__cancelledIds.push(id);return globalThis.__nativeCancel(id);};
  });
  const privateJob=await send('submit',{requestId:crypto.randomUUID(),tabId:privateTabId,url:privateUrl,formats:['text'],incognito:true});
  assert.equal(privateJob.success,true,JSON.stringify(privateJob));
  await wait(()=>worker.evaluate(()=>!!globalThis.__releasePrivateDownload),'private download waiting for native ID');
  await worker.evaluate(async windowId=>chrome.windows.remove(windowId),privateWindow.id);
  await wait(async()=>(await state()).privateJobs.length===0&&(await state()).cancelledDownloads.length===1,'last private window cleanup');
  const privateState=await state();
  assert.equal(JSON.stringify(privateState).includes(privateUrl),false);
  assert.equal(JSON.stringify(privateState).includes('PRIVATE_ONLY_TITLE'),false);
  assert.equal(JSON.stringify(await worker.evaluate(()=>chrome.storage.local.get(null))).includes(privateUrl),false);
  await worker.evaluate(async()=>{await globalThis.__releasePrivateDownload();});
  await wait(async()=>(await state()).cancelledDownloads.length===0,'late private download cancellation confirmed');
  const cancelledIds=await worker.evaluate(()=>globalThis.__cancelledIds);
  assert.ok(cancelledIds.length>0);
  for(const downloadId of cancelledIds) assert.notEqual((await worker.evaluate(async id=>(await chrome.downloads.search({id}))[0],downloadId)).state,'in_progress');
  await worker.evaluate(()=>{chrome.downloads.download=globalThis.__nativeDownload;chrome.downloads.cancel=globalThis.__nativeCancel;});
  console.log('PASS actual last private window closure; late native ID cancellation; no private article/job in storage');
  assert.deepEqual(errors, []);
} finally {
  for (const handler of pending.values()) clearTimeout(handler.timer);
  socket.close();
  await context.close();
  await rm(profile, { recursive: true, force: true });
  await rm(downloads, { recursive: true, force: true });
}
