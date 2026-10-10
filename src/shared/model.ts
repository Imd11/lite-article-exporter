import type { ArticleData, ExportFormat } from "../types/index";

export interface PageIdentity {
  tabId: number;
  documentId: string;
  url: string;
  revision: number;
  incognito: boolean;
}
export type JobState = "queued" | "preparing" | "building" | "downloading" | "complete" | "partial" | "error" | "cancelled" | "uncertain";
export type FormatState = "queued" | "building" | "downloading" | "complete" | "error" | "cancelled" | "uncertain";
export interface FormatResult {
  state: FormatState;
  attemptId?: string;
  downloadId?: number;
  blobUrl?: string;
  filename?: string;
  error?: string;
  warnings?: string[];
}
export interface ExportJob {
  id: string;
  attemptId?: string;
  cancelRequested?: boolean;
  requestId: string;
  url: string;
  identity?: PageIdentity;
  requester?: PageIdentity;
  requesterTabId?: number;
  articleKey?: string;
  title: string;
  formats: ExportFormat[];
  results: Partial<Record<ExportFormat, FormatResult>>;
  state: JobState;
  createdAt: number;
  updatedAt: number;
  historyGeneration: number;
  incognito: boolean;
  error?: string;
}
export interface CacheEntry {
  key: string;
  identity: PageIdentity;
  fingerprint: string;
  dependencies?: Array<{ identity: PageIdentity; fingerprint: string }>;
  version: number;
  article: ArticleData;
  touchedAt: number;
  pins: string[];
}
export interface Preparation {
  id: string;
  url: string;
  identity?: PageIdentity;
  sources?: PageIdentity[];
  sourceUrls?: string[];
  dependencies?: Array<{ identity: PageIdentity; fingerprint: string }>;
  incognito: boolean;
  fingerprint: string;
  mode: "automatic" | "user";
  jobIds: string[];
  startedAt: number;
}
export const EXTRACTOR_VERSION = 2;
export function blobKey(jobId: string, format: ExportFormat, attemptId?: string): string {
  return attemptId ? `${jobId}:${attemptId}:${format}` : `${jobId}:${format}`;
}
export function boundedFingerprint(value: string): string {
  if (value.length > 1500000) return "";
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  return `${value.length}:${hash >>> 0}`;
}
export const FORMATS: ExportFormat[] = ["markdown", "text", "word", "pdf"];
export const TERMINAL = new Set<JobState>(["complete", "partial", "error", "cancelled", "uncertain"]);
export function identityKey(identity: PageIdentity): string {
  return `${identity.incognito ? "private" : "normal"}:${identity.tabId}:${identity.documentId}:${identity.revision}`;
}
export function sameIdentity(a?: PageIdentity, b?: PageIdentity): boolean {
  return !!a && !!b && identityKey(a) === identityKey(b) && a.url === b.url;
}
export function matchUrl(a: string, b: string): boolean {
  try {
    const left = new URL(a), right = new URL(b);
    if (!["https:", "http:"].includes(left.protocol) || !["https:", "http:"].includes(right.protocol)) return false;
    const host = (value: string) => /^(?:www\.)?(?:twitter|x)\.com$/.test(value) ? "x.com" : value;
    return left.protocol === right.protocol && left.username === right.username && left.password === right.password && left.port === right.port && host(left.hostname) === host(right.hostname) && left.pathname.replace(/\/$/, "") === right.pathname.replace(/\/$/, "") && left.search === right.search && left.hash === right.hash;
  } catch { return false; }
}
export function aggregateState(job: ExportJob): JobState {
  const states = job.formats.map(format => job.results[format]?.state ?? "queued");
  if (states.includes("building") || states.includes("queued")) return "building";
  if (states.includes("downloading")) return "downloading";
  if (states.every(state => state === "complete")) return "complete";
  if (states.some(state => state === "complete")) return "partial";
  if (states.includes("uncertain")) return "uncertain";
  if (states.every(state => state === "cancelled")) return "cancelled";
  return "error";
}
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.catch(() => undefined);
    return result;
  }
}
