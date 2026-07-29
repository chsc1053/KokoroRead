/**
 * @file utils.ts
 * @description Small pure helpers shared across KokoroRead contexts.
 */

/**
 * Clamp a number into [min, max].
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Truncate text for UI previews without cutting mid-word when possible.
 */
export function previewText(text: string, maxLen = 80): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLen) return normalized;
  const slice = normalized.slice(0, maxLen);
  const lastSpace = slice.lastIndexOf(" ");
  const cut = lastSpace > maxLen * 0.5 ? slice.slice(0, lastSpace) : slice;
  return `${cut}…`;
}

/**
 * Collapse whitespace and strip common invisible characters.
 */
export function normalizeWhitespace(text: string): string {
  return text
    .replace(/\u00a0/g, " ")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/**
 * Resolve Kokoro voice gender from metadata, or from the voice id convention
 * (`af_heart` → Female, `am_adam` → Male) used across Kokoro voice packs.
 */
export function resolveKokoroGender(
  voiceId: string,
  metaGender?: string | null,
): string {
  const fromMeta = (metaGender ?? "").trim();
  if (fromMeta) return fromMeta;
  const match = /^[a-z]([fm])_/i.exec(voiceId);
  if (!match) return "";
  return match[1]!.toLowerCase() === "f" ? "Female" : "Male";
}

/**
 * Kokoro VOICES.md gender markers (🚺 / 🚹), plus optional trait emojis.
 * Dedupes when `traits` already starts with the gender symbol.
 */
export function formatKokoroVoiceMarkers(
  gender: string,
  traits?: string | null,
): string {
  const g = gender.trim().toLowerCase();
  const genderEmoji =
    g === "female" || g === "f" ? "🚺" : g === "male" || g === "m" ? "🚹" : "";
  const rest = (traits ?? "").replace(/^[🚺🚹]+/u, "");
  return `${genderEmoji}${rest}`;
}

/**
 * Generate a short opaque request id for message correlation.
 */
export function createRequestId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Delay helper for backoff / pacing.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Safe error message extraction.
 */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "Unknown error";
}
