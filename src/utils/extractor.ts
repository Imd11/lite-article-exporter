import { Readability } from "@mozilla/readability";
import type { ReadabilityResult } from "@mozilla/readability";
import TurndownService from "turndown";
import type { ArticleData, ImageAsset } from "../types/index";
import { t } from "./i18n";
import { capturePage, findTabForUrl, type ExtractionContext } from "./page-capture";

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

type SerializedXLongformArticle = {
  title?: string;
  excerpt?: string | null;
  canonicalUrl?: string | null;
  byline?: string;
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
const STRUCTURAL_NOISE_PATTERNS = [
  /This feature is available for registered users/i,
  /\bGift this article free\b/i,
  /\bGift article\b/i,
  /\bShare article\b/i,
  /\bAdd us as preferred source\b/i,
  /\bRelated Topics\b/i,
  /\bRegister\b[\s\S]{0,40}\bLog in\b/i,
  /\bComment speech bubble icon\b/i
];

function getHostnameFromUrl(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function isTelegraphHostName(hostname: string | null | undefined): boolean {
  if (!hostname) {
    return false;
  }

  return hostname === "telegraph.co.uk" || hostname.endsWith(".telegraph.co.uk");
}

function isTelegraphUrl(url: string): boolean {
  return isTelegraphHostName(getHostnameFromUrl(url));
}

function countMatchingPatterns(patterns: RegExp[], text: string): number {
  return patterns.reduce((count, pattern) => count + (pattern.test(text) ? 1 : 0), 0);
}

function normalizeWhitespacePreservingParagraphs(text: string): string {
  return text
    .replace(/\u00A0/g, " ")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function getPreferredContentSelectors(baseUrl: string): string[] {
  const hostname = getHostnameFromUrl(baseUrl);
  const siteSpecific: string[] = [];

  if (isTelegraphHostName(hostname)) {
    siteSpecific.push(
      '[itemprop="articleBody"]',
      '[data-testid="article-body"]',
      '[data-testid*="article-body"]',
      '[class*="articleBody"]',
      '[class*="article-body"]',
      '[class*="ArticleBody"]',
      '[class*="story-body"]',
      '[class*="storyBody"]'
    );
  }

  return [
    ...siteSpecific,
    "#js_content",
    ".rich_media_content",
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
}

function getSchemaTypes(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }

  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }

  return [];
}

function isArticleSchemaType(types: string[]): boolean {
  return types.some(type => /(^|:)(article|newsarticle|reportagenewsarticle|analysisnewsarticle|blogposting)$/i.test(type));
}

function extractSchemaText(value: unknown): string | undefined {
  if (typeof value === "string") {
    const normalized = normalizeWhitespacePreservingParagraphs(value);
    return normalized || undefined;
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const candidates = [record.name, record.headline, record.description, record.text];
    for (const candidate of candidates) {
      if (typeof candidate === "string") {
        const normalized = normalizeWhitespacePreservingParagraphs(candidate);
        if (normalized) {
          return normalized;
        }
      }
    }
  }

  return undefined;
}

function extractSchemaAuthorName(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value.trim() || undefined;
  }

  if (Array.isArray(value)) {
    const names = value
      .map(entry => extractSchemaAuthorName(entry))
      .filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
    return names.length ? names.join(", ") : undefined;
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return extractSchemaText(record.name ?? record.author);
  }

  return undefined;
}

function collectJsonLdObjects(value: unknown): Array<Record<string, unknown>> {
  const results: Array<Record<string, unknown>> = [];

  const visit = (node: unknown) => {
    if (!node) {
      return;
    }

    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }

    if (typeof node !== "object") {
      return;
    }

    const record = node as Record<string, unknown>;
    results.push(record);

    if (record["@graph"]) {
      visit(record["@graph"]);
    }
  };

  visit(value);
  return results;
}

function splitStructuredArticleBody(text: string): string[] {
  const normalized = normalizeWhitespacePreservingParagraphs(text);
  if (!normalized) {
    return [];
  }

  const blocks = normalized
    .split(/\n{2,}|\n+/)
    .map(block => block.trim())
    .filter(Boolean);

  if (blocks.length > 0) {
    return blocks;
  }

  return [normalized];
}

