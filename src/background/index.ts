import { clearPrivateWhenClosed, cleanIdle, downloadChanged, handle, invalidate, prepareActive, reconcile } from "./engine";
const popupCommands = new Set(["view", "getJob", "submit", "retry", "cancel", "setAuto", "getHistory", "clearHistory", "addRecord", "updateRecord", "legacyDownload"]);
const processorCommands = new Set(["capturePage", "findTab", "resolveCanonical", "prepared", "prepareFailed", "payloadReady", "formatStarted", "formatFailed", "buildFailed", "buildFinished", "processorIdle"]);
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.target && message.target !== "background") return;
  if (sender.id !== chrome.runtime.id) return;
  const path = sender.url ? new URL(sender.url).pathname : "";
  const user = path === "/popup/index.html", processor = path === "/offscreen/index.html";
  if (!user && !processor || user && !popupCommands.has(message?.type) || processor && !processorCommands.has(message?.type)) return;
  void handle(message).then(data => {
    if (data && typeof data === "object" && "success" in data) respond(data);
    else respond({ success: true, data, ...(data && typeof data === "object" && "release" in data ? { release: data.release } : {}) });
    if (["processorIdle", "buildFinished", "buildFailed"].includes(message.type)) void cleanIdle();
    if (message.type === "setAuto" && message.enabled) void prepareActive();
  }).catch(error => respond({ success: false, error: String(error) }));
  return true;
});
chrome.downloads.onChanged.addListener(delta => { void downloadChanged(delta.id).catch(console.error); });
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === "articleExporter:watchdog") void reconcile().catch(console.error); });
const navigation = (details: { tabId: number; frameId: number }) => {
  if (details.frameId !== 0) return;
  void invalidate(details.tabId).then(prepareActive).catch(console.error);
};
chrome.webNavigation.onCommitted.addListener(navigation);
chrome.webNavigation.onHistoryStateUpdated.addListener(navigation);
chrome.webNavigation.onReferenceFragmentUpdated.addListener(navigation);
chrome.webNavigation.onDOMContentLoaded.addListener(details => { if (details.frameId === 0) void prepareActive(); });
chrome.tabs.onUpdated.addListener((_id, change) => { if (change.status === "complete") void prepareActive(); });
chrome.tabs.onActivated.addListener(() => { void prepareActive(); });
chrome.tabs.onRemoved.addListener(id => { void invalidate(id).then(cleanIdle).catch(console.error); });
chrome.tabs.onReplaced.addListener((_added, removed) => { void invalidate(removed).then(prepareActive).catch(console.error); });
chrome.windows.onFocusChanged.addListener(id => { if (id !== chrome.windows.WINDOW_ID_NONE) void prepareActive(); });
chrome.windows.onRemoved.addListener(() => { void clearPrivateWhenClosed().catch(console.error); });
chrome.runtime.onStartup.addListener(() => { void reconcile().then(prepareActive).catch(console.error); });
chrome.runtime.onInstalled.addListener(() => { void reconcile().then(prepareActive).catch(console.error); });
