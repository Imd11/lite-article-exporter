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

/**
 * 从 img 元素获取最佳图片 URL
 * 优先使用 srcset 中的最高分辨率图片，回退到 src
 */
function getImageSource(el: HTMLImageElement, baseUrl: string): string | null {
  // 1. 尝试从 srcset 获取最佳图片（最高分辨率）
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

  // 2. 尝试常见的 data-* 属性（按优先级排序）
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

  // 3. 回退到 src 属性
  const src = el.getAttribute("src");
  if (src) {
    const resolved = absolutifyUrl(src, baseUrl);
    // 验证 src 是否为有效 URL（不是 sizes 值或占位符）
    if (resolved.startsWith("http://") || resolved.startsWith("https://")) {
      return resolved;
    }
    // 如果是相对路径且不是占位符，也返回
    if (!resolved.startsWith("(") && !resolved.includes("nonexistent") && !resolved.includes("undefined")) {
      return resolved;
    }
  }

  return null;
}

/**
 * 解析 srcset 属性
 * 例如："image-320w.jpg 320w, image-480w.jpg 480w, image-800w.jpg 800w"
 * 或："image-1x.jpg 1x, image-2x.jpg 2x, image-3x.jpg 3x"
 */
function parseSrcset(srcset: string): Array<{ url: string; width?: number; density?: number }> {
  return srcset.split(",").map(entry => {
    const parts = entry.trim().split(/\s+/);
    const url = parts[0];
    const descriptor = parts[1];

    if (!descriptor) {
      return { url };
    }

    const widthMatch = descriptor.match(/(\d+)w/);
    if (widthMatch) {
      return { url, width: parseInt(widthMatch[1], 10) };
    }

    const densityMatch = descriptor.match(/(\d+(?:\.\d+)?)x/);
    if (densityMatch) {
      return { url, density: parseFloat(densityMatch[1]) };
    }

    return { url };
  }).filter(item => item.url);
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

    // 在标签页中执行脚本，获取页面 HTML 和所有图片的完整信息
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        // 获取完整的 HTML（包括动态加载的内容）
        const html = document.documentElement.outerHTML;

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

        // 找出正文容器（Substack 特定的选择器）
        let articleContent = document.querySelector(".substack-post-body")?.innerHTML ||
                             document.querySelector("article")?.innerHTML ||
                             document.querySelector(".post-body")?.innerHTML ||
                             "";

        return { html, imageStates, articleContent };
      }
    });

    if (!results || !results[0]?.result) {
      throw new Error("无法获取页面内容");
    }

    const { html, imageStates, articleContent } = results[0].result as {
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
      articleContent: string;
    };

    console.log(`从标签页获取：${imageStates.length} 张图片`);

    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");

    if (!doc) {
      throw new Error("无法解析页面 HTML 内容");
    }

    const base = doc.createElement("base");
    base.href = url;
    doc.head?.prepend(base);

    // 方案变更：不使用 Readability，直接从已打开的标签页获取内容
    // 因为用户已经在浏览器中打开了页面，内容是完整的

    // 尝试从特定容器获取内容
    let contentContainer: Element | null = null;

    // 首先在原始文档中查找内容容器
    const selectors = [
      ".substack-post-body",
      ".post-body",
      ".post-content",
      ".article-content",
      ".entry-content",
      "article",
      '[role="article"]',
      "main",
      '[role="main"]'
    ];

    for (const selector of selectors) {
      contentContainer = doc.querySelector(selector);
      if (contentContainer) break;
    }

    let contentHtml: string;
    let textContent: string;

    if (contentContainer) {
      // 清理容器中的脚本和样式
      contentContainer.querySelectorAll("script, style, noscript").forEach(el => el.remove());

      contentHtml = contentContainer.innerHTML;
      textContent = contentContainer.textContent?.trim() ?? "";
    } else {
      // 回退到 Readability
      const reader = new Readability(doc, { charThreshold: 50 });
      const article = reader.parse();

      if (!article) {
        throw new Error("未能提取到正文内容");
      }

      contentHtml = article.content;
      textContent = article.textContent;
    }

    // 创建临时容器处理图片
    const tempContainer = doc.createElement("div");
    tempContainer.innerHTML = contentHtml;

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
    const images = sanitizeContent(tempContainer as HTMLElement, url);

    console.log(`从内容中提取：${images.length} 张图片`);

    contentHtml = tempContainer.innerHTML;
    textContent = tempContainer.textContent?.trim() ?? "";

    if (!textContent || textContent.length < 100) {
      throw new Error("提取的内容过短");
    }

    console.log(`提取完成：${images.length} 张图片，${textContent.length} 字符`);

    return {
      url,
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

  // 增强 fallback 目标选择器，支持更多网站
  const fallbackTarget =
    documentRef.querySelector("#js_content") ||
    documentRef.querySelector("article") ||
    documentRef.querySelector("main") ||
    documentRef.querySelector('[role="main"]') ||
    // Substack 特定选择器
    documentRef.querySelector(".substack-post-body") ||
    documentRef.querySelector(".post-body") ||
    documentRef.querySelector(".post-content") ||
    documentRef.querySelector(".article-content") ||
    // 通用内容容器
    documentRef.querySelector('[class*="post-content"]') ||
    documentRef.querySelector('[class*="article-body"]') ||
    documentRef.querySelector('[class*="post-article"]');

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
