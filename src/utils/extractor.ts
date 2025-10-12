import { Readability } from "@mozilla/readability";
import type { ReadabilityResult } from "@mozilla/readability";
import TurndownService from "turndown";
import type { ArticleData, ImageAsset } from "../types/index";

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

turndown.addRule("removeEmpty", {
  filter: (node: any) => node.nodeName === "DIV" && node.textContent?.trim() === "",
  replacement: () => ""
});

turndown.addRule("preserveImages", {
  filter: "img",
  replacement: (_content: any, node: any) => {
    if (!(node instanceof HTMLImageElement)) {
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
  /继续滑动看下一个/,
  /向上滑动看下一个/,
  /点击[\s\S]{0,10}看下一个/,
  /阅读全文/,
  /原文链接/
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

function sanitizeContent(container: HTMLElement, baseUrl: string): ImageAsset[] {
  const images: ImageAsset[] = [];
  const elements = Array.from(container.querySelectorAll("*"));

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
      if (el.closest("figure")?.innerText.replace(/\s+/g, "").includes("广告")) {
        el.remove();
        continue;
      }
      const src = (
        el.getAttribute("src") ||
        el.getAttribute("data-src") ||
        el.getAttribute("data-original") ||
        el.getAttribute("data-actualsrc") ||
        el.getAttribute("data-url") ||
        ""
      );
      if (!src) {
        el.remove();
        continue;
      }
      const resolved = absolutifyUrl(src, baseUrl);
      el.src = resolved;
      el.removeAttribute("srcset");
      el.removeAttribute("data-src");
      el.removeAttribute("data-original");
      el.removeAttribute("data-actualsrc");
      el.removeAttribute("data-url");
      images.push({
        url: resolved,
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

export async function fetchArticle(url: string): Promise<ArticleData> {
  const response = await fetch(url, {
    method: "GET",
    headers: {
      "accept": "text/html,application/xhtml+xml"
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

  doc.querySelectorAll("script, style, noscript, footer, nav, header").forEach(node => node.remove());

  const reader = new Readability(doc, { charThreshold: 80 });
  const article = reader.parse();

  if (!article) {
    throw new Error("未能提取到正文内容，请确认链接有效");
  }

  const { contentHtml, textContent, images } = buildContentWithFallback(article, doc, url);

  if (!textContent) {
    throw new Error("提取内容为空，可能是付费或受限页面");
  }

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
    documentRef.querySelector("article") ||
    documentRef.querySelector("main") ||
    documentRef.querySelector('[role="main"]');

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
