import type { ArticleData, DownloadRecord, ExportFormat } from "../types/index";
import type { ExportJob, PageIdentity } from "../shared/model";
import { TERMINAL, matchUrl } from "../shared/model";
import { slugify, buildDocumentBaseName } from "../utils/files";
import { t, getFormatOptions, getFormatLabel } from "../utils/i18n";

interface State {
  article: ArticleData | null;
  isLoading: boolean;
  isExporting: boolean;
  history: DownloadRecord[];
  historyFilter: string;
}

const state: State = {
  article: null,
  isLoading: false,
  isExporting: false,
  history: [],
  historyFilter: ""
};
let backgroundEnabled = false;
let identity: PageIdentity | undefined;
let tabId: number | undefined;
let incognito = false;
let job: ExportJob | undefined;
let inputRevision = 0;
let viewStatus = "idle";
let pollTimer: ReturnType<typeof setInterval> | undefined;

const STORAGE_KEYS = {
  formatSelection: "smartArticleExporter:lastFormats"
};

const DEFAULT_FORMATS: ExportFormat[] = ["markdown"];
const manifestVersion = chrome.runtime.getManifest().version;

const app = document.getElementById("app") as HTMLDivElement;

// 使用 i18n 渲染 HTML
function renderUI() {
  const formats = getFormatOptions();

  app.innerHTML = `
  <section class="section card card-hero">
    <div class="hero-header">
      <div class="hero-title-row">
        <h1>${t("appTitle")}</h1>
        <button
          type="button"
          id="version-history-link"
          class="version-link"
          aria-label="${t("versionHistoryButton")}"
          title="${t("versionHistoryButton")}"
        >v${manifestVersion}</button>
      </div>
      <p class="status" id="status" role="status" aria-live="polite"></p>
      <p id="article-title" class="article-title" hidden></p>
      <label class="auto-prepare"><input type="checkbox" id="auto-prepare" checked /> ${t("autoPrepareLabel")}</label>
    </div>
    <form id="export-form" class="form-shell">
      <div class="field-group">
        <label for="url-input">${t("urlInputLabel")}</label>
        <input id="url-input" type="url" name="url" placeholder="${t("urlPlaceholder")}" required />
      </div>
      <div class="section format-section">
        <label>${t("formatSelectLabel")}</label>
        <div class="options-grid" id="format-options">
          ${formats
            .map(
              option => `
              <label class="option-tile">
                <input type="checkbox" name="formats" value="${option.value}" />
                <span class="option-tile-icon" aria-hidden="true">${option.icon}</span>
                <span class="option-tile-copy">
                  <strong class="option-tile-label">${option.label}</strong>
                </span>
                <span class="option-tile-check" aria-hidden="true"></span>
              </label>
            `
            )
            .join("")}
        </div>
      </div>
      <button type="submit" id="export-button">${t("downloadButton")}</button>
      <p id="job-details" class="job-details" hidden></p>
      <div id="task-actions" class="task-actions" hidden>
        <button type="button" id="cancel-task">${t("cancelButton")}</button>
        <button type="button" id="retry-task">${t("retryButton")}</button>
      </div>
    </form>
  </section>
  <section class="history card card-history" id="history-section">
    <div class="history-header">
      <h2>${t("historyTitle")}</h2>
      <div class="history-toolbar">
        <input type="search" id="history-search" placeholder="${t("historySearchPlaceholder")}" aria-label="${t("historySearchPlaceholder")}" />
        <button type="button" id="history-clear">${t("historyClearButton")}</button>
      </div>
    </div>
    <div id="history-list"></div>
  </section>
`;
}

renderUI();

