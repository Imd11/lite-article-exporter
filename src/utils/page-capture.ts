import { matchUrl, type PageIdentity } from "../shared/model";
import { executeCapture, type CaptureStage } from "../shared/capture";

export interface ExtractionContext {
  identity?: PageIdentity;
  operationId?: string;
  signal?: AbortSignal;
  automatic?: boolean;
  incognito?: boolean;
  preferredTabId?: number;
  canonicalDepth?: number;
}
export async function canonicalContext(url: string, context?: ExtractionContext): Promise<ExtractionContext | undefined> {
  if (!matchUrl(url, url) || (context?.canonicalDepth ?? 0) >= 2) throw new Error("INVALID_SOURCE");
  if (!context?.identity) return { ...context, canonicalDepth: (context?.canonicalDepth ?? 0) + 1 };
  let identity: PageIdentity | undefined;
  if (typeof chrome.tabs?.query === "function") {
    const source = await chrome.tabs.get(context.identity.tabId);
    if (!source.url || !matchUrl(source.url, context.identity.url)) throw new Error("SOURCE_CHANGED");
    if (context.identity.documentId && (await chrome.webNavigation.getFrame({ tabId: source.id!, frameId: 0 }))?.documentId !== context.identity.documentId) throw new Error("SOURCE_CHANGED");
    const [tab] = await findTabForUrl(url, context);
    if (tab?.id && tab.url) {
      const frame = await chrome.webNavigation?.getFrame({ tabId: tab.id, frameId: 0 });
      identity = { tabId: tab.id, url: tab.url, documentId: frame?.documentId ?? "", revision: 0, incognito: !!tab.incognito };
    }
  } else {
    const response = await chrome.runtime.sendMessage({ target: "background", type: "resolveCanonical", url, identity: context.identity, operationId: context.operationId });
    if (!response?.success) throw new Error(response?.error ?? "INVALID_SOURCE");
    identity = response.data;
  }
  return { ...context, identity, canonicalDepth: (context.canonicalDepth ?? 0) + 1 };
}
export async function capturePage(stage: CaptureStage, tabId: number, url: string, args: unknown[] = [], context?: ExtractionContext) {
  if (typeof chrome.scripting?.executeScript === "function") {
    let identity = context?.identity;
    if (!identity) {
      const tab = await chrome.tabs.get(tabId);
      if (!tab.url || !matchUrl(tab.url, url)) throw new Error("SOURCE_CHANGED");
      identity = { tabId, url: tab.url, documentId: "", revision: 0, incognito: !!tab.incognito };
    }
    return executeCapture(stage, identity, args);
  }
  const response = await chrome.runtime.sendMessage({ target: "background", type: "capturePage", stage, identity: context?.identity, operationId: context?.operationId, args });
  if (!response?.success) throw new Error(response?.error ?? "CAPTURE_FAILED");
  return response.data;
}
export async function findTabForUrl(url: string, context?: ExtractionContext): Promise<chrome.tabs.Tab[]> {
  if (chrome.tabs?.query) return (await chrome.tabs.query({})).filter(tab => !!tab.url && matchUrl(tab.url, url) && !!tab.incognito === !!context?.incognito).sort((a, b) => Number(b.id === context?.preferredTabId) - Number(a.id === context?.preferredTabId));
  const response = await chrome.runtime.sendMessage({ target: "background", type: "findTab", url, operationId: context?.operationId });
  if (!response?.success) throw new Error(response?.error ?? "CAPTURE_FAILED");
  return response.data;
}
