import type { ArticleData, DownloadRecord, ExportFormat } from "../types/index";
import { fetchArticle } from "../utils/extractor";
import { buildExportPayloads } from "../utils/exporters";
import { slugify, buildDocumentBaseName } from "../utils/files";
import { t, getFormatOptions } from "../utils/i18n";

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

const STORAGE_KEYS = {
  formatSelection: "smartArticleExporter:lastFormats"
};

const DEFAULT_FORMATS: ExportFormat[] = ["markdown"];

const app = document.getElementById("app") as HTMLDivElement;

// 使用 i18n 渲染 HTML
function renderUI() {
  const formats = getFormatOptions();

  app.innerHTML = `
  <section class="section card">
    <div>
      <h1>${t("appTitle")}</h1>
      <p class="status" id="status" role="status" aria-live="polite"></p>
    </div>
    <form id="export-form">
      <label for="url-input">${t("urlInputLabel")}</label>
      <input id="url-input" type="url" name="url" placeholder="${t("urlPlaceholder")}" required />
      <div class="section">
        <label>${t("formatSelectLabel")}</label>
        <div class="options-grid" id="format-options">
          ${formats
            .map(
              option => `
              <label class="option-tile">
                <input type="checkbox" name="formats" value="${option.value}" />
                <span>
                  <strong>${option.icon} ${option.label}</strong>
                </span>
              </label>
            `
            )
            .join("")}
        </div>
      </div>
      <button type="submit" id="export-button">${t("downloadButton")}</button>
    </form>
  </section>
  <section class="section" id="preview-section" hidden>
    <div class="summary">
      <h2 id="article-title"></h2>
      <p id="article-meta"></p>
      <p id="article-excerpt"></p>
      <p id="article-stats"></p>
    </div>
  </section>
  <section class="history card" id="history-section">
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
const articleTitleEl = document.getElementById("article-title") as HTMLHeadingElement;
const articleMetaEl = document.getElementById("article-meta") as HTMLParagraphElement;
const articleExcerptEl = document.getElementById("article-excerpt") as HTMLParagraphElement;
const articleStatsEl = document.getElementById("article-stats") as HTMLParagraphElement;
const previewSection = document.getElementById("preview-section") as HTMLDivElement;

exportButton.disabled = true;

formEl.addEventListener("submit", handleExportSubmit);
urlInput.addEventListener("input", handleUrlInputChange);
formEl
  .querySelectorAll<HTMLInputElement>('input[name="formats"]')
  .forEach(box => box.addEventListener("change", handleFormatChange));
historySearchInput.addEventListener("input", handleHistorySearchChange);
historyClearButton.addEventListener("click", handleHistoryClearClick);

void initialize();

async function initialize() {
  await loadHistory();
  await restoreFormatSelection();
  const activeUrl = await getActiveTabUrl();
  if (activeUrl) {
    urlInput.value = activeUrl;
    await ensureArticle(activeUrl);
  } else {
    setStatus(t("statusIdle"));
    updateExportButtonState();
  }
}

function handleUrlInputChange() {
  state.article = null;
  previewSection.hidden = true;
  if (urlInput.value.trim().length === 0) {
    setStatus(t("statusIdle"));
  } else {
    setStatus(t("statusExtracted"));
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
    const article = await fetchArticle(url);
    state.article = article;
    renderArticle(article);
    setStatus(t("statusExtracted"), false);
    return article;
  } catch (error) {
    console.error(error);
    let message = error instanceof Error ? error.message : t("statusExtractFailed");

    // Enhanced error messages
    if (message.includes("dynamic") || message.includes("Substack") || message.includes("Medium")) {
      message = t("statusDynamicSite");
    } else if (message.includes("browser") || message.includes("tab")) {
      message = t("statusNoTabFound");
    } else if (message.includes("too short") || message.includes("paywall")) {
      message = t("statusContentTooShort");
    }

    setStatus(message, true);
    state.article = null;
    previewSection.hidden = true;
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
    status: "success"
  };

  await sendMessage({ type: "addRecord", payload: record });
  state.history = [record, ...state.history].slice(0, 20);
  renderHistory();

  state.isExporting = true;
  updateExportButtonState();
  setStatus(t("statusDownloading"));

  try {
    const payloads = await buildExportPayloads(article, selectedFormats, {
      baseFileName: baseName
    });

    for (const payload of payloads) {
      await triggerBlobDownload(payload.blob, payload.fileName);
    }

    setStatus(t("statusSuccess"), false);
    await chrome.storage.local.set({ [STORAGE_KEYS.formatSelection]: selectedFormats });
  } catch (error) {
    console.error(error);
    const message = error instanceof Error ? error.message : t("statusExportFailed");
    setStatus(message, true);
    await sendMessage({
      type: "updateRecord",
      payload: { id: recordId, changes: { status: "error", errorMessage: message } }
    });
    state.history = state.history.map(item =>
      item.id === recordId ? { ...item, status: "error", errorMessage: message } : item
    );
    renderHistory();
  } finally {
    state.isExporting = false;
    updateExportButtonState();
  }
}

function getSelectedFormats(): ExportFormat[] {
  const checkboxes = formEl.querySelectorAll<HTMLInputElement>('input[name="formats"]:checked');
  return Array.from(checkboxes).map(box => box.value as ExportFormat);
}

function renderArticle(article: ArticleData) {
  articleTitleEl.textContent = article.title;
  const metaParts: string[] = [];
  if (article.byline) metaParts.push(`${t("metaAuthor")}：${article.byline}`);
  metaParts.push(`${t("metaSource")}：${new URL(article.url).hostname}`);
  articleMetaEl.textContent = metaParts.join(" · ");
  articleExcerptEl.textContent = article.excerpt || article.textContent.slice(0, 120);
  const wordCount = Math.round(article.textContent.length / 2);
  const imageCount = article.images.length;
  articleStatsEl.textContent = `${t("metaWords")}约 ${wordCount} ${t("metaWords")} · ${t("metaImages")} ${imageCount} ${t("metaImages")}`;
  previewSection.hidden = false;
  updateExportButtonState();
}

async function loadHistory() {
  try {
    const response = await sendMessage<{ success: boolean; data?: DownloadRecord[] }>({ type: "getHistory" });
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
    historyList.innerHTML = `<p class="status">${t("historyNoMatches")}</p>`;
    return;
  }

  historyList.innerHTML = filtered
    .map(record => {
      const date = new Date(record.timestamp);
      const formatText = record.formats.join(" · ");
      const statusText = record.status === "success" ? t("historyStatusSuccess") : t("historyStatusError");
      const statusClass = record.status === "success" ? "" : "status error";
      const safeTitle = escapeHtmlInline(record.title);
      const safeUrl = escapeHtmlInline(record.url);
      const link = `<a href="${safeUrl}" target="_blank" rel="noreferrer">${safeUrl}</a>`;
      const errorText = record.errorMessage ? ` - ${escapeHtmlInline(record.errorMessage)}` : "";
      return `
        <div class="history-item">
          <strong>${safeTitle}</strong>
          <span>${date.toLocaleString()}</span>
          <span>${t("historyFormatLabel")}：${formatText}</span>
          <span class="${statusClass}">${statusText}${errorText}</span>
          <span class="history-link">${link}</span>
        </div>
      `;
    })
    .join("");
}

function setStatus(message: string, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle("error", isError);
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
  const articleMatchesUrl = state.article && state.article.url === urlInput.value.trim();
  const hasFormats = getSelectedFormats().length > 0;
  exportButton.disabled =
    !hasUrl ||
    !articleMatchesUrl ||
    state.isLoading ||
    state.isExporting ||
    !hasFormats;
}

function triggerBlobDownload(blob: Blob, filename: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    chrome.downloads.download(
      {
        url,
        filename,
        saveAs: false,
        conflictAction: "overwrite"
      },
      downloadId => {
        URL.revokeObjectURL(url);
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(downloadId ?? -1);
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

async function getActiveTabUrl(): Promise<string | null> {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    if (!tab?.url) return null;
    return isHttpUrl(tab.url) ? tab.url : null;
  } catch (error) {
    console.warn("Failed to get active tab URL", error);
    return null;
  }
}

function isHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}
