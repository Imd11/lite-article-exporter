export type ExportFormat = "markdown" | "pdf" | "word" | "text";

export interface ImageAsset {
  url: string;
  alt?: string;
  fileName?: string;
  downloaded?: boolean;
}

export interface ArticleData {
  url: string;
  title: string;
  byline?: string | null;
  excerpt?: string | null;
  contentHtml: string;
  textContent: string;
  images: ImageAsset[];
  language?: string | null;
  fetchedAt: number;
}

export interface DownloadRecord {
  id: string;
  title: string;
  url: string;
  timestamp: number;
  formats: ExportFormat[];
  status: "success" | "error";
  errorMessage?: string;
}

export interface ExtractResponse {
  success: true;
  article: ArticleData;
}

export interface ExtractError {
  success: false;
  error: string;
}

export type ExtractResult = ExtractResponse | ExtractError;
