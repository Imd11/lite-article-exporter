import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const profile = await mkdtemp(path.join(tmpdir(), 'article-history-test-'));
const extension = path.resolve('dist');
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true, ignoreDefaultArgs: ['--disable-extensions'],
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
  });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  const records = Array.from({ length: 8 }, (_, index) => ({
    id: `history-fixture-${index}`, title: index < 2 ? ['微赞直播行为规范', '微信视频号运营规范'][index] : `其他文章 ${index}`,
    url: `https://wx.vzan.com/article/${index}`, formats: ['markdown'],
    timestamp: Date.now() - index * 60000, status: 'success'
  }));
  await worker.evaluate(records => chrome.storage.local.set({ downloadHistory: records }), records);
  const popup = await context.newPage();
  await popup.addInitScript(() => {
    const query = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = options => options.active && options.currentWindow ? Promise.resolve([]) : query(options);
  });
  await popup.goto(`chrome-extension://${id}/popup/index.html`);
  await popup.waitForSelector('.history-item');
  assert.equal(await popup.locator('#status').isVisible(), false, 'normal opening must not show a status banner');
  await popup.waitForTimeout(350); // Measure the layout after the existing entrance animation.
  const inputTop = (await popup.locator('#url-input').boundingBox()).y;

  async function assertStableHistory(description, expectItems = true) {
    await popup.waitForTimeout(350); // Let entry animations finish before observing two real polling cycles.
    const result = await popup.evaluate(async () => {
      const list = document.querySelector('#history-list');
      const first = list.firstElementChild;
      const link = list.querySelector('.history-item');
      link?.focus();
      list.scrollTop = 60;
      const scrollTop = list.scrollTop;
      const focused = document.activeElement;
      let mutations = 0, animations = 0, polls = 0;
      const observer = new MutationObserver(records => { mutations += records.length; });
      observer.observe(list, { childList: true, subtree: true });
      const onAnimation = () => { animations++; };
      list.addEventListener('animationstart', onAnimation);
      const send = chrome.runtime.sendMessage;
      chrome.runtime.sendMessage = function(message, ...args) {
        if (message?.type === 'view') polls++;
        return send.call(this, message, ...args);
      };
      try {
        await new Promise(resolve => setTimeout(resolve, 2300));
        return { mutations, animations, polls, sameNode: first === list.firstElementChild,
          sameFocus: focused === document.activeElement, sameScroll: scrollTop === list.scrollTop };
      } finally {
        chrome.runtime.sendMessage = send;
        observer.disconnect();
        list.removeEventListener('animationstart', onAnimation);
      }
    });
    assert.ok(result.polls >= 2, `${description}: task polling must continue`);
    assert.equal(result.mutations, 0, `${description}: unchanged history must not rebuild its DOM`);
    assert.equal(result.animations, 0, `${description}: unchanged history must not replay entry animations`);
    assert.equal(result.sameNode, true, `${description}: preserve existing nodes`);
    assert.equal(result.sameScroll, true, `${description}: preserve scrolling`);
    if (expectItems) assert.equal(result.sameFocus, true, `${description}: preserve keyboard focus`);
    console.log(`PASS ${description}; continued polling without DOM changes or repeated animations`);
  }

  await assertStableHistory('idle history');
  assert.equal((await popup.locator('#url-input').boundingBox()).y, inputTop, 'passive polling must not move the input');
  await popup.locator('input[name="formats"][value="markdown"]').click(); // The app restores the default when the last format is deselected.
  assert.equal(await popup.locator('#status.error').isVisible(), true, 'validation errors must remain visible');
  await assertStableHistory('history with a validation error');
  assert.equal(await popup.locator('#status.error').isVisible(), true, 'passive polling must not erase an interaction error');
  await popup.locator('input[name="formats"][value="text"]').check();
  assert.equal(await popup.locator('#status').isVisible(), false, 'correcting the format selection must clear the error');
  console.log('PASS quiet opening and stable layout; errors survive polling and clear on correction');
  await popup.locator('#history-search').fill('规范');
  assert.equal(await popup.locator('.history-item').count(), 2);
  await assertStableHistory('filtered history');
  records[0] = { ...records[0], title: '微赞直播行为规范（更新）', url: 'https://wx.vzan.com/updated',
    formats: ['text'], verified: true, status: 'error', errorMessage: 'HISTORY_FAILURE_DETAIL',
    results: { text: { state: 'error' } } };
  await worker.evaluate(records => chrome.storage.local.set({ downloadHistory: records }), records);
  await popup.waitForFunction(() => document.querySelector('#history-list').textContent.includes('HISTORY_FAILURE_DETAIL'));
  assert.equal(await popup.locator('.history-item').count(), 2);
  assert.equal(await popup.locator('.history-item').first().getAttribute('href'), records[0].url);
  assert.match(await popup.locator('.history-item').first().innerText(), /微赞直播行为规范（更新）.*TXT/s);
  assert.equal(await popup.locator('#history-search').inputValue(), '规范');
  console.log('PASS changed history title, URL, format and failure details update during polling; search remains active');
  await popup.locator('#history-search').fill('不存在的标题');
  assert.equal(await popup.locator('.history-item').count(), 0);
  await assertStableHistory('no search matches', false);
  popup.once('dialog', dialog => dialog.accept());
  await popup.locator('#history-clear').click();
  await popup.waitForFunction(() => document.querySelector('#history-search').value === '');
  assert.deepEqual(await worker.evaluate(async () => (await chrome.storage.local.get('downloadHistory')).downloadHistory), []);
  assert.equal(await popup.locator('.history-item').count(), 0);
  await assertStableHistory('empty history', false);
  assert.equal((await worker.evaluate(() => chrome.downloads.search({}))).length, 0);
  console.log('PASS history clear; no downloads caused by history polling');
  await popup.locator('#url-input').fill('https://chatgpt.com/c/missing-test');
  await popup.locator('#export-button').click();
  await popup.waitForFunction(() => !document.querySelector('#status').hidden && document.querySelector('#job-details').textContent.includes('Failed'));
  assert.equal(await popup.locator('#status.error').isVisible(), true, 'failed exports must show a banner');
  assert.equal(await popup.locator('#export-button').isEnabled(), true, 'failed exports must allow a new request');
  await popup.waitForTimeout(2300);
  assert.equal(await popup.locator('#status.error').isVisible(), true, 'failed export errors must survive polling');
  await popup.locator('#url-input').fill('https://example.org/corrected');
  assert.equal(await popup.locator('#status').isVisible(), false, 'changing the failed source must clear the old error');
  assert.equal((await worker.evaluate(() => chrome.downloads.search({}))).length, 0);
  console.log('PASS real export failure remains visible and clears when the URL is corrected');
} finally {
  await context?.close();
  await rm(profile, { recursive: true, force: true });
}
