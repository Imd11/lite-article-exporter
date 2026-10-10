import messages from "../../public/_locales/en/messages.json";

const path = "offscreen/index.html";
let creating: Promise<void> | undefined;
export function supported(): boolean {
  return !!chrome.offscreen?.createDocument && !!chrome.runtime.getContexts;
}
export async function exists(): Promise<boolean> {
  return supported() && (await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT" as chrome.runtime.ContextType], documentUrls: [chrome.runtime.getURL(path)] })).length > 0;
}
export async function ensureOffscreen() {
  if (!supported()) throw new Error("OFFSCREEN_UNAVAILABLE");
  if (await exists()) return;
  if (!creating) creating = chrome.offscreen.createDocument({ url: path, reasons: [chrome.offscreen.Reason.DOM_PARSER, chrome.offscreen.Reason.BLOBS], justification: "Parse article snapshots and generate local export files independently of the popup." }).finally(() => { creating = undefined; });
  await creating;
}
export async function offscreenMessage(message: Record<string, unknown>) {
  await ensureOffscreen();
  const response = await chrome.runtime.sendMessage({ ...message, target: "offscreen" });
  if (!response?.success) throw new Error(response?.error ?? "OFFSCREEN_FAILED");
  return response.data;
}
export function translations() {
  return Object.fromEntries(Object.keys(messages).map(key => [key, chrome.i18n.getMessage(key, ["{0}", "{1}", "{2}"])]));
}
export async function closeIfIdle() {
  if (!await exists()) return;
  const state = await offscreenMessage({ type: "activity" });
  if (!state.operations.length && !state.jobs.length && !state.blobs) await chrome.offscreen.closeDocument();
}
