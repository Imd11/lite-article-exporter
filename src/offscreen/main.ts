import { fetchArticle, articleToMarkdown, articleToPlainText } from "../utils/extractor";
import { setTranslations } from "../utils/i18n";
import type { ArticleData, ExportFormat } from "../types/index";
import { blobKey, FORMATS, type ExportJob, type Preparation } from "../shared/model";

const operations = new Map<string, AbortController>();
const jobs = new Map<string, AbortController>();
const seen = new Set<string>();
const blobs = new Map<string, string>();
const snapshots = new Map<string, ArticleData>();
const preparationTimers = new Map<string, ReturnType<typeof setTimeout>>();
let buildTail = Promise.resolve();
let exporters: typeof import("../utils/exporters") | undefined;
const report = (type: string, data: Record<string, unknown>) => chrome.runtime.sendMessage({ target: "background", type, ...data });

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.target !== "offscreen" || sender.id !== chrome.runtime.id || sender.tab || sender.url && new URL(sender.url).pathname !== "/background.js") return;
  if (message.type === "activity") { respond({ success: true, data: { operations: [...operations.keys()], jobs: [...jobs.keys()], blobs: blobs.size } }); return; }
  if (message.type === "promote") {
    clearTimeout(preparationTimers.get(message.id));
    const controller = operations.get(message.id);
    if (controller) preparationTimers.set(message.id, setTimeout(() => controller.abort(), 60000));
    respond({ success: true }); return;
  }
  if (message.type === "cancel") {
    operations.get(message.id)?.abort();
    for (const [key, controller] of jobs) if (message.attemptId ? key === `${message.id}:${message.attemptId}` : key.startsWith(`${message.id}:`)) controller.abort();
    snapshots.delete(message.id);
    respond({ success: true }); return;
  }
  if (message.type === "release") {
    const url = blobs.get(message.key);
    if (url) URL.revokeObjectURL(url);
    blobs.delete(message.key); snapshots.delete(message.operationId);
    respond({ success: true }); return;
  }
  if (message.type === "prepare") {
    if (!seen.has(message.operation.id)) {
      seen.add(message.operation.id);
      const controller = new AbortController(); operations.set(message.operation.id, controller);
      setTranslations(message.messages, message.language);
      void prepare(message.operation, controller);
    }
    respond({ success: true }); return;
  }
  if (message.type === "build") {
    const runId = `${message.job.id}:${message.job.attemptId}`;
    if (!seen.has(runId)) {
      seen.add(runId);
      const controller = new AbortController(); jobs.set(runId, controller);
      setTranslations(message.messages, message.language);
      const article = message.article ?? snapshots.get(message.operationId);
      buildTail = buildTail.catch(() => undefined).then(() => build(message.job, article, message.baseName, controller)).finally(() => {
        jobs.delete(runId);
        snapshots.delete(message.operationId);
        if (!jobs.size) exporters?.releaseExportResources();
        void report("processorIdle", {}).catch(() => undefined);
      });
    }
    respond({ success: true }); return;
  }
});

async function prepare(operation: Preparation, controller: AbortController) {
  preparationTimers.set(operation.id, setTimeout(() => controller.abort(), operation.mode === "automatic" ? 15000 : 60000));
  try {
    const article = await fetchArticle(operation.url, { identity: operation.identity, operationId: operation.id, signal: controller.signal, automatic: operation.mode === "automatic", incognito: operation.incognito });
    if (controller.signal.aborted) throw new Error("PREPARATION_TIMEOUT");
    snapshots.set(operation.id, article);
    const response = await report("prepared", { operationId: operation.id, article });
    if (response?.release) snapshots.delete(operation.id);
  } catch (error) {
    await report("prepareFailed", { operationId: operation.id, error: controller.signal.aborted ? "PREPARATION_TIMEOUT" : String(error) }).catch(() => undefined);
  } finally {
    clearTimeout(preparationTimers.get(operation.id)); preparationTimers.delete(operation.id); operations.delete(operation.id);
    void report("processorIdle", {}).catch(() => undefined);
  }
}

async function build(job: ExportJob, article: ArticleData | undefined, baseName: string, controller: AbortController) {
  try {
    if (!article) throw new Error("SNAPSHOT_LOST");
    for (const format of FORMATS.filter(format => job.formats.includes(format) && job.results[format]?.state !== "complete")) {
      if (controller.signal.aborted) break;
      const allowed = await report("formatStarted", { jobId: job.id, attemptId: job.attemptId, format });
      if (!allowed?.success) break;
      const timer = setTimeout(() => controller.abort(), 180000);
      const warnings: string[] = [];
      try {
        let payload: { blob: Blob; fileName: string };
        if (format === "markdown" || format === "text") {
          const content = format === "markdown" ? articleToMarkdown(article) : articleToPlainText(article);
          payload = { blob: new Blob([content], { type: `${format === "markdown" ? "text/markdown" : "text/plain"};charset=utf-8` }), fileName: `${baseName}.${format === "markdown" ? "md" : "txt"}` };
        } else {
          exporters ??= await import("../utils/exporters");
          [payload] = await exporters.buildExportPayloads(article, [format], { baseFileName: baseName, signal: controller.signal, warnings });
        }
        if (controller.signal.aborted) throw new Error("CANCELLED");
        const key = blobKey(job.id, format, job.attemptId);
        const blobUrl = URL.createObjectURL(payload.blob); blobs.set(key, blobUrl);
        const result = await report("payloadReady", { jobId: job.id, attemptId: job.attemptId, format, blobUrl, filename: payload.fileName, warnings });
        if (!result?.success) { URL.revokeObjectURL(blobUrl); blobs.delete(key); }
      } catch (error) {
        await report("formatFailed", { jobId: job.id, attemptId: job.attemptId, format, error: controller.signal.aborted ? "GENERATION_CANCELLED_OR_TIMEOUT" : String(error) });
      } finally { clearTimeout(timer); }
    }
    await report("buildFinished", { jobId: job.id, attemptId: job.attemptId, aborted: controller.signal.aborted });
  } catch (error) {
    await report("buildFailed", { jobId: job.id, attemptId: job.attemptId, error: String(error) }).catch(() => undefined);
  }
}
