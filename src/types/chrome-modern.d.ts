// APIs used by the Chrome 116+ execution path; the legacy path is feature detected.
declare namespace chrome.scripting {
  interface InjectionTarget { documentIds?: string[]; }
  interface InjectionResult<T> { documentId?: string; }
}
declare namespace chrome.runtime {
  enum ContextType { OFFSCREEN_DOCUMENT = "OFFSCREEN_DOCUMENT" }
  function getContexts(filter: { contextTypes?: ContextType[]; documentUrls?: string[] }): Promise<{ contextType: ContextType; documentUrl?: string }[]>;
}
