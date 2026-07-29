/**
 * @file highlight.ts
 * @description Sentence / word offset helpers for in-page TTS highlighting.
 */

export interface HighlightState {
  /** False clears all highlights. */
  active: boolean;
  /** Absolute offsets into the session's spoken / extracted text. */
  sentenceStart?: number;
  sentenceEnd?: number;
  wordStart?: number;
  wordEnd?: number;
}

/**
 * Expand a character index to the surrounding sentence in `text`.
 */
export function sentenceBounds(text: string, charIndex: number): [number, number] {
  if (!text) return [0, 0];
  const i = Math.max(0, Math.min(charIndex, Math.max(0, text.length - 1)));
  let start = i;
  while (start > 0 && !/[.!?…]/.test(text[start - 1]!)) start -= 1;
  while (start < text.length && /\s/.test(text[start]!)) start += 1;

  let end = i;
  while (end < text.length && !/[.!?…]/.test(text[end]!)) end += 1;
  if (end < text.length && /[.!?…]/.test(text[end]!)) end += 1;

  if (end <= start) {
    start = 0;
    end = text.length;
  }
  return [start, end];
}

/**
 * Expand a character index to the surrounding word (non-whitespace run).
 */
export function wordBounds(text: string, charIndex: number): [number, number] {
  if (!text) return [0, 0];
  let i = Math.max(0, Math.min(charIndex, Math.max(0, text.length - 1)));
  if (/\s/.test(text[i]!)) {
    while (i > 0 && /\s/.test(text[i]!)) i -= 1;
    if (/\s/.test(text[i]!)) return [charIndex, charIndex];
  }
  let start = i;
  while (start > 0 && !/\s/.test(text[start - 1]!)) start -= 1;
  let end = i + 1;
  while (end < text.length && !/\s/.test(text[end]!)) end += 1;
  return [start, end];
}

/**
 * Map playback progress 0–1 within a chunk to a character index, weighted by word length.
 */
export function charIndexAtProgress(text: string, progress: number): number {
  const t = Math.max(0, Math.min(1, progress));
  const words = [...text.matchAll(/\S+/g)];
  if (words.length === 0) return 0;
  if (t >= 1) {
    const last = words[words.length - 1]!;
    return last.index ?? 0;
  }
  const totalWeight = words.reduce((sum, w) => sum + w[0].length, 0);
  let target = t * totalWeight;
  for (const word of words) {
    target -= word[0].length;
    if (target <= 0) return word.index ?? 0;
  }
  return words[words.length - 1]!.index ?? 0;
}

/**
 * Build a highlight snapshot for an absolute character position in session text.
 */
export function highlightAt(text: string, absoluteChar: number): HighlightState {
  if (!text) return { active: false };
  const [sentenceStart, sentenceEnd] = sentenceBounds(text, absoluteChar);
  const [wordStart, wordEnd] = wordBounds(text, absoluteChar);
  return {
    active: true,
    sentenceStart,
    sentenceEnd,
    wordStart,
    wordEnd,
  };
}
