/**
 * @file page-highlight.ts
 * @description Apply sentence + word highlights on the page via the CSS Highlight API.
 */

import type { HighlightState } from "../shared/highlight";
import type { LiveTextMap } from "./text-map";

const STYLE_ID = "kokororead-highlight-style";
const SENTENCE_NAME = "kokoro-sentence";
const WORD_NAME = "kokoro-word";

let activeMap: LiveTextMap | null = null;
let lastSentenceKey = "";
let lastWordKey = "";

export function ensureHighlightStyles(): void {
  const css = `
::highlight(${SENTENCE_NAME}) {
  background-color: rgba(232, 184, 109, 0.45);
  color: inherit;
}
::highlight(${WORD_NAME}) {
  background-color: rgba(180, 83, 9, 0.45);
  color: inherit;
}
`;
  let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement("style");
    style.id = STYLE_ID;
    (document.head || document.documentElement).appendChild(style);
  }
  style.textContent = css;
}

export function setHighlightMap(map: LiveTextMap | null): void {
  activeMap = map;
  if (!map) clearPageHighlight();
}

export function getHighlightMap(): LiveTextMap | null {
  return activeMap;
}

export function applyPageHighlight(state: HighlightState): void {
  ensureHighlightStyles();
  if (!state.active || !activeMap) {
    clearPageHighlight();
    return;
  }

  const highlights = cssHighlights();
  if (!highlights) return;

  if (
    typeof state.sentenceStart === "number" &&
    typeof state.sentenceEnd === "number" &&
    state.sentenceEnd > state.sentenceStart
  ) {
    const key = `${state.sentenceStart}:${state.sentenceEnd}`;
    const sentenceRanges = activeMap.rangesFor(state.sentenceStart, state.sentenceEnd);
    if (sentenceRanges.length > 0) {
      highlights.set(SENTENCE_NAME, new Highlight(...sentenceRanges));
      if (key !== lastSentenceKey) {
        lastSentenceKey = key;
        scrollRangeIntoView(sentenceRanges[0]!);
      }
    }
  }

  if (
    typeof state.wordStart === "number" &&
    typeof state.wordEnd === "number" &&
    state.wordEnd > state.wordStart
  ) {
    const key = `${state.wordStart}:${state.wordEnd}`;
    const wordRanges = activeMap.rangesFor(state.wordStart, state.wordEnd);
    if (wordRanges.length > 0) {
      highlights.set(WORD_NAME, new Highlight(...wordRanges));
      if (key !== lastWordKey) {
        lastWordKey = key;
        scrollRangeIntoView(wordRanges[0]!);
      }
    }
  }
}

export function clearPageHighlight(): void {
  const highlights = cssHighlights();
  if (highlights) {
    highlights.delete(SENTENCE_NAME);
    highlights.delete(WORD_NAME);
  }
  lastSentenceKey = "";
  lastWordKey = "";
}

/** Remove highlight styles + ranges (used when the extension unloads). */
export function disposeHighlightArtifacts(): void {
  clearPageHighlight();
  activeMap = null;
  document.getElementById(STYLE_ID)?.remove();
}

function cssHighlights(): HighlightRegistry | null {
  const css = CSS as typeof CSS & { highlights?: HighlightRegistry };
  return css.highlights ?? null;
}

function scrollRangeIntoView(range: Range): void {
  try {
    const rect = range.getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) {
      const node = range.startContainer;
      const el =
        node.nodeType === Node.ELEMENT_NODE
          ? (node as Element)
          : node.parentElement;
      el?.scrollIntoView({
        block: "center",
        inline: "nearest",
        behavior: "smooth",
      });
      return;
    }

    const viewCenter = window.innerHeight / 2;
    const rangeCenter = rect.top + rect.height / 2;
    // Skip tiny adjustments so word ticks don't constantly fight the user.
    if (Math.abs(rangeCenter - viewCenter) < window.innerHeight * 0.18) {
      return;
    }

    const node = range.startContainer;
    const el =
      node.nodeType === Node.ELEMENT_NODE
        ? (node as Element)
        : node.parentElement;
    el?.scrollIntoView({
      block: "center",
      inline: "nearest",
      behavior: "smooth",
    });
  } catch {
    // ignore
  }
}