const statusEl = document.getElementById("status") as HTMLParagraphElement;
const formEl = document.getElementById("export-form") as HTMLFormElement;
const urlInput = document.getElementById("url-input") as HTMLInputElement;
const exportButton = document.getElementById("export-button") as HTMLButtonElement;
const historyList = document.getElementById("history-list") as HTMLDivElement;
const historySearchInput = document.getElementById("history-search") as HTMLInputElement;
const historyClearButton = document.getElementById("history-clear") as HTMLButtonElement;
const versionHistoryLink = document.getElementById("version-history-link") as HTMLButtonElement;
const autoPrepare = document.getElementById("auto-prepare") as HTMLInputElement;
const articleTitle = document.getElementById("article-title") as HTMLParagraphElement;
const jobDetails = document.getElementById("job-details") as HTMLParagraphElement;
const taskActions = document.getElementById("task-actions") as HTMLDivElement;
const cancelTask = document.getElementById("cancel-task") as HTMLButtonElement;
const retryTask = document.getElementById("retry-task") as HTMLButtonElement;

exportButton.disabled = true;

formEl.addEventListener("submit", handleExportSubmit);
urlInput.addEventListener("input", handleUrlInputChange);
formEl
  .querySelectorAll<HTMLInputElement>('input[name="formats"]')
  .forEach(box => box.addEventListener("change", handleFormatChange));
historySearchInput.addEventListener("input", handleHistorySearchChange);
historyClearButton.addEventListener("click", handleHistoryClearClick);
versionHistoryLink.addEventListener("click", openVersionHistory);
autoPrepare.addEventListener("change", () => {
  void backgroundRequest("setAuto", { enabled: autoPrepare.checked }).catch(showTaskError);
});
cancelTask.addEventListener("click", () => { if (job) void backgroundRequest("cancel", { jobId: job.id }).then(() => refreshView()).catch(showTaskError); });
retryTask.addEventListener("click", () => {
  if (!job) return;
  retryTask.disabled = true;
  void backgroundRequest("retry", { jobId: job.id }).then(value => { job = value; renderJob(); }).catch(showTaskError).finally(() => { retryTask.disabled = false; });
});
window.addEventListener("pagehide", () => { if (pollTimer) clearInterval(pollTimer); });

void initialize();

async function initialize() {
  const initialRevision = inputRevision;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id;
  incognito = !!tab?.incognito;
  if (incognito) document.getElementById("history-section")!.hidden = true;
  else await loadHistory();
  await restoreFormatSelection();
  if (initialRevision === inputRevision && tab?.url && isHttpUrl(tab.url)) urlInput.value = tab.url;
  try { await refreshView(true); } catch { setStatus(t("statusFallback")); }
  if (!backgroundEnabled) { autoPrepare.disabled = true; setStatus(t("statusFallback")); }
  else pollTimer = setInterval(() => { void refreshView().catch(() => undefined); }, 1000);
  updateExportButtonState();
}

function handleUrlInputChange() {
  inputRevision++;
  state.article = null;
  job = undefined;
  articleTitle.hidden = true;
  jobDetails.hidden = true;
  taskActions.hidden = true;
  if (urlInput.value.trim().length === 0) {
    setStatus(t("statusIdle"));
  } else {
    setStatus(t("statusCanExport"));
  }
  updateExportButtonState();
}

async function restoreFormatSelection() {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEYS.formatSelection);
    const storedFormats = stored[STORAGE_KEYS.formatSelection] as ExportFormat[] | undefined;
    const formats = storedFormats && storedFormats.length ? storedFormats : DEFAULT_FORMATS;
    applyFormatSelection(formats);
  } catch (error) {
    console.warn("Failed to restore format selection", error);
    applyFormatSelection(DEFAULT_FORMATS);
  }
}

function applyFormatSelection(formats: ExportFormat[]) {
  const checkboxNodes = formEl.querySelectorAll<HTMLInputElement>('input[name="formats"]');
  const formatSet = new Set(formats);
  checkboxNodes.forEach(box => {
    const value = box.value as ExportFormat;
    box.checked = formatSet.has(value);
  });

  const checkedAfter = Array.from(checkboxNodes).some(box => box.checked);
  if (!checkedAfter) {
    checkboxNodes.forEach(box => {
      box.checked = DEFAULT_FORMATS.includes(box.value as ExportFormat);
    });
  }
  updateExportButtonState();
}

