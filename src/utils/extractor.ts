import { Readability } from "@mozilla/readability";
import type { ReadabilityResult } from "@mozilla/readability";
import TurndownService from "turndown";
import type { ArticleData, ImageAsset } from "../types/index";
import { t } from "./i18n";

type SerializedSubstackRuntimeArticle = {
  title?: string;
  excerpt?: string | null;
  canonicalUrl?: string | null;
  byline?: string;
  bodyHtml: string;
};

type SerializedChatGptConversation = {
  title?: string;
  excerpt?: string | null;
  bodyHtml: string;
  language?: string | null;
};

type SerializedGeminiConversation = {
  title?: string;
  excerpt?: string | null;
  bodyHtml: string;
  language?: string | null;
};

type SerializedGrokConversation = {
  title?: string;
  excerpt?: string | null;
  bodyHtml: string;
  language?: string | null;
};

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-"
});

function extractPreformattedText(element: HTMLElement): string {
  const clone = element.cloneNode(true) as HTMLElement;

  clone.querySelectorAll("br").forEach(br => br.replaceWith("\n"));

  const directText = (clone.textContent ?? "").replace(/\r\n?/g, "\n");
  if (directText.includes("\n")) {
    return directText;
  }

  const children = Array.from(clone.children).filter(child => child instanceof HTMLElement) as HTMLElement[];
  if (children.length) {
    const lineChildren = children.filter(isLikelyLineWrapper);
    if (lineChildren.length === children.length) {
      return lineChildren
        .map(line => extractPreformattedText(line).replace(/\n+$/u, ""))
        .join("\n");
    }
  }

  return directText;
}

function isLikelyLineWrapper(element: HTMLElement): boolean {
  if (element.hasAttribute("data-line-number") || element.hasAttribute("data-code-line") || element.hasAttribute("data-line")) {
    return true;
  }
  const classList = Array.from(element.classList);
  if (!classList.length) {
    return false;
  }
  return classList.some(token => /(^|-)line($|-|\d)/i.test(token) || /^code-line/i.test(token) || token === "hljs-line");
}

turndown.addRule("tables", {
  filter: "table",
  replacement: (_content: any, node: any): string => {
    if (!(node instanceof HTMLTableElement)) return _content ?? "";

    const rows: string[][] = [];
    const allRows = Array.from(node.querySelectorAll("tr")) as HTMLTableRowElement[];

    for (const row of allRows) {
      const cells = Array.from(row.querySelectorAll("td, th")) as HTMLTableCellElement[];
      const cellTexts = cells.map(cell =>
        (cell.textContent ?? "").replace(/\n+/g, " ").replace(/\|/g, "\\|").trim()
      );
      if (cellTexts.some(t => t)) {
        rows.push(cellTexts);
      }
    }

    if (!rows.length) return _content ?? "";

    const columnCount = Math.max(...rows.map(r => r.length));
    if (!columnCount) return _content ?? "";

    for (const row of rows) {
      while (row.length < columnCount) row.push("");
    }

    const firstRowHasHeaders = allRows[0]?.querySelector("th") !== null || allRows[0]?.closest("thead") !== null;
    const separator = Array(columnCount).fill("---");
    const lines: string[] = [];

    if (firstRowHasHeaders || rows.length > 1) {
      lines.push("| " + rows[0].join(" | ") + " |");
      lines.push("| " + separator.join(" | ") + " |");
      for (const row of rows.slice(1)) {
        lines.push("| " + row.join(" | ") + " |");
      }
    } else {
      lines.push("| " + separator.join(" | ") + " |");
      lines.push("| " + rows[0].join(" | ") + " |");
    }

    return "\n\n" + lines.join("\n") + "\n\n";
  }
});

turndown.addRule("removeEmpty", {
  filter: (node: any) =>
    node.nodeName === "DIV" &&
    node.textContent?.trim() === "" &&
    !(node as Element).querySelector?.("img, picture, figure, video, iframe, table, pre, code, blockquote, ul, ol, hr"),
  replacement: () => ""
});

turndown.addRule("preserveImages", {
  filter: "img",
  replacement: (_content: any, node: any) => {
    if (!node || node.nodeName !== "IMG" || typeof node.getAttribute !== "function") {
      return "";
    }
    const src = node.getAttribute("src");
    if (!src) {
      return "";
    }
    const alt = (node.getAttribute("alt") || "").replace(/\s+/g, " ").trim();
    const title = (node.getAttribute("title") || "").replace(/\s+/g, " ").trim();
    const escapedAlt = escapeMarkdown(alt);
    const escapedTitle = title ? ` "${escapeMarkdown(title)}"` : "";
    return `![${escapedAlt}](${src}${escapedTitle})`;
  }
});

turndown.addRule("unwrapImageLinks", {
  filter: (node: any) => {
    if (!node || node.nodeName !== "A" || typeof node.querySelector !== "function") {
      return false;
    }

    const text = (node.textContent ?? "").trim();
    const image = node.querySelector("img");
    return !!image && text.length === 0;
  },
  replacement: (content: any, node: any) => {
    if (!node || typeof node.getAttribute !== "function") {
      return content ?? "";
    }

    const href = node.getAttribute("href")?.trim();
    const image = node.querySelector?.("img");
    const imageSrc = image?.getAttribute?.("src")?.trim();
    const normalizedContent = typeof content === "string" ? content.trim() : "";

    if (!normalizedContent) {
      return "";
    }

    if (!href || (imageSrc && href === imageSrc)) {
      return normalizedContent;
    }

    const escapedHref = href.replace(/([()])/g, "\\$1");
    return `[${normalizedContent}](${escapedHref})`;
  }
});

turndown.addRule("preserveCodeBlocks", {
  filter: (node: any) => {
    if (!(node instanceof HTMLElement)) return false;
    if (node.nodeName === "PRE") {
      return true;
    }
    return node.nodeName === "CODE" && !node.closest("pre");
  },
  replacement: (_content: any, node: any) => {
    if (!(node instanceof HTMLElement)) return "";

    if (node.nodeName === "PRE") {
      const codeElement = node.querySelector("code") ?? node;
      const raw = extractPreformattedText(codeElement as HTMLElement).replace(/\s+$/u, "");
      const languageClass = codeElement.getAttribute("class") ?? "";
      const match = languageClass.match(/language-([\w-]+)/i);
      const language = match ? match[1] : "";
      const fence = "```";
      const header = language ? `${fence}${language}\n` : `${fence}\n`;
      return raw ? `\n\n${header}${raw}\n${fence}\n\n` : "";
    }

    if (node.nodeName === "CODE") {
      const elementNode = node as HTMLElement;
      const rawText = extractPreformattedText(elementNode);
      const trimmed = rawText.trim();
      if (!trimmed) {
        return "";
      }

      const languageClass = elementNode.getAttribute("class") ?? "";
      const match = languageClass.match(/language-([\w-]+)/i);
      const language = match ? match[1] : "";
      const hasLineBreak = /\r?\n/.test(rawText);
      const hasExplicitBreak = !!elementNode.querySelector("br");
      const looksLikeBlock = hasLineBreak || hasExplicitBreak;

      if (looksLikeBlock) {
        const fence = "```";
        const header = language ? `${fence}${language}\n` : `${fence}\n`;
        const body = rawText.replace(/^\n+/u, "").replace(/\s+$/u, "");
        return body ? `\n\n${header}${body}\n${fence}\n\n` : "";
      }

      const escaped = trimmed.replace(/`/g, "\\`");
      return `\`${escaped}\``;
    }

    return "";
  }
});

const AD_KEYWORDS = ["ad-", "ads", "advert", "sponsor", "promo", "banner", "subscribe"];
const TEXT_NOISE_PATTERNS = [
  /\bSuggestions\b/i,
  /\bSuggested\b/i,
  /\bSee all\b/i,
  /继续滑动看下一个/,
  /向上滑动看下一个/,
  /点击[\s\S]{0,10}看下一个/,
  /阅读全文/,
  /原文链接/,
  /Discussion about this post/i,
  /Ready for more\?/i,
  /TopLatestDiscussions/i,
  /CommentsRestacks/i
];

function isLikelyAd(node: Element): boolean {
  if (!node.getAttribute) return false;
  const className = node.getAttribute("class")?.toLowerCase() ?? "";
  const id = node.getAttribute("id")?.toLowerCase() ?? "";
  return AD_KEYWORDS.some(keyword => className.includes(keyword) || id.includes(keyword));
}

function isNoiseBlock(node: HTMLElement): boolean {
  const text = node.textContent ?? "";
  const normalised = text.replace(/\s+/g, "").trim();
  if (!normalised) return false;
  return TEXT_NOISE_PATTERNS.some(pattern => pattern.test(normalised));
}

function absolutifyUrl(url: string, baseUrl: string): string {
  try {
    return new URL(url, baseUrl).toString();
  } catch (error) {
    console.warn("Failed to resolve URL", url, error);
    return url;
  }
}

/**
 * 清理微信公众号图片 URL，移除导致水印/追踪的参数。
 * data-src 通常只有 wx_fmt，而浏览器渲染后的 src 会被微信 JS 注入
 * tp=wxpic、wxfrom、wx_lazy、wx_co 等参数，这些参数会触发 CDN 添加水印。
 */
function cleanWeChatImageUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (!isWeChatImageHost(parsed.hostname)) {
      return url;
    }
    const paramsToRemove = ["tp", "wxfrom", "wx_lazy", "wx_co", "retryload", "watermark"];
    for (const param of paramsToRemove) {
      parsed.searchParams.delete(param);
    }
    // 移除 hash fragment（如 #imgIndex=0）
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return url;
  }
}

function isWeChatImageHost(hostname: string): boolean {
  return hostname.includes("mmbiz.qpic.cn") || hostname.includes("mmbiz.qlogo.cn");
}

/**
 * 通过 images.weserv.nl 代理微信图片，绕过防盗链和水印。
 * 微信 CDN 会根据 Referer 等请求上下文决定是否添加水印，
 * 代理服务以无上下文方式请求原始图片，从而获取无水印版本。
 */
function proxyWeChatImageUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (!isWeChatImageHost(parsed.hostname)) {
      return url;
    }
    const encodedUrl = encodeURIComponent(url);
    let proxyUrl = `https://images.weserv.nl/?url=${encodedUrl}`;
    // GIF 图片保留动画帧
    if (url.toLowerCase().includes("wx_fmt=gif") || url.toLowerCase().includes("/mmbiz_gif/")) {
      proxyUrl += "&n=-1";
    }
    return proxyUrl;
  } catch {
    return url;
  }
}

/**
 * 从 img 元素获取最佳图片 URL。
 * 优先使用 data-* 属性（懒加载原始 URL），避免浏览器渲染后 src 被注入水印/追踪参数
 * （如微信公众号的 tp=wxpic&wxfrom=5 等）。
 * srcset 放在最后，避免某些 CDN（如 Substack）在 srcset URL 中自带逗号时被错误拆分。
 */
function getImageSource(el: HTMLImageElement, baseUrl: string): string | null {
  // 1. 优先使用 data-* 属性（懒加载场景下保存的是原始干净 URL）
  const dataSrc = (
    el.getAttribute("data-src") ||
    el.getAttribute("data-original") ||
    el.getAttribute("data-actualsrc") ||
    el.getAttribute("data-url") ||
    el.getAttribute("data-lazy-src") ||
    el.getAttribute("data-srcset") ||
    el.getAttribute("data-medium") ||
    el.getAttribute("data-large") ||
    el.getAttribute("data-thumb") ||
    el.getAttribute("data-image") ||
    el.getAttribute("data-file") ||
    el.getAttribute("data-link")
  );

  if (dataSrc) {
    const resolved = absolutifyUrl(dataSrc, baseUrl);
    if (resolved.startsWith("http://") || resolved.startsWith("https://")) {
      return resolved;
    }
    if (!resolved.startsWith("(") && !resolved.includes("nonexistent") && !resolved.includes("undefined")) {
      return resolved;
    }
  }

  // 2. 回退到 src 属性
  const src = el.getAttribute("src");
  if (src) {
    const resolved = absolutifyUrl(src, baseUrl);
    if (resolved.startsWith("http://") || resolved.startsWith("https://")) {
      return resolved;
    }
    if (!resolved.startsWith("(") && !resolved.includes("nonexistent") && !resolved.includes("undefined")) {
      return resolved;
    }
  }

  // 3. 最后尝试 srcset（放最后避免 Substack 等 CDN 的逗号解析问题）
  const srcset = el.getAttribute("srcset");
  if (srcset) {
    const candidates = parseSrcset(srcset);
    if (candidates.length > 0) {
      const best = candidates.reduce((max, curr) =>
        (curr.width || curr.density || 0) > (max.width || max.density || 0) ? curr : max
      );
      if (best.url) {
        return absolutifyUrl(best.url, baseUrl);
      }
    }
  }

  return null;
}

function normalizeExtractedText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function isLikelyRecommendationBlock(container: ParentNode, text: string): boolean {
  const normalizedText = normalizeExtractedText(text);
  if (!normalizedText) {
    return false;
  }

  const followMatches = normalizedText.match(/\bFollow\b/gi) ?? [];
  const suggestionMatches = normalizedText.match(/\bSuggestions?\b/gi) ?? [];
  const links = Array.from(container.querySelectorAll("a"));
  const profileLinks = links.filter(link => {
    const href = link.getAttribute("href") ?? "";
    return href.includes("substack.com/@") || href.includes("substack.com/profile/");
  });

  return suggestionMatches.length >= 1 && followMatches.length >= 3 && profileLinks.length >= 3;
}

function extractCanonicalUrl(documentRef: Document, fallbackUrl: string): string | null {
  const candidates = [
    documentRef.querySelector('link[rel="canonical"]')?.getAttribute("href"),
    documentRef.querySelector('meta[property="og:url"]')?.getAttribute("content"),
    documentRef.querySelector('meta[name="twitter:url"]')?.getAttribute("content")
  ];

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }

    try {
      return new URL(candidate, fallbackUrl).toString();
    } catch (error) {
      console.warn("Failed to parse canonical URL", candidate, error);
    }
  }

  return null;
}

function decodeJsonParseStringLiteral(serialized: string): string | null {
  try {
    return JSON.parse(serialized) as string;
  } catch (error) {
    console.warn("Failed to decode JSON.parse string literal", error);
    return null;
  }
}

