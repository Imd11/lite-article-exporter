// Existing page functions, isolated from DOM parsing and export generation.
export async function capture_wechat(expectedUrl: string, timeoutMs: number) {
if (location.href !== expectedUrl) throw new Error("SOURCE_CHANGED");

            try {
              const resp = await fetch(location.href, { cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
              if (!resp.ok) return { error: "WECHAT_RAW_FETCH_FAILED" };
              const html = await resp.text();
              // Parse in the offscreen document, whose CSP blocks implicit image/frame loads.
              return { html };
            } catch {
              return { error: "WECHAT_RAW_FETCH_FAILED" };
            }
          }

export async function capture_x(expectedUrl: string, timeoutMs: number) {
if (location.href !== expectedUrl) throw new Error("SOURCE_CHANGED");

          const normalizeText = (value: string | null | undefined) =>
            (value ?? "").replace(/\u00A0/g, " ").replace(/\r\n?/g, "\n").replace(/[ \t]+/g, " ").trim();

          const isXHostName = (hostname: string) =>
            hostname === "x.com" || hostname === "www.x.com" || hostname === "twitter.com" || hostname === "www.twitter.com";

          const isStatusPathname = (pathname: string) =>
            /^\/(?:i\/web\/)?status\/\d+/i.test(pathname) || /^\/[^/]+\/status\/\d+/i.test(pathname);

          const isArticlePathname = (pathname: string) => /^\/i\/article\/\d+/i.test(pathname);

          const normalizeArticleUrl = (value: string | null | undefined) => {
            if (!value) {
              return null;
            }

            try {
              const parsed = new URL(value, location.href);
              if (!isXHostName(parsed.hostname) || !isArticlePathname(parsed.pathname)) {
                return null;
              }

              parsed.protocol = "https:";
              parsed.hostname = "x.com";
              parsed.hash = "";
              return parsed.toString();
            } catch {
              return null;
            }
          };

          const xNoisePatterns = [
            /^要查看键盘快捷键，按下问号$/u,
            /^查看键盘快捷键$/u,
            /Relevant users/i,
            /What'?s happening/i,
            /Who to follow/i,
            /You might like/i,
            /Terms of Service/i,
            /Privacy Policy/i,
            /Cookie Policy/i,
            /Posts?$/i,
            /^Post$/i,
            /^Home$/i,
            /^Explore$/i,
            /^Notifications$/i,
            /^Messages$/i,
            /^Bookmarks$/i,
            /^Profile$/i,
            /^Follow$/i,
            /^More$/i,
            /^Premium$/i,
            /^Grok$/i,
            /^Communities$/i,
            /^Lists$/i,
            /^文章$/u,
            /^主页$/u,
            /^探索$/u,
            /^通知$/u,
            /^关注$/u,
            /^聊天$/u,
            /^书签$/u,
            /^创作者工作室$/u,
            /^个人资料$/u,
            /^更多$/u,
            /^发帖$/u,
            /^查看新帖子$/u,
            /^对话$/u,
            /^相关用户$/u,
            /^有什么新鲜事$/u,
            /^显示更多$/u
          ];

          const isNoiseText = (text: string) => {
            const normalized = normalizeText(text);
            if (!normalized) {
              return false;
            }
            return xNoisePatterns.some(pattern => pattern.test(normalized));
          };

          const collectRoots = () => {
            const roots: Array<Document | ShadowRoot> = [document];
            const queue: Array<Document | ShadowRoot> = [document];
            const seen = new Set<Node>([document]);

            while (queue.length > 0) {
              const root = queue.shift();
              if (!root) {
                continue;
              }

              const elements = Array.from(root.querySelectorAll("*"));
              for (const element of elements) {
                const shadowRoot = (element as HTMLElement).shadowRoot;
                if (shadowRoot && !seen.has(shadowRoot)) {
                  seen.add(shadowRoot);
                  roots.push(shadowRoot);
                  queue.push(shadowRoot);
                }
              }
            }

            return roots;
          };

          const extractArticleUrlFromState = () => {
            const fromLocation = normalizeArticleUrl(location.href);
            if (fromLocation) {
              return fromLocation;
            }

            const anchors = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="/i/article/"]'));
            for (const anchor of anchors) {
              const normalized = normalizeArticleUrl(anchor.href || anchor.getAttribute("href"));
              if (normalized) {
                return normalized;
              }
            }

            try {
              const state = (window as typeof window & {
                __INITIAL_STATE__?: {
                  entities?: {
                    tweets?: {
                      entities?: Record<string, {
                        entities?: {
                          urls?: Array<{ expanded_url?: string; url?: string }>;
                        };
                      }>;
                    };
                  };
                };
              }).__INITIAL_STATE__;

              const statusId = location.pathname.match(/\/status\/(\d+)/)?.[1];
              const tweet = statusId ? state?.entities?.tweets?.entities?.[statusId] : undefined;
              const urls = tweet?.entities?.urls ?? [];
              for (const entry of urls) {
                const normalized = normalizeArticleUrl(entry?.expanded_url || entry?.url);
                if (normalized) {
                  return normalized;
                }
              }
            } catch {
              // Ignore X runtime state parsing failures.
            }

            return null;
          };

          const hasMeaningfulXArticle = (element: HTMLElement | null) => {
            if (!element) {
              return false;
            }

            const text = normalizeText(element.innerText || element.textContent);
            if (text.length < 500) {
              return false;
            }

            const lines = (element.innerText || element.textContent || "")
              .split(/\n+/)
              .map(part => normalizeText(part))
              .filter(Boolean);

            const imageCount = element.querySelectorAll("img").length;
            const dirAutoCount = element.querySelectorAll('[dir="auto"]').length;

            return (
              text.length >= 1400 ||
              (text.length >= 900 && lines.length >= 8) ||
              (text.length >= 650 && lines.length >= 6 && (imageCount > 0 || dirAutoCount >= 4))
            );
          };

          const scoreCandidate = (element: HTMLElement) => {
            if (element.closest("nav, aside, footer, form, header, button")) {
              return Number.NEGATIVE_INFINITY;
            }

            const rect = element.getBoundingClientRect();
            if (rect.width < 220 || rect.height < 80) {
              return Number.NEGATIVE_INFINITY;
            }

            const text = normalizeText(element.innerText || element.textContent);
            if (text.length < 180 || isNoiseText(text)) {
              return Number.NEGATIVE_INFINITY;
            }

            const lines = (element.innerText || element.textContent || "")
              .split(/\n+/)
              .map(part => normalizeText(part))
              .filter(Boolean);

            const imageCount = element.querySelectorAll("img").length;
            const linkCount = element.querySelectorAll("a").length;
            const paragraphLikeCount = element.querySelectorAll('p, blockquote, li, [dir="auto"]').length;
            const dataTestId = element.getAttribute("data-testid") ?? "";
            const viewportCenterX = window.innerWidth / 2;
            const candidateCenterX = rect.left + rect.width / 2;
            const centerDistance = Math.abs(candidateCenterX - viewportCenterX);
            const leadingNoiseCount = lines.slice(0, 20).filter(line => isNoiseText(line)).length;

            let score = Math.min(text.length, 22000);
            score += Math.min(lines.length, 80) * 40;
            score += paragraphLikeCount * 75;
            score += imageCount * 45;
            score -= linkCount * 3;
            score += Math.min(rect.height, 2600) / 4;
            score += Math.max(0, 260 - centerDistance);
            score -= leadingNoiseCount * 220;

            if (text.length >= 1200) {
              score += 900;
            }
            if (lines.length >= 8) {
              score += 400;
            }
            if (element.tagName.toLowerCase() === "article") {
              score += 240;
            }
            if (dataTestId === "cellInnerDiv") {
              score += 120;
            }
            if (rect.width >= 280 && rect.width <= Math.min(window.innerWidth * 0.52, 760)) {
              score += 220;
            }
            if (rect.width > Math.min(window.innerWidth * 0.72, 980)) {
              score -= 900;
            }
            if (linkCount > 80) {
              score -= 800;
            }
            if (leadingNoiseCount >= 4) {
              score -= 1400;
            }
            if (centerDistance > window.innerWidth * 0.2) {
              score -= 600;
            }

            return score;
          };

          const findBestXCandidate = () => {
            const roots = collectRoots();
            const selectors = [
              "main article",
              'main [data-testid="cellInnerDiv"]',
              "main section",
              "main div"
            ];
            const candidates: Array<{ element: HTMLElement; score: number }> = [];
            const seen = new Set<HTMLElement>();

            for (const root of roots) {
              for (const selector of selectors) {
                const matches = Array.from(root.querySelectorAll<HTMLElement>(selector));
                for (const match of matches) {
                  if (seen.has(match)) {
                    continue;
                  }

                  seen.add(match);
                  const score = scoreCandidate(match);
                  if (Number.isFinite(score)) {
                    candidates.push({ element: match, score });
                  }
                }
              }
            }

            candidates.sort((left, right) => right.score - left.score);
            return candidates[0]?.element ?? null;
          };

          const makeParagraphBlocks = (text: string) => {
            const rawBlocks = text
              .replace(/\r\n?/g, "\n")
              .split(/\n{2,}/)
              .map(part => normalizeText(part))
              .filter(Boolean);

            if (rawBlocks.length >= 3) {
              return rawBlocks;
            }

            return text
              .replace(/\r\n?/g, "\n")
              .split(/\n+/)
              .map(part => normalizeText(part))
              .filter(Boolean);
          };

          const looksLikeMetaLine = (text: string) => {
            const normalized = normalizeText(text);
            if (!normalized) {
              return true;
            }

            return (
              /^@\w+/i.test(normalized) ||
              /^https?:\/\//i.test(normalized) ||
              /^[\d\s.,万亿kKmM]+$/.test(normalized) ||
              /^(?:AM|PM|\d{1,2}:\d{2})/i.test(normalized) ||
              (normalized.length <= 32 && /(?:^|[\s|])\d+(?:\.\d+)?(?:万|k|m)?(?:[\s|]|$)/i.test(normalized))
            );
          };

          const parseFontWeight = (value: string) => {
            const numeric = Number(value);
            if (Number.isFinite(numeric)) {
              return numeric;
            }

            if (value === "bold" || value === "bolder") {
              return 700;
            }

            return 400;
          };

          const isVisibleElement = (element: HTMLElement) => {
            const style = getComputedStyle(element);
            if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity || "1") === 0) {
              return false;
            }

            const rect = element.getBoundingClientRect();
            return rect.width >= 8 && rect.height >= 8;
          };

          const countMeaningfulImages = (element: HTMLElement) =>
            Array.from(element.querySelectorAll("img")).filter(img => img.naturalWidth >= 120).length;

          const getDirectTextLength = (element: HTMLElement) =>
            Array.from(element.childNodes)
              .filter(node => node.nodeType === Node.TEXT_NODE)
              .map(node => normalizeText(node.textContent))
              .join(" ").length;

          const isSemanticBlockTag = (tagName: string) =>
            tagName === "p" ||
            tagName === "blockquote" ||
            tagName === "pre" ||
            tagName === "figure" ||
            tagName === "li" ||
            tagName === "ul" ||
            tagName === "ol" ||
            /^h[1-6]$/.test(tagName);

          const isCandidateBlockElement = (element: HTMLElement) => {
            const tagName = element.tagName.toLowerCase();
            const display = getComputedStyle(element).display;

            return (
              tagName === "article" ||
              tagName === "section" ||
              tagName === "div" ||
              tagName === "p" ||
              tagName === "blockquote" ||
              tagName === "pre" ||
              tagName === "figure" ||
              tagName === "li" ||
              tagName === "ul" ||
              tagName === "ol" ||
              /^h[1-6]$/.test(tagName) ||
              element.getAttribute("dir") === "auto" ||
              display === "block" ||
              display === "flex" ||
              display === "grid" ||
              display === "flow-root" ||
              display === "list-item" ||
              display === "-webkit-box"
            );
          };

          const median = (values: number[]) => {
            if (values.length === 0) {
              return 0;
            }

            const sorted = [...values].sort((left, right) => left - right);
            const middle = Math.floor(sorted.length / 2);
            return sorted.length % 2 === 0
              ? (sorted[middle - 1] + sorted[middle]) / 2
              : sorted[middle];
          };

          const isFooterText = (text: string) => {
            const normalized = normalizeText(text);
            if (!normalized) {
              return false;
            }

            return (
              /查看引用/u.test(normalized) ||
              /(?:^|[\s·])\d{4}年\d{1,2}月\d{1,2}日/u.test(normalized) ||
              /^(?:上午|下午|凌晨|中午|晚上)\d/u.test(normalized) ||
              /^(?:#[^#\s]+(?:\s+#[^#\s]+){1,})$/u.test(normalized) ||
              /(?:查看|views?)$/i.test(normalized)
            );
          };

          const looksLikeCodeText = (text: string, fontFamily = "") => {
            const source = text
              .replace(/\u00A0/g, " ")
              .replace(/\r\n?/g, "\n")
              .replace(/\t/g, "  ");
            const lines = source
              .split(/\n+/)
              .map(line => line.replace(/\s+$/u, ""))
              .filter(line => line.trim().length > 0);

            if (lines.length === 0) {
              return false;
            }

            const lowerFont = fontFamily.toLowerCase();
            if (lowerFont.includes("mono") || lowerFont.includes("code")) {
              return true;
            }

            const codeLikeLineCount = lines.filter(line => {
              const trimmed = line.trim();
              return (
                /[{}[\];]|=>/.test(trimmed) ||
                /^(?:import|from|def|class|function|const|let|var|if\b|elif\b|else:|for\b|while\b|return\b|git\b|pip\b|python\b|docker\b|RUN\b|ENV\b|CMD\b|COPY\b)/.test(trimmed)
              );
            }).length;
            const indentedLineCount = lines.filter(line => /^\s{2,}\S/.test(line)).length;

            return (
              lines.length >= 2 &&
              (
                codeLikeLineCount >= Math.max(2, Math.ceil(lines.length * 0.4)) ||
                indentedLineCount >= Math.max(2, Math.ceil(lines.length * 0.4))
              )
            );
          };

          const splitStructuredText = (text: string) => {
            const source = text
              .replace(/\u00A0/g, " ")
              .replace(/\r\n?/g, "\n")
              .trim();

            if (!source) {
              return [];
            }

            if (looksLikeCodeText(source)) {
              return [source];
            }

            const normalized = source
              .replace(/\u00A0/g, " ")
              .replace(/\r\n?/g, "\n")
              .replace(/([^\n])\s+(?=(?:[❌✅🔑🌐📊🔍📥🧪🔄🤖📈✍️📤🌟⚠️📋⏰])\s*[^\s])/gu, "$1\n\n")
              .replace(/([。！？.!?])\s*(?=[📊🛠️📑🔍📥🧪🔄🤖📈✍️📤🌟🔑🚀⚠️❌✅📋⏰])/gu, "$1\n\n")
              .replace(/([。！？.!?])\s*(?=(?:第[一二三四五六七八九十0-9]+[章节步]|[一二三四五六七八九十0-9]+[、.．:：]))/gu, "$1\n\n")
              .replace(/([)）】」"'A-Za-z0-9\u4e00-\u9fff])\s*(?=(?:核心优势|具体使用场景|账号获取建议|配置建议|使用技巧|安装步骤|开发流程|开发框架选择|常见问题(?:及解决方案)?|示例(?:使用)?|拆解要点|拆解重点|关键词组合策略|工作流程|评估维度|决策公式|决策矩阵|危险信号|验证方法|理性选择建议|主流平台|热门Skill推荐|优质项目推荐|目标期刊|字数限制|章节要求)[:：])/gu, "$1\n\n")
              .replace(/([:：])\s*(?=(?:核心优势|具体使用场景|账号获取建议|配置建议|使用技巧|安装步骤|开发流程|常见问题|示例使用|拆解要点|关键词组合策略|工作流程|评估维度|决策公式|决策矩阵|危险信号|验证方法|理性选择建议))/gu, "$1\n\n")
              .replace(/([:：])\s*(?=(?:#|git\b|pip\b|python\b|export\b|docker\b|FROM\b|RUN\b|ENV\b|CMD\b|COPY\b))/gu, "$1\n\n")
              .replace(/\s*(?=(?:[-*•]\s+|\d+\.\s+))/g, "\n");

            const coarseBlocks = normalized
              .split(/\n{2,}/)
              .map(part => normalizeText(part))
              .filter(Boolean);

            return coarseBlocks.length > 0 ? coarseBlocks : makeParagraphBlocks(text);
          };

          const createListNode = (segment: string) => {
            const lines = segment
              .split(/\n+/)
              .map(line => normalizeText(line))
              .filter(Boolean);

            if (lines.length < 2) {
              return null;
            }

            const bulletPattern = /^[-*•]\s+/;
            const orderedPattern = /^\d+\.\s+/;

            if (lines.every(line => bulletPattern.test(line))) {
              const list = document.createElement("ul");
              for (const line of lines) {
                const item = document.createElement("li");
                item.textContent = line.replace(bulletPattern, "");
                list.appendChild(item);
              }
              return list;
            }

            if (lines.every(line => orderedPattern.test(line))) {
              const list = document.createElement("ol");
              for (const line of lines) {
                const item = document.createElement("li");
                item.textContent = line.replace(orderedPattern, "");
                list.appendChild(item);
              }
              return list;
            }

            return null;
          };

          const collectStructuredBlocks = (root: HTMLElement) => {
            const blocks: Array<{
              element: HTMLElement;
              rawText: string;
              text: string;
              top: number;
              bottom: number;
              fontSize: number;
              fontWeight: number;
              fontFamily: string;
              imageCount: number;
              tagName: string;
            }> = [];

            const buildBlock = (element: HTMLElement) => {
              const rawText = (element.innerText || element.textContent || "")
                .replace(/\u00A0/g, " ")
                .replace(/\r\n?/g, "\n");
              const text = normalizeText(rawText);
              const rect = element.getBoundingClientRect();
              const style = getComputedStyle(element);
              return {
                element,
                rawText,
                text,
                top: rect.top + window.scrollY,
                bottom: rect.bottom + window.scrollY,
                fontSize: parseFloat(style.fontSize || "0") || 0,
                fontWeight: parseFontWeight(style.fontWeight || "400"),
                fontFamily: style.fontFamily || "",
                imageCount: countMeaningfulImages(element),
                tagName: element.tagName.toLowerCase()
              };
            };

            const visit = (element: HTMLElement) => {
              if (!isCandidateBlockElement(element) || !isVisibleElement(element)) {
                return;
              }

              if (element.closest("nav, aside, footer, form, header, button")) {
                return;
              }

              const block = buildBlock(element);
              if (block.imageCount === 0 && block.text.length < 8) {
                return;
              }

              if ((isNoiseText(block.text) || isFooterText(block.text)) && block.imageCount === 0) {
                return;
              }

              const childBlocks = Array.from(element.children)
                .filter((child): child is HTMLElement => child instanceof HTMLElement)
                .filter(child => isCandidateBlockElement(child) && isVisibleElement(child))
                .map(buildBlock)
                .filter(child => child.imageCount > 0 || child.text.length >= 8)
                .filter(child => !(isNoiseText(child.text) && child.imageCount === 0));

              const childTextCoverage = childBlocks.reduce((sum, child) => sum + child.text.length, 0);
              const childImageCoverage = childBlocks.reduce((sum, child) => sum + child.imageCount, 0);
              const directTextLength = getDirectTextLength(element);
              const shouldDescend = (
                childBlocks.length > 0 &&
                !isSemanticBlockTag(block.tagName) &&
                element.getAttribute("dir") !== "auto" &&
                directTextLength < Math.max(24, block.text.length * 0.18) &&
                (
                  childBlocks.length === 1 ||
                  childTextCoverage >= block.text.length * 0.55 ||
                  childImageCoverage >= block.imageCount
                )
              );

              if (shouldDescend) {
                for (const child of childBlocks) {
                  visit(child.element);
                }
                return;
              }

              blocks.push(block);
            };

            visit(root);

            const deduped: typeof blocks = [];
            for (const block of blocks.sort((left, right) =>
              left.top !== right.top ? left.top - right.top : left.text.length - right.text.length
            )) {
              const duplicateIndex = deduped.findIndex(existing =>
                Math.abs(existing.top - block.top) < 10 &&
                (existing.element.contains(block.element) || block.element.contains(existing.element)) &&
                (
                  existing.text === block.text ||
                  existing.text.includes(block.text) ||
                  block.text.includes(existing.text)
                )
              );

              if (duplicateIndex < 0) {
                deduped.push(block);
                continue;
              }

              if (block.text.length < deduped[duplicateIndex].text.length) {
                deduped[duplicateIndex] = block;
              }
            }

            return deduped.sort((left, right) =>
              left.top !== right.top ? left.top - right.top : left.text.length - right.text.length
            );
          };

          const buildNormalizedBody = (element: HTMLElement) => {
            const wrapper = document.createElement("div");
            const seenImageUrls = new Set<string>();

            const blocks = collectStructuredBlocks(element);
            if (blocks.length === 0) {
              return {
                title: "",
                bodyHtml: "",
                bodyText: ""
              };
            }

            const paragraphLikeBlocks = blocks.filter(block =>
              !isNoiseText(block.text) &&
              !looksLikeMetaLine(block.text) &&
              block.text.length >= 40 &&
              /[。！？.!?]/.test(block.text)
            );
            const paragraphFontSize = median(paragraphLikeBlocks.map(block => block.fontSize).filter(size => size > 0)) || 16;

            const scorePotentialTitle = (block: typeof blocks[number], index: number) => {
              if (isNoiseText(block.text) || looksLikeMetaLine(block.text) || isFooterText(block.text)) {
                return Number.NEGATIVE_INFINITY;
              }

              let score = 0;
              if (block.text.length >= 18 && block.text.length <= 220) {
                score += 220;
              } else if (block.text.length >= 12 && block.text.length <= 260) {
                score += 80;
              } else {
                score -= 120;
              }

              if (/[:：!！?？]/.test(block.text)) {
                score += 140;
              }
              if (/[\u4e00-\u9fff]/u.test(block.text)) {
                score += 80;
              }
              if (block.text.length >= 24 && block.text.length <= 120) {
                score += 120;
              }
              if (block.text.length > 160) {
                score -= 80;
              }
              if (block.fontSize > paragraphFontSize) {
                score += Math.min(320, (block.fontSize - paragraphFontSize) * 80);
              }
              if (block.fontWeight >= 600) {
                score += 120;
              }
              if (isSemanticBlockTag(block.tagName)) {
                score += 60;
              }
              if (index < 8) {
                score += 180 - index * 18;
              }
              if (/\|/.test(block.text) && block.text.length < 40) {
                score -= 260;
              }

              const nextContentBlocks = blocks
                .slice(index + 1)
                .filter(part => !isNoiseText(part.text) && !looksLikeMetaLine(part.text) && !isFooterText(part.text))
                .slice(0, 3);

              if (nextContentBlocks.length >= 2) {
                score += 80;
              }
              if (nextContentBlocks.some(part => /^@\w+/i.test(part.text))) {
                score -= 220;
              }
              if (nextContentBlocks.some(part => part.text.length >= 80 && /[。！？.!?]/.test(part.text))) {
                score += 240;
              }

              return score;
            };

            let titleIndex = 0;
            let bestTitleScore = Number.NEGATIVE_INFINITY;
            for (const [index, block] of blocks.entries()) {
              const score = scorePotentialTitle(block, index);
              if (score > bestTitleScore) {
                bestTitleScore = score;
                titleIndex = index;
              }
            }

            const title = blocks[titleIndex]?.text ?? "";
            const titleFontSize = blocks[titleIndex]?.fontSize || paragraphFontSize;

            const getSingleLineText = (value: string) => normalizeText(value.replace(/\r\n?/g, " "));

            const appendImageNodes = (sourceElement: HTMLElement) => {
              const images = Array.from(sourceElement.querySelectorAll("img"))
                .filter(img => img.naturalWidth >= 120)
                .slice(0, 6);

              for (const image of images) {
                const source = (image as HTMLImageElement).currentSrc || image.getAttribute("src");
                if (!source || seenImageUrls.has(source)) {
                  continue;
                }

                seenImageUrls.add(source);
                const img = document.createElement("img");
                img.src = source;
                const alt = image.getAttribute("alt");
                if (alt) {
                  img.alt = alt;
                }
                wrapper.appendChild(img);
              }
            };

            const appendCodeBlock = (text: string) => {
              const trimmed = text.replace(/\s+$/u, "");
              if (!trimmed) {
                return;
              }

              const pre = document.createElement("pre");
              const code = document.createElement("code");
              code.textContent = trimmed;
              pre.appendChild(code);
              wrapper.appendChild(pre);
            };

            const isHeadingSegment = (segment: string, block: typeof blocks[number]) => {
              if (segment.length < 6 || segment.length > 140) {
                return false;
              }

              if (looksLikeMetaLine(segment) || isNoiseText(segment)) {
                return false;
              }

              if (/^[📊🛠️📑🔍📥🧪🔄🤖📈✍️📤🌟🔑🚀⚠️❌✅📋⏰]/u.test(segment)) {
                return true;
              }

              if (/^(?:第[一二三四五六七八九十0-9]+[章节步]|[一二三四五六七八九十0-9]+[、.．:：])/u.test(segment)) {
                return true;
              }

              if (block.fontWeight >= 600 && block.fontSize >= paragraphFontSize * 1.05) {
                return true;
              }

              return !/[。！？.!?]/.test(segment) && segment.length <= 60 && block.fontSize >= paragraphFontSize;
            };

            const getListType = (segment: string) => {
              if (/^[-*•]\s+/.test(segment)) {
                return "ul";
              }

              if (/^\d+\.\s+/.test(segment)) {
                return "ol";
              }

              return null;
            };

            const stripListMarker = (segment: string) =>
              segment.replace(/^[-*•]\s+/, "").replace(/^\d+\.\s+/, "");

            let activeList: HTMLUListElement | HTMLOListElement | null = null;
            let activeListType: "ul" | "ol" | null = null;
            const resetActiveList = () => {
              activeList = null;
              activeListType = null;
            };
            const ensureList = (type: "ul" | "ol") => {
              if (!activeList || activeListType !== type) {
                activeList = document.createElement(type);
                activeListType = type;
                wrapper.appendChild(activeList);
              }
              return activeList;
            };

            let bodyStarted = false;

            for (const [index, block] of blocks.entries()) {
              if (index < titleIndex) {
                if (block.imageCount > 0 && Math.abs(block.top - blocks[titleIndex].top) < 320) {
                  appendImageNodes(block.element);
                }
                continue;
              }

              if (index === titleIndex) {
                continue;
              }

              if (isFooterText(block.text)) {
                resetActiveList();
                if (bodyStarted) {
                  break;
                }
                continue;
              }

              if (isNoiseText(block.text) || looksLikeMetaLine(block.text)) {
                resetActiveList();
                continue;
              }

              if (block.imageCount > 0) {
                appendImageNodes(block.element);
                if (block.text.length < 24) {
                  resetActiveList();
                  continue;
                }
              }

              const segments = splitStructuredText(block.rawText);
              if (segments.length === 0) {
                resetActiveList();
                continue;
              }

              for (const segment of segments) {
                const singleLineSegment = getSingleLineText(segment);
                if (!singleLineSegment || isNoiseText(singleLineSegment) || looksLikeMetaLine(singleLineSegment) || isFooterText(singleLineSegment)) {
                  resetActiveList();
                  continue;
                }

                if (looksLikeCodeText(segment, block.fontFamily)) {
                  resetActiveList();
                  appendCodeBlock(segment);
                  bodyStarted = true;
                  continue;
                }

                const listNode = createListNode(segment);
                if (listNode) {
                  resetActiveList();
                  wrapper.appendChild(listNode);
                  bodyStarted = true;
                  continue;
                }

                const listType = getListType(singleLineSegment);
                if (listType) {
                  const list = ensureList(listType);
                  const item = document.createElement("li");
                  item.textContent = stripListMarker(singleLineSegment);
                  list.appendChild(item);
                  bodyStarted = true;
                  continue;
                }

                resetActiveList();

                if (isHeadingSegment(singleLineSegment, block)) {
                  const heading = document.createElement(
                    block.fontSize >= Math.max(titleFontSize * 0.82, paragraphFontSize * 1.18) ? "h2" : "h3"
                  );
                  heading.textContent = singleLineSegment;
                  wrapper.appendChild(heading);
                  bodyStarted = true;
                  continue;
                }

                if (block.tagName === "blockquote") {
                  const quote = document.createElement("blockquote");
                  const paragraph = document.createElement("p");
                  paragraph.textContent = singleLineSegment;
                  quote.appendChild(paragraph);
                  wrapper.appendChild(quote);
                } else {
                  const paragraph = document.createElement("p");
                  paragraph.textContent = singleLineSegment;
                  wrapper.appendChild(paragraph);
                }
                bodyStarted = true;
              }
            }

            if (wrapper.childNodes.length === 0 && title) {
              const paragraph = document.createElement("p");
              paragraph.textContent = title;
              wrapper.appendChild(paragraph);
            }

            const bodyText = normalizeText(wrapper.textContent);
            return {
              title,
              bodyHtml: wrapper.innerHTML,
              bodyText
            };
          };

          const titleFromDocument = (document.title || "")
            .replace(/\s*\/\s*X\s*$/i, "")
            .replace(/\s*on X:?\s*$/i, "")
            .trim();

          const startedAt = Date.now();
          let candidate = findBestXCandidate();
          while (Date.now() - startedAt < 8000 && !hasMeaningfulXArticle(candidate)) {
            await new Promise(resolve => setTimeout(resolve, 250));
            candidate = findBestXCandidate();
          }

          if (!candidate || !hasMeaningfulXArticle(candidate)) {
            return null;
          }

          const articleUrl = extractArticleUrlFromState();
          const normalizedBody = buildNormalizedBody(candidate);
          if (!normalizedBody.bodyHtml || normalizedBody.bodyText.length < 400) {
            return null;
          }

          return {
            title: normalizedBody.title || titleFromDocument,
            excerpt: normalizedBody.bodyText.slice(0, 220) || null,
            canonicalUrl: articleUrl,
            bodyHtml: normalizedBody.bodyHtml,
            language: document.documentElement.lang || null
          };
        }

export function capture_chatgpt(expectedUrl: string, timeoutMs: number, userRoleLabel: string, assistantRoleLabel: string, conversationTitle: string, sharedConversationTitle: string) {
if (location.href !== expectedUrl) throw new Error("SOURCE_CHANGED");

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

export function capture_gemini(expectedUrl: string, timeoutMs: number, userRoleLabel: string, assistantRoleLabel: string, fallbackConversationTitle: string) {
if (location.href !== expectedUrl) throw new Error("SOURCE_CHANGED");

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

export async function capture_grok(expectedUrl: string, timeoutMs: number, userRoleLabel: string, assistantRoleLabel: string, fallbackConversationTitle: string) {
if (location.href !== expectedUrl) throw new Error("SOURCE_CHANGED");

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

export function capture_substack(expectedUrl: string, timeoutMs: number) {
if (location.href !== expectedUrl) throw new Error("SOURCE_CHANGED");

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

export async function capture_generic(expectedUrl: string, timeoutMs: number) {
if (location.href !== expectedUrl) throw new Error("SOURCE_CHANGED");

        const isSubstackWrapperPage =
          location.hostname === "substack.com" && location.pathname.startsWith("/home/post/");

        const normalizeText = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();
        const isTelegraphHost = location.hostname === "telegraph.co.uk" || location.hostname.endsWith(".telegraph.co.uk");
        const structuralNoisePatterns = [
          /This feature is available for registered users/i,
          /\bGift this article free\b/i,
          /\bGift article\b/i,
          /\bShare article\b/i,
          /\bAdd us as preferred source\b/i,
          /\bRelated Topics\b/i,
          /\bRegister\b[\s\S]{0,40}\bLog in\b/i,
          /\bComment speech bubble icon\b/i
        ];
        const countNoiseHits = (value: string) =>
          structuralNoisePatterns.reduce((count, pattern) => count + (pattern.test(value) ? 1 : 0), 0);

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
          const noiseHits = countNoiseHits(text);

          let score = Math.min(text.length, 12000);
          score += paragraphCount * 260;
          score += listCount * 80;
          score += quoteCount * 140;
          score += codeBlockCount * 140;
          score += headingCount * 110;
          score += imageCount * 30;
          score -= linkCount * 6;
          score -= noiseHits * 700;

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
          if (noiseHits >= 2) {
            score -= 1600;
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
            ...(isTelegraphHost
              ? [
                  '[itemprop="articleBody"]',
                  '[data-testid="article-body"]',
                  '[data-testid*="article-body"]',
                  '[class*="articleBody"]',
                  '[class*="article-body"]',
                  '[class*="ArticleBody"]',
                  '[class*="story-body"]',
                  '[class*="storyBody"]'
                ]
              : []),
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
