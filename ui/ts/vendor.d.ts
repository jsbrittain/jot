interface MarkedGlobal {
  parse(source: string, options?: { gfm?: boolean; breaks?: boolean }): string;
}

interface DOMPurifyGlobal {
  sanitize(html: string, options?: Record<string, unknown>): string;
}

interface Window {
  marked?: MarkedGlobal;
  DOMPurify?: DOMPurifyGlobal;
}