function extractSubstackPreloads(documentRef: Document): Record<string, unknown> | null {
  const scripts = Array.from(documentRef.querySelectorAll("script"));

  for (const script of scripts) {
    const text = script.textContent ?? "";
    if (!text.includes("window._preloads") || !text.includes("JSON.parse(")) {
      continue;
    }

    const match = text.match(/window\._preloads\s*=\s*JSON\.parse\((["'][\s\S]*?["'])\)/);
    if (!match?.[1]) {
      continue;
    }

    const decoded = decodeJsonParseStringLiteral(match[1]);
    if (!decoded) {
      continue;
    }

    try {
      return JSON.parse(decoded) as Record<string, unknown>;
    } catch (error) {
      console.warn("Failed to parse Substack preload payload", error);
    }
  }

  return null;
}

function extractSubstackByline(preloads: Record<string, unknown>): string | undefined {
  const publishedBylines = preloads.publishedBylines;
  if (!Array.isArray(publishedBylines)) {
    return undefined;
  }

  const names = publishedBylines
    .map(entry => (entry && typeof entry === "object" && "name" in entry ? entry.name : undefined))
    .filter((name): name is string => typeof name === "string" && name.trim().length > 0);

  return names.length ? names.join(", ") : undefined;
}

function extractSubstackCanonicalUrlFromPreloads(
  preloads: Record<string, unknown>,
  documentRef: Document,
  sourceUrl: string
): string | null {
  const post = preloads.post;
  const canonicalFromPost =
    post && typeof post === "object" && "canonical_url" in post && typeof post.canonical_url === "string"
      ? post.canonical_url
      : null;

  const canonicalFromRoot =
    "canonicalUrl" in preloads && typeof preloads.canonicalUrl === "string"
      ? preloads.canonicalUrl
      : null;

  return canonicalFromPost || canonicalFromRoot || extractCanonicalUrl(documentRef, sourceUrl);
}

function extractSubstackArticleFromPreloads(
  documentRef: Document,
  sourceUrl: string
): Omit<ArticleData, "fetchedAt"> | null {
  const preloads = extractSubstackPreloads(documentRef);
  if (!preloads) {
    return null;
  }

  const post = preloads.post;
  if (!post || typeof post !== "object") {
    return null;
  }

  const bodyHtml = "body_html" in post && typeof post.body_html === "string" ? post.body_html : null;
  if (!bodyHtml) {
    return null;
  }

  const canonicalUrl = extractSubstackCanonicalUrlFromPreloads(preloads, documentRef, sourceUrl);

  const articleUrl = getPreferredArticleUrl(sourceUrl, canonicalUrl);
  const tempContainer = documentRef.createElement("div");
  tempContainer.innerHTML = bodyHtml;
  tempContainer.querySelectorAll("script, style, noscript").forEach(node => node.remove());

  const images = sanitizeContent(tempContainer as HTMLElement, articleUrl);
  const textContent = tempContainer.textContent?.trim() ?? "";

  if (!hasMeaningfulArticleContent(tempContainer, textContent)) {
    return null;
  }

  const title =
    ("title" in post && typeof post.title === "string" ? post.title : null) ||
    documentRef.title ||
    t("defaultTitle");

  const excerpt =
    ("subtitle" in post && typeof post.subtitle === "string" ? post.subtitle : null) ||
    ("description" in post && typeof post.description === "string" ? post.description : null) ||
    ("truncated_body_text" in post && typeof post.truncated_body_text === "string" ? post.truncated_body_text : null) ||
    null;

  return {
    url: articleUrl,
    title,
    byline: extractSubstackByline(preloads),
    excerpt,
    contentHtml: tempContainer.innerHTML,
    textContent,
    images,
    language: documentRef.documentElement.lang || undefined
  };
}

function buildSubstackArticleFromSerializedPayload(
  documentRef: Document,
  sourceUrl: string,
  payload: SerializedSubstackRuntimeArticle
): Omit<ArticleData, "fetchedAt"> | null {
  const articleUrl = getPreferredArticleUrl(sourceUrl, payload.canonicalUrl ?? null);
  const tempContainer = documentRef.createElement("div");
  tempContainer.innerHTML = payload.bodyHtml;
  tempContainer.querySelectorAll("script, style, noscript").forEach(node => node.remove());

  const images = sanitizeContent(tempContainer as HTMLElement, articleUrl);
  const textContent = tempContainer.textContent?.trim() ?? "";
  if (!hasMeaningfulArticleContent(tempContainer, textContent)) {
    return null;
  }

  return {
    url: articleUrl,
    title: payload.title?.trim() || documentRef.title || t("defaultTitle"),
    byline: payload.byline,
    excerpt: payload.excerpt ?? undefined,
    contentHtml: tempContainer.innerHTML,
    textContent,
    images,
    language: documentRef.documentElement.lang || undefined
  };
}

function buildChatGptConversationFromSerializedPayload(
  documentRef: Document,
  sourceUrl: string,
  payload: SerializedChatGptConversation
): Omit<ArticleData, "fetchedAt"> | null {
  const tempContainer = documentRef.createElement("div");
  tempContainer.innerHTML = payload.bodyHtml;
  tempContainer.querySelectorAll("script, style, noscript").forEach(node => node.remove());

  const images = sanitizeContent(tempContainer as HTMLElement, sourceUrl);
  const textContent = tempContainer.textContent?.trim() ?? "";
  if (!hasMeaningfulArticleContent(tempContainer, textContent)) {
    return null;
  }

  const fallbackTitle = sourceUrl.includes("/share/")
    ? t("chatSharedConversationTitle")
    : t("chatConversationTitle");

  return {
    url: sourceUrl,
    title: payload.title?.trim() || documentRef.title || fallbackTitle,
    byline: "ChatGPT",
    excerpt: payload.excerpt ?? undefined,
    contentHtml: tempContainer.innerHTML,
    textContent,
    images: dedupeImages(images),
    language: payload.language || documentRef.documentElement.lang || undefined
  };
}

function buildGeminiConversationFromSerializedPayload(
  documentRef: Document,
  sourceUrl: string,
  payload: SerializedGeminiConversation
): Omit<ArticleData, "fetchedAt"> | null {
  const tempContainer = documentRef.createElement("div");
  tempContainer.innerHTML = payload.bodyHtml;
  tempContainer.querySelectorAll("script, style, noscript").forEach(node => node.remove());

  const images = sanitizeContent(tempContainer as HTMLElement, sourceUrl);
  const textContent = tempContainer.textContent?.trim() ?? "";
  if (!hasMeaningfulArticleContent(tempContainer, textContent)) {
    return null;
  }

  return {
    url: sourceUrl,
    title: payload.title?.trim() || documentRef.title || t("geminiConversationTitle"),
    byline: "Gemini",
    excerpt: payload.excerpt ?? undefined,
    contentHtml: tempContainer.innerHTML,
    textContent,
    images: dedupeImages(images),
    language: payload.language || documentRef.documentElement.lang || undefined
  };
}

function buildGrokConversationFromSerializedPayload(
  documentRef: Document,
  sourceUrl: string,
  payload: SerializedGrokConversation
): Omit<ArticleData, "fetchedAt"> | null {
  const tempContainer = documentRef.createElement("div");
  tempContainer.innerHTML = payload.bodyHtml;
  tempContainer.querySelectorAll("script, style, noscript").forEach(node => node.remove());

  const images = sanitizeContent(tempContainer as HTMLElement, sourceUrl);
  const textContent = tempContainer.textContent?.trim() ?? "";
  if (!hasMeaningfulArticleContent(tempContainer, textContent)) {
    return null;
  }

  return {
    url: sourceUrl,
    title: payload.title?.trim() || documentRef.title || t("grokConversationTitle"),
    byline: "Grok",
    excerpt: payload.excerpt ?? undefined,
    contentHtml: tempContainer.innerHTML,
    textContent,
    images: dedupeImages(images),
    language: payload.language || documentRef.documentElement.lang || undefined
  };
}

function extractSubstackCanonicalUrl(documentRef: Document, sourceUrl: string): string | null {
  const preloads = extractSubstackPreloads(documentRef);
  if (preloads) {
    return extractSubstackCanonicalUrlFromPreloads(preloads, documentRef, sourceUrl);
  }

  return extractCanonicalUrl(documentRef, sourceUrl);
}

function shouldResolveCanonicalSourceUrl(currentUrl: string, canonicalUrl: string | null): canonicalUrl is string {
  if (!canonicalUrl) {
    return false;
  }

  try {
    const current = new URL(currentUrl);
    const canonical = new URL(canonicalUrl);

    if (canonical.href === current.href) {
      return false;
    }

    return current.hostname === "substack.com" && current.pathname.startsWith("/home/post/");
  } catch {
    return false;
  }
}

function getPreferredArticleUrl(currentUrl: string, canonicalUrl: string | null): string {
  return shouldResolveCanonicalSourceUrl(currentUrl, canonicalUrl) ? canonicalUrl : currentUrl;
}

function isChatGptHost(hostname: string): boolean {
  return hostname === "chatgpt.com" || hostname === "chat.openai.com";
}

function isChatGptConversationUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return isChatGptHost(parsed.hostname) && (parsed.pathname.startsWith("/c/") || parsed.pathname.startsWith("/share/"));
  } catch {
    return false;
  }
}

function isGeminiHost(hostname: string): boolean {
  return hostname === "gemini.google.com";
}

function isGeminiConversationUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return isGeminiHost(parsed.hostname) && parsed.pathname.startsWith("/app/");
  } catch {
    return false;
  }
}

function isGrokHost(hostname: string): boolean {
  return hostname === "grok.com" || hostname === "www.grok.com";
}

function isGrokConversationUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return isGrokHost(parsed.hostname) && (parsed.pathname.startsWith("/c/") || parsed.pathname.startsWith("/share/"));
  } catch {
    return false;
  }
}

function scoreContentCandidate(element: Element): number {
  const clone = element.cloneNode(true) as HTMLElement;
  clone.querySelectorAll("script, style, noscript, svg, form, input, textarea, select, button, nav, footer, aside").forEach(node => node.remove());

  const text = normalizeExtractedText(clone.textContent ?? "");
  const textLength = text.length;
  if (textLength < 80) {
    return Number.NEGATIVE_INFINITY;
  }

  if (isLikelyRecommendationBlock(clone, text)) {
    return Number.NEGATIVE_INFINITY;
  }

   if (
    /Discussion about this post/i.test(text) ||
    /Ready for more\?/i.test(text) ||
    /TopLatestDiscussions/i.test(text) ||
    /CommentsRestacks/i.test(text)
  ) {
    return Number.NEGATIVE_INFINITY;
  }

  const paragraphCount = clone.querySelectorAll("p").length;
  const listCount = clone.querySelectorAll("li").length;
  const quoteCount = clone.querySelectorAll("blockquote").length;
  const codeBlockCount = clone.querySelectorAll("pre").length;
  const headingCount = clone.querySelectorAll("h2, h3, h4, h5, h6").length;
  const imageCount = clone.querySelectorAll("img").length;
  const linkCount = clone.querySelectorAll("a").length;
  const buttonCount = clone.querySelectorAll("button").length;

  let score = Math.min(textLength, 12000);
  score += paragraphCount * 260;
  score += listCount * 80;
  score += quoteCount * 140;
  score += codeBlockCount * 140;
  score += headingCount * 110;
  score += imageCount * 30;
  score -= linkCount * 6;
  score -= buttonCount * 100;

  if (paragraphCount === 0 && listCount === 0 && quoteCount === 0 && codeBlockCount === 0) {
    score -= 800;
  }

  if (paragraphCount < 2 && textLength < 1200) {
    score -= 500;
  }

  const className = element.getAttribute("class")?.toLowerCase() ?? "";
  const id = element.getAttribute("id")?.toLowerCase() ?? "";
  const marker = `${className} ${id}`;

  if (/(content|body|article|post|markup|prose|story)/.test(marker)) {
    score += 140;
  }

  if (/(header|hero|meta|author|toolbar|sidebar|footer|related|recommend)/.test(marker)) {
    score -= 220;
  }

  if (/(comment|discussion|reply|restack)/.test(marker)) {
    score -= 1200;
  }

  if (element.tagName.toLowerCase() === "article") {
    score += 120;
  }

  if (element.tagName.toLowerCase() === "main") {
    score -= 80;
  }

  return score;
}

function findBestContentContainer(documentRef: Document): Element | null {
  const selectors = [
    "#js_content",                 // 微信公众号正文容器
    ".rich_media_content",         // 微信公众号正文 class
    ".available-content .body.markup",
    ".available-content .markup",
    ".available-content",
    ".body.markup",
    ".substack-post-body",
    ".post-body",
    ".post-content",
    ".article-content",
    ".entry-content",
    '[data-testid="post-body"]',
    '[data-testid*="post"]',
    '[class*="post-body"]',
    '[class*="post-content"]',
    '[class*="article-content"]',
    '[class*="article-body"]',
    '[class*="markup"]',
    '[class*="prose"]',
    '[class*="story-body"]',
    "article",
    '[role="article"]',
    "main",
    '[role="main"]'
  ];

  const seen = new Set<Element>();
  const candidates: Array<{ element: Element; score: number }> = [];

  for (const selector of selectors) {
    const elements = Array.from(documentRef.querySelectorAll(selector));
    for (const element of elements) {
      if (seen.has(element)) {
        continue;
      }

      seen.add(element);
      const score = scoreContentCandidate(element);
      if (Number.isFinite(score)) {
        candidates.push({ element, score });
      }
    }
  }

  candidates.sort((left, right) => right.score - left.score);
  return candidates[0]?.element ?? null;
}

function hasMeaningfulArticleContent(container: ParentNode, text: string): boolean {
  const normalizedText = normalizeExtractedText(text);
  if (normalizedText.length < 180) {
    return false;
  }

  if (isLikelyRecommendationBlock(container, normalizedText)) {
    return false;
  }

  const paragraphCount = container.querySelectorAll("p").length;
  const listCount = container.querySelectorAll("li").length;
  const quoteCount = container.querySelectorAll("blockquote").length;
  const codeBlockCount = container.querySelectorAll("pre").length;
  const blockCount = paragraphCount + listCount + quoteCount + codeBlockCount;

  if (paragraphCount >= 2 || blockCount >= 3) {
    return true;
  }

  return normalizedText.length >= 1200;
}

function parseSrcset(srcset: string): Array<{ url: string; width?: number; density?: number }> {
  const candidates: Array<{ url: string; width?: number; density?: number }> = [];
  const candidatePattern = /(\S[\s\S]*?\S)\s+(\d+w|\d+(?:\.\d+)?x)(?:\s*,\s*|$)/g;

  for (const match of srcset.matchAll(candidatePattern)) {
    const url = match[1]?.trim();
    const descriptor = match[2]?.trim();
    if (!url || !descriptor) {
      continue;
    }

    const widthMatch = descriptor.match(/^(\d+)w$/);
    if (widthMatch) {
      candidates.push({ url, width: parseInt(widthMatch[1], 10) });
      continue;
    }

    const densityMatch = descriptor.match(/^(\d+(?:\.\d+)?)x$/);
    if (densityMatch) {
      candidates.push({ url, density: parseFloat(densityMatch[1]) });
      continue;
    }

    candidates.push({ url });
  }

  if (candidates.length > 0) {
    return candidates;
  }

  const fallback = srcset.trim();
  return fallback ? [{ url: fallback }] : [];
}

