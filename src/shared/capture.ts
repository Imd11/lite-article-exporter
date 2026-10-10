import * as scripts from "./page-scripts";
import type { PageIdentity } from "./model";
export type CaptureStage = "wechat" | "x" | "chatgpt" | "gemini" | "grok" | "substack" | "generic";
export async function executeCapture(stage: CaptureStage, identity: PageIdentity, args: unknown[] = [], timeoutMs = 60000) {
  const func = scripts[`capture_${stage}`];
  if (!func) throw new Error("INVALID_CAPTURE_STAGE");
  const results = await chrome.scripting.executeScript({
    target: identity.documentId ? { tabId: identity.tabId, documentIds: [identity.documentId] } : { tabId: identity.tabId },
    world: stage === "substack" ? "MAIN" : "ISOLATED",
    func: func as (...args: any[]) => unknown,
    args: [identity.url, timeoutMs, ...args]
  });
  if (identity.documentId && results[0]?.documentId !== identity.documentId) throw new Error("SOURCE_CHANGED");
  return results;
}

// A bounded article-only check; no whole-page scoring or network requests.
export function probeArticle(expectedUrl: string) {
  if (location.href !== expectedUrl) throw new Error("SOURCE_CHANGED");
  const hostname = location.hostname;
  const hostIs = (site: string) => hostname === site || hostname.endsWith("." + site);
  const allowed = hostname === "mp.weixin.qq.com" || hostIs("substack.com") || hostIs("medium.com") || hostIs("telegraph.co.uk");
  const selectors = ["#js_content", ".rich_media_content", ".available-content .body.markup", ".body.markup", ".substack-post-body", '[itemprop="articleBody"]', '[data-testid="article-body"]', ".article-body", "article"];
  const root = selectors.map(selector => document.querySelector(selector)).find(Boolean);
  const ogArticle = document.querySelector('meta[property="og:type"]')?.getAttribute("content") === "article";
  const pathIsArticle = hostname === "mp.weixin.qq.com" ? /^\/s(?:\/|$)/.test(location.pathname) : hostIs("substack.com") ? /^\/(?:p\/|home\/post\/p-)/.test(location.pathname) : ogArticle;
  if (!root || document.getElementsByTagName("*").length > 15000) return { eligible: false, fingerprint: "", title: document.title };
  const html = root.innerHTML;
  if (html.length > 1500000) return { eligible: false, fingerprint: "", title: document.title };
  const text = root.textContent ?? "";
  const eligible = allowed && pathIsArticle && text.trim().length >= 100;
  if (!eligible) return { eligible: false, fingerprint: "", title: document.title };
  // Lazy loading changes display attributes without changing exportable content.
  // Fingerprint text, structure and meaningful attributes without cloning DOM/images.
  const transient = new Set(["style", "width", "height", "loading", "decoding", "fetchpriority", "data-w", "data-h", "data-width", "data-height"]);
  const imageData = ["data-src", "data-original", "data-actualsrc", "data-url", "data-lazy-src", "data-srcset", "data-medium", "data-large", "data-thumb", "data-image", "data-file", "data-link"];
  const structure = [root, ...Array.from(root.querySelectorAll("*"))].map(node => {
    const lazyImage = node.tagName === "IMG" && imageData.some(name => !!node.getAttribute(name));
    const attributes = node.getAttributeNames().filter(name => !transient.has(name) && !(name === "src" && lazyImage)).sort().map(name => {
      const value = node.tagName === "IMG" && name === "class" ? (node.getAttribute(name) ?? "").replace(/\blazy(?:load|loaded|loading)?\b/gi, "").trim() : node.getAttribute(name);
      return name === "class" && !value ? undefined : [name, value];
    }).filter(Boolean);
    const directText = Array.from(node.childNodes).flatMap((child, index) => child.nodeType === Node.TEXT_NODE ? [[index, child.textContent]] : []);
    return [node.tagName, node.parentElement?.tagName, node.childElementCount, directText, attributes];
  });
  const metadata = Array.from(document.querySelectorAll('head meta, head link[rel="canonical"]')).map(node => node.outerHTML).join("\n");
  const headline = document.querySelector("#activity-name, h1")?.textContent ?? "";
  // Some adapters read structured/preloaded content outside the visible article.
  const sourceParts: string[] = [];
  let sourceLength = 0, scannedLength = 0;
  for (const script of document.scripts) {
    const content = script.textContent ?? "";
    scannedLength += content.length;
    if (scannedLength > 1500000) return { eligible: false, fingerprint: "", title: document.title };
    if (script.type !== "application/ld+json" && !/_preloads|body_html/.test(content)) continue;
    sourceLength += content.length;
    if (sourceLength > 1500000) return { eligible: false, fingerprint: "", title: document.title };
    sourceParts.push(content);
  }
  const sourceScripts = sourceParts.join("\n");
  const value = `${document.title}\n${headline}\n${metadata}\n${sourceScripts}\n${text}\n${JSON.stringify(structure)}`;
  if (value.length > 1500000) return { eligible: false, fingerprint: "", title: document.title };
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  return { eligible, fingerprint: `${value.length}:${hash >>> 0}`, title: document.title };
}