function buildStructuredArticleHtml(documentRef: Document, text: string): string {
  const container = documentRef.createElement("div");

  for (const paragraph of splitStructuredArticleBody(text)) {
    const element = documentRef.createElement("p");
    element.textContent = paragraph;
    container.appendChild(element);
  }

  return container.innerHTML;
}

function extractStructuredArticleFromJsonLd(
  documentRef: Document,
  sourceUrl: string
): Omit<ArticleData, "fetchedAt"> | null {
  const scripts = Array.from(documentRef.querySelectorAll('script[type="application/ld+json"]'));
  let bestCandidate: Omit<ArticleData, "fetchedAt"> | null = null;
  let bestScore = 0;

  for (const script of scripts) {
    const text = script.textContent?.trim();
    if (!text) {
      continue;
    }

    try {
      const parsed = JSON.parse(text) as unknown;
      const candidates = collectJsonLdObjects(parsed);

      for (const candidate of candidates) {
        if (!isArticleSchemaType(getSchemaTypes(candidate["@type"]))) {
          continue;
        }

        const articleBody = extractSchemaText(candidate.articleBody);
        if (!articleBody || articleBody.length < 400) {
          continue;
        }

        const contentHtml = buildStructuredArticleHtml(documentRef, articleBody);
        const tempContainer = documentRef.createElement("div");
        tempContainer.innerHTML = contentHtml;
        const textContent = tempContainer.textContent?.trim() ?? "";
        if (!hasMeaningfulArticleContent(tempContainer, textContent, sourceUrl)) {
          continue;
        }

        const articleUrl =
          extractSchemaText(candidate.url) ||
          extractSchemaText(candidate.mainEntityOfPage) ||
          extractCanonicalUrl(documentRef, sourceUrl) ||
          sourceUrl;

        const score = textContent.length;
        if (score <= bestScore) {
          continue;
        }

        bestScore = score;
        bestCandidate = {
          url: articleUrl,
          title:
            extractSchemaText(candidate.headline) ||
            extractSchemaText(candidate.name) ||
            documentRef.title ||
            t("defaultTitle"),
          byline: extractSchemaAuthorName(candidate.author),
          excerpt: extractSchemaText(candidate.description) ?? undefined,
          contentHtml,
          textContent,
          images: [],
          language: extractSchemaText(candidate.inLanguage) || documentRef.documentElement.lang || undefined
        };
      }
    } catch (error) {
      console.warn("Failed to parse JSON-LD article", error);
    }
  }

  return bestCandidate;
}

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