function sanitizeContent(container: HTMLElement, baseUrl: string): ImageAsset[] {
  const images: ImageAsset[] = [];
  const elements = Array.from(container.querySelectorAll("*"));

  // 第一步：处理 picture 元素的 source 标签，转换为 img 标签
  container.querySelectorAll("picture").forEach(picture => {
    const sources = Array.from(picture.querySelectorAll("source"));
    for (const source of sources) {
      const srcset = source.getAttribute("srcset");
      const media = source.getAttribute("media");
      if (srcset) {
        // 创建临时的 img 元素以保持一致的处理逻辑
        const img = container.ownerDocument.createElement("img");
        img.setAttribute("srcset", srcset);
        if (media) img.setAttribute("data-media", media);
        // 将 img 插入到 picture 的最后
        picture.appendChild(img);
      }
    }
  });

  for (const el of elements) {
    if (el instanceof HTMLElement && (isLikelyAd(el) || isNoiseBlock(el))) {
      el.remove();
      continue;
    }

    if (el instanceof HTMLAnchorElement) {
      el.referrerPolicy = "no-referrer";
      el.rel = "noreferrer noopener";
      el.href = absolutifyUrl(el.href, baseUrl);
    }

    if (el instanceof HTMLImageElement) {
      // 检查是否在包含"广告"的 figure 标签内
      const figureEl = el.closest("figure");
      if (figureEl?.innerText.replace(/\s+/g, "").includes("广告")) {
        el.remove();
        continue;
      }

      // 检查是否是 Lazy Loaded 图片
      const isLazyLoaded = el.hasAttribute("data-src") ||
                           el.hasAttribute("data-original") ||
                           el.hasAttribute("data-lazy-src") ||
                           el.classList.contains("lazy") ||
                           el.classList.contains("lazyload");

      // 使用增强版的图片源获取方法
      let source = getImageSource(el, baseUrl);

      // 如果还是没有找到源，尝试从父元素或相邻元素寻找
      if (!source) {
        // 尝试从父标签获取 background-image
        const parent = el.parentElement;
        if (parent) {
          const parentStyle = parent.getAttribute("style");
          if (parentStyle) {
            const bgMatch = parentStyle.match(/background-image:\s*url\(['"]?([^'")]+)['"]?\)/i);
            if (bgMatch && bgMatch[1]) {
              source = absolutifyUrl(bgMatch[1], baseUrl);
            }
          }
        }
      }

      // 如果还是没有找到源，检查是否有 src 但被过滤掉了
      if (!source) {
        const rawSrc = el.getAttribute("src");
        if (rawSrc) {
          // 尝试直接使用原始 src（即使是看起来像占位符的值）
          const resolved = absolutifyUrl(rawSrc, baseUrl);
          // 排除明显的占位符
          const placeholders = ["placeholder", "blank", "transparent", "1x1", "pixel", "spacer"];
          const isPlaceholder = placeholders.some(p => resolved.toLowerCase().includes(p));
          if (!isPlaceholder && resolved.length > 10) {
            source = resolved;
          }
        }
      }

      if (!source) {
        // 如果还是无法获取图片源，保留图片但标记为无效
        // 而不是直接删除，这样可以在后续处理中保留结构
        console.warn("无法解析图片源:", el.outerHTML.slice(0, 200));
        el.remove();
        continue;
      }

      // 清理微信图片 URL 中的水印/追踪参数，然后通过代理绕过防盗链
      source = cleanWeChatImageUrl(source);
      source = proxyWeChatImageUrl(source);

      el.src = source;
      el.removeAttribute("srcset");
      el.removeAttribute("data-src");
      el.removeAttribute("data-original");
      el.removeAttribute("data-actualsrc");
      el.removeAttribute("data-url");
      el.removeAttribute("data-lazy-src");
      el.removeAttribute("data-srcset");
      el.removeAttribute("data-medium");
      el.removeAttribute("data-large");
      el.removeAttribute("data-thumb");
      el.removeAttribute("data-image");
      el.removeAttribute("data-file");
      el.removeAttribute("data-link");

      images.push({
        url: source,
        alt: el.alt || undefined
      });

      const altCaption = el.closest("figure")?.querySelector("figcaption");
      if (altCaption && !el.alt) {
        el.alt = altCaption.textContent?.trim() ?? "";
      }
    }

    if (el instanceof HTMLDivElement && el.querySelector("iframe")) {
      el.remove();
    }
  }

  return images;
}

/**
 * 从指定标签页获取页面内容
 * 通过注入脚本获取已加载页面的完整 DOM，适用于需要登录或动态加载的网站
 */
