import type { DownloadRecord } from "../types/index";

const HISTORY_KEY = "downloadHistory";
const HISTORY_LIMIT = 20;

type BackgroundMessage =
  | { type: "getHistory" }
  | { type: "addRecord"; payload: DownloadRecord }
  | { type: "updateRecord"; payload: { id: string; changes: Partial<DownloadRecord> } }
  | { type: "clearHistory" };

chrome.runtime.onMessage.addListener((message: BackgroundMessage, _sender, sendResponse) => {
  void handler(message)
    .then(result => sendResponse(result))
    .catch(error => {
      console.error("Background handler error", error);
      sendResponse({ success: false, error: String(error) });
    });
  return true;
});

async function handler(message: BackgroundMessage) {
  switch (message.type) {
    case "getHistory":
      return { success: true, data: await getHistory() };
    case "addRecord":
      await addHistoryRecord(message.payload);
      return { success: true };
    case "updateRecord":
      await updateHistoryRecord(message.payload.id, message.payload.changes);
      return { success: true };
    case "clearHistory":
      await clearHistory();
      return { success: true };
    default:
      return { success: false, error: "Unknown message" };
  }
}

async function getHistory(): Promise<DownloadRecord[]> {
  const stored = await chrome.storage.local.get(HISTORY_KEY);
  const history = stored[HISTORY_KEY] as DownloadRecord[] | undefined;
  return history ?? [];
}

async function addHistoryRecord(record: DownloadRecord) {
  const history = await getHistory();
  const next = [record, ...history].slice(0, HISTORY_LIMIT);
  await chrome.storage.local.set({ [HISTORY_KEY]: next });
}

async function updateHistoryRecord(id: string, changes: Partial<DownloadRecord>) {
  const history = await getHistory();
  const next = history.map(record =>
    record.id === id ? { ...record, ...changes } : record
  );
  await chrome.storage.local.set({ [HISTORY_KEY]: next });
}

async function clearHistory() {
  await chrome.storage.local.remove(HISTORY_KEY);
}

chrome.downloads.onChanged.addListener(delta => {
  if (delta.state?.current === "complete") {
    chrome.storage.local.set({ lastDownloadCompletedAt: Date.now() }).catch(error => {
      console.warn("记录下载完成时间失败", error);
    });
  }
});
