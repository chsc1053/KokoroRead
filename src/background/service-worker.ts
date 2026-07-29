/**
 * @file service-worker.ts
 * @description Manifest V3 background service worker for KokoroRead.
 *
 * Responsibilities:
 * - Create / ensure the offscreen document (model + audio lifecycle)
 * - Relay messages between popup, content scripts, and offscreen
 * - Open / close the floating player on the active tab
 * - Stop reading when the user switches away from the player tab
 * - Forward live sentence/word highlights to the player tab
 */

import {
  isExtensionMessage,
  type ExtensionMessage,
  type ExtractResultMessage,
  type SettingsUpdatedMessage,
} from "../shared/messages";
import { loadSettings, saveSettings } from "../shared/storage";
import type { ProgressInfo } from "../shared/types";
import { errorMessage, sleep } from "../shared/utils";

const OFFSCREEN_URL = "offscreen.html";
const OFFSCREEN_REASONS: chrome.offscreen.Reason[] = [
  "AUDIO_PLAYBACK" as chrome.offscreen.Reason,
  "WORKERS" as chrome.offscreen.Reason,
];
const OFFSCREEN_JUSTIFICATION =
  "KokoroRead keeps the Kokoro TTS model warm and plays synthesized audio locally in an offscreen document.";

let creatingOffscreen: Promise<void> | null = null;
/** Tab that hosts the floating player + in-page highlights. */
let playerTabId: number | null = null;

async function ensureOffscreenDocument(): Promise<void> {
  const existing = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT" as chrome.runtime.ContextType],
  });
  if (existing.length > 0) return;

  if (creatingOffscreen) {
    await creatingOffscreen;
    return;
  }

  creatingOffscreen = chrome.offscreen
    .createDocument({
      url: OFFSCREEN_URL,
      reasons: OFFSCREEN_REASONS,
      justification: OFFSCREEN_JUSTIFICATION,
    })
    .catch(async (err: unknown) => {
      const contexts = await chrome.runtime.getContexts({
        contextTypes: ["OFFSCREEN_DOCUMENT" as chrome.runtime.ContextType],
      });
      if (contexts.length === 0) throw err;
    })
    .finally(() => {
      creatingOffscreen = null;
    });

  await creatingOffscreen;
}

async function sendToOffscreen(
  message: ExtensionMessage,
): Promise<ExtensionMessage> {
  await ensureOffscreenDocument();
  const payload: ExtensionMessage = { ...message, target: "offscreen" };
  const response = (await chrome.runtime.sendMessage(payload)) as
    | ExtensionMessage
    | undefined;
  if (chrome.runtime.lastError) {
    throw new Error(chrome.runtime.lastError.message);
  }
  if (!response) {
    throw new Error("No response from offscreen document");
  }
  return response;
}

async function sendToPlayerTab(message: ExtensionMessage): Promise<void> {
  if (playerTabId == null) return;
  try {
    await chrome.tabs.sendMessage(playerTabId, message);
  } catch {
    // Tab may be closed or content script missing.
  }
}

async function ensureContentScript(tabId: number): Promise<void> {
  const ping = async (): Promise<boolean> => {
    try {
      const response = (await chrome.tabs.sendMessage(tabId, {
        type: "PING",
      })) as ExtensionMessage | undefined;
      return response?.type === "PONG";
    } catch {
      return false;
    }
  };

  if (await ping()) return;

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
    });
  } catch (err) {
    throw new Error(
      `Could not inject into this tab (${errorMessage(err)}). Try reloading the page.`,
    );
  }

  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (await ping()) return;
    await sleep(40 * (attempt + 1));
  }

  throw new Error(
    "Content script did not start. Reload the page and try again.",
  );
}

function assertReadableTabUrl(url: string): void {
  if (
    !url ||
    url.startsWith("chrome://") ||
    url.startsWith("chrome-extension://") ||
    url.startsWith("edge://") ||
    url.startsWith("about:") ||
    url.startsWith("https://chrome.google.com/webstore") ||
    url.startsWith("https://chromewebstore.google.com")
  ) {
    throw new Error("Cannot use KokoroRead on this page (restricted URL).");
  }
}

async function getActiveTab(): Promise<chrome.tabs.Tab> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active tab found");
  assertReadableTabUrl(tab.url ?? "");
  return tab;
}