async function fetchArticleFromTab(tabId: number, url: string): Promise<ArticleData> {
  try {
    // 对于微信公众号文章，通过原始 HTTP 请求获取未被 JS 修改的图片 URL。
    // 微信的页面 JS 会在浏览器中将 data-src 中的图片路径替换为完全不同的
    // 带水印版本（不同的 CDN 路径），因此从 DOM 中读取的 data-src 已经不是原始值。
    // 直接 fetch 原始 HTML 可以拿到未被修改的 data-src，从而获取无水印图片。
    const isWeChatArticle = (() => {
      try {
        return new URL(url).hostname === "mp.weixin.qq.com";
      } catch {
        return false;
      }
    })();

    let rawWeChatImageUrls: string[] = [];
    if (isWeChatArticle) {
      try {
        // 在页面上下文中执行 fetch，自动带上浏览器的 cookies 和请求头
        const rawResults = await chrome.scripting.executeScript({
          target: { tabId },
          func: async () => {
            try {
              const resp = await fetch(location.href, { cache: "no-store" });
              if (!resp.ok) return [];
              const html = await resp.text();
              // 使用 DOMParser 精确解析，只从文章正文容器中提取图片
              const rawDoc = new DOMParser().parseFromString(html, "text/html");
              const contentEl = rawDoc.querySelector("#js_content") || rawDoc.querySelector(".rich_media_content");
              if (!contentEl) return [];
              const imgs = contentEl.querySelectorAll("img[data-src]");
              const urls: string[] = [];
              imgs.forEach(img => {
                const ds = img.getAttribute("data-src");
                if (ds && (ds.includes("mmbiz.qpic.cn") || ds.includes("mmbiz.qlogo.cn"))) {
                  urls.push(ds);
                }
              });
              return urls;
            } catch {
              return [];
            }
          }
        });
        rawWeChatImageUrls = (rawResults?.[0]?.result as string[] | undefined) ?? [];
        console.log(`从微信原始 HTML 提取到 ${rawWeChatImageUrls.length} 个原始图片 URL`);
      } catch (error) {
        console.warn("获取微信原始图片 URL 失败:", error);
      }
    }

    // 等待一小段时间让图片完全加载（针对懒加载图片）
    await new Promise(resolve => setTimeout(resolve, 1000));

    if (isChatGptConversationUrl(url)) {
      const chatResults = await chrome.scripting.executeScript({
        target: { tabId },
        args: [
          t("chatGptRoleYouSaid"),
          t("chatGptRoleAssistantSaid"),
          t("chatConversationTitle"),
          t("chatSharedConversationTitle")
        ],
        func: (
          userRoleLabel: string,
          assistantRoleLabel: string,
          conversationTitle: string,
          sharedConversationTitle: string
        ) => {
          const normalizeText = (value: string | null | undefined) =>
            (value ?? "").replace(/\r\n?/g, "\n").replace(/\u00A0/g, " ").trim();

          const collectRoots = () => {
            const roots: ParentNode[] = [document];
            const queue: ParentNode[] = [document];
            const seen = new Set<ParentNode>([document]);

            while (queue.length > 0) {
              const root = queue.shift();
              if (!root || typeof (root as ParentNode).querySelectorAll !== "function") {
                continue;
              }

              const elements = Array.from(root.querySelectorAll("*"));
              for (const element of elements) {
                if (element.shadowRoot && !seen.has(element.shadowRoot)) {
                  seen.add(element.shadowRoot);
                  roots.push(element.shadowRoot);
                  queue.push(element.shadowRoot);
                }
              }
            }

            return roots;
          };

          const isSameTurnDescendant = (candidate: Element, turn: HTMLElement) => {
            const closest = candidate.closest("[data-message-author-role]");
            return !closest || closest === turn;
          };

          const scoreContentNode = (candidate: HTMLElement) => {
            const textLength = normalizeText(candidate.innerText || candidate.textContent).length;
            const paragraphCount = candidate.querySelectorAll("p").length;
            const codeCount = candidate.querySelectorAll("pre, code").length;
            const listCount = candidate.querySelectorAll("li").length;
            const imageCount = candidate.querySelectorAll("img").length;
            return textLength + paragraphCount * 180 + codeCount * 220 + listCount * 90 + imageCount * 60;
          };

          const findTurnContent = (turn: HTMLElement) => {
            const selectors = [
              '[data-testid="conversation-turn-content"]',
              '[data-message-id]',
              '.markdown',
              '[class*="markdown"]',
              '.prose',
              '[class*="prose"]',
              'pre',
              'p',
              'ol',
              'ul',
              'table',
              '[dir="auto"]'
            ];

            const candidates: HTMLElement[] = [];
            for (const selector of selectors) {
              const matches = turn.matches(selector) ? [turn] : [];
              const descendants = Array.from(turn.querySelectorAll<HTMLElement>(selector))
                .filter(candidate => isSameTurnDescendant(candidate, turn));
              for (const match of [...matches, ...descendants]) {
                if (!candidates.includes(match)) {
                  candidates.push(match);
                }
              }
            }

            candidates.sort((left, right) => scoreContentNode(right) - scoreContentNode(left));
            return candidates[0] ?? turn;
          };

          const sanitizeTurnClone = (source: HTMLElement) => {
            const clone = source.cloneNode(true) as HTMLElement;
            clone.querySelectorAll(
              "button, textarea, input, select, form, nav, aside, footer, canvas, svg, audio, video"
            ).forEach(node => node.remove());

            clone.querySelectorAll<HTMLElement>("[contenteditable]").forEach(node => {
              node.removeAttribute("contenteditable");
            });

            clone.querySelectorAll<HTMLElement>("[aria-hidden='true']").forEach(node => {
              if (!node.querySelector("img") && normalizeText(node.textContent).length === 0) {
                node.remove();
              }
            });

            const hasStructuredContent = !!clone.querySelector(
              "p, pre, ul, ol, li, table, blockquote, h1, h2, h3, h4, h5, h6, img"
            );

            if (!hasStructuredContent) {
              const text = normalizeText(source.innerText || source.textContent);
              clone.innerHTML = "";

              const paragraphs = text
                .split(/\n{2,}/)
                .map(part => part.trim())
                .filter(Boolean);

              for (const paragraphText of paragraphs) {
                const paragraph = document.createElement("p");
                paragraph.textContent = paragraphText;
                clone.appendChild(paragraph);
              }
            }

            return clone;
          };

          const roots = collectRoots();
          const turns: HTMLElement[] = [];
          const seen = new Set<HTMLElement>();

          for (const root of roots) {
            const matches = Array.from(root.querySelectorAll<HTMLElement>("[data-message-author-role]"));
            for (const match of matches) {
              const role = match.getAttribute("data-message-author-role");
              if (role !== "user" && role !== "assistant") {
                continue;
              }

              const parentRoleNode = match.parentElement?.closest("[data-message-author-role]");
              if (parentRoleNode) {
                continue;
              }

              if (!seen.has(match)) {
                seen.add(match);
                turns.push(match);
              }
            }
          }

          if (turns.length === 0) {
            return null;
          }

          const article = document.createElement("article");
          let firstUserText = "";
          let firstAssistantText = "";

          for (const turn of turns) {
            const role = turn.getAttribute("data-message-author-role") ?? "assistant";
            const source = findTurnContent(turn);
            const clone = sanitizeTurnClone(source);
            const text = normalizeText(clone.innerText || clone.textContent);
            const hasImage = !!clone.querySelector("img");

            if (!text && !hasImage) {
              continue;
            }

            if (!firstUserText && role === "user") {
              firstUserText = text;
            }
            if (!firstAssistantText && role === "assistant") {
              firstAssistantText = text;
            }

            const section = document.createElement("section");
            section.setAttribute("data-chatgpt-role", role);

            const heading = document.createElement("h1");
            heading.textContent = role === "user" ? userRoleLabel : assistantRoleLabel;
            section.appendChild(heading);

            if (clone.childNodes.length > 0) {
              section.append(...Array.from(clone.childNodes));
            } else if (text) {
              const paragraph = document.createElement("p");
              paragraph.textContent = text;
              section.appendChild(paragraph);
            }

            article.appendChild(section);
          }

          const titleFromDocument = (document.title || "")
            .replace(/\s*[-|]\s*ChatGPT\s*$/i, "")
            .trim();

          const defaultConversationTitle = location.pathname.startsWith("/share/")
            ? sharedConversationTitle
            : conversationTitle;
          const fallbackTitle = firstUserText ? firstUserText.slice(0, 80) : defaultConversationTitle;
          const excerptSource = firstAssistantText || firstUserText;

          return {
            title: titleFromDocument || fallbackTitle,
            excerpt: excerptSource ? excerptSource.slice(0, 220) : null,
            bodyHtml: article.innerHTML,
            language: document.documentElement.lang || null
          };
        }
      });

      const chatPayload = chatResults?.[0]?.result as SerializedChatGptConversation | null | undefined;
      if (chatPayload?.bodyHtml) {
        const chatDoc = new DOMParser().parseFromString("<!DOCTYPE html><html><head></head><body></body></html>", "text/html");
        const chatArticle = buildChatGptConversationFromSerializedPayload(chatDoc, url, chatPayload);
        if (chatArticle) {
          console.log(`从 ChatGPT 标签页提取正文：${chatArticle.images.length} 张图片，${chatArticle.textContent.length} 字符`);
          return {
            ...chatArticle,
            fetchedAt: Date.now()
          };
        }
      }
    }

    if (isGeminiConversationUrl(url)) {
      const geminiResults = await chrome.scripting.executeScript({
        target: { tabId },
        args: [t("geminiRoleYouSaid"), t("geminiRoleAssistantSaid"), t("geminiConversationTitle")],
        func: (userRoleLabel: string, assistantRoleLabel: string, fallbackConversationTitle: string) => {
          type ConversationRole = "user" | "assistant";
          type Marker = {
            element: HTMLElement;
            role: ConversationRole;
            text: string;
          };

          const normalizeText = (value: string | null | undefined) =>
            (value ?? "").replace(/\r\n?/g, "\n").replace(/\u00A0/g, " ").replace(/\s+/g, " ").trim();

          const isUserRoleText = (text: string) => /^你说$/i.test(text) || /^You said$/i.test(text);
          const isAssistantRoleText = (text: string) => /^Gemini\s*说$/i.test(text) || /^Gemini said$/i.test(text);
          const isCustomAssistantRoleText = (text: string) => {
            if (!text || isUserRoleText(text) || isAssistantRoleText(text)) {
              return false;
            }

            return (
              /^[\p{Script=Han}\p{Letter}\p{Number}][\p{Script=Han}\p{Letter}\p{Number}\s._-]{0,31}\s*说$/u.test(text) ||
              /^[\p{Letter}\p{Number}][\p{Letter}\p{Number}\s._-]{0,31}\s+said$/iu.test(text)
            );
          };
          const matchRole = (text: string): ConversationRole | null => {
            if (isUserRoleText(text)) {
              return "user";
            }
            if (isAssistantRoleText(text) || isCustomAssistantRoleText(text)) {
              return "assistant";
            }
            return null;
          };

          const exactNoisePatterns = [
            /^与 Gemini 对话$/i,
            /^Chat with Gemini$/i,
            /^Gemini$/i,
            /^升级到 Google AI(?: Plus| Pro)?$/i,
            /^Upgrade to Google AI(?: Plus| Pro)?$/i,
            /^Google AI (?:Plus| Pro)$/i,
            /^自定义 Gem$/i,
            /^Custom Gem$/i,
            /^显示思路$/i,
            /^Show thinking$/i,
            /^导出到 Google 表格$/i,
            /^Export to Google Sheets$/i,
            /^工具$/i,
            /^Tools$/i,
            /^Pro$/i
          ];
          const blockNoisePatterns = [
            /Gemini 是一款 AI 工具/i,
            /Gemini is an AI tool/i,
            /你的隐私权与 Gemini/i,
            /Your privacy & Gemini/i,
            /opens in a new window/i
          ];

          const isNoiseText = (text: string) =>
            exactNoisePatterns.some(pattern => pattern.test(text)) || blockNoisePatterns.some(pattern => pattern.test(text));

          const cleanDocumentTitle = (value: string | null | undefined) =>
            normalizeText(value)
              .replace(/\s*[-|]\s*(?:Google\s+)?Gemini\s*$/i, "")
              .trim();

          const extractConversationTitle = () => {
            const titleFromDocument = cleanDocumentTitle(document.title);
            if (titleFromDocument && !/^Gemini$/i.test(titleFromDocument)) {
              return titleFromDocument;
            }

            const scope = document.querySelector("main") ?? document.body;
            const viewportWidth = Math.max(window.innerWidth, document.documentElement.clientWidth || 0);
            const viewportHeight = Math.max(window.innerHeight, document.documentElement.clientHeight || 0);
            const candidates = Array.from(scope.querySelectorAll<HTMLElement>("h1, h2, div, span"))
              .map(element => {
                if (element.closest("nav, aside, footer, button, form")) {
                  return null;
                }

                const text = normalizeText(element.innerText || element.textContent);
                if (
                  !text ||
                  text.length < 4 ||
                  text.length > 80 ||
                  isNoiseText(text) ||
                  isUserRoleText(text) ||
                  isAssistantRoleText(text) ||
                  isCustomAssistantRoleText(text)
                ) {
                  return null;
                }

                const rect = element.getBoundingClientRect();
                if (rect.width < 60 || rect.height < 16 || rect.top > viewportHeight * 0.35) {
                  return null;
                }

                const centerOffset = Math.abs(rect.left + rect.width / 2 - viewportWidth / 2);
                const headingBonus = /^H[12]$/.test(element.tagName) ? 600 : 0;
                const topBonus = Math.max(0, 260 - rect.top);
                const centerBonus = Math.max(0, 420 - centerOffset);
                const widthPenalty = Math.max(0, rect.width - viewportWidth * 0.6) / 2;

                return {
                  text,
                  score: headingBonus + topBonus + centerBonus - widthPenalty
                };
              })
              .filter((candidate): candidate is { text: string; score: number } => !!candidate);

            candidates.sort((left, right) => right.score - left.score);
            return candidates[0]?.text ?? "";
          };

          const collectRoleMarkers = (): Marker[] => {
            const scope = document.querySelector("main") ?? document.body;
            const rawMarkers = Array.from(
              scope.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6, p, span, div, strong, section")
            )
              .map(element => {
                const text = normalizeText(element.textContent);
                const role = matchRole(text);
                if (!role) {
                  return null;
                }
                if (element.closest("nav, aside, footer")) {
                  return null;
                }
                return { element, role, text };
              })
              .filter((marker): marker is Marker => !!marker);

            const deduped = rawMarkers.filter(candidate => {
              return !rawMarkers.some(
                other =>
                  other !== candidate &&
                  other.role === candidate.role &&
                  candidate.element.contains(other.element) &&
                  other.text === candidate.text
              );
            });

            deduped.sort((left, right) => {
              if (left.element === right.element) {
                return 0;
              }
              return left.element.compareDocumentPosition(right.element) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
            });

            return deduped;
          };

          const waitForMarkers = async () => {
            const startedAt = Date.now();
            while (Date.now() - startedAt < 8000) {
              const markers = collectRoleMarkers();
              if (markers.some(marker => marker.role === "user") && markers.some(marker => marker.role === "assistant")) {
                return markers;
              }
              await new Promise(resolve => setTimeout(resolve, 250));
            }
            return collectRoleMarkers();
          };

          const markerContainsOtherTurn = (container: HTMLElement, currentMarker: Marker, markers: Marker[]) =>
            markers.some(marker => marker !== currentMarker && container.contains(marker.element));

          const comesBefore = (left: Node, right: Node) =>
            !!(left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING);

          const findContentElementAfterMarker = (marker: Marker, nextMarker?: Marker) => {
            const scope = document.querySelector("main") ?? document.body;
            const markerTop = marker.element.getBoundingClientRect().top;
            const candidates = Array.from(
              scope.querySelectorAll<HTMLElement>("article, section, div, p, ul, ol, li, pre, table, blockquote")
            )
              .map(element => {
                if (element === marker.element || element.contains(marker.element) || element.closest("nav, aside, footer, button, form")) {
                  return null;
                }

                if (!comesBefore(marker.element, element)) {
                  return null;
                }

                if (nextMarker && !comesBefore(element, nextMarker.element)) {
                  return null;
                }

                const rect = element.getBoundingClientRect();
                if (rect.width < 120 || rect.height < 18 || rect.top + 4 < markerTop) {
                  return null;
                }

                const text = normalizeText(element.innerText || element.textContent);
                if (!text || isNoiseText(text) || isUserRoleText(text) || isAssistantRoleText(text) || isCustomAssistantRoleText(text)) {
                  return null;
                }

                const structuredCount = element.querySelectorAll("p, pre, ul, ol, li, table, blockquote, img").length;
                const headingCount = element.querySelectorAll("h1, h2, h3, h4, h5, h6").length;
                if (text.length < 24 && structuredCount === 0 && headingCount === 0) {
                  return null;
                }

                const distancePenalty = Math.max(0, rect.top - markerTop);
                return {
                  element,
                  score: structuredCount * 280 + headingCount * 180 + Math.min(text.length, 2400) - distancePenalty
                };
              })
              .filter((candidate): candidate is { element: HTMLElement; score: number } => !!candidate);

            candidates.sort((left, right) => right.score - left.score);
            return candidates[0]?.element ?? null;
          };

          const findTurnContainer = (marker: Marker, markers: Marker[]) => {
            let candidate: HTMLElement | null = null;

            for (let current: HTMLElement | null = marker.element; current && current !== document.body; current = current.parentElement) {
              const text = normalizeText(current.innerText || current.textContent);
              const hasStructuredContent = !!current.querySelector(
                "p, pre, ul, ol, li, table, blockquote, img, h1, h2, h3, h4, h5, h6"
              );
              const containsOtherTurn = markerContainsOtherTurn(current, marker, markers);

              if (!containsOtherTurn && (text.length >= marker.text.length + 20 || hasStructuredContent)) {
                candidate = current;
                continue;
              }

              if (containsOtherTurn && candidate) {
                break;
              }
            }

            return candidate ?? marker.element.parentElement ?? marker.element;
          };

          const sanitizeTurnClone = (source: HTMLElement) => {
            const clone = source.cloneNode(true) as HTMLElement;

            clone.querySelectorAll(
              "button, textarea, input, select, form, nav, aside, footer, canvas, svg, audio, video"
            ).forEach(node => node.remove());

            clone.querySelectorAll<HTMLElement>("[contenteditable]").forEach(node => {
              node.removeAttribute("contenteditable");
            });

            clone.querySelectorAll<HTMLElement>("img").forEach(img => {
              const alt = normalizeText(img.getAttribute("alt"));
              const src = img.getAttribute("src") ?? "";
              if (
                /个人资料|头像|profile photo|profile picture|avatar/i.test(alt) ||
                /googleusercontent\.com\/a\//i.test(src)
              ) {
                img.remove();
              }
            });

            const allNodes = [clone, ...Array.from(clone.querySelectorAll<HTMLElement>("*"))];
            for (const node of allNodes.reverse()) {
              if (node.closest("pre, code")) {
                continue;
              }

              const text = normalizeText(node.innerText || node.textContent);
              if (!text) {
                continue;
              }

              const isRoleHeading = isUserRoleText(text) || isAssistantRoleText(text) || isCustomAssistantRoleText(text);
              const isExactNoise = exactNoisePatterns.some(pattern => pattern.test(text));
              const isBlockNoise = text.length <= 260 && blockNoisePatterns.some(pattern => pattern.test(text));
              const isCustomGemAvatar = text.length <= 2 && /^(?:[\p{Script=Han}\p{Letter}])$/u.test(text);

              if (isRoleHeading || isExactNoise || isBlockNoise || isCustomGemAvatar) {
                node.remove();
              }
            }

            clone.querySelectorAll<HTMLElement>("a").forEach(link => {
              if (isNoiseText(normalizeText(link.textContent)) && !link.querySelector("img")) {
                link.remove();
              }
            });

            clone.querySelectorAll<HTMLElement>("div, section, article, span, p, li").forEach(node => {
              const text = normalizeText(node.innerText || node.textContent);
              if (!text && !node.querySelector("img, pre, code, table, ul, ol, blockquote")) {
                node.remove();
              }
            });

            const hasStructuredContent = !!clone.querySelector(
              "p, pre, ul, ol, li, table, blockquote, h1, h2, h3, h4, h5, h6, img"
            );

            if (!hasStructuredContent) {
              const text = normalizeText(source.innerText || source.textContent);
              clone.innerHTML = "";

              const paragraphs = text
                .split(/\n{2,}/)
                .map(part => part.trim())
                .filter(part => part && !isNoiseText(part) && !isUserRoleText(part) && !isAssistantRoleText(part));

              for (const paragraphText of paragraphs) {
                const paragraph = document.createElement("p");
                paragraph.textContent = paragraphText;
                clone.appendChild(paragraph);
              }
            }

            return clone;
          };

          return waitForMarkers().then(markers => {
            if (markers.length === 0) {
              return null;
            }

            const article = document.createElement("article");
            const seenTurnContainers = new Set<HTMLElement>();
            let firstUserText = "";
            let firstAssistantText = "";

            for (const [index, marker] of markers.entries()) {
              const nextMarker = markers[index + 1];
              let container = findTurnContainer(marker, markers);
              if (seenTurnContainers.has(container)) {
                continue;
              }

              let clone = sanitizeTurnClone(container);
              let text = normalizeText(clone.innerText || clone.textContent);
              let hasImage = !!clone.querySelector("img");

              if (!text && !hasImage) {
                const fallbackContainer = findContentElementAfterMarker(marker, nextMarker);
                if (fallbackContainer && !seenTurnContainers.has(fallbackContainer)) {
                  container = fallbackContainer;
                  clone = sanitizeTurnClone(container);
                  text = normalizeText(clone.innerText || clone.textContent);
                  hasImage = !!clone.querySelector("img");
                }
              }

              if (!text && !hasImage) {
                continue;
              }

              seenTurnContainers.add(container);

              if (!firstUserText && marker.role === "user") {
                firstUserText = text;
              }
              if (!firstAssistantText && marker.role === "assistant") {
                firstAssistantText = text;
              }

              const section = document.createElement("section");
              section.setAttribute("data-gemini-role", marker.role);

              const heading = document.createElement("h1");
              heading.textContent = marker.role === "user" ? userRoleLabel : assistantRoleLabel;
              section.appendChild(heading);

              if (clone.childNodes.length > 0) {
                section.append(...Array.from(clone.childNodes));
              } else if (text) {
                const paragraph = document.createElement("p");
                paragraph.textContent = text;
                section.appendChild(paragraph);
              }

              article.appendChild(section);
            }

            if (!article.childNodes.length) {
              return null;
            }

            const titleFromDocument = extractConversationTitle();

            const fallbackTitle = firstUserText ? firstUserText.slice(0, 80) : fallbackConversationTitle;
            const excerptSource = firstAssistantText || firstUserText;

            return {
              title: titleFromDocument || fallbackTitle,
              excerpt: excerptSource ? excerptSource.slice(0, 220) : null,
              bodyHtml: article.innerHTML,
              language: document.documentElement.lang || navigator.language || null
            };
          });
        }
      });

      const geminiPayload = geminiResults?.[0]?.result as SerializedGeminiConversation | null | undefined;
      if (geminiPayload?.bodyHtml) {
        const geminiDoc = new DOMParser().parseFromString("<!DOCTYPE html><html><head></head><body></body></html>", "text/html");
        const geminiArticle = buildGeminiConversationFromSerializedPayload(geminiDoc, url, geminiPayload);
        if (geminiArticle) {
          console.log(`从 Gemini 标签页提取正文：${geminiArticle.images.length} 张图片，${geminiArticle.textContent.length} 字符`);
          return {
            ...geminiArticle,
            fetchedAt: Date.now()
          };
        }
      }
    }

    if (isGrokConversationUrl(url)) {
      const grokResults = await chrome.scripting.executeScript({
        target: { tabId },
        args: [t("grokRoleYouSaid"), t("grokRoleAssistantSaid"), t("grokConversationTitle")],
        func: async (userRoleLabel: string, assistantRoleLabel: string, fallbackConversationTitle: string) => {
          type ConversationRole = "user" | "assistant";
          type GrokTurn = {
            role: ConversationRole;
            text: string;
            order: number;
            timestamp?: number;
            element?: HTMLElement;
            top?: number;
          };

          const normalizeText = (value: string | null | undefined) =>
            (value ?? "").replace(/\r\n?/g, "\n").replace(/\u00A0/g, " ").replace(/[ \t]+/g, " ").trim();

          const unique = <T,>(items: T[]) => Array.from(new Set(items));

          const isUiNoiseText = (text: string) => {
            if (!text) {
              return true;
            }

            return [
              /^分享$/i,
              /^share$/i,
              /^编辑$/i,
              /^edit$/i,
              /^复制$/i,
              /^copy$/i,
              /^重试$/i,
              /^retry$/i,
              /^重新生成$/i,
              /^regenerate$/i,
              /^搜索$/i,
              /^search$/i,
              /^语音$/i,
              /^voice$/i,
              /^expert$/i,
              /^deepsearch$/i,
              /^grok$/i
            ].some(pattern => pattern.test(text));
          };

          const isAuxiliaryTurnText = (text: string) => {
            const normalized = normalizeText(text);
            if (!normalized) {
              return true;
            }

            return [
              /^思考了\s*\d+(?:\.\d+)?\s*(?:ms|s|m|h|秒|分钟|分|小时)?$/i,
              /^thought\s+for\s+\d+(?:\.\d+)?\s*(?:ms|s|m|h|seconds?|minutes?|hours?)$/i,
              /^searching(?:\s+the\s+web)?$/i,
              /^搜索中$/i,
              /^\d+\s+sources?$/i,
              /^sources?$/i
            ].some(pattern => pattern.test(normalized));
          };

          const isLikelySourcesBlock = (element: HTMLElement, rawText?: string) => {
            const text = rawText ? normalizeText(rawText) : normalizeText(element.innerText || element.textContent);
            if (!text) {
              return false;
            }

            if (/^\d+\s+sources?$/i.test(text)) {
              return true;
            }

            const imageCount = element.querySelectorAll("img").length;
            const linkCount = element.querySelectorAll("a").length;
            return imageCount >= 2 && linkCount <= imageCount + 2 && text.length <= 120 && /sources?/i.test(text);
          };

          const countUrls = (text: string) => (text.match(/https?:\/\/\S+/gi) ?? []).length;

          const looksLikePromptText = (text: string) => {
            const normalized = normalizeText(text);
            if (!normalized || isUiNoiseText(normalized) || isAuxiliaryTurnText(normalized)) {
              return false;
            }

            const lineCount = normalized.split("\n").filter(Boolean).length;
            const questionCount = (normalized.match(/[?？]/g) ?? []).length;
            const urlCount = countUrls(normalized);
            const hasPromptStart = /^(请你|请帮|帮我|写成|写一篇|根据|基于|估算|解释|分析|总结|翻译|改写|润色|列出|搜索|搜一下|查一下|为什么|怎么|如何|能否|可否|可以|所以|那|write\b|rewrite\b|summari[sz]e\b|translate\b|analy[sz]e\b|explain\b|estimate\b|help me\b|can you\b|could you\b|would you\b|why\b|what\b|how\b|please\b)/iu.test(
              normalized
            );
            const hasPromptConstraint = /(禁止使用|使用.*风格|技术博客|微信公众号|根据以下|基于以下|给我|帮我|写成|整理成|估算一下|解释一下|总结一下|改写成|translate|rewrite|summari[sz]e|explain|estimate)/iu.test(
              normalized
            );
            const hasPromptEnding = /[?？]\s*$/.test(normalized);

            return (
              lineCount <= 12 &&
              (hasPromptEnding || questionCount > 0 || hasPromptStart || (urlCount > 0 && hasPromptConstraint))
            );
          };

          const looksLikeAnswerText = (text: string, structuredCount = 0) => {
            const normalized = normalizeText(text);
            if (!normalized || isAuxiliaryTurnText(normalized)) {
              return false;
            }

            const paragraphCount = normalized.split(/\n{2,}/).filter(Boolean).length;
            const lineCount = normalized.split("\n").filter(Boolean).length;
            const hasList = /(?:^|\n)\s*(?:[-*•]|\d+\.)\s+/m.test(normalized);
            const hasTable = /\|.+\|/.test(normalized);

            return (
              structuredCount > 0 ||
              hasList ||
              hasTable ||
              paragraphCount >= 2 ||
              (lineCount >= 3 && normalized.length >= 220)
            );
          };

          const overlapsUsedElements = (element: HTMLElement, usedElements: Set<HTMLElement>) => {
            return Array.from(usedElements).some(used => used.contains(element) || element.contains(used));
          };

          const normalizeRole = (value: unknown): ConversationRole | null => {
            if (typeof value !== "string") {
              return null;
            }

            const normalized = value.trim().toLowerCase();
            if (!normalized) {
              return null;
            }

            if (["user", "human", "prompt", "question", "asker", "requester"].includes(normalized)) {
              return "user";
            }

            if (["assistant", "grok", "ai", "model", "bot", "answer", "response"].includes(normalized)) {
              return "assistant";
            }

            return null;
          };

          const textKeys = [
            "text",
            "body",
            "markdown",
            "content",
            "message",
            "prompt",
            "query",
            "answer",
            "response",
            "output",
            "input",
            "value",
            "parts",
            "segments",
            "chunks",
            "fragments",
            "blocks",
            "children",
            "items",
            "nodes"
          ];

          const collectTextCandidates = (value: unknown, depth = 0, seen = new WeakSet<object>()): string[] => {
            if (depth > 5 || value == null) {
              return [];
            }

            if (typeof value === "string") {
              const normalized = normalizeText(value);
              if (!normalized || isUiNoiseText(normalized) || isAuxiliaryTurnText(normalized)) {
                return [];
              }
              return [normalized];
            }

            if (typeof value === "number" || typeof value === "boolean") {
              return [];
            }

            if (Array.isArray(value)) {
              return unique(
                value
                  .slice(0, 24)
                  .flatMap(item => collectTextCandidates(item, depth + 1, seen))
                  .filter(candidate => candidate.length > 0)
              );
            }

            if (typeof value !== "object") {
              return [];
            }

            if (seen.has(value)) {
              return [];
            }
            seen.add(value);

            const record = value as Record<string, unknown>;
            const candidates: string[] = [];

            for (const key of textKeys) {
              if (!(key in record)) {
                continue;
              }
              candidates.push(...collectTextCandidates(record[key], depth + 1, seen));
            }

            if (candidates.length > 0) {
              return unique(candidates);
            }

            return unique(
              Object.values(record)
                .slice(0, 16)
                .flatMap(entry => collectTextCandidates(entry, depth + 1, seen))
            );
          };

          const extractRole = (value: unknown): ConversationRole | null => {
            if (!value || typeof value !== "object") {
              return null;
            }

            const record = value as Record<string, unknown>;

            if (record.isUser === true || record.fromUser === true) {
              return "user";
            }

            if (record.isAssistant === true || record.fromAssistant === true || record.isBot === true) {
              return "assistant";
            }

            const roleFields = ["role", "sender", "author", "source", "name", "type", "speaker"];
            for (const key of roleFields) {
              const normalized = normalizeRole(record[key]);
              if (normalized) {
                return normalized;
              }
            }

            return null;
          };

          const extractTimestamp = (value: unknown): number | undefined => {
            if (!value || typeof value !== "object") {
              return undefined;
            }

            const record = value as Record<string, unknown>;
            const keys = ["createdAt", "updatedAt", "timestamp", "time", "created_at"];

            for (const key of keys) {
              const raw = record[key];
              if (typeof raw === "number" && Number.isFinite(raw)) {
                return raw;
              }
              if (typeof raw === "string") {
                const numeric = Number(raw);
                if (Number.isFinite(numeric)) {
                  return numeric;
                }
                const parsed = Date.parse(raw);
                if (Number.isFinite(parsed)) {
                  return parsed;
                }
              }
            }

            return undefined;
          };

          const extractCandidateTurn = (value: unknown, order: number): GrokTurn | null => {
            if (!value || typeof value !== "object") {
              return null;
            }

            const role = extractRole(value);
            if (!role) {
              return null;
            }

            const textCandidates = collectTextCandidates(value)
              .filter(candidate => candidate.length >= 2)
              .sort((left, right) => right.length - left.length);

            const text = textCandidates[0];
            if (!text || isAuxiliaryTurnText(text)) {
              return null;
            }

            return {
              role,
              text,
              order,
              timestamp: extractTimestamp(value)
            };
          };

          const scoreTurnArray = (turns: GrokTurn[]) => {
            const userCount = turns.filter(turn => turn.role === "user").length;
            const assistantCount = turns.filter(turn => turn.role === "assistant").length;
            if (userCount === 0 || assistantCount === 0 || turns.length < 2) {
              return Number.NEGATIVE_INFINITY;
            }

            const totalTextLength = turns.reduce((sum, turn) => sum + turn.text.length, 0);
            const roleTransitions = turns.slice(1).reduce((sum, turn, index) => {
              return sum + (turn.role !== turns[index].role ? 1 : 0);
            }, 0);
            const auxiliaryPenalty = turns.reduce((sum, turn) => sum + (isAuxiliaryTurnText(turn.text) ? 900 : 0), 0);
            const duplicatePenalty = turns.reduce((sum, turn, index) => {
              return sum + (turns.findIndex(candidate => candidate.role === turn.role && candidate.text === turn.text) !== index ? 600 : 0);
            }, 0);
            const roleMismatchPenalty = turns.reduce((sum, turn) => {
              const promptLike = looksLikePromptText(turn.text);
              const answerLike = looksLikeAnswerText(turn.text);
              if (turn.role === "assistant" && promptLike && !answerLike) {
                return sum + 2400;
              }
              if (turn.role === "user" && answerLike && !promptLike) {
                return sum + 1800;
              }
              return sum;
            }, 0);

            return (
              turns.length * 400 +
              Math.min(totalTextLength, 20000) +
              roleTransitions * 250 -
              auxiliaryPenalty -
              duplicatePenalty -
              roleMismatchPenalty
            );
          };

          const normalizeTurnSequence = (turns: GrokTurn[]) => {
            const adjusted = turns.map(turn => ({ ...turn }));

            for (const [index, turn] of adjusted.entries()) {
              const promptLike = looksLikePromptText(turn.text);
              const answerLike = looksLikeAnswerText(turn.text);
              if (!(turn.role === "assistant" && promptLike && !answerLike)) {
                continue;
              }

              const previousUsers = adjusted.slice(0, index).filter(candidate => candidate.role === "user").length;
              const next = adjusted[index + 1];
              if (index === 0 || previousUsers === 0 || (next && next.role === "assistant")) {
                turn.role = "user";
              }
            }

            return adjusted.filter(
              (turn, index, list) => list.findIndex(candidate => candidate.role === turn.role && candidate.text === turn.text) === index
            );
          };

          const chooseBestTurnArray = (runtimeTurns: GrokTurn[], domTurns: GrokTurn[]) => {
            const candidates = [
              { turns: runtimeTurns, score: scoreTurnArray(runtimeTurns) },
              { turns: domTurns, score: scoreTurnArray(domTurns) }
            ]
              .filter(candidate => candidate.turns.length > 0)
              .map(candidate => ({
                ...candidate,
                roleCount: new Set(candidate.turns.map(turn => turn.role)).size,
                totalTextLength: candidate.turns.reduce((sum, turn) => sum + turn.text.length, 0)
              }));

            if (candidates.length === 0) {
              return [];
            }

            const finiteCandidates = candidates.filter(candidate => Number.isFinite(candidate.score));
            if (finiteCandidates.length === 0) {
              return [];
            }

            const pool = finiteCandidates;

            pool.sort((left, right) => {
              if (Number.isFinite(left.score) && Number.isFinite(right.score) && left.score !== right.score) {
                return right.score - left.score;
              }
              if (left.roleCount !== right.roleCount) {
                return right.roleCount - left.roleCount;
              }
              if (left.totalTextLength !== right.totalTextLength) {
                return right.totalTextLength - left.totalTextLength;
              }
              return right.turns.length - left.turns.length;
            });

            return pool[0]?.turns ?? [];
          };

          const extractRuntimeTurns = (): GrokTurn[] => {
            const explicitRootNames = [
              "__NEXT_DATA__",
              "__INITIAL_STATE__",
              "__PRELOADED_STATE__",
              "__APOLLO_STATE__",
              "__REMIX_CONTEXT__",
              "__remixContext",
              "__NUXT__",
              "__data"
            ];

            const roots: unknown[] = [];
            const windowRecord = window as unknown as Record<string, unknown>;

            for (const name of explicitRootNames) {
              const value = windowRecord[name];
              if (value != null) {
                roots.push(value);
              }
            }

            for (const name of Object.getOwnPropertyNames(window)) {
              if (!/(message|conversation|chat|state|data|cache|apollo|redux|query|grok|turn)/i.test(name)) {
                continue;
              }
              try {
                const value = windowRecord[name];
                if (value != null) {
                  roots.push(value);
                }
              } catch {
                // Ignore inaccessible properties.
              }
            }

            const queue = roots.map(value => ({ value, depth: 0 }));
            const seen = new WeakSet<object>();
            let bestTurns: GrokTurn[] = [];
            let bestScore = Number.NEGATIVE_INFINITY;
            let visited = 0;

            while (queue.length > 0 && visited < 8000) {
              const current = queue.shift();
              if (!current) {
                break;
              }

              const { value, depth } = current;
              if (value == null || typeof value !== "object") {
                continue;
              }

              if (seen.has(value)) {
                continue;
              }
              seen.add(value);
              visited += 1;

              if (Array.isArray(value)) {
                const turns = value
                  .slice(0, 200)
                  .map((item, index) => extractCandidateTurn(item, index))
                  .filter((turn): turn is GrokTurn => !!turn)
                  .filter((turn, index, list) => list.findIndex(candidate => candidate.role === turn.role && candidate.text === turn.text) === index);

                const score = scoreTurnArray(turns);
                if (score > bestScore) {
                  bestScore = score;
                  bestTurns = turns;
                }
              }

              if (depth >= 6) {
                continue;
              }

              const children = Array.isArray(value) ? value.slice(0, 80) : Object.values(value as Record<string, unknown>).slice(0, 80);
              for (const child of children) {
                if (child && typeof child === "object") {
                  queue.push({ value: child, depth: depth + 1 });
                }
              }
            }

            return normalizeTurnSequence(
              bestTurns
              .sort((left, right) => {
                if (left.timestamp != null && right.timestamp != null && left.timestamp !== right.timestamp) {
                  return left.timestamp - right.timestamp;
                }
                return left.order - right.order;
              })
              .filter((turn, index, list) => list.findIndex(candidate => candidate.role === turn.role && candidate.text === turn.text) === index)
            );
          };

          const extractDomTurns = (): GrokTurn[] => {
            const scope = document.querySelector("main") ?? document.body;
            const scopeRect = scope.getBoundingClientRect();
            const scopeWidth = Math.max(scopeRect.width, 1);
            const containerSelectors = "article, section, div";
            const rawCandidates = Array.from(scope.querySelectorAll<HTMLElement>(containerSelectors));

            const candidates = rawCandidates
              .map((element, index) => {
                if (element.closest("nav, aside, footer, form, button")) {
                  return null;
                }

                const rect = element.getBoundingClientRect();
                if (rect.width < 120 || rect.height < 18) {
                  return null;
                }

                const text = normalizeText(element.innerText || element.textContent);
                if (!text || isUiNoiseText(text) || isAuxiliaryTurnText(text) || isLikelySourcesBlock(element, text)) {
                  return null;
                }

                const structuredCount = element.querySelectorAll("p, pre, ul, ol, li, table, blockquote, img").length;
                const promptLike = looksLikePromptText(text);
                const answerLike = looksLikeAnswerText(text, structuredCount);
                const leftOffset = rect.left - scopeRect.left;
                const rightOffset = scopeRect.right - rect.right;
                const widthRatio = rect.width / scopeWidth;

                let userScore = 0;
                let assistantScore = 0;

                if (promptLike) {
                  userScore += 5;
                }
                if (answerLike) {
                  assistantScore += 4;
                }
                if (rightOffset < leftOffset) {
                  userScore += 3;
                }
                if (leftOffset < rightOffset) {
                  assistantScore += 2;
                }
                if (widthRatio <= 0.78) {
                  userScore += 1;
                }
                if (widthRatio >= 0.36) {
                  assistantScore += 1;
                }
                if (structuredCount > 0) {
                  assistantScore += 2;
                }
                if (countUrls(text) > 0 && promptLike) {
                  userScore += 1;
                }

                const role =
                  userScore >= assistantScore + 2 ? "user" : assistantScore >= userScore + 2 ? "assistant" : null;

                if (!role) {
                  return null;
                }

                return {
                  element,
                  role,
                  text,
                  top: rect.top + window.scrollY,
                  order: index,
                  score: text.length + structuredCount * 180
                };
              })
              .filter(
                (
                  candidate
                ): candidate is { element: HTMLElement; role: ConversationRole; text: string; top: number; order: number; score: number } =>
                  !!candidate
              );

            const minimalCandidates = candidates.filter(candidate => {
              return !candidates.some(other => {
                if (other === candidate) {
                  return false;
                }

                if (!candidate.element.contains(other.element)) {
                  return false;
                }

                if (other.role !== candidate.role && other.text.length >= 8) {
                  return true;
                }

                if (other.role !== candidate.role) {
                  return false;
                }

                return other.text.length >= candidate.text.length * 0.65 && other.score >= candidate.score * 0.75;
              });
            });

            const ordered = minimalCandidates
              .sort((left, right) =>
                left.top !== right.top ? left.top - right.top : left.text.length !== right.text.length ? left.text.length - right.text.length : left.order - right.order
              )
              .filter((candidate, index, list) => {
                return list.findIndex(other => other.role === candidate.role && other.text === candidate.text) === index;
              });

            const merged: GrokTurn[] = [];
            for (const candidate of ordered) {
              if (
                merged.some(
                  turn =>
                    turn.element &&
                    turn.role === candidate.role &&
                    (turn.element.contains(candidate.element) || candidate.element.contains(turn.element))
                )
              ) {
                continue;
              }

              const last = merged[merged.length - 1];
              if (
                last &&
                last.role === candidate.role &&
                last.element &&
                last.top != null &&
                candidate.top - last.top < 120
              ) {
                continue;
              }

              merged.push({
                role: candidate.role,
                text: candidate.text,
                order: candidate.order,
                top: candidate.top,
                element: candidate.element
              });
            }

            return normalizeTurnSequence(merged);
          };

          const buildSnippets = (text: string) => {
            const candidates = text
              .split(/\n+/)
              .flatMap(part => part.split(/[。！？.!?]/))
              .map(part => normalizeText(part))
              .filter(part => part.length >= 12 && part.length <= 160)
              .sort((left, right) => right.length - left.length);

            return unique(candidates).slice(0, 4);
          };

          const collectRoots = () => {
            const roots: ParentNode[] = [document];
            const queue: ParentNode[] = [document];
            const seen = new Set<ParentNode>([document]);

            while (queue.length > 0) {
              const root = queue.shift();
              if (!root || typeof root.querySelectorAll !== "function") {
                continue;
              }

              const elements = Array.from(root.querySelectorAll("*"));
              for (const element of elements) {
                if (element.shadowRoot && !seen.has(element.shadowRoot)) {
                  seen.add(element.shadowRoot);
                  roots.push(element.shadowRoot);
                  queue.push(element.shadowRoot);
                }
              }
            }

            return roots;
          };

          const findElementForMessage = (messageText: string, neighboringTexts: string[], usedElements: Set<HTMLElement>) => {
            const roots = collectRoots();
            const snippets = buildSnippets(messageText);
            const fallbackSnippet = normalizeText(messageText).slice(0, 120);
            const querySnippets = snippets.length > 0 ? snippets : (fallbackSnippet ? [fallbackSnippet] : []);
            const neighboringSnippets = neighboringTexts.flatMap(text => buildSnippets(text).slice(0, 1));
            const candidates: Array<{ element: HTMLElement; score: number }> = [];

            if (querySnippets.length === 0) {
              return null;
            }

            for (const root of roots) {
              const elements = Array.from(
                root.querySelectorAll<HTMLElement>("article, section, div, p, li, pre, table, blockquote")
              );

              for (const element of elements) {
                if (usedElements.has(element) || overlapsUsedElements(element, usedElements)) {
                  continue;
                }

                if (element.closest("nav, aside, footer, form, button")) {
                  continue;
                }

                const rect = element.getBoundingClientRect();
                if (rect.width < 120 || rect.height < 18) {
                  continue;
                }

                const text = normalizeText(element.innerText || element.textContent);
                if (!text || text.length < 8 || isUiNoiseText(text) || isAuxiliaryTurnText(text) || isLikelySourcesBlock(element, text)) {
                  continue;
                }

                const matchedSnippets = querySnippets.filter(snippet => text.includes(snippet));
                if (matchedSnippets.length === 0) {
                  continue;
                }

                const neighboringMatches = neighboringSnippets.filter(snippet => text.includes(snippet));
                if (neighboringMatches.length > 0 && text.length > messageText.length * 1.6) {
                  continue;
                }

                const structuredBonus = element.querySelector("p, pre, ul, ol, li, table, blockquote, img") ? 220 : 0;
                const closeness = Math.max(0, 800 - Math.abs(text.length - messageText.length));
                const exactBonus = text === normalizeText(messageText) ? 400 : 0;
                const overlapPenalty = neighboringMatches.length * 900;
                const oversizePenalty = Math.max(0, text.length - messageText.length * 1.35) / 3;

                candidates.push({
                  element,
                  score: matchedSnippets.length * 1000 + structuredBonus + closeness + exactBonus - overlapPenalty - oversizePenalty
                });
              }
            }

            candidates.sort((left, right) => right.score - left.score);
            return candidates[0]?.element ?? null;
          };

          const findTurnContainer = (match: HTMLElement, currentText: string, neighboringTexts: string[]) => {
            let candidate = match;
            const currentSnippets = buildSnippets(currentText).slice(0, 2);
            const neighboringSnippets = neighboringTexts.flatMap(text => buildSnippets(text).slice(0, 1));
            const scope = document.querySelector("main") ?? document.body;

            for (let current = match.parentElement; current && current !== scope; current = current.parentElement) {
              const text = normalizeText(current.innerText || current.textContent);
              if (!text) {
                continue;
              }

              const containsCurrent = currentSnippets.every(snippet => text.includes(snippet));
              const containsNeighbor = neighboringSnippets.some(snippet => text.includes(snippet));

              if (!containsCurrent || containsNeighbor) {
                break;
              }

              if (text.length > currentText.length * 6) {
                break;
              }

              candidate = current;
            }

            return candidate;
          };

          const sanitizeTurnClone = (source: HTMLElement) => {
            const clone = source.cloneNode(true) as HTMLElement;
            clone.querySelectorAll(
              "button, textarea, input, select, form, nav, aside, footer, canvas, svg, audio, video"
            ).forEach(node => node.remove());

            clone
              .querySelectorAll<HTMLImageElement>('img[src*="google.com/s2/favicons"], img[src*="www.google.com/s2/favicons"]')
              .forEach(node => node.remove());

            clone.querySelectorAll<HTMLElement>("[contenteditable]").forEach(node => {
              node.removeAttribute("contenteditable");
            });

            const allNodes = [clone, ...Array.from(clone.querySelectorAll<HTMLElement>("*"))];
            for (const node of allNodes.reverse()) {
              if (node.closest("pre, code, table")) {
                continue;
              }

              const text = normalizeText(node.innerText || node.textContent);
              if (!text) {
                continue;
              }

              if ((text.length <= 40 && isUiNoiseText(text) && !node.querySelector("img")) || isAuxiliaryTurnText(text) || isLikelySourcesBlock(node, text)) {
                node.remove();
              }
            }

            clone.querySelectorAll("table").forEach(table => {
              const firstRow = table.querySelector("tr");
              if (!firstRow || firstRow.querySelector("th")) {
                return;
              }

              const cells = Array.from(firstRow.children).filter(
                (child): child is HTMLTableCellElement => child instanceof HTMLTableCellElement
              );
              if (cells.length < 2) {
                return;
              }

              const headerRow = document.createElement("tr");
              for (const cell of cells) {
                const th = document.createElement("th");
                th.innerHTML = cell.innerHTML;
                headerRow.appendChild(th);
              }

              let thead = table.querySelector("thead");
              if (!thead) {
                thead = document.createElement("thead");
                table.prepend(thead);
              }

              thead.appendChild(headerRow);
              firstRow.remove();
            });

            clone.querySelectorAll<HTMLElement>("div, section, article, span, p, li").forEach(node => {
              const text = normalizeText(node.innerText || node.textContent);
              if (
                (!text || isAuxiliaryTurnText(text) || isLikelySourcesBlock(node, text)) &&
                !node.querySelector("img, pre, code, table, ul, ol, blockquote")
              ) {
                node.remove();
              }
            });

            return clone;
          };

          const appendPlainText = (container: HTMLElement, text: string) => {
            const blocks = text
              .replace(/\r\n?/g, "\n")
              .split(/\n{2,}/)
              .map(block => block.trim())
              .filter(Boolean);

            const appendMarkdownTable = (tableLines: string[]) => {
              const rows = tableLines
                .map(line => line.trim())
                .filter(Boolean)
                .map(line => line.replace(/^\||\|$/g, "").split("|").map(cell => cell.trim()));

              if (rows.length < 2) {
                return false;
              }

              const separatorIndex = rows.findIndex(row => row.every(cell => /^:?-{3,}:?$/.test(cell)));
              if (separatorIndex !== 1) {
                return false;
              }

              const table = document.createElement("table");
              const thead = document.createElement("thead");
              const headerRow = document.createElement("tr");
              for (const cellText of rows[0]) {
                const th = document.createElement("th");
                th.textContent = cellText;
                headerRow.appendChild(th);
              }
              thead.appendChild(headerRow);
              table.appendChild(thead);

              const tbody = document.createElement("tbody");
              for (const row of rows.slice(2)) {
                const tr = document.createElement("tr");
                for (const cellText of row) {
                  const td = document.createElement("td");
                  td.textContent = cellText;
                  tr.appendChild(td);
                }
                tbody.appendChild(tr);
              }
              table.appendChild(tbody);
              container.appendChild(table);
              return true;
            };

            for (const block of blocks) {
              const lines = block
                .split("\n")
                .map(line => line.trim())
                .filter(Boolean);

              if (lines.length === 0) {
                continue;
              }

              if (lines.every(line => /^\|.*\|$/.test(line)) && appendMarkdownTable(lines)) {
                continue;
              }

              if (lines.every(line => /^[-*]\s+/.test(line))) {
                const list = document.createElement("ul");
                for (const line of lines) {
                  const li = document.createElement("li");
                  li.textContent = line.replace(/^[-*]\s+/, "");
                  list.appendChild(li);
                }
                container.appendChild(list);
                continue;
              }

              if (lines.every(line => /^\d+\.\s+/.test(line))) {
                const list = document.createElement("ol");
                for (const line of lines) {
                  const li = document.createElement("li");
                  li.textContent = line.replace(/^\d+\.\s+/, "");
                  list.appendChild(li);
                }
                container.appendChild(list);
                continue;
              }

              const paragraph = document.createElement("p");
              paragraph.textContent = lines.join(" ");
              container.appendChild(paragraph);
            }
          };

          const hasCompleteConversation = (turns: GrokTurn[]) => {
            return turns.length >= 2 && new Set(turns.map(turn => turn.role)).size === 2;
          };

          let runtimeTurns: GrokTurn[] = [];
          let domTurns: GrokTurn[] = [];
          let turns: GrokTurn[] = [];
          const deadline = Date.now() + 8000;

          do {
            runtimeTurns = extractRuntimeTurns();
            domTurns = extractDomTurns();
            turns = chooseBestTurnArray(runtimeTurns, domTurns);

            if (turns.length === 0) {
              if (Date.now() >= deadline) {
                break;
              }
            } else if (hasCompleteConversation(turns) || Date.now() >= deadline) {
              break;
            }

            await new Promise(resolve => setTimeout(resolve, 250));
          } while (Date.now() < deadline);

          turns = normalizeTurnSequence(turns);

          if (turns.length === 0 || !hasCompleteConversation(turns)) {
            return null;
          }

          const article = document.createElement("article");
          const usedElements = new Set<HTMLElement>();
          let firstUserText = "";
          let firstAssistantText = "";

          for (const [index, turn] of turns.entries()) {
            if (!firstUserText && turn.role === "user") {
              firstUserText = turn.text;
            }
            if (!firstAssistantText && turn.role === "assistant") {
              firstAssistantText = turn.text;
            }

            const neighboringTexts = turns
              .filter((_candidate, candidateIndex) => candidateIndex !== index)
              .map(candidate => candidate.text);
            const elementMatch = turn.element && !overlapsUsedElements(turn.element, usedElements)
              ? turn.element
              : findElementForMessage(turn.text, neighboringTexts, usedElements);

            const section = document.createElement("section");
            section.setAttribute("data-grok-role", turn.role);

            const heading = document.createElement("h1");
            heading.textContent = turn.role === "user" ? userRoleLabel : assistantRoleLabel;
            section.appendChild(heading);

            if (elementMatch) {
              const container = findTurnContainer(elementMatch, turn.text, neighboringTexts);
              usedElements.add(elementMatch);
              usedElements.add(container);

              const clone = sanitizeTurnClone(container);
              const cleanedText = normalizeText(clone.innerText || clone.textContent);
              const hasStructuredContent = !!clone.querySelector("p, pre, ul, ol, li, table, blockquote, img");

              if (cleanedText || hasStructuredContent) {
                section.append(...Array.from(clone.childNodes));
              } else {
                appendPlainText(section, turn.text);
              }
            } else {
              appendPlainText(section, turn.text);
            }

            article.appendChild(section);
          }

          const titleFromDocument = (document.title || "")
            .replace(/\s*[-|]\s*Grok\s*$/i, "")
            .trim();

          const fallbackTitle = firstUserText ? firstUserText.slice(0, 80) : fallbackConversationTitle;
          const excerptSource = firstAssistantText || firstUserText;

          return {
            title: titleFromDocument || fallbackTitle,
            excerpt: excerptSource ? excerptSource.slice(0, 220) : null,
            bodyHtml: article.innerHTML,
            language: document.documentElement.lang || navigator.language || null
          };
        }
      });

      const grokPayload = grokResults?.[0]?.result as SerializedGrokConversation | null | undefined;
      if (grokPayload?.bodyHtml) {
        const grokDoc = new DOMParser().parseFromString("<!DOCTYPE html><html><head></head><body></body></html>", "text/html");
        const grokArticle = buildGrokConversationFromSerializedPayload(grokDoc, url, grokPayload);
        if (grokArticle) {
          console.log(`从 Grok 标签页提取正文：${grokArticle.images.length} 张图片，${grokArticle.textContent.length} 字符`);
          return {
            ...grokArticle,
            fetchedAt: Date.now()
          };
        }
      }
    }

    const isSubstackWrapperUrl = (() => {
      try {
        const parsed = new URL(url);
        return parsed.hostname === "substack.com" && parsed.pathname.startsWith("/home/post/");
      } catch {
        return false;
      }
    })();

    if (isSubstackWrapperUrl) {
      const runtimeResults = await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: () => {
          const postIdMatch = location.pathname.match(/\/home\/post\/p-(\d+)/);
          const targetPostId = postIdMatch ? Number(postIdMatch[1]) : null;

          const bylineFromEntries = (entries: unknown): string | undefined => {
            if (!Array.isArray(entries)) {
              return undefined;
            }

            const names = entries
              .map(entry => (entry && typeof entry === "object" && "name" in entry ? (entry as { name?: unknown }).name : undefined))
              .filter((name): name is string => typeof name === "string" && name.trim().length > 0);

            return names.length ? names.join(", ") : undefined;
          };

          const toPayload = (candidate: Record<string, unknown>, post: Record<string, unknown>) => {
            const bodyHtml = typeof post.body_html === "string" ? post.body_html : null;
            if (!bodyHtml) {
              return null;
            }

            const postId = typeof post.id === "number" ? post.id : typeof post.post_id === "number" ? post.post_id : null;
            if (targetPostId && postId && postId !== targetPostId) {
              return null;
            }

            const canonicalUrl =
              (typeof post.canonical_url === "string" ? post.canonical_url : null) ||
              (typeof candidate.canonicalUrl === "string" ? candidate.canonicalUrl : null) ||
              (typeof candidate.ogUrl === "string" ? candidate.ogUrl : null);

            const publishedBylines =
              (Array.isArray(candidate.publishedBylines) ? candidate.publishedBylines : null) ||
              (Array.isArray(post.publishedBylines) ? post.publishedBylines : null);

            return {
              title: typeof post.title === "string" ? post.title : undefined,
              excerpt:
                (typeof post.subtitle === "string" ? post.subtitle : null) ||
                (typeof post.description === "string" ? post.description : null) ||
                (typeof post.truncated_body_text === "string" ? post.truncated_body_text : null),
              canonicalUrl,
              byline: bylineFromEntries(publishedBylines),
              bodyHtml
            };
          };

          const roots: Array<unknown> = [];
          const explicitRootNames = [
            "_preloads",
            "__NEXT_DATA__",
            "__INITIAL_STATE__",
            "__APOLLO_STATE__",
            "__REMIX_CONTEXT__",
            "__remixContext",
            "__NUXT__",
            "__data"
          ];

          const windowRecord = window as unknown as Record<string, unknown>;

          for (const name of explicitRootNames) {
            const value = windowRecord[name];
            if (value != null) {
              roots.push(value);
            }
          }

          for (const name of Object.getOwnPropertyNames(window)) {
            if (!/(preload|state|store|data|cache|router|post|publication|apollo|redux|query|relay)/i.test(name)) {
              continue;
            }
            try {
              const value = windowRecord[name];
              if (value != null) {
                roots.push(value);
              }
            } catch {
              // Ignore inaccessible properties.
            }
          }

          const queue = roots.map(value => ({ value, depth: 0 }));
          const seen = new WeakSet<object>();
          let visited = 0;

          while (queue.length > 0 && visited < 5000) {
            const current = queue.shift();
            if (!current) {
              break;
            }

            const { value, depth } = current;
            if (!value || typeof value !== "object") {
              continue;
            }

            if (seen.has(value)) {
              continue;
            }
            seen.add(value);
            visited += 1;

            const record = value as Record<string, unknown>;
            const directPayload = toPayload(record, record);
            if (directPayload) {
              return directPayload;
            }

            const nestedPost = record.post;
            if (nestedPost && typeof nestedPost === "object") {
              const nestedPayload = toPayload(record, nestedPost as Record<string, unknown>);
              if (nestedPayload) {
                return nestedPayload;
              }
            }

            if (depth >= 6) {
              continue;
            }

            const children = Array.isArray(value) ? value.slice(0, 100) : Object.values(record).slice(0, 100);

            for (const child of children) {
              if (child && typeof child === "object") {
                queue.push({ value: child, depth: depth + 1 });
              }
            }
          }

          return null;
        }
      } as any);

      const runtimeArticle = runtimeResults?.[0]?.result as SerializedSubstackRuntimeArticle | null | undefined;
      if (runtimeArticle?.bodyHtml) {
        const runtimeDoc = new DOMParser().parseFromString("<!DOCTYPE html><html><head></head><body></body></html>", "text/html");
        const articleFromRuntime = buildSubstackArticleFromSerializedPayload(runtimeDoc, url, runtimeArticle);
        if (articleFromRuntime) {
          console.log(`从 Substack 运行时状态提取正文：${articleFromRuntime.images.length} 张图片，${articleFromRuntime.textContent.length} 字符`);
          return {
            ...articleFromRuntime,
            fetchedAt: Date.now()
          };
        }
      }
    }

    // 在标签页中执行脚本，获取页面 HTML 和所有图片的完整信息
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: async () => {
        const isSubstackWrapperPage =
          location.hostname === "substack.com" && location.pathname.startsWith("/home/post/");

        const normalizeText = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();

        const isRecommendationBlock = (element: Element, text: string) => {
          const normalized = normalizeText(text);
          if (!normalized) {
            return false;
          }

          const followMatches = normalized.match(/\bFollow\b/gi) ?? [];
          const suggestionMatches = normalized.match(/\bSuggestions?\b/gi) ?? [];
          const links = Array.from(element.querySelectorAll("a"));
          const profileLinks = links.filter(link => {
            const href = link.getAttribute("href") ?? "";
            return href.includes("substack.com/@") || href.includes("substack.com/profile/");
          });

          return suggestionMatches.length >= 1 && followMatches.length >= 3 && profileLinks.length >= 3;
        };

        const scoreCandidate = (element: Element) => {
          const clone = element.cloneNode(true) as HTMLElement;
          clone.querySelectorAll("script, style, noscript, svg, form, input, textarea, select, button, nav, footer, aside").forEach(node => node.remove());

          const text = normalizeText(clone.textContent);
          if (text.length < 80 || isRecommendationBlock(clone, text)) {
            return Number.NEGATIVE_INFINITY;
          }

          if (
            /Discussion about this post/i.test(text) ||
            /Ready for more\?/i.test(text) ||
            /TopLatestDiscussions/i.test(text) ||
            /CommentsRestacks/i.test(text)
          ) {
            return Number.NEGATIVE_INFINITY;
          }

          const paragraphCount = clone.querySelectorAll("p").length;
          const listCount = clone.querySelectorAll("li").length;
          const quoteCount = clone.querySelectorAll("blockquote").length;
          const codeBlockCount = clone.querySelectorAll("pre").length;
          const headingCount = clone.querySelectorAll("h2, h3, h4, h5, h6").length;
          const imageCount = clone.querySelectorAll("img").length;
          const linkCount = clone.querySelectorAll("a").length;

          let score = Math.min(text.length, 12000);
          score += paragraphCount * 260;
          score += listCount * 80;
          score += quoteCount * 140;
          score += codeBlockCount * 140;
          score += headingCount * 110;
          score += imageCount * 30;
          score -= linkCount * 6;

          const marker = `${element.getAttribute("class")?.toLowerCase() ?? ""} ${element.getAttribute("id")?.toLowerCase() ?? ""}`;
          if (/(content|body|article|post|markup|prose|story)/.test(marker)) {
            score += 140;
          }
          if (/(header|hero|meta|author|toolbar|sidebar|footer|related|recommend)/.test(marker)) {
            score -= 220;
          }
          if (/(comment|discussion|reply|restack)/.test(marker)) {
            score -= 1200;
          }

          return score;
        };

        const collectRoots = () => {
          const roots: Array<Document | ShadowRoot> = [document];
          const queue: Array<Document | ShadowRoot> = [document];
          const seen = new Set<Node>([document]);

          while (queue.length > 0) {
            const root = queue.shift()!;
            const elements = Array.from(root.querySelectorAll("*"));
            for (const element of elements) {
              const shadowRoot = (element as HTMLElement).shadowRoot;
              if (shadowRoot && !seen.has(shadowRoot)) {
                seen.add(shadowRoot);
                roots.push(shadowRoot);
                queue.push(shadowRoot);
              }

              if (element instanceof HTMLIFrameElement) {
                try {
                  const frameDocument = element.contentDocument;
                  if (frameDocument?.documentElement && !seen.has(frameDocument)) {
                    seen.add(frameDocument);
                    roots.push(frameDocument);
                    queue.push(frameDocument);
                  }
                } catch {
                  // Ignore cross-origin iframes.
                }
              }
            }
          }

          return roots;
        };

        const findDeepArticleCandidate = () => {
          const selectors = [
            "#js_content",                 // 微信公众号正文容器
            ".rich_media_content",         // 微信公众号正文 class
            ".available-content .body.markup",
            ".available-content .markup",
            ".available-content",
            ".body.markup",
            ".substack-post-body",
            ".post-body",
            ".post-content",
            ".article-content",
            ".entry-content",
            '[data-testid="post-body"]',
            '[data-testid*="post"]',
            '[class*="post-body"]',
            '[class*="post-content"]',
            '[class*="article-content"]',
            '[class*="article-body"]',
            '[class*="markup"]',
            '[class*="prose"]',
            '[class*="story-body"]',
            "article",
            '[role="article"]',
            "main",
            '[role="main"]'
          ];

          const roots = collectRoots();
          const candidates: Array<{ element: Element; score: number }> = [];
          const seen = new Set<Element>();

          for (const root of roots) {
            for (const selector of selectors) {
              const elements = Array.from(root.querySelectorAll(selector));
              for (const element of elements) {
                if (seen.has(element)) {
                  continue;
                }
                seen.add(element);
                const score = scoreCandidate(element);
                if (Number.isFinite(score)) {
                  candidates.push({ element, score });
                }
              }
            }
          }

          candidates.sort((left, right) => right.score - left.score);
          return candidates[0]?.element ?? null;
        };

        const hasMeaningfulSubstackBody = (): boolean => {
          const directBody = findDeepArticleCandidate();
          if (directBody && (directBody.textContent?.trim().length ?? 0) > 800) {
            return true;
          }

          const article = document.querySelector("article, [role='article'], main");
          if (!article) {
            return false;
          }

          const text = article.textContent?.trim() ?? "";
          if (!text || /\bSuggestions\b/i.test(text) || /Discussion about this post/i.test(text)) {
            return false;
          }

          const paragraphCount = article.querySelectorAll("p").length;
          return paragraphCount >= 4 && text.length > 1500;
        };

        if (isSubstackWrapperPage) {
          const startedAt = Date.now();
          while (Date.now() - startedAt < 8000) {
            if (hasMeaningfulSubstackBody()) {
              break;
            }
            await new Promise(resolve => setTimeout(resolve, 250));
          }
        }

        // 获取完整的 HTML（包括动态加载的内容）
        const html = document.documentElement.outerHTML;
        const liveArticleElement = findDeepArticleCandidate();
        const liveArticleHtml = liveArticleElement?.innerHTML ?? null;
        const liveArticleText = normalizeText(liveArticleElement?.textContent);

        // 收集所有图片的当前状态
        const images = Array.from(document.querySelectorAll("img"));
        const imageStates = images.map((img, index) => ({
          index,
          src: img.src,
          currentSrc: (img as HTMLImageElement).currentSrc,
          naturalWidth: img.naturalWidth,
          naturalHeight: img.naturalHeight,
          complete: img.complete,
          hasDataSrc: img.hasAttribute("data-src"),
          hasDataOriginal: img.hasAttribute("data-original"),
          hasSrcset: img.hasAttribute("srcset"),
          alt: img.alt || "",
          className: img.className || "",
          parentElement: img.parentElement?.className || ""
        }));

        const canonicalUrl =
          document.querySelector('link[rel="canonical"]')?.getAttribute("href") ||
          document.querySelector('meta[property="og:url"]')?.getAttribute("content") ||
          null;

        return { html, imageStates, canonicalUrl, liveArticleHtml, liveArticleText };
      }
    });

    if (!results || !results[0]?.result) {
      throw new Error("无法获取页面内容");
    }

    const { html, imageStates, canonicalUrl, liveArticleHtml, liveArticleText } = results[0].result as {
      html: string;
      imageStates: Array<{
        src: string;
        currentSrc: string;
        naturalWidth: number;
        naturalHeight: number;
        complete: boolean;
        alt: string;
        className: string;
        parentElement: string;
      }>;
      canonicalUrl: string | null;
      liveArticleHtml: string | null;
      liveArticleText: string;
    };

    console.log(`从标签页获取：${imageStates.length} 张图片`);

    const resolvedCanonicalUrl = canonicalUrl ? absolutifyUrl(canonicalUrl, url) : null;
    if (shouldResolveCanonicalSourceUrl(url, resolvedCanonicalUrl)) {
      try {
        console.log(`检测到 Substack 包装页，转为抓取 canonical 地址：${resolvedCanonicalUrl}`);
        return await fetchArticle(resolvedCanonicalUrl);
      } catch (error) {
        console.warn("抓取 canonical 地址失败，回退到当前标签页内容", error);
      }
    }

    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");

    if (!doc) {
      throw new Error("无法解析页面 HTML 内容");
    }

    const base = doc.createElement("base");
    base.href = url;
    doc.head?.prepend(base);

    const substackCanonicalUrl = extractSubstackCanonicalUrl(doc, url);
    if (shouldResolveCanonicalSourceUrl(url, substackCanonicalUrl)) {
      try {
        console.log(`从页面预加载数据检测到 Substack canonical 地址：${substackCanonicalUrl}`);
        return await fetchArticle(substackCanonicalUrl);
      } catch (error) {
        console.warn("根据预加载数据抓取 canonical 地址失败，继续回退当前页面内容", error);
      }
    }

    const preferredUrl = getPreferredArticleUrl(url, substackCanonicalUrl);

    const preloadedArticle = extractSubstackArticleFromPreloads(doc, preferredUrl);
    if (preloadedArticle) {
      console.log(`从 Substack 预加载数据提取正文：${preloadedArticle.images.length} 张图片，${preloadedArticle.textContent.length} 字符`);
      return {
        ...preloadedArticle,
        fetchedAt: Date.now()
      };
    }

    const contentContainer = findBestContentContainer(doc);

    let contentHtml: string;
    let textContent: string;
    let usedReadability = false;

    if (liveArticleHtml && liveArticleText) {
      contentHtml = liveArticleHtml;
      textContent = liveArticleText;
    } else if (contentContainer) {
      contentHtml = contentContainer.innerHTML;
      textContent = contentContainer.textContent?.trim() ?? "";
    } else {
      contentHtml = "";
      textContent = "";
    }

    // 创建临时容器处理图片
    const tempContainer = doc.createElement("div");
    tempContainer.innerHTML = contentHtml;
    tempContainer.querySelectorAll("script, style, noscript").forEach(node => node.remove());

    // 处理图片：确保使用正确的 src
    const imgElements = tempContainer.querySelectorAll("img");
    const imgSrcMap = new Map<string, string>();

    // 构建图片 src 映射（从标签页获取的完整信息）
    // 清理微信图片 URL 水印参数并通过代理绕过防盗链
    imageStates.forEach(img => {
      if (img.src && img.complete && img.naturalWidth > 0) {
        const cleaned = cleanWeChatImageUrl(img.currentSrc || img.src);
        imgSrcMap.set(img.src, proxyWeChatImageUrl(cleaned));
      }
    });

    // 对于微信文章：使用从原始 HTML 获取的未被 JS 修改的图片 URL
    // 微信的页面 JS 会将 data-src 替换为完全不同的带水印 CDN 路径，
    // 因此 DOM 中的 data-src 已经不可靠，必须用原始 HTML 中的值
    if (rawWeChatImageUrls.length > 0) {
      let rawUrlIndex = 0;
      imgElements.forEach(img => {
        const dataSrc = img.getAttribute("data-src");
        const src = img.getAttribute("src");
        // 只替换微信图片（通过检查 data-src 或 src 是否指向微信 CDN）
        const currentUrl = dataSrc || src || "";
        if (currentUrl.includes("mmbiz.qpic.cn") || currentUrl.includes("mmbiz.qlogo.cn")) {
          if (rawUrlIndex < rawWeChatImageUrls.length) {
            const originalUrl = rawWeChatImageUrls[rawUrlIndex];
            const cleaned = cleanWeChatImageUrl(originalUrl);
            img.setAttribute("src", proxyWeChatImageUrl(cleaned));
            // 同时更新 data-src 以确保后续处理一致
            img.setAttribute("data-src", originalUrl);
            rawUrlIndex++;
          }
        }
      });
      console.log(`已用原始 URL 替换 ${rawUrlIndex} 张微信图片`);
    } else {
      // 非微信文章或获取原始 HTML 失败时的回退逻辑
      imgElements.forEach(img => {
        const src = img.getAttribute("src");
        const dataSrc = img.getAttribute("data-src");
        if (dataSrc) {
          const cleaned = cleanWeChatImageUrl(dataSrc);
          img.setAttribute("src", proxyWeChatImageUrl(cleaned));
        } else if (src && imgSrcMap.has(src)) {
          img.setAttribute("src", imgSrcMap.get(src)!);
        }
      });
    }

    // 运行 sanitizeContent 来处理图片和其他清理工作
    let images = sanitizeContent(tempContainer as HTMLElement, preferredUrl);

    console.log(`从内容中提取：${images.length} 张图片`);

    contentHtml = tempContainer.innerHTML;
    textContent = tempContainer.textContent?.trim() ?? "";

    if (!hasMeaningfulArticleContent(tempContainer, textContent)) {
      console.warn("候选容器更像标题区而不是真正文，回退到 Readability");
      const reader = new Readability(doc, { charThreshold: 50 });
      const article = reader.parse();

      if (article) {
        const fallback = buildContentWithFallback(article, doc, preferredUrl);
        contentHtml = fallback.contentHtml;
        textContent = fallback.textContent;
        images = fallback.images;
        usedReadability = true;
      }
    }

    const finalContainer = doc.createElement("div");
    finalContainer.innerHTML = contentHtml;
    finalContainer.querySelectorAll("script, style, noscript").forEach(node => node.remove());

    if (!hasMeaningfulArticleContent(finalContainer, textContent)) {
      if (!usedReadability) {
        throw new Error("提取到的内容仍然更像页面头部，未找到真正正文");
      }

      throw new Error("提取的内容过短");
    }

    console.log(`提取完成：${images.length} 张图片，${textContent.length} 字符`);

    return {
      url: preferredUrl,
      title: doc.title || t("defaultTitle"),
      byline: undefined,
      excerpt: undefined,
      contentHtml,
      textContent,
      images,
      language: doc.documentElement.lang || undefined,
      fetchedAt: Date.now()
    };
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`从标签页获取失败：${error.message}`);
    }
    throw new Error("从标签页获取失败");
  }
}