function handleFormatChange() {
  const selected = getSelectedFormats();
  if (!selected.length) {
    applyFormatSelection(DEFAULT_FORMATS);
    setStatus(t("statusFormatRequired"), true);
  }
  updateExportButtonState();
  void chrome.storage.local.set({ [STORAGE_KEYS.formatSelection]: getSelectedFormats() });
}

function handleHistorySearchChange() {
  state.historyFilter = historySearchInput.value;
  renderHistory();
}

async function handleHistoryClearClick() {
  if (!state.history.length) {
    return;
  }
  if (!confirm(t("historyConfirmClear"))) {
    return;
  }
  await sendMessage({ type: "clearHistory" });
  state.history = [];
  state.historyFilter = "";
  historySearchInput.value = "";
  renderHistory();
  setStatus(t("historyCleared"));
}

function openVersionHistory() {
  void chrome.tabs.create({
    url: chrome.runtime.getURL("changelog/index.html")
  });
}

async function handleExportSubmit(event: Event) {
  event.preventDefault();
  const url = urlInput.value.trim();
  if (!url) {
    setStatus(t("statusUrlRequired"), true);
    return;
  }

  if (!isHttpUrl(url)) {
    setStatus(t("statusHttpRequired"), true);
    return;
  }

  if (backgroundEnabled) {
    if (state.isExporting) return;
    state.isExporting = true;
    updateExportButtonState();
    setStatus(t("statusQueued"));
    try {
      job = await backgroundRequest("submit", { url, tabId, incognito, formats: getSelectedFormats(), requestId: crypto.randomUUID() });
      renderJob();
    } catch (error) { state.isExporting = false; showTaskError(error); updateExportButtonState(); }
    return;
  }

  if (!state.article || state.article.url !== url) {
    const article = await ensureArticle(url);
    if (!article) {
      return;
    }
  }

  const selectedFormats = getSelectedFormats();
  if (!selectedFormats.length) {
    setStatus(t("statusFormatRequired"), true);
    return;
  }

  await exportArticle(state.article!, selectedFormats);
}

async function ensureArticle(url: string): Promise<ArticleData | null> {
  setLoading(true);
  setStatus(t("statusExtracting"));
  try {
    const { fetchArticle } = await import("../utils/extractor");
    const article = await fetchArticle(url, { identity: identity && matchUrl(identity.url, url) ? identity : undefined, incognito, preferredTabId: tabId });
    state.article = article;
    if (article.url !== urlInput.value.trim()) {
      urlInput.value = article.url;
    }
    setStatus(t("statusExtracted"), false);
    return article;
  } catch (error) {
    console.error(error);
    setStatus(getLocalizedExtractErrorMessage(error), true);
    state.article = null;
    return null;
  } finally {
    setLoading(false);
    updateExportButtonState();
  }
}

async function exportArticle(article: ArticleData, selectedFormats: ExportFormat[]) {
  const now = new Date();
  const slug = slugify(article.title);
  const baseName = buildDocumentBaseName(slug, now);
  const recordId = crypto.randomUUID();

  const record: DownloadRecord = {
    id: recordId,
    title: article.title,
    url: article.url,
    timestamp: now.getTime(),
    formats: selectedFormats,
    status: "pending"
  };

  await sendMessage({ type: "addRecord", payload: record, incognito });
  state.history = [record, ...state.history].slice(0, 20);
  renderHistory();

  state.isExporting = true;
  updateExportButtonState();
  setStatus(t("statusDownloading"));

  try {
    const { buildExportPayloads } = await import("../utils/exporters");
    const payloads = await buildExportPayloads(article, selectedFormats, {
      baseFileName: baseName
    });

    for (const payload of payloads) {
      await triggerBlobDownload(payload.blob, payload.fileName, record, payload.format);
    }

    setStatus(t("statusSuccess"), false);
    await loadHistory();
    await chrome.storage.local.set({ [STORAGE_KEYS.formatSelection]: selectedFormats });
  } catch (error) {
    console.error(error);
    const message = getLocalizedExportErrorMessage(error);
    setStatus(message, true);
    await sendMessage({
      type: "updateRecord",
      incognito,
      payload: { id: recordId, changes: { status: "error", errorMessage: message } }
    });
    state.history = state.history.map(item =>
      item.id === recordId ? { ...item, status: "error", errorMessage: message } : item
    );
    renderHistory();
    await loadHistory();
  } finally {
    state.isExporting = false;
    updateExportButtonState();
  }
}

