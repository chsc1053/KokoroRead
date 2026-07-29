/**
 * @file messages.ts
 * @description Typed message contracts for KokoroRead Chrome messaging.
 *
 * All chrome.runtime / tabs messaging should use these discriminated unions
 * so popup ↔ background ↔ offscreen ↔ content stay type-safe.
 *
 * Privacy note: messages may carry page text locally between extension
 * contexts. Text is never sent to remote servers by this extension.
 */

import type { HighlightState } from "./highlight";
import type {
  DiagnosticsInfo,
  ExtractionResult,
  KokoroSettings,
  ProgressInfo,
  VoiceInfo,
} from "./types";

export type { HighlightState };

/** Discriminant for all extension messages. */
export type MessageType =
  | "PING"
  | "PONG"
  | "ENSURE_OFFSCREEN"
  | "OFFSCREEN_READY"
  | "GET_STATUS"
  | "STATUS_UPDATE"
  | "INIT_TTS"
  | "LIST_VOICES"
  | "VOICES_RESULT"
  | "READ_TEXT"
  | "PAUSE"
  | "RESUME"
  | "STOP"
  | "SKIP_BACK"
  | "SKIP_FORWARD"
  | "PROGRESS"
  | "EXTRACT_SELECTION"
  | "EXTRACT_ARTICLE"
  | "EXTRACT_RESULT"
  | "GET_SETTINGS"
  | "SAVE_SETTINGS"
  | "SETTINGS_UPDATED"
  | "GET_DIAGNOSTICS"
  | "DIAGNOSTICS_RESULT"
  | "ERROR"
  | "SAMPLE_SYNTH"
  | "BEGIN_HIGHLIGHT"
  | "HIGHLIGHT_UPDATE"
  | "CLEAR_HIGHLIGHT"
  | "OPEN_PLAYER"
  | "SHOW_PLAYER"
  | "HIDE_PLAYER"
  | "CLOSE_PLAYER"
  | "PLAYER_SYNC";

/** Optional routing hint so SW and offscreen do not double-handle. */
export type MessageTarget = "background" | "offscreen" | "any";

interface BaseMessage<T extends MessageType> {
  type: T;
  /** Optional correlation id for request/response pairing. */
  requestId?: string;
  /**
   * When set to "offscreen", only the offscreen document should handle.
   * When "background", only the service worker should handle.
   * When omitted or "any", any context may handle (use carefully).
   */
  target?: MessageTarget;
}

export type PingMessage = BaseMessage<"PING">;
export type PongMessage = BaseMessage<"PONG"> & { ok: true };

export type EnsureOffscreenMessage = BaseMessage<"ENSURE_OFFSCREEN">;
export type OffscreenReadyMessage = BaseMessage<"OFFSCREEN_READY">;

export type GetStatusMessage = BaseMessage<"GET_STATUS">;
export type StatusUpdateMessage = BaseMessage<"STATUS_UPDATE"> & {
  progress: ProgressInfo;
};

export type InitTtsMessage = BaseMessage<"INIT_TTS"> & {
  settings?: Partial<KokoroSettings>;
};

export type ListVoicesMessage = BaseMessage<"LIST_VOICES">;
export type VoicesResultMessage = BaseMessage<"VOICES_RESULT"> & {
  voices: VoiceInfo[];
};

export type ReadTextMessage = BaseMessage<"READ_TEXT"> & {
  text: string;
  title?: string;
  settings?: Partial<KokoroSettings>;
};

export type PauseMessage = BaseMessage<"PAUSE">;
export type ResumeMessage = BaseMessage<"RESUME">;
export type StopMessage = BaseMessage<"STOP">;
export type SkipBackMessage = BaseMessage<"SKIP_BACK">;
export type SkipForwardMessage = BaseMessage<"SKIP_FORWARD">;

export type ProgressMessage = BaseMessage<"PROGRESS"> & {
  progress: ProgressInfo;
};

export type ExtractSelectionMessage = BaseMessage<"EXTRACT_SELECTION">;
export type ExtractArticleMessage = BaseMessage<"EXTRACT_ARTICLE">;
export type ExtractResultMessage = BaseMessage<"EXTRACT_RESULT"> & {
  result: ExtractionResult;
};

export type GetSettingsMessage = BaseMessage<"GET_SETTINGS">;
export type SaveSettingsMessage = BaseMessage<"SAVE_SETTINGS"> & {
  settings: Partial<KokoroSettings>;
};
export type SettingsUpdatedMessage = BaseMessage<"SETTINGS_UPDATED"> & {
  settings: KokoroSettings;
};

