import type { ArticleData, DownloadRecord, ExportFormat } from "../types/index";
import { fetchArticle } from "../utils/extractor";
import { buildExportPayloads } from "../utils/exporters";
import { slugify, buildDocumentBaseName } from "../utils/files";

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

const formatOptions: Array<{ value: ExportFormat; label: string; description: string; icon: string }> = [
  { value: "markdown", label: "Markdown", description: "保留结构，可用于笔记", icon: "📝" },
  { value: "word", label: "Word", description: "专业DOCX格式，固定排版", icon: "📄" },
  { value: "pdf", label: "PDF", description: "适合分享与存档", icon: "📕" },
  { value: "text", label: "TXT", description: "纯文本提要", icon: "📃" }
];

const STORAGE_KEYS = {
  formatSelection: "smartArticleExporter:lastFormats"
};

const DEFAULT_FORMATS: ExportFormat[] = ["markdown"];

const app = document.getElementById("app") as HTMLDivElement;
app.innerHTML = `
  <section class="section card">
    <div>
      <h1>文章提取与导出</h1>
      <p class="status" id="status" role="status" aria-live="polite"></p>
    </div>
    <form id="export-form">
      <label for="url-input">输入公众号或网页链接</label>
      <input id="url-input" type="url" name="url" placeholder="https://" required />
      <div class="section">
        <label>选择导出格式</label>
        <div class="options-grid" id="format-options">
          ${formatOptions
            .map(
              option => `
              <label class="option-tile">
                <input type="checkbox" name="formats" value="${option.value}" />
                <span>
                  <strong>${option.icon} ${option.label}</strong><br />
                  <small>${option.description}</small>
                </span>
              </label>
            `
            )
            .join("")}
        </div>
      </div>
      <button type="submit" id="export-button">一键下载</button>
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
      <h2>下载记录</h2>
      <div class="history-toolbar">
        <input type="search" id="history-search" placeholder="搜索标题或链接" aria-label="搜索下载记录" />
        <button type="button" id="history-clear">清空</button>
      </div>
    </div>
    <div id="history-list"></div>
  </section>
`;


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
    setStatus("请粘贴微信公众号文章或网页链接");
    updateExportButtonState();
  }
}

function handleUrlInputChange() {
  state.article = null;
  previewSection.hidden = true;
  if (urlInput.value.trim().length === 0) {
    setStatus("请粘贴微信公众号文章或网页链接");
  } else {
    setStatus("链接已更新，点击一键下载即可完成导出");
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
    console.warn("恢复导出格式失败", error);
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
    setStatus("至少需要一种导出格式，已恢复默认 Markdown", true);
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
  if (!confirm("确认清空全部下载记录？")) {
    return;
  }
  await sendMessage({ type: "clearHistory" });
  state.history = [];
  state.historyFilter = "";
  historySearchInput.value = "";
  renderHistory();
  setStatus("下载记录已清空。");
}

async function handleExportSubmit(event: Event) {
  event.preventDefault();
  const url = urlInput.value.trim();
  if (!url) {
    setStatus("请粘贴微信公众号文章或网页链接", true);
    return;
  }

  if (!isHttpUrl(url)) {
    setStatus("仅支持 http 或 https 协议的网页", true);
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
    setStatus("至少选择一种导出格式", true);
    return;
  }

  await exportArticle(state.article!, selectedFormats);
}

async function ensureArticle(url: string): Promise<ArticleData | null> {
  setLoading(true);
  setStatus("正在提取正文，请稍候...");
  try {
    const article = await fetchArticle(url);
    state.article = article;
    renderArticle(article);
    setStatus("提取完成，点击一键下载即可导出。", false);
    return article;
  } catch (error) {
    console.error(error);
    const message = error instanceof Error ? error.message : "提取失败，请稍后再试";
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
  setStatus("正在生成文档并下载...");

  try {
    const payloads = await buildExportPayloads(article, selectedFormats, {
      baseFileName: baseName
    });

    for (const payload of payloads) {
      await triggerBlobDownload(payload.blob, payload.fileName);
    }

    setStatus("导出完成，可在下载文件夹中查看。", false);
    await chrome.storage.local.set({ [STORAGE_KEYS.formatSelection]: selectedFormats });
  } catch (error) {
    console.error(error);
    const message = error instanceof Error ? error.message : "导出失败";
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
  if (article.byline) metaParts.push(`作者：${article.byline}`);
  metaParts.push(`来源：${new URL(article.url).hostname}`);
  articleMetaEl.textContent = metaParts.join(" · ");
  articleExcerptEl.textContent = article.excerpt || article.textContent.slice(0, 120);
  articleStatsEl.textContent = `字数约 ${Math.round(article.textContent.length / 2)} 字 · 图片 ${article.images.length} 张`;
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
    console.warn("加载历史记录失败", error);
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
    historyList.innerHTML = `<p class="status">暂无匹配记录</p>`;
    return;
  }

  historyList.innerHTML = filtered
    .map(record => {
      const date = new Date(record.timestamp);
      const formatText = record.formats.join(" · ");
      const statusText = record.status === "success" ? "已完成" : "失败";
      const statusClass = record.status === "success" ? "" : "status error";
      const safeTitle = escapeHtmlInline(record.title);
      const safeUrl = escapeHtmlInline(record.url);
      const link = `<a href="${safeUrl}" target="_blank" rel="noreferrer">${safeUrl}</a>`;
      const errorText = record.errorMessage ? ` - ${escapeHtmlInline(record.errorMessage)}` : "";
      return `
        <div class="history-item">
          <strong>${safeTitle}</strong>
          <span>${date.toLocaleString()}</span>
          <span>格式：${formatText}</span>
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
    console.warn("获取当前标签页链接失败", error);
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