function getSelectedFormats(): ExportFormat[] {
  const checkboxes = formEl.querySelectorAll<HTMLInputElement>('input[name="formats"]:checked');
  return Array.from(checkboxes).map(box => box.value as ExportFormat);
}

async function loadHistory() {
  try {
    const response = await sendMessage<{ success: boolean; data?: DownloadRecord[] }>({ type: "getHistory", incognito });
    if (response.success && response.data) {
      state.history = response.data;
      renderHistory();
    }
  } catch (error) {
    console.warn("Failed to load history", error);
  }
}

function escapeHtmlInline(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getHostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function formatHistoryTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const sameYear = date.getFullYear() === now.getFullYear();

  return new Intl.DateTimeFormat(undefined, {
    month: "numeric",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
    hour: "numeric",
    minute: "2-digit"
  }).format(date);
}

function renderHistory() {
  const keyword = state.historyFilter.trim().toLowerCase();
  const filtered = state.history.filter(record => {
    if (!keyword) return true;
    return (
      record.title.toLowerCase().includes(keyword) ||
      record.url.toLowerCase().includes(keyword)
    );
  });

  if (!filtered.length) {
    const emptyMessage = state.history.length === 0 ? t("historyEmpty") : t("historyNoMatches");
    historyList.innerHTML = `<p class="status">${emptyMessage}</p>`;
    return;
  }

  historyList.innerHTML = filtered
    .map(record => {
      const dateLabel = formatHistoryTimestamp(record.timestamp);
      const formatText = record.formats.map(getFormatLabel).join(" · ");
      const safeTitle = escapeHtmlInline(record.title);
      const safeUrl = escapeHtmlInline(record.url);
      const safeHost = escapeHtmlInline(getHostname(record.url));
      const safeDateLabel = escapeHtmlInline(dateLabel);
      const safeFormatText = escapeHtmlInline(formatText);
      const statusLabel = record.verified ? record.status === "partial" ? t("historyStatusPartial") : record.status === "cancelled" ? t("historyStatusCancelled") : formatStateLabel(record.status === "success" ? "complete" : "error") : record.status === "pending" ? t("historyStatusPending") : t("historyStatusLegacy");
      const details = record.results ? Object.entries(record.results).map(([format, result]) => `${getFormatLabel(format as ExportFormat)}: ${formatStateLabel(result.state)}`).join(" · ") : "";
      const errorText = record.errorMessage
        ? `<p class="history-item-error">${escapeHtmlInline(record.errorMessage)}</p>`
        : "";
      return `
        <a class="history-item" href="${safeUrl}" target="_blank" rel="noreferrer">
          <div class="history-item-top">
            <strong>${safeTitle}</strong>
            <span class="history-item-time">${safeDateLabel}</span>
          </div>
          <p class="history-item-detail">${safeHost} · ${safeFormatText} · ${escapeHtmlInline(statusLabel)}</p>
          ${details ? `<p class="history-item-detail">${escapeHtmlInline(details)}</p>` : ""}
          ${errorText}
        </a>
      `;
    })
    .join("");
}

function setStatus(message: string, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle("error", isError);
}

function getLocalizedExtractErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return t("statusExtractFailed");
  }

  const raw = error.message;
  if (raw.includes("CONTENT_TOO_SHORT")) return t("statusContentTooShort");
  if (raw.includes("OPEN_PAGE_REQUIRED")) return t("statusDynamicSite");
  const normalized = raw.toLowerCase();

  if (
    normalized.includes("too short") ||
    normalized.includes("paywall") ||
    raw.includes("内容过短")
  ) {
    return t("statusContentTooShort");
  }

  if (
    normalized.includes("dynamic") ||
    normalized.includes("substack") ||
    normalized.includes("medium") ||
    normalized.includes("chatgpt") ||
    raw.includes("动态加载")
  ) {
    return t("statusDynamicSite");
  }

  if (
    raw.includes("未找到真正正文") ||
    raw.includes("提取失败") ||
    raw.includes("提取内容")
  ) {
    return t("statusExtractFailed");
  }

  if (
    normalized.includes("browser") ||
    normalized.includes("tab") ||
    raw.includes("标签页") ||
    raw.includes("浏览器") ||
    raw.includes("从标签页获取失败")
  ) {
    return t("statusNoTabFound");
  }

  return t("statusExtractFailed");
}

function getLocalizedExportErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return t("statusExportFailed");
  }

  const normalized = error.message.toLowerCase();
  if (normalized.includes("download") || normalized.includes("blob") || normalized.includes("failed")) {
    return t("statusExportFailed");
  }

  return t("statusExportFailed");
}

function setLoading(loading: boolean) {
  state.isLoading = loading;
  urlInput.disabled = loading;
  formEl
    .querySelectorAll<HTMLInputElement>('input[name="formats"]')
    .forEach(element => {
      element.disabled = loading;
    });
}

function updateExportButtonState() {
  const hasUrl = urlInput.value.trim().length > 0;
  const hasFormats = getSelectedFormats().length > 0;
  const canExport =
    hasUrl &&
    isHttpUrl(urlInput.value.trim()) &&
    !state.isLoading &&
    !state.isExporting &&
    hasFormats;

  exportButton.disabled = !canExport;
  exportButton.classList.toggle("is-ready", canExport);
  exportButton.classList.toggle("is-busy", state.isLoading || state.isExporting);
  exportButton.setAttribute("aria-disabled", String(!canExport));
  exportButton.dataset.state = state.isExporting ? "exporting" : state.isLoading ? "loading" : canExport ? "ready" : "idle";
  if (backgroundEnabled) {
    urlInput.disabled = state.isExporting;
    formEl.querySelectorAll<HTMLInputElement>('input[name="formats"]').forEach(element => { element.disabled = state.isExporting; });
  }
}

function triggerBlobDownload(blob: Blob, filename: string, record: DownloadRecord, format: ExportFormat): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    chrome.downloads.download(
      {
        url,
        filename,
        saveAs: false,
        conflictAction: "uniquify"
      },
      downloadId => {
        if (chrome.runtime.lastError) {
          URL.revokeObjectURL(url);
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          void backgroundRequest("legacyDownload", { record, format, downloadId, incognito }).then(async () => {
            const check = (item: chrome.downloads.DownloadItem) => {
              if (item.state === "in_progress") return false;
              chrome.downloads.onChanged.removeListener(listener);
              URL.revokeObjectURL(url);
              if (item.state === "complete") resolve(item.id);
              else reject(new Error(item.error ?? "DOWNLOAD_FAILED"));
              return true;
            };
            const listener = (delta: chrome.downloads.DownloadDelta) => {
              if (delta.id === downloadId) void chrome.downloads.search({ id: downloadId }).then(items => { if (items[0]) check(items[0]); });
            };
            chrome.downloads.onChanged.addListener(listener);
            const [item] = await chrome.downloads.search({ id: downloadId });
            if (item) check(item);
          }).catch(error => { URL.revokeObjectURL(url); reject(error); });
        }
      }
    );
  });
}

function sendMessage<T>(message: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, response => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response as T);
    });
  });
}

function isHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function urlsMatch(left: string, right: string): boolean {
  try {
    const leftUrl = new URL(left);
    const rightUrl = new URL(right);
    return leftUrl.href === rightUrl.href;
  } catch {
    return left.trim() === right.trim();
  }
}

