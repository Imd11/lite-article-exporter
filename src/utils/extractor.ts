import { Readability } from "@mozilla/readability";
import type { ReadabilityResult } from "@mozilla/readability";
import TurndownService from "turndown";
import type { ArticleData, ImageAsset } from "../types/index";

type SerializedSubstackRuntimeArticle = {
  title?: string;
  excerpt?: string | null;
  canonicalUrl?: string | null;
  byline?: string;
  bodyHtml: string;
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

    if (firstRowHasHeaders) {
      lines.push("| " + rows[0].join(" | ") + " |");
      lines.push("| " + separator.join(" | ") + " |");
      for (const row of rows.slice(1)) {
        lines.push("| " + row.join(" | ") + " |");
      }
    } else {
      lines.push("| " + separator.join(" | ") + " |");
      for (const row of rows) {
        lines.push("| " + row.join(" | ") + " |");
      }
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
 * 从 img 元素获取最佳图片 URL。
 * 优先使用明确的 src，避免某些 CDN（如 Substack）在 srcset URL 中自带逗号时被错误拆分。
 */
function getImageSource(el: HTMLImageElement, baseUrl: string): string | null {
  // 1. 优先使用 src
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

  // 2. 再尝试从 srcset 获取最佳图片（最高分辨率）
  const srcset = el.getAttribute("srcset");
  if (srcset) {
    const candidates = parseSrcset(srcset);
    if (candidates.length > 0) {
      // 选择最高分辨率的图片
      const best = candidates.reduce((max, curr) =>
        (curr.width || curr.density || 0) > (max.width || max.density || 0) ? curr : max
      );
      if (best.url) {
        return absolutifyUrl(best.url, baseUrl);
      }
    }
  }

  // 3. 尝试常见的 data-* 属性（按优先级排序）
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
    // 如果是有效的 URL 则返回
    if (resolved.startsWith("http://") || resolved.startsWith("https://")) {
      return resolved;
    }
    // 如果是相对路径，也返回
    if (!resolved.startsWith("(") && !resolved.includes("nonexistent") && !resolved.includes("undefined")) {
      return resolved;
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
    "未命名文章";

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
    title: payload.title?.trim() || documentRef.title || "未命名文章",
    byline: payload.byline,
    excerpt: payload.excerpt ?? undefined,
    contentHtml: tempContainer.innerHTML,
    textContent,
    images,
    language: documentRef.documentElement.lang || undefined
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
    // 等待一小段时间让图片完全加载（针对懒加载图片）
    await new Promise(resolve => setTimeout(resolve, 1000));

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
    imageStates.forEach(img => {
      if (img.src && img.complete && img.naturalWidth > 0) {
        imgSrcMap.set(img.src, img.currentSrc || img.src);
      }
    });

    // 更新图片 src
    imgElements.forEach(img => {
      const src = img.getAttribute("src");
      if (src && imgSrcMap.has(src)) {
        img.setAttribute("src", imgSrcMap.get(src)!);
      }
    });

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
      title: doc.title || "未命名文章",
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

支持动态加载的网站：Substack, Medium, Twitter/X, LinkedIn, IndieHackers, ProductHunt, Reddit 等。`);
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
    title: article.title?.trim() || doc.title || "未命名文章",
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
