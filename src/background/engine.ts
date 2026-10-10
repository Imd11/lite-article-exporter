import type { ArticleData, DownloadRecord, ExportFormat } from "../types/index";
import { aggregateState, blobKey, boundedFingerprint, EXTRACTOR_VERSION, FORMATS, identityKey, matchUrl, sameIdentity, SerialQueue, TERMINAL, type CacheEntry, type ExportJob, type PageIdentity, type Preparation } from "../shared/model";
import { executeCapture, probeArticle, type CaptureStage } from "../shared/capture";
import { buildDocumentBaseName, slugify } from "../utils/files";
import { closeIfIdle, exists, offscreenMessage, supported, translations } from "./offscreen";

const SESSION = "articleExporter:session";
const JOBS = "articleExporter:jobs";
const PREF = "articleExporter:autoPrepare";
const HISTORY = "downloadHistory";
const GENERATION = "articleExporter:historyGeneration";
const WATCHDOG = "articleExporter:watchdog";
const MAX_CACHE_BYTES = 6 * 1024 * 1024;
const MAX_ENTRY_BYTES = 2 * 1024 * 1024;
const queue = new SerialQueue();
const revisions = new Map<number, number>();
type CancelledDownload = { jobId: string; attemptId?: string; format: ExportFormat; blobUrl?: string; downloadId?: number };
const sameCancellation = (a: CancelledDownload, b: CancelledDownload) => a.jobId === b.jobId && a.attemptId === b.attemptId && a.format === b.format;
type SessionState = { cache: CacheEntry[]; preparations: Preparation[]; privateJobs: ExportJob[]; revisions: Record<number, number>; autoPending: boolean; cancelledDownloads: CancelledDownload[] };
const emptySession = (): SessionState => ({ cache: [], preparations: [], privateJobs: [], revisions: {}, autoPending: false, cancelledDownloads: [] });
async function session(): Promise<SessionState> { return { ...emptySession(), ...(await chrome.storage.session.get(SESSION))[SESSION] }; }
async function saveSession(state: SessionState) { await chrome.storage.session.set({ [SESSION]: state }); }
async function allJobs(state?: SessionState): Promise<ExportJob[]> { return [...((await chrome.storage.local.get(JOBS))[JOBS] ?? []), ...(state ?? await session()).privateJobs]; }
const hasNativeWork = (job: ExportJob) => Object.values(job.results).some(result => ["downloading", "uncertain"].includes(result.state));
async function saveJob(job: ExportJob, state?: SessionState) {
  job.updatedAt = Date.now();
  if (job.incognito) {
    const current = state ?? await session();
    current.privateJobs = [...current.privateJobs.filter(item => item.id !== job.id), job];
    await saveSession(current);
  } else {
    const jobs: ExportJob[] = (await chrome.storage.local.get(JOBS))[JOBS] ?? [];
    const next = [...jobs.filter(item => item.id !== job.id), job];
    const active = next.filter(item => !TERMINAL.has(item.state) || hasNativeWork(item));
    const done = next.filter(item => TERMINAL.has(item.state) && !hasNativeWork(item)).sort((a, b) => b.createdAt - a.createdAt).slice(0, 20);
    await chrome.storage.local.set({ [JOBS]: [...active, ...done] });
  }
}
async function jobById(id: string) { return (await allJobs()).find(job => job.id === id); }
export async function getIdentity(tabId: number): Promise<PageIdentity | undefined> {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab.url || !/^https?:/.test(tab.url)) return;
    const frame = await chrome.webNavigation.getFrame({ tabId, frameId: 0 });
    if (!frame?.documentId) return;
    const saved = await session();
    return { tabId, url: tab.url, documentId: frame.documentId, revision: revisions.get(tabId) ?? saved.revisions[tabId] ?? 0, incognito: !!tab.incognito };
  } catch { return; }
}
async function probe(identity: PageIdentity) {
  const result = await chrome.scripting.executeScript({ target: { tabId: identity.tabId, documentIds: [identity.documentId] }, func: probeArticle, args: [identity.url] });
  if (result[0]?.documentId !== identity.documentId || !sameIdentity(identity, await getIdentity(identity.tabId))) throw new Error("SOURCE_CHANGED");
  const value = result[0].result as ReturnType<typeof probeArticle>;
  if (value.fingerprint && new URL(identity.url).hostname === "substack.com" && new URL(identity.url).pathname.startsWith("/home/post/")) {
    const runtime = await executeCapture("substack", identity);
    if (!sameIdentity(identity, await getIdentity(identity.tabId))) throw new Error("SOURCE_CHANGED");
    const payload = runtime[0]?.result as Record<string, unknown> | null;
    const size = payload ? Object.values(payload).reduce<number>((size, part) => size + (typeof part === "string" ? part.length : 0), 0) : 0;
    const fingerprint = size > 1500000 ? "" : boundedFingerprint(JSON.stringify(payload ?? null));
    value.fingerprint = fingerprint ? `${value.fingerprint}:${fingerprint}` : "";
    if (!fingerprint) value.eligible = false;
  }
  return value;
}
async function history(job: ExportJob) {
  if (job.incognito) return;
  const stored = await chrome.storage.local.get([HISTORY, GENERATION]);
  if ((stored[GENERATION] ?? 0) !== job.historyGeneration) return;
  const record: DownloadRecord = { id: job.id, title: job.title, url: job.url, timestamp: job.createdAt, formats: job.formats, status: job.state === "complete" ? "success" : job.state === "partial" ? "partial" : job.state === "cancelled" ? "cancelled" : "error", errorMessage: job.error, results: job.results, verified: true };
  const records: DownloadRecord[] = stored[HISTORY] ?? [];
  await chrome.storage.local.set({ [HISTORY]: [record, ...records.filter(item => item.id !== job.id)].sort((a, b) => b.timestamp - a.timestamp).slice(0, 20) });
}
async function badge(job: ExportJob) {
  if (!job.identity) return;
  if (!sameIdentity(job.identity, await getIdentity(job.identity.tabId))) return;
  const done = job.state === "complete";
  const terminal = TERMINAL.has(job.state);
  try {
    await chrome.action.setBadgeText({ tabId: job.identity.tabId, text: done ? "✓" : terminal ? "!" : "…" });
    await chrome.action.setBadgeBackgroundColor({ tabId: job.identity.tabId, color: done ? "#5f9d6a" : terminal ? "#b75244" : "#6c88a4" });
  } catch { /* A source tab may have closed after its snapshot was captured. */ }
}
async function preparationBadge(identity: PageIdentity, text: string) {
  if (!sameIdentity(identity, await getIdentity(identity.tabId))) return;
  if ((await allJobs()).some(job => sameIdentity(job.identity, identity))) return;
  await chrome.action.setBadgeText({ tabId: identity.tabId, text }).catch(() => undefined);
  await chrome.action.setBadgeBackgroundColor({ tabId: identity.tabId, color: "#5f9d6a" }).catch(() => undefined);
}
async function finish(job: ExportJob) {
  job.state = aggregateState(job);
  if (job.state === "complete") job.error = undefined;
  await saveJob(job);
  await badge(job);
  if (TERMINAL.has(job.state)) {
    await history(job);
    const state = await session();
    state.cache.forEach(entry => { entry.pins = entry.pins.filter(id => id !== job.id); });
    await saveSession(state);
  }
}
async function failJob(job: ExportJob, error: string) {
  job.error = error;
  for (const format of job.formats) if (["queued", "building"].includes(job.results[format]?.state ?? "")) job.results[format] = { state: "error", attemptId: job.attemptId, error };
  await finish(job);
}
function trimCache(entries: CacheEntry[]) {
  const sorted = entries.sort((a, b) => b.touchedAt - a.touchedAt);
  let size = 0;
  return sorted.filter((entry, index) => {
    const bytes = new TextEncoder().encode(JSON.stringify(entry)).byteLength;
    if (entry.pins.length) { size += bytes; return true; }
    if (index >= 10 || bytes > MAX_ENTRY_BYTES || size + bytes > MAX_CACHE_BYTES) return false;
    size += bytes; return true;
  });
}
async function pinSnapshot(job: ExportJob, entry: CacheEntry, state: SessionState) {
  entry.pins = [...new Set([...entry.pins, job.id])]; entry.touchedAt = Date.now();
  try { await saveSession(state); job.articleKey = entry.key; }
  catch {
    // Cache bookkeeping must not interrupt an accepted full-snapshot export.
    state.cache = []; await saveSession(state); job.articleKey = undefined;
  }
}
async function dispatchBuild(job: ExportJob, article: ArticleData | undefined, operationId?: string) {
  job.attemptId = crypto.randomUUID();
  job.cancelRequested = false;
  job.state = "building";
  await saveJob(job);
  await chrome.alarms.create(WATCHDOG, { periodInMinutes: 1 });
  await badge(job);
  await offscreenMessage({ type: "build", job, article, operationId, baseName: buildDocumentBaseName(slugify(job.title), new Date(job.createdAt)), messages: translations(), language: chrome.i18n.getUILanguage() });
}
async function startPreparation(identity: PageIdentity | undefined, url: string, fingerprint: string, job?: ExportJob) {
  const state = await session();
  if (identity) state.revisions[identity.tabId] = identity.revision;
  const existing = state.preparations.find(item => identity ? sameIdentity(item.identity, identity) : !item.identity && item.incognito === !!job?.incognito && matchUrl(item.url, url));
  if (existing) {
    if (job) {
      if (existing.mode === "automatic") await offscreenMessage({ type: "promote", id: existing.id });
      existing.mode = "user";
      existing.jobIds = [...new Set([...existing.jobIds, job.id])];
      job.state = "preparing"; await saveJob(job, state);
    }
    await saveSession(state); return;
  }
  // Automatic work never creates a backlog, and yields to accepted user jobs.
  if (!job && (state.preparations.length || (await allJobs(state)).some(item => !TERMINAL.has(item.state)))) {
    state.autoPending = true; await saveSession(state); return;
  }
  const operation: Preparation = { id: crypto.randomUUID(), url, identity, incognito: !!job?.incognito, fingerprint, mode: job ? "user" : "automatic", jobIds: job ? [job.id] : [], startedAt: Date.now() };
  state.preparations.push(operation); await saveSession(state);
  if (!job && identity) await preparationBadge(identity, "…");
  if (job) { job.state = "preparing"; await saveJob(job); await badge(job); }
  try { await offscreenMessage({ type: "prepare", operation, messages: translations(), language: chrome.i18n.getUILanguage() }); }
  catch (error) {
    state.preparations = state.preparations.filter(item => item.id !== operation.id); await saveSession(state);
    if (job) await failJob(job, String(error));
    else if (identity) await preparationBadge(identity, "");
  }
}
async function cached(identity: PageIdentity, fingerprint: string, state: SessionState) {
  const entry = state.cache.find(entry => sameIdentity(entry.identity, identity) && entry.version === EXTRACTOR_VERSION && fingerprint && entry.fingerprint === fingerprint);
  if (!entry) return;
  for (const dependency of entry.dependencies ?? []) {
    try {
      if (!sameIdentity(dependency.identity, await getIdentity(dependency.identity.tabId)) || !dependency.fingerprint || (await probe(dependency.identity)).fingerprint !== dependency.fingerprint) return;
    } catch { return; }
  }
  return entry;
}
export async function prepareActive() {
  if (!supported() || (await chrome.storage.local.get(PREF))[PREF] === false) return;
  try {
    const window = await chrome.windows.getLastFocused();
    if (!window.focused) return;
    const [tab] = await chrome.tabs.query({ active: true, windowId: window.id });
    if (!tab?.id || tab.incognito || tab.discarded || !tab.url) return;
    const host = new URL(tab.url).hostname;
    if (host !== "mp.weixin.qq.com" && !["substack.com", "medium.com", "telegraph.co.uk"].some(site => host === site || host.endsWith("." + site))) return;
    const identity = await getIdentity(tab.id);
    if (!identity) return;
    const result = await probe(identity);
    if (!result.eligible) return;
    await queue.run(async () => {
      if (!sameIdentity(identity, await getIdentity(identity.tabId))) return;
      const latestWindow = await chrome.windows.getLastFocused();
      const [latestTab] = await chrome.tabs.query({ active: true, windowId: latestWindow.id });
      if (!latestWindow.focused || latestTab?.id !== identity.tabId) return;
      const state = await session();
      if (!await cached(identity, result.fingerprint, state)) await startPreparation(identity, identity.url, result.fingerprint);
    });
  } catch { /* Permissions, special pages and unfinished loads remain available on demand. */ }
}
async function view(tabId?: number, validate = true, incognito = false) {
  const identity = tabId === undefined ? undefined : await getIdentity(tabId);
  const state = await session();
  let fingerprint = "";
  try { if (identity && validate) fingerprint = (await probe(identity)).fingerprint; } catch { /* Explicit export can still retry. */ }
  const entry = identity ? validate ? await cached(identity, fingerprint, state) : state.cache.find(entry => sameIdentity(entry.identity, identity) && entry.version === EXTRACTOR_VERSION && !!entry.fingerprint) : undefined;
  const operation = state.preparations.find(item => sameIdentity(item.identity, identity));
  const jobs = (await allJobs(state)).filter(job => job.incognito === (identity?.incognito ?? incognito)).sort((a, b) => b.createdAt - a.createdAt);
  const recent = jobs.find(job => (sameIdentity(job.identity, identity) || sameIdentity(job.requester, identity) || !identity && tabId !== undefined && job.requesterTabId === tabId) && Date.now() - job.createdAt < 86400000);
  return { identity, supported: supported(), autoPrepare: (await chrome.storage.local.get(PREF))[PREF] !== false, status: entry ? "ready" : operation ? "preparing" : "idle", title: entry?.article.title, job: recent };
}
async function submit(message: any) {
  const url = String(message.url ?? "");
  if (!/^https?:\/\//.test(url) || !matchUrl(url, url)) throw new Error("INVALID_URL");
  const formats = FORMATS.filter(format => Array.isArray(message.formats) && message.formats.includes(format));
  if (!formats.length || typeof message.requestId !== "string") throw new Error("INVALID_REQUEST");
  const requester = message.tabId === undefined ? undefined : await getIdentity(message.tabId);
  let identity = requester;
  if (identity && !matchUrl(identity.url, url)) identity = undefined;
  if (!identity) {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find(tab => !!tab.url && matchUrl(tab.url, url) && !!tab.incognito === !!message.incognito);
    if (tab?.id) identity = await getIdentity(tab.id);
  }
  const jobs = await allJobs();
  const duplicate = jobs.find(job => job.requestId === message.requestId || !TERMINAL.has(job.state) && matchUrl(job.url, url) && job.incognito === !!message.incognito && JSON.stringify(job.formats) === JSON.stringify(formats) && (!identity || sameIdentity(job.identity, identity)));
  if (duplicate) return duplicate;
  if (jobs.filter(job => !TERMINAL.has(job.state)).length >= 3) throw new Error("QUEUE_FULL");
  const generation = (await chrome.storage.local.get(GENERATION))[GENERATION] ?? 0;
  const job: ExportJob = { id: crypto.randomUUID(), requestId: message.requestId, url, identity, requester, requesterTabId: message.tabId, title: url, formats, results: Object.fromEntries(formats.map(format => [format, { state: "queued" }])), state: "queued", createdAt: Date.now(), updatedAt: Date.now(), historyGeneration: generation, incognito: !!message.incognito };
  if (requester) { const state = await session(); state.revisions[requester.tabId] = requester.revision; await saveSession(state); }
  await saveJob(job);
  await chrome.alarms.create(WATCHDOG, { periodInMinutes: 1 });
  try {
    const state = await session();
    let fingerprint = "";
    try { if (identity) fingerprint = (await probe(identity)).fingerprint; } catch { /* Re-read explicitly. */ }
    const entry = identity ? await cached(identity, fingerprint, state) : undefined;
    if (entry) {
      await pinSnapshot(job, entry, state); job.title = entry.article.title;
      await dispatchBuild(job, entry.article);
    } else await startPreparation(identity, url, fingerprint, job);
  } catch (error) { await failJob(job, String(error)); }
  return job;
}
async function prepared(message: any) {
  const state = await session();
  const operation = state.preparations.find(item => item.id === message.operationId);
  if (!operation) return { release: true };
  state.preparations = state.preparations.filter(item => item.id !== operation.id);
  const article = message.article as ArticleData;
  if (!article || typeof article.contentHtml !== "string" || typeof article.textContent !== "string" || typeof article.title !== "string" || !Array.isArray(article.images)) throw new Error("INVALID_ARTICLE");
  const valid = operation.identity && sameIdentity(operation.identity, await getIdentity(operation.identity.tabId));
  const jobs = (await allJobs(state)).filter(job => operation.jobIds.includes(job.id) && !TERMINAL.has(job.state));
  const key = `${operation.identity ? identityKey(operation.identity) : operation.id}:${operation.id}`;
  let stored = false;
  if (operation.identity && (valid || jobs.length)) {
    const entry: CacheEntry = { key, identity: operation.identity, fingerprint: operation.fingerprint, dependencies: operation.dependencies, version: EXTRACTOR_VERSION, article, touchedAt: Date.now(), pins: jobs.map(job => job.id) };
    if (new TextEncoder().encode(JSON.stringify(entry)).byteLength <= MAX_ENTRY_BYTES) {
      state.cache = trimCache([...state.cache, entry]); stored = state.cache.some(item => item.key === key);
    }
  }
  try { await saveSession(state); }
  catch {
    // A session quota failure must never discard the offscreen snapshot for an accepted job.
    state.cache = []; stored = false;
    await saveSession(state);
  }
  for (const job of jobs) {
    job.title = article.title; job.articleKey = stored ? key : undefined;
    await dispatchBuild(job, stored ? article : undefined, operation.id);
  }
  if (valid && operation.identity && !jobs.length) await preparationBadge(operation.identity, stored ? "✓" : "");
  return { release: stored || !jobs.length };
}
async function preparationFailed(message: any) {
  const state = await session();
  const operation = state.preparations.find(item => item.id === message.operationId);
  state.preparations = state.preparations.filter(item => item.id !== message.operationId); await saveSession(state);
  for (const id of operation?.jobIds ?? []) {
    const job = await jobById(id);
    if (job && !TERMINAL.has(job.state)) await failJob(job, String(message.error));
  }
  if (operation?.identity && !operation.jobIds.length) await preparationBadge(operation.identity, "");
}
async function startDownload(message: any) {
  const accepted = await queue.run(async () => {
    const job = await jobById(message.jobId);
    const format = message.format as ExportFormat;
    if (!job || job.attemptId !== message.attemptId || TERMINAL.has(job.state) || !job.formats.includes(format) || job.results[format]?.state !== "building") return false;
    if (typeof message.blobUrl !== "string" || !message.blobUrl.startsWith(`blob:chrome-extension://${chrome.runtime.id}/`) || typeof message.filename !== "string" || /[\\/]/.test(message.filename)) throw new Error("INVALID_PAYLOAD");
    job.results[format] = { state: "downloading", attemptId: job.attemptId, blobUrl: message.blobUrl, filename: message.filename, warnings: message.warnings };
    await saveJob(job); return true;
  });
  if (!accepted) return { success: false };
  let id: number;
  try { id = await chrome.downloads.download({ url: message.blobUrl, filename: message.filename, saveAs: false, conflictAction: "uniquify" }); }
  catch (error) {
    await queue.run(async () => {
      const job = await jobById(message.jobId);
      if (job && job.attemptId === message.attemptId) { job.results[message.format as ExportFormat] = { state: job.cancelRequested ? "cancelled" : "error", attemptId: message.attemptId, error: String(error) }; await finish(job); }
      const state = await session();
      state.cancelledDownloads = state.cancelledDownloads.filter(item => item.blobUrl !== message.blobUrl); await saveSession(state);
    });
    return { success: false };
  }
  // Once the browser accepts the blob, tracking/storage errors must not revoke it
  // or make a duplicate retry possible. The persisted intent is reconciled later.
  await queue.run(async () => {
    const job = await jobById(message.jobId);
    if (!job || job.attemptId !== message.attemptId) {
      const state = await session();
      const intent: CancelledDownload = state.cancelledDownloads.find(item => item.blobUrl === message.blobUrl) ?? { jobId: message.jobId, attemptId: message.attemptId, format: message.format, blobUrl: message.blobUrl };
      intent.downloadId = id;
      await chrome.downloads.cancel(id).catch(() => undefined);
      state.cancelledDownloads = [...state.cancelledDownloads.filter(item => item.blobUrl !== message.blobUrl), intent];
      await saveSession(state);
      await cancelOrphan(intent); return;
    }
    const result = job.results[message.format as ExportFormat]!;
    result.downloadId = id; await saveJob(job);
    if (job.cancelRequested) await chrome.downloads.cancel(id).catch(() => undefined);
    const [download] = await chrome.downloads.search({ id });
    if (download) await applyDownload(job, message.format, download);
  }).catch(() => undefined);
  return { success: true };
}
async function cancelOrphan(intent: CancelledDownload) {
  if (intent.downloadId === undefined && !intent.blobUrl) return;
  const items = await chrome.downloads.search(intent.downloadId !== undefined ? { id: intent.downloadId } : { url: intent.blobUrl });
  const item = items.find(item => item.byExtensionId === chrome.runtime.id);
  if (!item) return;
  intent.downloadId = item.id;
  if (item.state === "in_progress") await chrome.downloads.cancel(item.id).catch(() => undefined);
  const [confirmed] = await chrome.downloads.search({ id: item.id });
  const state = await session();
  if (confirmed && confirmed.state !== "in_progress") {
    if (await exists()) await offscreenMessage({ type: "release", key: blobKey(intent.jobId, intent.format, intent.attemptId) }).catch(() => undefined);
    state.cancelledDownloads = state.cancelledDownloads.filter(value => !sameCancellation(value, intent));
  } else state.cancelledDownloads = state.cancelledDownloads.map(value => sameCancellation(value, intent) ? intent : value);
  await saveSession(state);
}
async function applyDownload(job: ExportJob, format: ExportFormat, item: chrome.downloads.DownloadItem) {
  const result = job.results[format]!;
  result.downloadId = item.id; result.filename = item.filename;
  if (item.state === "complete") { result.state = "complete"; result.error = undefined; }
  else if (item.state === "interrupted") { result.state = item.error === "USER_CANCELED" ? "cancelled" : "error"; result.error = item.error; }
  else result.state = "downloading";
  await finish(job);
  if (item.state !== "in_progress" && await exists()) await offscreenMessage({ type: "release", key: blobKey(job.id, format, result.attemptId) }).catch(() => undefined);
}
export async function downloadChanged(id: number) {
  await queue.run(async () => {
    for (const intent of (await session()).cancelledDownloads) if (intent.downloadId === id) await cancelOrphan(intent).catch(() => undefined);
    const jobs = await allJobs();
    for (const job of jobs) for (const format of job.formats) if (job.results[format]?.downloadId === id) {
      const [item] = await chrome.downloads.search({ id });
      if (item) await applyDownload(job, format, item);
    }
  });
  await cleanIdle();
}
async function cancel(id: string) {
  const job = await jobById(id);
  if (!job || TERMINAL.has(job.state)) return;
  const state = await session();
  for (const operation of state.preparations) {
    operation.jobIds = operation.jobIds.filter(value => value !== job.id);
    if (!operation.jobIds.length && operation.mode === "user") {
      await offscreenMessage({ type: "cancel", id: operation.id }).catch(() => undefined);
      state.preparations = state.preparations.filter(value => value.id !== operation.id);
    }
  }
  state.cache.forEach(entry => { entry.pins = entry.pins.filter(value => value !== id); });
  await saveSession(state);
  if (await exists()) await offscreenMessage({ type: "cancel", id, attemptId: job.attemptId }).catch(() => undefined);
  job.cancelRequested = true;
  for (const format of job.formats) {
    const result = job.results[format]!;
    if (result.state === "complete") continue;
    if (result.downloadId !== undefined) await chrome.downloads.cancel(result.downloadId).catch(() => undefined);
    if (!["downloading", "uncertain"].includes(result.state)) result.state = "cancelled";
  }
  job.state = "cancelled"; await saveJob(job); await history(job); await badge(job);
}
async function retry(id: string) {
  const job = await jobById(id);
  if (!job || !TERMINAL.has(job.state)) throw new Error("INVALID_RETRY");
  if (job.state === "uncertain" || Object.values(job.results).some(result => ["uncertain", "downloading"].includes(result.state))) throw new Error("DOWNLOAD_UNCERTAIN");
  const state = await session();
  const entry = state.cache.find(item => item.key === job.articleKey);
  if (!entry) throw new Error("SNAPSHOT_EXPIRED");
  if ((await allJobs(state)).filter(item => !TERMINAL.has(item.state)).length >= 3) throw new Error("QUEUE_FULL");
  for (const format of job.formats) if (job.results[format]?.state !== "complete") job.results[format] = { state: "queued" };
  await pinSnapshot(job, entry, state);
  job.error = undefined;
  await dispatchBuild(job, entry.article);
  return job;
}
export async function handle(message: any) {
  if (message.type === "resolveCanonical") return queue.run(async () => {
    const state = await session();
    const operation = state.preparations.find(item => item.id === message.operationId);
    if (!operation?.identity || !sameIdentity(operation.identity, message.identity) || !sameIdentity(operation.identity, await getIdentity(operation.identity.tabId))) throw new Error("SOURCE_CHANGED");
    const source = new URL(operation.identity.url);
    if (source.hostname !== "substack.com" || !source.pathname.startsWith("/home/post/") || !matchUrl(message.url, message.url)) throw new Error("INVALID_SOURCE");
    // Canonical content is independently pinned and validated alongside the
    // wrapper. Sources without a reliable fingerprint bypass fresh cache reuse.
    operation.sourceUrls = [...new Set([...(operation.sourceUrls ?? []), message.url])];
    const tab = (await chrome.tabs.query({})).find(tab => tab.url && matchUrl(tab.url, message.url) && !!tab.incognito === operation.identity!.incognito);
    const identity = tab?.id === undefined ? undefined : await getIdentity(tab.id);
    if (identity) {
      operation.sources = [...(operation.sources ?? []).filter(value => value.tabId !== identity.tabId), identity];
      state.revisions[identity.tabId] = identity.revision;
      let fingerprint = "";
      try { fingerprint = (await probe(identity)).fingerprint; } catch { /* Preserve explicit extraction without reusing an unverifiable source. */ }
      operation.dependencies = [...(operation.dependencies ?? []).filter(value => value.identity.tabId !== identity.tabId), { identity, fingerprint }];
      if (!fingerprint) operation.fingerprint = "";
    } else operation.fingerprint = "";
    await saveSession(state); return identity;
  });
  if (message.type === "capturePage") {
    const operation = (await session()).preparations.find(item => item.id === message.operationId);
    const identity = [operation?.identity, ...(operation?.sources ?? [])].find(value => sameIdentity(value, message.identity));
    if (!operation?.identity || !identity || !sameIdentity(operation.identity, await getIdentity(operation.identity.tabId)) || !sameIdentity(identity, await getIdentity(identity.tabId))) throw new Error("SOURCE_CHANGED");
    const result = await executeCapture(message.stage as CaptureStage, identity, message.args, operation.mode === "automatic" ? 15000 : 60000);
    if (!sameIdentity(identity, await getIdentity(identity.tabId)) || !sameIdentity(operation.identity, await getIdentity(operation.identity.tabId))) throw new Error("SOURCE_CHANGED");
    return result;
  }
  if (message.type === "findTab") {
    const operation = (await session()).preparations.find(item => item.id === message.operationId);
    if (!operation || !matchUrl(operation.url, message.url) && !operation.sourceUrls?.some(url => matchUrl(url, message.url))) throw new Error("INVALID_SOURCE");
    // Without a pinned document, use HTTP extraction; never silently adopt a newly opened tab.
    const identity = [operation.identity, ...(operation.sources ?? [])].find(value => value && matchUrl(value.url, message.url));
    return identity ? (await chrome.tabs.query({})).filter(tab => tab.id === identity.tabId) : [];
  }
  if (message.type === "payloadReady") return startDownload(message);
  if (message.type === "view") return view(message.tabId, message.validate !== false, !!message.incognito);
  if (message.type === "getJob") return jobById(message.jobId);
  return queue.run(async () => {
    switch (message.type) {
      case "submit": return submit(message);
      case "legacyDownload": {
        const record = message.record as DownloadRecord;
        if (!record || !matchUrl(record.url, record.url) || !FORMATS.includes(message.format) || typeof message.downloadId !== "number") throw new Error("INVALID_REQUEST");
        let job = await jobById(record.id);
        job ??= { id: record.id, requestId: record.id, url: record.url, title: record.title, formats: record.formats, results: Object.fromEntries(record.formats.map(format => [format, { state: "queued" }])), state: "downloading", createdAt: record.timestamp, updatedAt: Date.now(), historyGeneration: (await chrome.storage.local.get(GENERATION))[GENERATION] ?? 0, incognito: !!message.incognito };
        job.results[message.format as ExportFormat] = { state: "downloading", downloadId: message.downloadId };
        await saveJob(job);
        const [item] = await chrome.downloads.search({ id: message.downloadId });
        if (item) await applyDownload(job, message.format, item);
        return;
      }
      case "prepared": return prepared(message);
      case "prepareFailed": return preparationFailed(message);
      case "cancel": return cancel(message.jobId);
      case "retry": return retry(message.jobId);
      case "setAuto": {
        await chrome.storage.local.set({ [PREF]: !!message.enabled });
        if (!message.enabled) {
          const state = await session();
          state.autoPending = false;
          for (const operation of state.preparations.filter(item => !item.jobIds.length)) await offscreenMessage({ type: "cancel", id: operation.id }).catch(() => undefined);
          state.preparations = state.preparations.filter(item => item.jobIds.length);
          state.cache = state.cache.filter(item => item.pins.length); await saveSession(state);
        }
        return;
      }
      case "getHistory": return message.incognito ? [] : (await chrome.storage.local.get(HISTORY))[HISTORY] ?? [];
      case "clearHistory": {
        const generation = (await chrome.storage.local.get(GENERATION))[GENERATION] ?? 0;
        await chrome.storage.local.set({ [HISTORY]: [], [GENERATION]: generation + 1 }); return;
      }
      case "addRecord": {
        if (message.incognito) return;
        const records: DownloadRecord[] = (await chrome.storage.local.get(HISTORY))[HISTORY] ?? [];
        await chrome.storage.local.set({ [HISTORY]: [message.payload, ...records.filter(item => item.id !== message.payload.id)].slice(0, 20) }); return;
      }
      case "updateRecord": {
        if (message.incognito) return;
        const job = await jobById(message.payload.id);
        if (job && message.payload.changes.status === "error") { await failJob(job, String(message.payload.changes.errorMessage ?? "EXPORT_FAILED")); return; }
        const records: DownloadRecord[] = (await chrome.storage.local.get(HISTORY))[HISTORY] ?? [];
        await chrome.storage.local.set({ [HISTORY]: records.map(item => item.id === message.payload.id ? { ...item, ...message.payload.changes } : item) }); return;
      }
      default: {
        if (message.type === "processorIdle") return;
        const job = await jobById(message.jobId);
        if (!job || job.attemptId !== message.attemptId || TERMINAL.has(job.state)) {
          if (message.type === "formatStarted") throw new Error("STALE_FORMAT");
          return;
        }
        const format = message.format as ExportFormat;
        if (message.type === "formatStarted") {
          if (!job.formats.includes(format) || job.results[format]?.state !== "queued") throw new Error("STALE_FORMAT");
          job.results[format] = { state: "building", attemptId: job.attemptId }; await finish(job);
        } else if (message.type === "formatFailed") {
          if (!job.formats.includes(format) || job.results[format]?.state !== "building") return;
          job.results[format] = { state: "error", error: String(message.error) }; await finish(job);
        } else if (message.type === "buildFailed") await failJob(job, String(message.error));
        else if (message.type === "buildFinished") {
          for (const result of Object.values(job.results)) if (["queued", "building"].includes(result.state)) { result.state = message.aborted ? "cancelled" : "error"; result.error = "GENERATION_INTERRUPTED"; }
          await finish(job);
        }
      }
    }
  });
}
export async function invalidate(tabId: number) {
  // Update the in-memory guard synchronously, before queued capture work can finish.
  revisions.set(tabId, (revisions.get(tabId) ?? 0) + 1);
  await chrome.action.setBadgeText({ tabId, text: "" }).catch(() => undefined);
  await queue.run(async () => {
    const state = await session();
    const tracked = state.cache.some(entry => entry.identity.tabId === tabId || entry.dependencies?.some(source => source.identity.tabId === tabId)) || state.preparations.some(operation => operation.identity?.tabId === tabId || operation.sources?.some(source => source.tabId === tabId)) || (await allJobs(state)).some(job => job.identity?.tabId === tabId || job.requesterTabId === tabId);
    // Unrelated browsing must not continually rewrite the article cache/session state.
    if (!tracked) return;
    state.revisions[tabId] = Math.max((state.revisions[tabId] ?? 0) + 1, revisions.get(tabId) ?? 0);
    revisions.set(tabId, Math.max(revisions.get(tabId) ?? 0, state.revisions[tabId]));
    for (const entry of state.cache) if (entry.dependencies?.some(source => source.identity.tabId === tabId)) await chrome.action.setBadgeText({ tabId: entry.identity.tabId, text: "" }).catch(() => undefined);
    state.cache = state.cache.filter(item => item.pins.length || item.identity.tabId !== tabId && !item.dependencies?.some(source => source.identity.tabId === tabId));
    const obsolete = state.preparations.filter(item => (item.identity?.tabId === tabId || item.sources?.some(source => source.tabId === tabId)) && !item.jobIds.length);
    state.preparations = state.preparations.filter(item => !obsolete.includes(item)); await saveSession(state);
    if (await exists()) for (const operation of obsolete) await offscreenMessage({ type: "cancel", id: operation.id }).catch(() => undefined);
  });
}
export async function cleanIdle() {
  let prepareLatest = false;
  await queue.run(async () => {
    const state = await session();
    const jobs = await allJobs(state);
    if (!state.preparations.length && !jobs.some(job => !TERMINAL.has(job.state))) {
      prepareLatest = state.autoPending;
      if (prepareLatest) { state.autoPending = false; await saveSession(state); }
      await closeIfIdle().catch(() => undefined);
      if (!state.cancelledDownloads.length && !jobs.some(hasNativeWork)) await chrome.alarms.clear(WATCHDOG);
    }
  });
  if (prepareLatest) await prepareActive();
}
export async function reconcile() {
  await queue.run(async () => {
    let state = await session();
    let activity: { operations: string[]; jobs: string[] } = { operations: [], jobs: [] };
    if (await exists()) activity = await offscreenMessage({ type: "activity" });
    for (const intent of state.cancelledDownloads) await cancelOrphan(intent).catch(() => undefined);
    state = await session();
    for (const operation of [...state.preparations]) if (!activity.operations.includes(operation.id)) {
      state.preparations = state.preparations.filter(item => item.id !== operation.id);
      await saveSession(state);
      for (const id of operation.jobIds) { const job = await jobById(id); if (job && !TERMINAL.has(job.state)) await failJob(job, "PREPARATION_INTERRUPTED"); }
      state = await session();
    }
    for (const job of await allJobs()) {
      for (const format of job.formats) {
        const result = job.results[format]!;
        if (!["downloading", "uncertain"].includes(result.state)) continue;
        let items: chrome.downloads.DownloadItem[];
        try { items = await chrome.downloads.search(result.downloadId !== undefined ? { id: result.downloadId } : { url: result.blobUrl, startedAfter: new Date(job.createdAt).toISOString() }); }
        catch { continue; }
        const item = items.find(item => item.byExtensionId === chrome.runtime.id);
        if (item) {
          if (job.cancelRequested && item.state === "in_progress") {
            await chrome.downloads.cancel(item.id).catch(() => undefined);
            const [confirmed] = await chrome.downloads.search({ id: item.id });
            if (confirmed) await applyDownload(job, format, confirmed);
          } else await applyDownload(job, format, item);
        }
        else { result.state = "uncertain"; result.error = "DOWNLOAD_UNCERTAIN"; await finish(job); }
      }
      if (Object.values(job.results).some(result => ["queued", "building"].includes(result.state)) && !activity.jobs.includes(`${job.id}:${job.attemptId}`) && !state.preparations.some(operation => operation.jobIds.includes(job.id))) await failJob(job, "PROCESSOR_INTERRUPTED");
    }
  });
  await cleanIdle();
}
export async function clearPrivateWhenClosed() {
  const windows = await chrome.windows.getAll();
  if (windows.some(window => window.incognito)) return;
  await queue.run(async () => {
    if ((await chrome.windows.getAll()).some(window => window.incognito)) return;
    const state = await session();
    for (const job of state.privateJobs) for (const format of job.formats) {
      const result = job.results[format];
      if (result && (result.blobUrl || result.downloadId !== undefined) && ["downloading", "uncertain"].includes(result.state)) state.cancelledDownloads.push({ jobId: job.id, attemptId: result.attemptId, format, blobUrl: result.blobUrl, downloadId: result.downloadId });
    }
    if (await exists()) {
      for (const operation of state.preparations.filter(item => item.incognito)) await offscreenMessage({ type: "cancel", id: operation.id }).catch(() => undefined);
      for (const job of state.privateJobs) {
        await offscreenMessage({ type: "cancel", id: job.id }).catch(() => undefined);
        for (const format of job.formats) {
          const result = job.results[format];
          if (result?.blobUrl && !["downloading", "uncertain"].includes(result.state)) await offscreenMessage({ type: "release", key: blobKey(job.id, format, result.attemptId) }).catch(() => undefined);
        }
      }
    }
    state.privateJobs = []; state.cache = state.cache.filter(entry => !entry.identity.incognito);
    state.preparations = state.preparations.filter(operation => !operation.incognito);
    await saveSession(state);
    for (const intent of state.cancelledDownloads) await cancelOrphan(intent).catch(() => undefined);
    if ((await session()).cancelledDownloads.length) await chrome.alarms.create(WATCHDOG, { periodInMinutes: 1 });
  });
}
