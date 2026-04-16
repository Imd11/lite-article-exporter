import type { ExportFormat } from "../types/index";

/**
 * 国际化 (i18n) 工具模块
 * 使用 Chrome 扩展的 i18n API
 */

export interface I18nKey {
  // 应用标题
  appTitle: string;
  urlInputLabel: string;
  urlPlaceholder: string;
  formatSelectLabel: string;

  // 格式选项
  formatMarkdown: string;
  formatMarkdownDesc: string;
  formatWord: string;
  formatWordDesc: string;
  formatPdf: string;
  formatPdfDesc: string;
  formatText: string;
  formatTextDesc: string;

  // 按钮
  downloadButton: string;
  historyClearButton: string;

  // 状态消息
  statusIdle: string;
  statusExtracting: string;
  statusExtracted: string;
  statusDownloading: string;
  statusSuccess: string;
  statusUrlRequired: string;
  statusFormatRequired: string;
  statusHttpRequired: string;
  statusExtractFailed: string;
  statusExportFailed: string;
  statusNoTabFound: string;
  statusDynamicSite: string;
  statusContentTooShort: string;

  // 历史记录
  historyTitle: string;
  historySearchPlaceholder: string;
  historyEmpty: string;
  historyConfirmClear: string;
  historyCleared: string;
  historyNoMatches: string;
  historyStatusSuccess: string;
  historyStatusError: string;
  historyFormatLabel: string;

  // 预览
  previewTitle: string;
  metaAuthor: string;
  metaSource: string;
  metaWords: string;
  metaImages: string;
  articleMetaAuthorLine: string;
  articleMetaSourceLine: string;
  articleStatsLine: string;
  historyFormatValue: string;
  exportAuthorLine: string;
  exportImageUnavailable: string;
  exportImageCaption: string;
  chatConversationTitle: string;
  chatSharedConversationTitle: string;
  geminiConversationTitle: string;
  chatRoleUser: string;
  chatRoleAssistant: string;
  chatGptRoleYouSaid: string;
  chatGptRoleAssistantSaid: string;
  geminiRoleYouSaid: string;
  geminiRoleAssistantSaid: string;

  // 其他
  defaultTitle: string;
}

export type TranslationKey = keyof I18nKey;

/**
 * 获取翻译文本
 * @param key 翻译键
 * @returns 翻译后的文本
 */
export function t(key: TranslationKey, substitutions?: string | string[]): string {
  return chrome.i18n.getMessage(key, substitutions);
}

/**
 * 获取当前语言
 * @returns 语言代码，如 'zh-CN' 或 'en'
 */
export function getCurrentLanguage(): string {
  return chrome.i18n.getUILanguage();
}

/**
 * 检查是否为中文
 */
export function isChinese(): boolean {
  const lang = getCurrentLanguage().toLowerCase();
  return lang === 'zh-cn' || lang === 'zh-hans' || lang.startsWith('zh');
}

/**
 * 获取格式选项（本地化）
 */
export function getFormatOptions() {
  return [
    {
      value: "markdown" as const,
      label: getFormatLabel("markdown"),
      icon: "📝"
    },
    {
      value: "word" as const,
      label: getFormatLabel("word"),
      icon: "📄"
    },
    {
      value: "pdf" as const,
      label: getFormatLabel("pdf"),
      icon: "📕"
    },
    {
      value: "text" as const,
      label: getFormatLabel("text"),
      icon: "📃"
    }
  ];
}

export function getFormatLabel(format: ExportFormat): string {
  switch (format) {
    case "markdown":
      return t("formatMarkdown");
    case "word":
      return t("formatWord");
    case "pdf":
      return t("formatPdf");
    case "text":
      return t("formatText");
    default:
      return format;
  }
}