async function extractFromActiveTab(
  kind: "selection" | "article",
): Promise<ExtractResultMessage> {
  const tab = await getActiveTab();
  await ensureContentScript(tab.id!);
  playerTabId = tab.id!;

  const message: ExtensionMessage =
    kind === "selection"
      ? { type: "EXTRACT_SELECTION" }
      : { type: "EXTRACT_ARTICLE" };

  const response = (await chrome.tabs.sendMessage(tab.id!, message)) as
    | ExtensionMessage
    | undefined;
  if (chrome.runtime.lastError) {
    throw new Error(chrome.runtime.lastError.message);
  }
  if (!response || response.type !== "EXTRACT_RESULT") {
    if (response?.type === "ERROR") throw new Error(response.error);
    throw new Error("Content script did not return extraction result");
  }
  return response;
}

async function openPlayerOnActiveTab(): Promise<void> {
  const tab = await getActiveTab();
  await ensureContentScript(tab.id!);

  if (playerTabId != null && playerTabId !== tab.id) {
    await sendToPlayerTab({ type: "HIDE_PLAYER" });
  }
  playerTabId = tab.id!;

  await ensureOffscreenDocument();
  const settings = await loadSettings();
  try {
    await sendToOffscreen({ type: "SAVE_SETTINGS", settings });
    await sendToOffscreen({ type: "INIT_TTS", settings });
  } catch {
    // Offscreen may still be warming; player can retry via controls.
  }

  let voices: Extract<ExtensionMessage, { type: "VOICES_RESULT" }>["voices"] = [];
  let progress: ProgressInfo = {
    status: "idle",
    playChunk: 0,
    synthChunk: 0,
    currentChunk: 0,
    totalChunks: 0,
    message: "Ready",
  };

  try {
    const voicesReply = await sendToOffscreen({ type: "LIST_VOICES" });
    if (voicesReply.type === "VOICES_RESULT") voices = voicesReply.voices;
  } catch {
    // ignore
  }
  try {
    const statusReply = await sendToOffscreen({ type: "GET_STATUS" });
    if (statusReply.type === "STATUS_UPDATE") progress = statusReply.progress;
  } catch {
    // ignore
  }

  await chrome.tabs.sendMessage(tab.id!, {
    type: "SHOW_PLAYER",
    settings,
    voices,
    progress,
  } satisfies ExtensionMessage);
}

async function closePlayerAndStop(): Promise<void> {
  try {
    await sendToOffscreen({ type: "STOP" });
  } catch {
    // ignore
  }
  await sendToPlayerTab({ type: "CLEAR_HIGHLIGHT" });
  await sendToPlayerTab({ type: "HIDE_PLAYER" });
}

async function stopPlaybackOnly(): Promise<void> {
  try {
    await sendToOffscreen({ type: "STOP" });
  } catch {
    // ignore
  }
  await sendToPlayerTab({ type: "CLEAR_HIGHLIGHT" });
  await sendToPlayerTab({
    type: "PLAYER_SYNC",
    progress: {
      status: "ready",
      playChunk: 0,
      synthChunk: 0,
      currentChunk: 0,
      totalChunks: 0,
      message: "Stopped (tab switched)",
    },
  });
}

chrome.runtime.onInstalled.addListener(() => {
  void loadSettings();
});

/** Content scripts open a port so they can tear down injected UI on reload/remove. */
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "kokororead-content") return;
  // Keep the port open until the content script or extension unloads.
  // Read lastError on disconnect (e.g. page entered bfcache) to avoid
  // "Unchecked runtime.lastError" in the extension Errors page.
  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
  });
});

/** Stop reading when the user leaves the player tab. */
chrome.tabs.onActivated.addListener((info) => {
  if (playerTabId == null) return;
  if (info.tabId === playerTabId) return;
  void stopPlaybackOnly();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === playerTabId) {
    playerTabId = null;
    void sendToOffscreen({ type: "STOP" }).catch(() => undefined);
  }
});

