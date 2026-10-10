import { matchUrl, type PageIdentity } from "../shared/model";
import { executeCapture, type CaptureStage } from "../shared/capture";

export interface ExtractionContext {
  identity?: PageIdentity;
  operationId?: string;
  signal?: AbortSignal;
  automatic?: boolean;
  incognito?: boolean;
  preferredTabId?: number;
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