async function backgroundRequest(type: string, data: Record<string, unknown> = {}): Promise<any> {
  const response = await sendMessage<{ success: boolean; data?: any; error?: string }>({ target: "background", type, ...data });
  if (!response?.success) throw new Error(response?.error ?? "BACKGROUND_UNAVAILABLE");
  return response.data;
}
function showTaskError(error: unknown) {
  const raw = String(error);
  const codes = {
    SOURCE_CHANGED: "statusSourceChanged", SNAPSHOT_EXPIRED: "statusSnapshotExpired", QUEUE_FULL: "statusQueueFull", PDF_FONT_UNAVAILABLE: "statusFontUnavailable", OPEN_PAGE_REQUIRED: "statusDynamicSite", CONTENT_TOO_SHORT: "statusContentTooShort", DOWNLOAD_UNCERTAIN: "statusUncertain", EXTRACTION_FAILED: "statusExtractFailed", WECHAT_RAW_FETCH_FAILED: "statusExtractFailed",
    PREPARATION_TIMEOUT: "statusTimeout", GENERATION_CANCELLED_OR_TIMEOUT: "statusTimeout", OFFSCREEN_UNAVAILABLE: "statusFallback"
  } as const;
  const match = Object.entries(codes).find(([code]) => raw.includes(code));
  setStatus(t(match ? match[1] : "statusExportFailed"), true);
}
function formatStateLabel(value: string): string {
  const keys = { queued: "jobQueued", preparing: "jobPreparing", building: "jobBuilding", downloading: "jobDownloading", complete: "jobComplete", error: "jobError", cancelled: "jobCancelled", uncertain: "jobUncertain" } as const;
  return t(keys[value as keyof typeof keys] ?? "jobError");
}
function renderJob() {
  if (!job) return;
  state.isExporting = !TERMINAL.has(job.state);
  state.isLoading = false;
  const keys = { queued: "statusQueued", preparing: "statusPreparing", building: "statusBuilding", downloading: "statusNativeDownload", complete: "statusComplete", partial: "statusPartial", error: "statusExportFailed", cancelled: "statusCancelled", uncertain: "statusUncertain" } as const;
  setStatus(t(keys[job.state]), ["partial", "error", "uncertain"].includes(job.state));
  if (job.state === "partial" && !job.articleKey) setStatus(t("statusPartialRefresh"), true);
  if (job.state === "error") showTaskError(job.error ?? Object.values(job.results).find(result => result.error)?.error);
  articleTitle.textContent = job.title;
  articleTitle.hidden = false;
  jobDetails.textContent = job.formats.map(format => `${getFormatLabel(format)}: ${formatStateLabel(job!.results[format]?.state ?? "queued")}`).join(" · ");
  if (Object.values(job.results).some(result => result.warnings?.length)) jobDetails.textContent += ` · ${t("exportWarnings")}`;
  jobDetails.hidden = false;
  cancelTask.hidden = !state.isExporting;
  retryTask.hidden = !job.articleKey || !["partial", "error", "cancelled"].includes(job.state) || Object.values(job.results).some(result => result.state === "uncertain");
  taskActions.hidden = cancelTask.hidden && retryTask.hidden;
  updateExportButtonState();
}
async function refreshView(validate = false) {
  const revision = inputRevision;
  const response = await backgroundRequest("view", { tabId, validate, incognito });
  backgroundEnabled = response.supported;
  identity = response.identity;
  autoPrepare.checked = response.autoPrepare;
  if (!backgroundEnabled || revision !== inputRevision) return;
  if (job) {
    const updated = await backgroundRequest("getJob", { jobId: job.id });
    if (revision !== inputRevision) return;
    job = updated;
    if (job) renderJob();
  } else if ((validate && response.job) || (identity && urlsMatch(urlInput.value.trim(), identity.url))) {
    const candidate = response.job;
    job = candidate && (validate || urlsMatch(urlInput.value.trim(), candidate.url)) ? candidate : undefined;
    if (job && validate) urlInput.value = job.url;
    if (job) renderJob();
    else {
      viewStatus = response.status;
      setStatus(t(viewStatus === "ready" ? "statusReady" : viewStatus === "preparing" ? "statusPreparing" : "statusCanExport"));
      articleTitle.textContent = response.title ?? "";
      articleTitle.hidden = !response.title;
    }
  } else setStatus(t("statusCanExport"));
  if (!incognito) await loadHistory();
}