/**
 * 查找与指定 URL 匹配的已打开标签页 ID
 * 使用更宽松的匹配策略以提高命中率
 */
async function findMatchingTab(url: string): Promise<number | null> {
  try {
    const tabs = await chrome.tabs.query({});
    const normalizedUrl = url.endsWith("/") ? url.slice(0, -1) : url;

    // 解析目标 URL 的各个部分
    let targetHostname: string;
    let targetPathname: string;
    try {
      const parsed = new URL(normalizedUrl);
      targetHostname = parsed.hostname;
      targetPathname = parsed.pathname;
    } catch {
      return null;
    }

    let exactMatch: number | null = null;
    let pathMatch: number | null = null;
    let hostnameMatch: number | null = null;

    for (const tab of tabs) {
      if (!tab.url) continue;

      const tabUrl = tab.url.endsWith("/") ? tab.url.slice(0, -1) : tab.url;

      // 精确匹配或子路径匹配
      if (tabUrl === normalizedUrl || tabUrl.startsWith(normalizedUrl + "#") || tabUrl.startsWith(normalizedUrl + "?")) {
        return tab.id ?? null;
      }

      // 处理 Twitter/X 的 URL 变体
      const normalizedTabUrl = tabUrl.replace(/^https?:\/\/(www\.)?/, "").replace(/^x\.com/, "twitter.com");
      const normalizedTargetUrl = normalizedUrl.replace(/^https?:\/\/(www\.)?/, "").replace(/^x\.com/, "twitter.com");

      if (normalizedTabUrl === normalizedTargetUrl) {
        return tab.id ?? null;
      }

      // 宽松匹配：相同域名且路径包含目标路径
      try {
        const tabParsed = new URL(tabUrl);
        const tabHostname = tabParsed.hostname;
        const tabPathname = tabParsed.pathname;

        // hostname 匹配
        if (tabHostname === targetHostname) {
          if (hostnameMatch === null) {
            hostnameMatch = tab.id ?? null;
          }

          // 路径匹配（目标路径是 tab 路径的子串，或 tab 路径是目标路径的子串）
          if (tabPathname.includes(targetPathname) || targetPathname.includes(tabPathname)) {
            if (pathMatch === null) {
              pathMatch = tab.id ?? null;
            }
          }
        }
      } catch {
        continue;
      }
    }

    // 按优先级返回：路径匹配 > 主机名匹配
    return pathMatch || hostnameMatch;
  } catch (error) {
    console.warn("查找标签页失败", error);
  }

  return null;
}

