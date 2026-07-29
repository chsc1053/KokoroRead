/**
 * @file content-script.ts
 * @description Content script — extraction, highlighting, floating player.
 *
 * Does not speak, fetch models, or phone home. Text stays in-browser and
 * is returned to the service worker / popup for local TTS.
 *
 * Injected UI (floating player, highlight styles) is scrubbed when this
 * script starts after an extension reload, and when the extension context
 * is invalidated (reload / remove) via a runtime port disconnect.
 */

import {
  isExtensionMessage,
  type ExtensionMessage,
} from "../shared/messages";
import { errorMessage } from "../shared/utils";
import { extractArticle, extractSelection } from "./extract";
import {
  hideFloatingPlayer,
  showFloatingPlayer,
  syncFloatingPlayer,
} from "./floating-player";
import {
  applyPageHighlight,
  clearPageHighlight,
  disposeHighlightArtifacts,
  ensureHighlightStyles,
  getHighlightMap,
  setHighlightMap,
} from "./page-highlight";
import { LiveTextMap } from "./text-map";

declare global {
  interface Window {
    /** chrome.runtime.id of the content-script instance that owns this tab. */
    __KOKORO_READ_CS__?: string;
  }
}

function extensionStillValid(): boolean {
  try {
    return Boolean(chrome.runtime?.id);
  } catch {
    return false;
  }
}

function teardownInjectedUi(): void {
  hideFloatingPlayer();
  disposeHighlightArtifacts();
}

/**
 * Keep a port open so we learn when the extension is reloaded or removed.
 * If the service worker merely went idle, reconnect; if the extension is
 * gone, strip injected DOM so the floating player does not linger.
 *
 * Pages that enter the back/forward cache close extension ports; disconnect
 * ourselves on pagehide (persisted) and reconnect on pageshow so Chrome does
 * not log "Unchecked runtime.lastError: … back/forward cache …".
 */
function watchExtensionLifetime(): void {
  let port: chrome.runtime.Port | null = null;
  let suspendedForBfcache = false;

  const connect = () => {
    if (port) return;
    if (!extensionStillValid()) {
      teardownInjectedUi();
      delete window.__KOKORO_READ_CS__;
      return;
    }
    try {
      port = chrome.runtime.connect({ name: "kokororead-content" });
    } catch {
      teardownInjectedUi();
      delete window.__KOKORO_READ_CS__;
      return;
    }
    port.onDisconnect.addListener(() => {
      // Always read lastError — bfcache / SW restart set it otherwise Chrome
      // reports "Unchecked runtime.lastError".
      void chrome.runtime.lastError;
      port = null;
      if (suspendedForBfcache) return;
      if (extensionStillValid()) {
        connect();
        return;
      }
      teardownInjectedUi();
      delete window.__KOKORO_READ_CS__;
    });
  };

  window.addEventListener("pagehide", (event) => {
    if (!event.persisted) return;
    suspendedForBfcache = true;
    if (!port) return;
    try {
      port.disconnect();
    } catch {
      /* already closed */
    }
    port = null;
    void chrome.runtime.lastError;
  });

  window.addEventListener("pageshow", (event) => {
    if (!event.persisted) return;
    suspendedForBfcache = false;
    connect();
  });

  connect();
}

const instanceId = (() => {
  try {
    return chrome.runtime.id;
  } catch {
    return null;
  }
})();

// Guard against duplicate injection via scripting.executeScript for the
// *same* extension incarnation. A new runtime.id after reload must re-init
// and must scrub DOM left by the dead previous content script.
if (instanceId && window.__KOKORO_READ_CS__ !== instanceId) {
  teardownInjectedUi();
  window.__KOKORO_READ_CS__ = instanceId;
  ensureHighlightStyles();
  watchExtensionLifetime();

  chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    if (!isExtensionMessage(message)) return false;

    try {
      if (message.type === "EXTRACT_SELECTION") {
        const selected = extractSelection();
        if (!selected) {
          sendResponse({
            type: "ERROR",
            error: "No text selected on this page",
            requestId: message.requestId,
          } satisfies ExtensionMessage);
          return false;
        }
        sendResponse({
          type: "EXTRACT_RESULT",
          result: selected,
          requestId: message.requestId,
        } satisfies ExtensionMessage);
        return false;
      }

      if (message.type === "EXTRACT_ARTICLE") {
        const result = extractArticle();
        if (!result.text) {
          sendResponse({
            type: "ERROR",
            error: "Could not extract readable content from this page",
            requestId: message.requestId,
          } satisfies ExtensionMessage);
          return false;
        }
        sendResponse({
          type: "EXTRACT_RESULT",
          result,
          requestId: message.requestId,
        } satisfies ExtensionMessage);
        return false;
      }

      if (message.type === "BEGIN_HIGHLIGHT") {
        const existing = getHighlightMap();
        if (!existing || existing.text !== message.text) {
          const sel = LiveTextMap.fromSelection();
          if (sel && sel.text === message.text) {
            setHighlightMap(sel);
          }
        }
        ensureHighlightStyles();
        sendResponse({ type: "PONG", ok: true, requestId: message.requestId });
        return false;
      }

      if (message.type === "HIGHLIGHT_UPDATE") {
        applyPageHighlight(message.highlight);
        sendResponse({ type: "PONG", ok: true, requestId: message.requestId });
        return false;
      }

      if (message.type === "CLEAR_HIGHLIGHT") {
        clearPageHighlight();
        sendResponse({ type: "PONG", ok: true, requestId: message.requestId });
        return false;
      }

      if (message.type === "SHOW_PLAYER") {
        showFloatingPlayer({
          settings: message.settings,
          voices: message.voices,
          progress: message.progress,
        });
        sendResponse({ type: "PONG", ok: true, requestId: message.requestId });
        return false;
      }

      if (message.type === "HIDE_PLAYER") {
        hideFloatingPlayer();
        sendResponse({ type: "PONG", ok: true, requestId: message.requestId });
        return false;
      }

      if (message.type === "PLAYER_SYNC") {
        syncFloatingPlayer({
          settings: message.settings,
          voices: message.voices,
          progress: message.progress,
        });
        sendResponse({ type: "PONG", ok: true, requestId: message.requestId });
        return false;
      }

      if (message.type === "PING") {
        sendResponse({ type: "PONG", ok: true, requestId: message.requestId });
        return false;
      }
    } catch (err) {
      sendResponse({
        type: "ERROR",
        error: errorMessage(err),
        requestId: (message as ExtensionMessage).requestId,
      } satisfies ExtensionMessage);
    }

    return false;
  });

  console.info("[KokoroRead] content script ready");
}
