/**
 * @file main.ts
 * @description Offscreen document entry — owns Kokoro model + audio queue.
 *
 * Created by the service worker via chrome.offscreen.createDocument.
 * Stays alive so the model does not reload between popup opens.
 */

import {
  isExtensionMessage,
  type ExtensionMessage,
  type HighlightUpdateMessage,
  type ProgressMessage,
} from "../shared/messages";
import { DEFAULT_SETTINGS } from "../shared/types";
import { errorMessage } from "../shared/utils";
import { TtsEngine } from "./tts-engine";

const engine = new TtsEngine();

engine.onProgress((progress) => {
  const msg: ProgressMessage = { type: "PROGRESS", progress };
  // Broadcast to extension pages (popup listens). Service worker ACKs.
  void chrome.runtime.sendMessage(msg).catch(() => {
    // Popup may be closed; ignore.
  });
});

engine.onHighlight((highlight) => {
  const msg: HighlightUpdateMessage = { type: "HIGHLIGHT_UPDATE", highlight };
  void chrome.runtime.sendMessage(msg).catch(() => undefined);
});

/**
 * Offscreen does not read chrome.storage (may be undefined here).
 * Settings are pushed by the service worker / popup via INIT_TTS or SAVE_SETTINGS.
 */
async function bootstrap(): Promise<void> {
  await engine.applySettings(DEFAULT_SETTINGS);
  void chrome.runtime.sendMessage({ type: "OFFSCREEN_READY" }).catch(() => undefined);
  console.info("[KokoroRead] offscreen ready");
}

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (!isExtensionMessage(message)) return false;

  // Only handle messages aimed at offscreen (or untargeted progress ACKs we own).
  const ttsTypes = new Set([
    "INIT_TTS",
    "LIST_VOICES",
    "READ_TEXT",
    "PAUSE",
    "RESUME",
    "STOP",
    "SKIP_BACK",
    "SKIP_FORWARD",
    "GET_STATUS",
    "GET_DIAGNOSTICS",
    "SAMPLE_SYNTH",
    "SAVE_SETTINGS",
    "PING",
  ]);
  if (message.target === "background") return false;
  if (message.target !== "offscreen" && !ttsTypes.has(message.type)) {
    return false;
  }
  // Prefer explicit offscreen target for TTS ops to avoid racing the SW.
  if (ttsTypes.has(message.type) && message.target !== "offscreen") {
    return false;
  }

  void (async () => {
    try {
      switch (message.type) {
        case "PING":
          sendResponse({ type: "PONG", ok: true, requestId: message.requestId });
          return;

        case "INIT_TTS":
          await engine.init(message.settings);
          sendResponse({
            type: "STATUS_UPDATE",
            progress: engine.getProgress(),
            requestId: message.requestId,
          });
          return;

        case "LIST_VOICES": {
          await engine.init();
          sendResponse({
            type: "VOICES_RESULT",
            voices: engine.listVoices(),
            requestId: message.requestId,
          });
          return;
        }

        case "SAMPLE_SYNTH":
          if (message.settings) await engine.applySettings(message.settings);
          await engine.sample(message.text);
          sendResponse({
            type: "STATUS_UPDATE",
            progress: engine.getProgress(),
            requestId: message.requestId,
          });
          return;

        case "READ_TEXT":
          if (message.settings) await engine.applySettings(message.settings);
          // Fire-and-forget long-running read; acknowledge immediately.
          void engine.read(message.text, message.title).catch((err) => {
            console.error("[KokoroRead] read failed", err);
          });
          sendResponse({
            type: "STATUS_UPDATE",
            progress: {
              ...engine.getProgress(),
              message: "Starting read…",
            },
            requestId: message.requestId,
          });
          return;

        case "PAUSE":
          engine.pause();
          sendResponse({
            type: "STATUS_UPDATE",
            progress: engine.getProgress(),
            requestId: message.requestId,
          });
          return;

        case "RESUME":
          await engine.resume();
          sendResponse({
            type: "STATUS_UPDATE",
            progress: engine.getProgress(),
            requestId: message.requestId,
          });
          return;

        case "SKIP_BACK":
          await engine.skipBack();
          sendResponse({
            type: "STATUS_UPDATE",
            progress: engine.getProgress(),
            requestId: message.requestId,
          });
          return;

        case "SKIP_FORWARD":
          await engine.skipForward();
          sendResponse({
            type: "STATUS_UPDATE",
            progress: engine.getProgress(),
            requestId: message.requestId,
          });
          return;

        case "STOP":
          await engine.stop();
          sendResponse({
            type: "STATUS_UPDATE",
            progress: engine.getProgress(),
            requestId: message.requestId,
          });
          return;

        case "GET_STATUS":
          sendResponse({
            type: "STATUS_UPDATE",
            progress: engine.getProgress(),
            requestId: message.requestId,
          });
          return;

        case "GET_DIAGNOSTICS":
          sendResponse({
            type: "DIAGNOSTICS_RESULT",
            diagnostics: await engine.diagnostics(),
            requestId: message.requestId,
          });
          return;

        case "SAVE_SETTINGS":
          await engine.applySettings(message.settings);
          sendResponse({
            type: "SETTINGS_UPDATED",
            settings: engine.getSettings(),
            requestId: message.requestId,
          });
          return;

        default:
          // Let the service worker handle non-TTS messages; don't error.
          return;
      }
    } catch (err) {
      sendResponse({
        type: "ERROR",
        error: errorMessage(err),
        requestId: message.requestId,
      } satisfies ExtensionMessage);
    }
  })();

  return true;
});

void bootstrap();