chrome.runtime.onMessage.addListener(
  (message: unknown, sender, sendResponse) => {
    if (!isExtensionMessage(message)) return false;

    // Ignore messages addressed exclusively to the offscreen document.
    if (message.target === "offscreen") return false;

    void (async () => {
      try {
        switch (message.type) {
          case "PING":
            sendResponse({ type: "PONG", ok: true, requestId: message.requestId });
            return;

          case "ENSURE_OFFSCREEN": {
            await ensureOffscreenDocument();
            try {
              const settings = await loadSettings();
              await sendToOffscreen({
                type: "SAVE_SETTINGS",
                settings,
                requestId: message.requestId,
              });
            } catch (err) {
              console.warn("[KokoroRead] could not sync settings to offscreen", err);
            }
            sendResponse({ type: "OFFSCREEN_READY", requestId: message.requestId });
            return;
          }

          case "GET_SETTINGS": {
            const settings = await loadSettings();
            sendResponse({
              type: "SETTINGS_UPDATED",
              settings,
              requestId: message.requestId,
            } satisfies SettingsUpdatedMessage);
            return;
          }

          case "SAVE_SETTINGS": {
            let settings = await saveSettings(message.settings);
            try {
              const offscreenReply = await sendToOffscreen({
                type: "SAVE_SETTINGS",
                settings,
                requestId: message.requestId,
              });
              if (offscreenReply.type === "SETTINGS_UPDATED") {
                settings = await saveSettings(offscreenReply.settings);
              }
            } catch {
              // Offscreen may not be up yet; settings still persisted.
            }
            await sendToPlayerTab({
              type: "PLAYER_SYNC",
              settings,
            });
            sendResponse({
              type: "SETTINGS_UPDATED",
              settings,
              requestId: message.requestId,
            } satisfies SettingsUpdatedMessage);
            return;
          }

          case "EXTRACT_SELECTION": {
            const result = await extractFromActiveTab("selection");
            sendResponse(result);
            return;
          }

          case "EXTRACT_ARTICLE": {
            const result = await extractFromActiveTab("article");
            sendResponse(result);
            return;
          }

          case "OPEN_PLAYER": {
            await openPlayerOnActiveTab();
            sendResponse({ type: "PONG", ok: true, requestId: message.requestId });
            return;
          }

          case "CLOSE_PLAYER": {
            // Prefer sender tab when close comes from the floating player.
            if (sender.tab?.id != null) playerTabId = sender.tab.id;
            await closePlayerAndStop();
            sendResponse({ type: "PONG", ok: true, requestId: message.requestId });
            return;
          }

          case "READ_TEXT": {
            if (sender.tab?.id != null) {
              playerTabId = sender.tab.id;
              await sendToPlayerTab({
                type: "BEGIN_HIGHLIGHT",
                text: message.text,
              });
            } else if (playerTabId != null) {
              await sendToPlayerTab({
                type: "BEGIN_HIGHLIGHT",
                text: message.text,
              });
            }
            const response = await sendToOffscreen(message);
            sendResponse(response);
            return;
          }

          case "STOP": {
            const response = await sendToOffscreen(message);
            await sendToPlayerTab({ type: "CLEAR_HIGHLIGHT" });
            sendResponse(response);
            return;
          }

          case "INIT_TTS":
          case "LIST_VOICES":
          case "PAUSE":
          case "RESUME":
          case "SKIP_BACK":
          case "SKIP_FORWARD":
          case "GET_STATUS":
          case "GET_DIAGNOSTICS":
          case "SAMPLE_SYNTH": {
            const response = await sendToOffscreen(message);
            if (response.type === "VOICES_RESULT") {
              await sendToPlayerTab({
                type: "PLAYER_SYNC",
                voices: response.voices,
              });
            }
            if (response.type === "STATUS_UPDATE") {
              await sendToPlayerTab({
                type: "PLAYER_SYNC",
                progress: response.progress,
              });
            }
            sendResponse(response);
            return;
          }

          case "HIGHLIGHT_UPDATE":
            await sendToPlayerTab(message);
            sendResponse({ type: "PONG", ok: true });
            return;

          case "PROGRESS":
          case "STATUS_UPDATE":
          case "OFFSCREEN_READY":
            if (message.type === "PROGRESS") {
              await sendToPlayerTab({
                type: "PLAYER_SYNC",
                progress: message.progress,
              });
              if (
                message.progress.status === "ready" ||
                message.progress.status === "idle" ||
                message.progress.message === "Finished" ||
                message.progress.message === "Stopped"
              ) {
                await sendToPlayerTab({ type: "CLEAR_HIGHLIGHT" });
              }
            }
            sendResponse({ type: "PONG", ok: true });
            return;

          default:
            sendResponse({
              type: "ERROR",
              error: `Unhandled message type in service worker: ${message.type}`,
            });
        }
      } catch (err) {
        sendResponse({
          type: "ERROR",
          error: errorMessage(err),
        });
      }
    })();

    return true;
  },
);

console.info("[KokoroRead] service worker started");
