declare module "@mozilla/readability" {
  interface ReadabilityOptions {
    debug?: boolean;
    charThreshold?: number;
    serializer?: (node: Document | Element) => string;
  }

  export interface ReadabilityResult {
    title: string;
    byline?: string;
    dir?: string;
    content: string;
    textContent: string;
    length: number;
    excerpt?: string;
    siteName?: string;
  }

  class Readability {
    constructor(document: Document, options?: ReadabilityOptions);
    parse(): ReadabilityResult | null;
  }

  export { Readability };
}