/**
 * 检查 URL 是否来自动态内容网站（需要标签页抓取）
 */
function isDynamicContentSite(url: string): boolean {
  const dynamicSites = [
    'substack.com',
    'medium.com',
    'twitter.com',
    'x.com',
    'grok.com',
    'chatgpt.com',
    'chat.openai.com',
    'gemini.google.com',
    'linkedin.com',
    'indiehackers.com',
    'producthunt.com',
    'reddit.com'
  ];

  try {
    const hostname = new URL(url).hostname;
    return dynamicSites.some(site => hostname.includes(site) || hostname.endsWith(site));
  } catch {
    return false;
  }
}

export async function fetchArticle(url: string): Promise<ArticleData> {
  const isDynamicSite = isDynamicContentSite(url);

  // 对于动态内容网站，优先尝试从标签页获取
  if (isDynamicSite) {
    const matchingTabId = await findMatchingTab(url);

    if (matchingTabId) {
      try {
        console.log(`检测到动态内容网站，从标签页 ${matchingTabId} 获取内容...`);
        return await fetchArticleFromTab(matchingTabId, url);
      } catch (tabError) {
        console.warn("从标签页获取失败", tabError);
        throw new Error("无法从标签页获取内容。请确保该页面已在浏览器中完全打开并加载完成。");
      }
    } else {
      // 动态网站且没有匹配的标签页，直接报错
      console.warn(`检测到动态内容网站 (${new URL(url).hostname})，但没有找到已打开的标签页。`);
      throw new Error(`无法提取内容：${new URL(url).hostname} 使用动态加载。

请先在浏览器中打开该页面，等待内容完全加载后，再点击扩展图标进行提取。

支持动态加载的网站：Substack, Medium, Twitter/X, Grok, ChatGPT, Gemini, LinkedIn, IndieHackers, ProductHunt, Reddit 等。`);
    }
  }

  // 非动态网站：检查是否有匹配的标签页
  const matchingTabId = await findMatchingTab(url);

  if (matchingTabId) {
    try {
      // 优先从标签页获取内容（可以获取 JavaScript 动态加载的图片）
      console.log(`从标签页 ${matchingTabId} 获取内容...`);
      return await fetchArticleFromTab(matchingTabId, url);
    } catch (tabError) {
      console.warn("从标签页获取失败，尝试跨域抓取", tabError);
      // 继续尝试 fetch 方案
    }
  }

  console.log("无可用标签页，使用跨域抓取...");

  // 降级方案：跨域 fetch
  const response = await fetch(url, {
    method: "GET",
    headers: {
      "accept": "text/html,application/xhtml+xml",
      // 添加常见的浏览器 User-Agent 以提高兼容性
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    },
    credentials: "omit",
    cache: "no-store"
  });

  if (!response.ok) {
    throw new Error(`请求失败：${response.status} ${response.statusText}`);
  }

  const html = await response.text();
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");

  if (!doc) {
    throw new Error("无法解析页面 HTML 内容");
  }

  const base = doc.createElement("base");
  base.href = url;
  doc.head?.prepend(base);

  const preloadedArticle = extractSubstackArticleFromPreloads(doc, url);
  if (preloadedArticle) {
    console.log(`从 Substack 预加载数据提取正文：${preloadedArticle.images.length} 张图片，${preloadedArticle.textContent.length} 字符`);
    return {
      ...preloadedArticle,
      fetchedAt: Date.now()
    };
  }

  // 只移除 script 和 style，保留其他元素用于图片提取
  doc.querySelectorAll("script").forEach(node => node.remove());

  const reader = new Readability(doc, { charThreshold: 50 }); // 降低阈值以提取更多内容
  const article = reader.parse();

  if (!article) {
    throw new Error("未能提取到正文内容，请确认链接有效。对于 Substack/Medium 等网站，请先在浏览器中打开页面。");
  }

  const { contentHtml, textContent, images } = buildContentWithFallback(article, doc, url);

  // 验证提取的内容是否足够
  if (!textContent || textContent.length < 100) {
    console.warn(`提取的内容过短：${textContent?.length || 0} 字符`);
    throw new Error("提取的内容过短，可能是动态加载网站。请先在浏览器中打开该页面后再试。");
  }

  console.log(`提取完成：${images.length} 张图片，${textContent.length} 字符`);

  return {
    url,
    title: article.title?.trim() || doc.title || t("defaultTitle"),
    byline: article.byline ?? undefined,
    excerpt: article.excerpt ?? undefined,
    contentHtml,
    textContent,
    images,
    language: doc.documentElement.lang || article.dir || undefined,
    fetchedAt: Date.now()
  };
}