function stripTelegraphNoise(container: HTMLElement): void {
  const candidates = Array.from(
    container.querySelectorAll("section, div, aside, ul, ol, nav, header, footer, p")
  );

  for (const element of candidates) {
    if (element === container) {
      continue;
    }

    const text = normalizeExtractedText(element.textContent ?? "");
    if (!text) {
      continue;
    }

    const noiseHits = countMatchingPatterns(STRUCTURAL_NOISE_PATTERNS, text);
    const looksLikeAuthorCard =
      /is The (Sunday )?Telegraph'?s .* Editor/i.test(text) ||
      /can be contacted at .*@telegraph\.co\.uk/i.test(text);
    const looksLikeUtilityCluster = element.querySelectorAll("a, button").length >= 3;

    if (
      noiseHits >= 2 ||
      (noiseHits >= 1 && looksLikeUtilityCluster) ||
      looksLikeAuthorCard
    ) {
      element.remove();
    }
  }
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

  if (!hasMeaningfulArticleContent(tempContainer, textContent, articleUrl)) {
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
  if (!hasMeaningfulArticleContent(tempContainer, textContent, articleUrl)) {
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
  if (!hasMeaningfulArticleContent(tempContainer, textContent, sourceUrl)) {
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
  if (!hasMeaningfulArticleContent(tempContainer, textContent, sourceUrl)) {
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
  if (!hasMeaningfulArticleContent(tempContainer, textContent, sourceUrl)) {
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

function buildXLongformArticleFromSerializedPayload(
  documentRef: Document,
  sourceUrl: string,
  payload: SerializedXLongformArticle
): Omit<ArticleData, "fetchedAt"> | null {
  const articleUrl = normalizeXArticleUrl(payload.canonicalUrl ?? sourceUrl) ?? sourceUrl;
  const tempContainer = documentRef.createElement("div");
  tempContainer.innerHTML = payload.bodyHtml;
  tempContainer.querySelectorAll("script, style, noscript").forEach(node => node.remove());

  const images = sanitizeContent(tempContainer as HTMLElement, articleUrl);
  const textContent = tempContainer.textContent?.trim() ?? "";
  if (!hasMeaningfulArticleContent(tempContainer, textContent, articleUrl)) {
    return null;
  }

  return {
    url: articleUrl,
    title: payload.title?.trim() || documentRef.title || t("defaultTitle"),
    byline: payload.byline ?? undefined,
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
    return (
      isChatGptHost(parsed.hostname) &&
      (
        parsed.pathname.startsWith("/c/") ||
        parsed.pathname.startsWith("/share/") ||
        /^\/g\/[^/]+\/c\/[^/]+/.test(parsed.pathname)
      )
    );
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

function isXHost(hostname: string): boolean {
  return hostname === "x.com" || hostname === "www.x.com" || hostname === "twitter.com" || hostname === "www.twitter.com";
}

function isXStatusPath(pathname: string): boolean {
  return /^\/(?:i\/web\/)?status\/\d+/i.test(pathname) || /^\/[^/]+\/status\/\d+/i.test(pathname);
}

function isXArticlePath(pathname: string): boolean {
  return /^\/i\/article\/\d+/i.test(pathname);
}

function isXStatusUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return isXHost(parsed.hostname) && isXStatusPath(parsed.pathname);
  } catch {
    return false;
  }
}

function isXArticleUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return isXHost(parsed.hostname) && isXArticlePath(parsed.pathname);
  } catch {
    return false;
  }
}

function isXLongformUrl(url: string): boolean {
  return isXStatusUrl(url) || isXArticleUrl(url);
}

function normalizeXArticleUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (!isXHost(parsed.hostname) || !isXArticlePath(parsed.pathname)) {
      return null;
    }

    parsed.protocol = "https:";
    parsed.hostname = "x.com";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
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
  const noiseHits = countMatchingPatterns(STRUCTURAL_NOISE_PATTERNS, text);

  let score = Math.min(textLength, 12000);
  score += paragraphCount * 260;
  score += listCount * 80;
  score += quoteCount * 140;
  score += codeBlockCount * 140;
  score += headingCount * 110;
  score += imageCount * 30;
  score -= linkCount * 6;
  score -= buttonCount * 100;
  score -= noiseHits * 700;

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

  if (noiseHits >= 2) {
    score -= 1600;
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
  const selectors = getPreferredContentSelectors(documentRef.baseURI || documentRef.URL);

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

function hasMeaningfulArticleContent(container: ParentNode, text: string, sourceUrl?: string): boolean {
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
  const sentenceCount = (normalizedText.match(/[.!?。！？]+/g) ?? []).length;
  const linkCount = container.querySelectorAll("a").length;
  const noiseHits = countMatchingPatterns(STRUCTURAL_NOISE_PATTERNS, normalizedText);

  if (noiseHits >= 3) {
    return false;
  }

  if (noiseHits >= 2 && paragraphCount < 5) {
    return false;
  }

  if (linkCount > Math.max(12, paragraphCount * 6) && paragraphCount < 4) {
    return false;
  }

  if (sourceUrl && isTelegraphUrl(sourceUrl) && noiseHits >= 1 && paragraphCount < 6) {
    return false;
  }

  if (paragraphCount >= 3 && sentenceCount >= 4) {
    return true;
  }

  if ((paragraphCount >= 2 || blockCount >= 3) && sentenceCount >= 8 && noiseHits === 0) {
    return true;
  }

  return normalizedText.length >= 1800 && sentenceCount >= 12 && noiseHits === 0;
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
  if (isTelegraphUrl(baseUrl)) {
    stripTelegraphNoise(container);
  }

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
async function fetchArticleFromTab(tabId: number, url: string, context?: ExtractionContext): Promise<ArticleData> {
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
        const rawResults = await capturePage("wechat", tabId, url, [], context);
        const rawPayload = rawResults?.[0]?.result as { html?: string; error?: string } | undefined;
        const rawHtml = rawPayload?.html;
        if (typeof rawHtml !== "string" && context?.automatic) throw new Error(rawPayload?.error ?? "WECHAT_RAW_FETCH_FAILED");
        if (typeof rawHtml === "string") {
          const rawDoc = new DOMParser().parseFromString(rawHtml, "text/html");
          const root = rawDoc.querySelector("#js_content") || rawDoc.querySelector(".rich_media_content");
          rawWeChatImageUrls = Array.from(root?.querySelectorAll("img[data-src]") ?? []).map(img => img.getAttribute("data-src") ?? "").filter(src => src.includes("mmbiz.qpic.cn") || src.includes("mmbiz.qlogo.cn"));
        }
        console.log(`从微信原始 HTML 提取到 ${rawWeChatImageUrls.length} 个原始图片 URL`);
      } catch (error) {
        if (context?.automatic) throw error;
        console.warn("获取微信原始图片 URL 失败:", error);
      }
    }

    // 等待一小段时间让图片完全加载（针对懒加载图片）
    await new Promise(resolve => setTimeout(resolve, 1000));
    if (context?.signal?.aborted) throw new Error("PREPARATION_TIMEOUT");

    if (isXLongformUrl(url)) {
      const xResults = await capturePage("x", tabId, url, [], context);

      const xPayload = xResults?.[0]?.result as SerializedXLongformArticle | null | undefined;
      if (xPayload?.bodyHtml) {
        const xDoc = new DOMParser().parseFromString("<!DOCTYPE html><html><head></head><body></body></html>", "text/html");
        const xArticle = buildXLongformArticleFromSerializedPayload(xDoc, url, xPayload);
        if (xArticle) {
          console.log(`从 X 长文页面提取正文：${xArticle.images.length} 张图片，${xArticle.textContent.length} 字符`);
          return {
            ...xArticle,
            fetchedAt: Date.now()
          };
        }
      }
    }

    if (isChatGptConversationUrl(url)) {
      const chatResults = await capturePage("chatgpt", tabId, url, [
          t("chatGptRoleYouSaid"),
          t("chatGptRoleAssistantSaid"),
          t("chatConversationTitle"),
          t("chatSharedConversationTitle")
        ], context);

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
      const geminiResults = await capturePage("gemini", tabId, url, [t("geminiRoleYouSaid"), t("geminiRoleAssistantSaid"), t("geminiConversationTitle")], context);

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
      const grokResults = await capturePage("grok", tabId, url, [t("grokRoleYouSaid"), t("grokRoleAssistantSaid"), t("grokConversationTitle")], context);

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
      const runtimeResults = await capturePage("substack", tabId, url, [], context);

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
    const results = await capturePage("generic", tabId, url, [], context);

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
    if (!context?.identity && shouldResolveCanonicalSourceUrl(url, resolvedCanonicalUrl)) {
      try {
        console.log(`检测到 Substack 包装页，转为抓取 canonical 地址：${resolvedCanonicalUrl}`);
        return await fetchArticle(resolvedCanonicalUrl, context);
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
    if (!context?.identity && shouldResolveCanonicalSourceUrl(url, substackCanonicalUrl)) {
      try {
        console.log(`从页面预加载数据检测到 Substack canonical 地址：${substackCanonicalUrl}`);
        return await fetchArticle(substackCanonicalUrl, context);
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

    if (isTelegraphUrl(preferredUrl)) {
      const structuredArticle = extractStructuredArticleFromJsonLd(doc, preferredUrl);
      if (structuredArticle) {
        console.log(`从 Telegraph 结构化数据提取正文：${structuredArticle.textContent.length} 字符`);
        return {
          ...structuredArticle,
          fetchedAt: Date.now()
        };
      }
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

    if (!hasMeaningfulArticleContent(tempContainer, textContent, preferredUrl)) {
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

    if (!hasMeaningfulArticleContent(finalContainer, textContent, preferredUrl)) {
      if (!usedReadability) {
        throw new Error("EXTRACTION_FAILED");
      }

      throw new Error("CONTENT_TOO_SHORT");
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
 * 匹配完整地址，避免从同域名的其他文章提取正文
 */
async function findMatchingTab(url: string, context?: ExtractionContext): Promise<number | null> {
  try {
    const tabs = await findTabForUrl(url, context);
    return tabs[0]?.id ?? null;
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
    'telegraph.co.uk',
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
    return dynamicSites.some(site => hostname === site || hostname.endsWith("." + site));
  } catch {
    return false;
  }
}

export async function fetchArticle(url: string, context?: ExtractionContext): Promise<ArticleData> {
  if (context?.identity) return fetchArticleFromTab(context.identity.tabId, url, context);
  const isDynamicSite = isDynamicContentSite(url);

  // 对于动态内容网站，优先尝试从标签页获取
  if (isDynamicSite) {
    const matchingTabId = await findMatchingTab(url, context);

    if (matchingTabId) {
      try {
        console.log(`检测到动态内容网站，从标签页 ${matchingTabId} 获取内容...`);
        return await fetchArticleFromTab(matchingTabId, url, context);
      } catch (tabError) {
        console.warn("从标签页获取失败", tabError);
        if (tabError instanceof Error) {
          throw tabError;
        }
        throw new Error("无法从标签页获取内容。请确保该页面已在浏览器中完全打开并加载完成。");
      }
    } else {
      // 动态网站且没有匹配的标签页，直接报错
      console.warn(`检测到动态内容网站 (${new URL(url).hostname})，但没有找到已打开的标签页。`);
      throw new Error("OPEN_PAGE_REQUIRED");
    }
  }

  // 非动态网站：检查是否有匹配的标签页
  const matchingTabId = await findMatchingTab(url, context);

  if (matchingTabId) {
    try {
      // 优先从标签页获取内容（可以获取 JavaScript 动态加载的图片）
      console.log(`从标签页 ${matchingTabId} 获取内容...`);
      return await fetchArticleFromTab(matchingTabId, url, context);
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
    cache: "no-store",
    signal: context?.signal
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

  if (isTelegraphUrl(url)) {
    const structuredArticle = extractStructuredArticleFromJsonLd(doc, url);
    if (structuredArticle) {
      console.log(`从 Telegraph 结构化数据提取正文：${structuredArticle.textContent.length} 字符`);
      return {
        ...structuredArticle,
        fetchedAt: Date.now()
      };
    }
  }

  // 只移除 script 和 style，保留其他元素用于图片提取
  doc.querySelectorAll("script").forEach(node => node.remove());

  const reader = new Readability(doc, { charThreshold: 50 }); // 降低阈值以提取更多内容
  const article = reader.parse();

  if (!article) {
    throw new Error("EXTRACTION_FAILED");
  }

  const { contentHtml, textContent, images } = buildContentWithFallback(article, doc, url);
  const finalContainer = doc.createElement("div");
  finalContainer.innerHTML = contentHtml;

  // 验证提取的内容是否足够
  if (!textContent || textContent.length < 100 || !hasMeaningfulArticleContent(finalContainer, textContent, url)) {
    console.warn(`提取的内容过短：${textContent?.length || 0} 字符`);
    throw new Error("CONTENT_TOO_SHORT");
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

  if (hasMeaningfulArticleContent(primaryContainer, primaryText, baseUrl)) {
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

  if (
    hasMeaningfulArticleContent(fallbackContainer, fallbackText, baseUrl) &&
    (!hasMeaningfulArticleContent(primaryContainer, primaryText, baseUrl) || fallbackText.length > primaryText.length)
  ) {
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
  const firstHeading = wrapper.querySelector("h1, h2");
  if (
    firstHeading &&
    normalizeExtractedText(firstHeading.textContent ?? "") === normalizeExtractedText(article.title)
  ) {
    firstHeading.remove();
  }
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
  const segments = withoutDuplicateOrderedMarkers.split(/(```[\s\S]*?```)/g);
  const normalizedOutsideCodeFences = segments
    .map(segment => {
      if (segment.startsWith("```") && segment.endsWith("```")) {
        return segment;
      }

      return segment
        .replace(/^[ \t]{4,}(?=!\[[^\n]*\]\([^\n]+\)\s*$)/gm, "")
        .replace(/^[ \t]{4,}(?=\[!\[[^\n]*\]\([^\n]+\)\]\([^\n]+\)\s*$)/gm, "");
    })
    .join("");

  return normalizedOutsideCodeFences
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
