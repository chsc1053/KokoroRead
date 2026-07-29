/**
 * Ambient types for the CSS Custom Highlight API (Chrome 105+).
 * Used by the content script for non-destructive sentence/word highlighting.
 */
interface HighlightRegistry {
  get(name: string): Highlight | undefined;
  set(name: string, highlight: Highlight): void;
  delete(name: string): boolean;
  clear(): void;
  has(name: string): boolean;
}

declare const Highlight: {
  new (...ranges: Range[]): Highlight;
};

interface Highlight {
  add(range: Range): void;
  clear(): void;
  delete(range: Range): boolean;
  has(range: Range): boolean;
  values(): IterableIterator<Range>;
}

interface CSS {
  highlights?: HighlightRegistry;
}
