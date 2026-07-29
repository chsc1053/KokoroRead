/**
 * @file extract.ts
 * @description Clean article / newsletter / selection extraction for KokoroRead.
 *
 * Runs in the page context (via content script). Prefers semantic article
 * containers, then newsletter-ish main regions, then readable fallbacks.
 * Builds a LiveTextMap so playback can highlight sentence + word in-place.
 */

import type { ExtractionResult } from "../shared/types";
import { setHighlightMap } from "./page-highlight";
import { LiveTextMap } from "./text-map";

const ARTICLE_SELECTORS = [
  "article",
  "[role='main'] article",
  "main article",
  ".post-content",
  ".article-content",
  ".entry-content",
  ".story-body",
  ".article-body",
  ".post-body",
  ".rich-text",
  ".newsletter-body",
  ".email-body",
  ".message-body",
  "[data-testid='message-body']",
  ".ii.gt",
  ".a3s.aiL",
];

const MAIN_SELECTORS = ["main", "[role='main']", "#content", ".content", "#main"];

/**
 * Extract the user's current text selection, if any.
 */
export function extractSelection(): ExtractionResult | null {
  const map = LiveTextMap.fromSelection();
  if (!map || !map.text) {
    setHighlightMap(null);
    return null;
  }
  setHighlightMap(map);
  return {
    text: map.text,
    title: document.title || "Selection",
    source: "selection",
    url: location.href,
    charCount: map.text.length,
  };
}

/**
 * Extract the main article or newsletter body from the active document.
 */
export function extractArticle(): ExtractionResult {
  const title = document.title || "Untitled";
  const url = location.href;

  const newsletter = tryNewsletterRoot();
  if (newsletter) {
    const map = LiveTextMap.fromRoot(newsletter);
    if (map.text.length >= 80) {
      setHighlightMap(map);
      return {
        text: map.text,
        title,
        source: "newsletter",
        url,
        charCount: map.text.length,
      };
    }
  }

  for (const selector of ARTICLE_SELECTORS) {
    const node = document.querySelector(selector);
    if (!node) continue;
    const map = LiveTextMap.fromRoot(node);
    if (map.text.length >= 80) {
      setHighlightMap(map);
      return {
        text: map.text,
        title,
        source: "article",
        url,
        charCount: map.text.length,
      };
    }
  }

  for (const selector of MAIN_SELECTORS) {
    const node = document.querySelector(selector);
    if (!node) continue;
    const map = LiveTextMap.fromRoot(node);
    if (map.text.length >= 80) {
      setHighlightMap(map);
      return {
        text: map.text,
        title,
        source: "article",
        url,
        charCount: map.text.length,
      };
    }
  }

  const map = LiveTextMap.fromRoot(document.body);
  setHighlightMap(map);
  return {
    text: map.text,
    title,
    source: "fallback",
    url,
    charCount: map.text.length,
  };
}

function tryNewsletterRoot(): Element | null {
  const host = location.hostname;
  const isMailHost =
    host.includes("mail.google.com") ||
    host.includes("outlook.") ||
    host.includes("yahoo.com") ||
    host.includes("proton.me") ||
    host.includes("fastmail.");

  const candidates: Element[] = [];

  if (isMailHost) {
    document
      .querySelectorAll(
        ".a3s.aiL, .ii.gt, [data-testid='message-body'], .allowTextSelection, .SpMsgBody, .email-body, .message-body",
      )
      .forEach((el) => candidates.push(el));
  }

  document
    .querySelectorAll(
      "table[role='presentation'] .content, .newsletter, .email-content, [class*='newsletter']",
    )
    .forEach((el) => candidates.push(el));

  let best: Element | null = null;
  let bestLen = 0;
  for (const el of candidates) {
    const len = (el.textContent ?? "").trim().length;
    if (len > bestLen) {
      bestLen = len;
      best = el;
    }
  }
  return bestLen >= 80 ? best : null;
}
