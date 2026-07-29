/**
 * @file chunking.ts
 * @description Text chunking for paragraph / moderate-segment synthesis.
 *
 * Uses moderate sentence-sized chunks: long enough that playback of chunk N
 * usually covers synthesis of N+1 (Worker + gapless schedule), short enough
 * for a quick first utterance.
 *
 * Each chunk carries start/end offsets into the normalized full session text
 * so playback can drive in-page sentence/word highlighting.
 */

import type { TextChunk } from "./types";
import { normalizeWhitespace } from "./utils";

/** Soft target — ~1–2 short sentences so play duration can hide next synth. */
export const DEFAULT_CHUNK_TARGET = 140;

/** Hard ceiling before forced split. */
export const DEFAULT_CHUNK_MAX = 200;

/** Short first chunk for faster time-to-first-audio. */
export const DEFAULT_QUICK_START_CHARS = 80;

export interface ChunkOptions {
  targetChars?: number;
  maxChars?: number;
  /** When true (default), peel a short first chunk for faster start. */
  quickStart?: boolean;
  quickStartChars?: number;
}

interface Piece {
  text: string;
  start: number;
  end: number;
}

/**
 * Split cleaned article/newsletter text into synthesis chunks.
 */
export function chunkText(raw: string, options: ChunkOptions = {}): TextChunk[] {
  const target = options.targetChars ?? DEFAULT_CHUNK_TARGET;
  const max = options.maxChars ?? DEFAULT_CHUNK_MAX;
  const text = normalizeWhitespace(raw);
  if (!text) return [];

  const pieces: Piece[] = [];
  let cursor = 0;
  const parts = text.split(/(\n{2,})/);
  for (const part of parts) {
    if (!part) continue;
    if (/^\n+$/.test(part)) {
      cursor += part.length;
      continue;
    }
    const start = cursor;
    const end = cursor + part.length;
    cursor = end;
    const paragraph = part.replace(/\n/g, " ").trim();
    if (!paragraph) continue;
    // Prefer the trimmed span inside this paragraph segment.
    const leading = part.match(/^\s*/)?.[0].length ?? 0;
    const paraStart = start + leading;
    const paraEnd = paraStart + paragraph.length;
    if (paragraph.length <= max) {
      pieces.push({
        text: text.slice(paraStart, paraEnd),
        start: paraStart,
        end: paraEnd,
      });
      continue;
    }
    pieces.push(...splitLongParagraph(text, paragraph, paraStart, target, max));
  }

  const merged = mergeSmallPieces(text, pieces, target);
  return merged.map((piece, index) => ({
    index,
    text: piece.text,
    start: piece.start,
    end: piece.end,
  }));
}

/**
 * Split an oversized paragraph on sentence boundaries, then word-pack.
 */
function splitLongParagraph(
  full: string,
  paragraph: string,
  paraStart: number,
  target: number,
  max: number,
): Piece[] {
  const sentenceRe = /[^.!?…]+[.!?…]+|[^.!?…]+$/g;
  const out: Piece[] = [];
  let bufferStart = -1;
  let bufferEnd = -1;

  const flush = () => {
    if (bufferStart < 0) return;
    out.push({
      text: full.slice(bufferStart, bufferEnd),
      start: bufferStart,
      end: bufferEnd,
    });
    bufferStart = -1;
    bufferEnd = -1;
  };

  let match: RegExpExecArray | null;
  while ((match = sentenceRe.exec(paragraph)) !== null) {
    const s = match[0].trim();
    if (!s) continue;
    const local = paragraph.indexOf(s, match.index);
    const sStart = paraStart + (local >= 0 ? local : match.index);
    const sEnd = sStart + s.length;

    if (s.length > max) {
      flush();
      out.push(...splitByWords(full, sStart, sEnd, max));
      continue;
    }

    if (bufferStart < 0) {
      bufferStart = sStart;
      bufferEnd = sEnd;
      continue;
    }

    const nextLen = bufferEnd - bufferStart + 1 + (sEnd - sStart);
    if (nextLen > target) {
      flush();
      bufferStart = sStart;
      bufferEnd = sEnd;
    } else {
      bufferEnd = sEnd;
    }
  }
  flush();
  return out;
}

function splitByWords(
  full: string,
  start: number,
  end: number,
  max: number,
): Piece[] {
  const segment = full.slice(start, end);
  const out: Piece[] = [];
  const wordRe = /\S+/g;
  let bufferStart = -1;
  let bufferEnd = -1;
  let match: RegExpExecArray | null;

  const flush = () => {
    if (bufferStart < 0) return;
    out.push({
      text: full.slice(bufferStart, bufferEnd),
      start: bufferStart,
      end: bufferEnd,
    });
    bufferStart = -1;
    bufferEnd = -1;
  };

  while ((match = wordRe.exec(segment)) !== null) {
    const wStart = start + match.index;
    const wEnd = wStart + match[0].length;
    if (bufferStart < 0) {
      bufferStart = wStart;
      bufferEnd = wEnd;
      continue;
    }
    if (wEnd - bufferStart > max) {
      flush();
      bufferStart = wStart;
      bufferEnd = wEnd;
    } else {
      bufferEnd = wEnd;
    }
  }
  flush();
  return out;
}

/**
 * Merge tiny trailing fragments into the previous chunk when possible.
 * Keeps exact slices of the full text so offsets stay valid for highlighting.
 */
function mergeSmallPieces(full: string, pieces: Piece[], target: number): Piece[] {
  const out: Piece[] = [];
  for (const piece of pieces) {
    const last = out[out.length - 1];
    if (last && piece.end - last.start < target * 0.7) {
      out[out.length - 1] = {
        text: full.slice(last.start, piece.end),
        start: last.start,
        end: piece.end,
      };
    } else {
      out.push(piece);
    }
  }
  return out;
}