function buildContentWithFallback(
  readabilityArticle: ReadabilityResult,
  documentRef: Document,
  baseUrl: string
): { contentHtml: string; textContent: string; images: ImageAsset[] } {
  const primaryContainer = documentRef.createElement("div");
  primaryContainer.innerHTML = readabilityArticle.content;
  const primaryImages = sanitizeContent(primaryContainer as HTMLElement, baseUrl);
  const primaryText = primaryContainer.textContent?.trim() ?? "";

  if (primaryText.length >= 200) {
    return {
      contentHtml: primaryContainer.innerHTML,
      textContent: primaryText,
      images: dedupeImages(primaryImages)
    };
  }

  const fallbackTarget =
    documentRef.querySelector("#js_content") ||
    findBestContentContainer(documentRef);

  if (!fallbackTarget) {
    return {
      contentHtml: primaryContainer.innerHTML,
      textContent: primaryText,
      images: dedupeImages(primaryImages)
    };
  }

  const fallbackContainer = documentRef.createElement("div");
  fallbackContainer.innerHTML = fallbackTarget.innerHTML;
  const fallbackImages = sanitizeContent(fallbackContainer as HTMLElement, baseUrl);
  const fallbackText = fallbackContainer.textContent?.trim() ?? "";

  if (fallbackText.length > primaryText.length) {
    return {
      contentHtml: fallbackContainer.innerHTML,
      textContent: fallbackText,
      images: dedupeImages(fallbackImages)
    };
  }

  return {
    contentHtml: primaryContainer.innerHTML,
    textContent: primaryText,
    images: dedupeImages(primaryImages)
  };
}