export type GetDiagnosticsMessage = BaseMessage<"GET_DIAGNOSTICS">;
export type DiagnosticsResultMessage = BaseMessage<"DIAGNOSTICS_RESULT"> & {
  diagnostics: DiagnosticsInfo;
};

export type ErrorMessage = BaseMessage<"ERROR"> & {
  error: string;
  detail?: string;
};

/** Short sample utterance for Milestone 3 smoke test. */
export type SampleSynthMessage = BaseMessage<"SAMPLE_SYNTH"> & {
  text?: string;
  settings?: Partial<KokoroSettings>;
};

/** Prepare the content script to map spoken text to DOM ranges. */
export type BeginHighlightMessage = BaseMessage<"BEGIN_HIGHLIGHT"> & {
  text: string;
};

/** Live sentence / word highlight while audio plays. */
export type HighlightUpdateMessage = BaseMessage<"HIGHLIGHT_UPDATE"> & {
  highlight: HighlightState;
};

export type ClearHighlightMessage = BaseMessage<"CLEAR_HIGHLIGHT">;

/** Popup asks SW to open the floating player on the active tab. */
export type OpenPlayerMessage = BaseMessage<"OPEN_PLAYER">;

/** SW → content: show floating player with initial state. */
export type ShowPlayerMessage = BaseMessage<"SHOW_PLAYER"> & {
  settings: KokoroSettings;
  voices: VoiceInfo[];
  progress: ProgressInfo;
};

/** SW → content: hide floating player (without implying stop). */
export type HidePlayerMessage = BaseMessage<"HIDE_PLAYER">;

/**
 * Content → SW: user closed the floating player (stop playback + hide).
 * Popup may also send this to force-close.
 */
export type ClosePlayerMessage = BaseMessage<"CLOSE_PLAYER">;

/** SW → content: push settings / voices / progress updates to the float. */
export type PlayerSyncMessage = BaseMessage<"PLAYER_SYNC"> & {
  settings?: KokoroSettings;
  voices?: VoiceInfo[];
  progress?: ProgressInfo;
};

export type ExtensionMessage =
  | PingMessage
  | PongMessage
  | EnsureOffscreenMessage
  | OffscreenReadyMessage
  | GetStatusMessage
  | StatusUpdateMessage
  | InitTtsMessage
  | ListVoicesMessage
  | VoicesResultMessage
  | ReadTextMessage
  | PauseMessage
  | ResumeMessage
  | StopMessage
  | SkipBackMessage
  | SkipForwardMessage
  | ProgressMessage
  | ExtractSelectionMessage
  | ExtractArticleMessage
  | ExtractResultMessage
  | GetSettingsMessage
  | SaveSettingsMessage
  | SettingsUpdatedMessage
  | GetDiagnosticsMessage
  | DiagnosticsResultMessage
  | ErrorMessage
  | SampleSynthMessage
  | BeginHighlightMessage
  | HighlightUpdateMessage
  | ClearHighlightMessage
  | OpenPlayerMessage
  | ShowPlayerMessage
  | HidePlayerMessage
  | ClosePlayerMessage
  | PlayerSyncMessage;

/** Type guard for ExtensionMessage-shaped objects. */
export function isExtensionMessage(value: unknown): value is ExtensionMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof (value as { type: unknown }).type === "string"
  );
}

/**
 * Send a typed runtime message and await a typed response.
 * Throws if chrome.runtime.lastError is set or the response is an ERROR message.
 */
export async function sendMessage<T extends ExtensionMessage>(
  message: ExtensionMessage,
): Promise<T> {
  const response = (await chrome.runtime.sendMessage(message)) as
    | ExtensionMessage
    | undefined;
  if (chrome.runtime.lastError) {
    throw new Error(chrome.runtime.lastError.message);
  }
  if (!response) {
    throw new Error("No response from extension messaging");
  }
  if (response.type === "ERROR") {
    throw new Error(response.error);
  }
  return response as T;
}

/**
 * Send a typed message to a specific tab's content script.
 */
export async function sendTabMessage<T extends ExtensionMessage>(
  tabId: number,
  message: ExtensionMessage,
): Promise<T> {
  const response = (await chrome.tabs.sendMessage(tabId, message)) as
    | ExtensionMessage
    | undefined;
  if (chrome.runtime.lastError) {
    throw new Error(chrome.runtime.lastError.message);
  }
  if (!response) {
    throw new Error("No response from content script");
  }
  if (response.type === "ERROR") {
    throw new Error(response.error);
  }
  return response as T;
}
