/**
 * @file types.ts
 * @description Shared domain types for KokoroRead.
 *
 * Defines settings, playback state, backend preferences, diagnostics,
 * and voice metadata used across popup, background, content, and offscreen.
 * Keep this file free of Chrome APIs so it can be imported anywhere.
 */

/** Which on-device TTS stack to use. */
export type TtsEngineId = "system" | "kokoro";

/** Preferred compute backend for Kokoro / ONNX Runtime. */
export type BackendPreference = "auto" | "webgpu" | "wasm";

/** Resolved runtime backend actually in use after detection / fallback. */
export type ResolvedBackend = "webgpu" | "wasm" | "system" | "unknown";

/** ONNX dtype used with KokoroTTS.from_pretrained. */
export type ModelDtype = "fp32" | "fp16" | "q8" | "q4" | "q4f16";

/** High-level playback / engine lifecycle state. */
export type PlaybackStatus =
  | "idle"
  | "loading_model"
  | "ready"
  | "synthesizing"
  | "playing"
  | "paused"
  | "stopping"
  | "error";

/** User-configurable settings persisted in chrome.storage.local. */
export interface KokoroSettings {
  /** TTS engine: system (Web Speech) or Kokoro neural. */
  engine: TtsEngineId;
  /** Preferred Kokoro compute backend (ignored for system engine). */
  backend: BackendPreference;
  /** Selected voice id (Kokoro id or system voiceURI). */
  voice: string;
  /** Speaking rate (typically 0.5–2.0). */
  rate: number;
  /** Optional Kokoro dtype override; null means backend defaults. */
  dtype: ModelDtype | null;
}

/** Default settings applied on first run. */
export const DEFAULT_SETTINGS: KokoroSettings = {
  engine: "system",
  backend: "auto",
  voice: "",
  rate: 1.0,
  dtype: null,
};

/** Default Kokoro voice when switching to the neural engine. */
export const DEFAULT_KOKORO_VOICE = "af_heart";

/** Voice entry exposed to the popup UI. */
export interface VoiceInfo {
  id: string;
  name: string;
  language: string;
  gender: string;
  traits?: string;
  overallGrade?: string;
}

/** Progress snapshot broadcast to the popup during a read session. */
export interface ProgressInfo {
  status: PlaybackStatus;
  /** Total chunks in the active queue. */
  totalChunks: number;
  /**
   * 0-based index of the chunk currently playing (or last finished).
   * Prefer this for the main progress bar.
   */
  playChunk: number;
  /**
   * 0-based index of the chunk currently synthesizing (or last finished synth).
   * May run ahead of playChunk when pipelined.
   */
  synthChunk: number;
  /** @deprecated Alias of playChunk for older UI; keep in sync. */
  currentChunk: number;
  /** Short human-readable status line (usually playback-focused). */
  message: string;
  /** Synthesis-focused status when pipelining ahead of playback. */
  synthMessage?: string;
  /** Optional preview of the chunk currently playing. */
  preview?: string;
  /** Model download / load progress 0–1 when applicable. */
  modelLoadProgress?: number;
  /** True while a chunk is actively being synthesized (not merely buffered). */
  synthesizing?: boolean;
  /**
   * 0–1 how far through the session text playback has reached (word-level).
   * Prefer this for the main progress bar fill when present.
   */
  readProgress?: number;
}

/** Runtime diagnostics for the Diagnostics panel. */
export interface DiagnosticsInfo {
  engine: TtsEngineId;
  resolvedBackend: ResolvedBackend;
  requestedBackend: BackendPreference;
  dtype: ModelDtype | null;
  modelId: string;
  modelReady: boolean;
  webgpuAvailable: boolean;
  fallbackWarning: string | null;
  lastError: string | null;
  offlineCapable: boolean;
  chunkCount: number;
  queuedChunks: number;
  version: string;
}

/** Result of content-script text extraction. */
export interface ExtractionResult {
  text: string;
  title: string;
  source: "selection" | "article" | "newsletter" | "fallback";
  url: string;
  charCount: number;
}

/** A single text chunk prepared for synthesis. */
export interface TextChunk {
  index: number;
  text: string;
  /** Start offset into the normalized full session text. */
  start: number;
  /** End offset (exclusive) into the normalized full session text. */
  end: number;
}

/** Extension package version string (mirrored from package.json / manifest). */
export const APP_VERSION = "0.1.0";

/** Hugging Face model id for Kokoro ONNX. */
export const KOKORO_MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";