function dedupeImages(images: ImageAsset[]): ImageAsset[] {
  return images.filter((asset, index, list) =>
    list.findIndex(candidate => candidate.url === asset.url) === index
  );
}

export function articleToMarkdown(article: ArticleData): string {
  const wrapper = document.createElement("article");
  wrapper.innerHTML = article.contentHtml;
  const markdownBody = normalizeMarkdown(turndown.turndown(wrapper.innerHTML));
  return `# ${article.title}\n\n${markdownBody}`.trim();
}


export function articleToPlainText(article: ArticleData): string {
  return `${article.title}\n\n${normalisePlainText(article.textContent)}`;
}


function normalizeMarkdown(markdown: string): string {
  const withoutDecorativeBullets = markdown.replace(/^-+\s*•\s*/gm, "- ");

  const withStructuredCodeBlocks = withoutDecorativeBullets.replace(/```([^\n]*)\n([\s\S]*?)```/g, (_match, lang, body) => {
    const fence = lang ? '```' + lang : '```';
    const cleanedBody = body.replace(/\s+$/u, "");
    return `

${fence}
${cleanedBody}
${'```'}

`;
  });

  const withoutDuplicateOrderedMarkers = withStructuredCodeBlocks.replace(/^(\s*)(\d+)\.\s+\2\.\s+/gm, (_match, indent, index) => `${indent}${index}. `);

  return withoutDuplicateOrderedMarkers
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[\t\u00A0]+/g, " ")
    .trim();
}

export function articleToHtmlDoc(article: ArticleData): string {
  return `<!DOCTYPE html>
<html lang="${article.language || "zh-CN"}">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escapeHtml(article.title)}</title>
    <style>
        @page {
            margin: 2.5cm 2cm 2cm 2cm;
            size: A4;
        }
        
        * {
            box-sizing: border-box;
        }
        
        body {
            font-family: "Times New Roman", "SimSun", "宋体", serif;
            font-size: 12pt;
            line-height: 1.6;
            color: #2c3e50;
            max-width: 21cm;
            margin: 0 auto;
            padding: 0;
            background: white;
        }
        
        h1 {
            font-size: 18pt;
            font-weight: bold;
            color: #2c3e50;
            text-align: center;
            margin: 0 0 24pt 0;
            padding: 0;
            line-height: 1.4;
        }
        
        h2 {
            font-size: 14pt;
            font-weight: bold;
            color: #2c3e50;
            margin: 18pt 0 12pt 0;
            padding: 0;
        }
        
        h3 {
            font-size: 13pt;
            font-weight: bold;
            color: #2c3e50;
            margin: 15pt 0 9pt 0;
            padding: 0;
        }
        
        h4, h5, h6 {
            font-size: 12pt;
            font-weight: bold;
            color: #2c3e50;
            margin: 12pt 0 6pt 0;
            padding: 0;
        }
        
        p {
            margin: 0 0 12pt 0;
            padding: 0;
            text-align: justify;
            text-indent: 2em;
        }
        
        ul, ol {
            margin: 12pt 0;
            padding-left: 2em;
        }
        
        li {
            margin: 6pt 0;
        }
        
        blockquote {
            margin: 12pt 2em;
            padding: 12pt;
            background: #f8f9fa;
            border-left: 4pt solid #e9ecef;
            font-style: italic;
        }
        
        img {
            max-width: 100%;
            height: auto;
            display: block;
            margin: 18pt auto;
            border: 1pt solid #dee2e6;
            padding: 6pt;
            background: white;
        }
        
        figure {
            margin: 18pt 0;
            text-align: center;
        }
        
        figcaption {
            font-size: 10pt;
            color: #6c757d;
            margin-top: 6pt;
            font-style: italic;
        }
        
        table {
            width: 100%;
            border-collapse: collapse;
            margin: 12pt 0;
            font-size: 11pt;
        }
        
        th, td {
            border: 1pt solid #dee2e6;
            padding: 6pt 9pt;
            text-align: left;
        }
        
        th {
            background: #f8f9fa;
            font-weight: bold;
        }
        
        a {
            color: #0066cc;
            text-decoration: underline;
            word-break: break-all;
        }
        
        code {
            font-family: "Courier New", monospace;
            background: #f8f9fa;
            padding: 2pt 4pt;
            border-radius: 2pt;
            font-size: 11pt;
        }
        
        pre {
            background: #f8f9fa;
            padding: 12pt;
            border-radius: 4pt;
            overflow-x: auto;
            margin: 12pt 0;
            border: 1pt solid #e9ecef;
        }
        
        pre code {
            background: none;
            padding: 0;
        }
        
        /* 避免分页时的孤行寡行 */
        h1, h2, h3, h4, h5, h6 {
            page-break-after: avoid;
        }
        
        p, li {
            page-break-inside: avoid;
            orphans: 2;
            widows: 2;
        }
        
        /* 图片避免跨页断开 */
        img, figure {
            page-break-inside: avoid;
        }
        
        /* 表格处理 */
        table {
            page-break-inside: avoid;
        }
        
        /* 确保内容不会超出页面边界 */
        * {
            word-wrap: break-word;
            overflow-wrap: break-word;
        }
        
        /* 移除默认的文本缩进对于特殊元素 */
        h1, h2, h3, h4, h5, h6, ul, ol, blockquote, figure, table {
            text-indent: 0;
        }
    </style>
</head>
<body>
    <h1>${escapeHtml(article.title)}</h1>
    ${article.contentHtml}
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function normalisePlainText(content: string): string {
  return content
    .replace(/\r\n|\r/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function escapeMarkdown(value: string): string {
  return value.replace(/[\\\[\]\(\)!]/g, match => `\\${match}`);
}
