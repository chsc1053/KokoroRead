/**
 * @file App.tsx
 * @description KokoroRead toolbar popup — settings & diagnostics.
 *
 * Playback lives in the on-page floating player (opened from here).
 * Kokoro always uses auto backend selection (WebGPU → WASM).
 */

import { useEffect, useState } from "react";
import {
  isExtensionMessage,
  sendMessage,
  type ExtensionMessage,
} from "../shared/messages";
import type {
  DiagnosticsInfo,
  KokoroSettings,
  ProgressInfo,
  TtsEngineId,
  VoiceInfo,
} from "../shared/types";
import { DEFAULT_KOKORO_VOICE, DEFAULT_SETTINGS } from "../shared/types";
import { errorMessage, formatKokoroVoiceMarkers } from "../shared/utils";

function formatActiveBackend(
  settings: KokoroSettings,
  diagnostics: DiagnosticsInfo | null,
  status: ProgressInfo["status"],
): string {
  if (settings.engine === "system") return "System";
  const resolved = diagnostics?.resolvedBackend;
  if (resolved === "webgpu") {
    const dtype = diagnostics?.dtype ? ` · ${diagnostics.dtype}` : "";
    return `WebGPU${dtype}`;
  }
  if (resolved === "wasm") {
    const dtype = diagnostics?.dtype ? ` · ${diagnostics.dtype}` : "";
    return `WASM${dtype}`;
  }
  if (status === "loading_model") return "Loading…";
  return "—";
}

function SampleIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="sample-icon">
      <path
        fill="currentColor"
        d="M3 10v4h4l5 4V6L7 10H3zm13.5 2a3.5 3.5 0 0 0-1.8-3.05v6.1A3.5 3.5 0 0 0 16.5 12zM14.7 4.07v2.06A6.5 6.5 0 0 1 19 12a6.5 6.5 0 0 1-4.3 5.87v2.06A8.5 8.5 0 0 0 21 12a8.5 8.5 0 0 0-6.3-7.93z"
      />
    </svg>
  );
}

export function App() {
  const [settings, setSettings] = useState<KokoroSettings>(DEFAULT_SETTINGS);
  const [voices, setVoices] = useState<VoiceInfo[]>([]);
  const [progress, setProgress] = useState<ProgressInfo>({
    status: "idle",
    playChunk: 0,
    synthChunk: 0,
    currentChunk: 0,
    totalChunks: 0,
    message: "Starting…",
  });
  const [diagnostics, setDiagnostics] = useState<DiagnosticsInfo | null>(null);
  const [showDiag, setShowDiag] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void bootstrap();
    const onMessage = (message: unknown) => {
      if (!isExtensionMessage(message)) return;
      if (message.type === "PROGRESS" || message.type === "STATUS_UPDATE") {
        setProgress(message.progress);
      }
    };
    chrome.runtime.onMessage.addListener(onMessage);
    return () => chrome.runtime.onMessage.removeListener(onMessage);
  }, []);

  async function refreshVoicesAndStatus(): Promise<void> {
    const voicesReply = await sendMessage<
      Extract<ExtensionMessage, { type: "VOICES_RESULT" }>
    >({ type: "LIST_VOICES" });
    setVoices(voicesReply.voices);
    const status = await sendMessage<
      Extract<ExtensionMessage, { type: "STATUS_UPDATE" }>
    >({ type: "GET_STATUS" });
    setProgress(status.progress);
    const diag = await sendMessage<
      Extract<ExtensionMessage, { type: "DIAGNOSTICS_RESULT" }>
    >({ type: "GET_DIAGNOSTICS" });
    setDiagnostics(diag.diagnostics);
  }

  async function bootstrap(): Promise<void> {
    try {
      setError(null);
      await sendMessage({ type: "ENSURE_OFFSCREEN" });
      const settingsReply = await sendMessage<
        Extract<ExtensionMessage, { type: "SETTINGS_UPDATED" }>
      >({ type: "GET_SETTINGS" });
      let nextSettings = settingsReply.settings;
      // Kokoro backend is always auto — migrate any older preference.
      if (nextSettings.backend !== "auto") {
        const migrated = await sendMessage<
          Extract<ExtensionMessage, { type: "SETTINGS_UPDATED" }>
        >({ type: "SAVE_SETTINGS", settings: { backend: "auto" } });
        nextSettings = migrated.settings;
      }
      setSettings(nextSettings);

      void (async () => {
        try {
          await sendMessage({ type: "INIT_TTS", settings: nextSettings });
          await refreshVoicesAndStatus();
        } catch (err) {
          setError(errorMessage(err));
        }
      })();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function persist(patch: Partial<KokoroSettings>): Promise<void> {
    const next = { ...settings, ...patch };
    setSettings(next);
    const reply = await sendMessage<
      Extract<ExtensionMessage, { type: "SETTINGS_UPDATED" }>
    >({ type: "SAVE_SETTINGS", settings: patch });
    setSettings(reply.settings);
  }

  async function changeEngine(engine: TtsEngineId): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const patch: Partial<KokoroSettings> = {
        engine,
        backend: "auto",
        voice: engine === "kokoro" ? DEFAULT_KOKORO_VOICE : "",
      };
      await persist(patch);
      await sendMessage({ type: "INIT_TTS", settings: patch });
      const refreshed = await sendMessage<
        Extract<ExtensionMessage, { type: "SETTINGS_UPDATED" }>
      >({ type: "GET_SETTINGS" });
      setSettings(refreshed.settings);
      await refreshVoicesAndStatus();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function runAction(label: string, fn: () => Promise<void>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(`${label}: ${errorMessage(err)}`);
    } finally {
      setBusy(false);
    }
  }

  async function openPlayer(): Promise<void> {
    await runAction("Open player", async () => {
      await sendMessage({ type: "OPEN_PLAYER" });
      window.close();
    });
  }

  async function playSample(): Promise<void> {
    await runAction("Sample", async () => {
      await sendMessage({ type: "SAMPLE_SYNTH", settings });
      await refreshVoicesAndStatus();
    });
  }

  async function refreshDiagnostics(): Promise<void> {
    await runAction("Diagnostics", async () => {
      const reply = await sendMessage<
        Extract<ExtensionMessage, { type: "DIAGNOSTICS_RESULT" }>
      >({ type: "GET_DIAGNOSTICS" });
      setDiagnostics(reply.diagnostics);
      setShowDiag(true);
    });
  }

  const activeLabel = formatActiveBackend(settings, diagnostics, progress.status);

  return (
    <div className="app">
      <header className="header">
        <div className="brand">
          <img
            className="brand-mark"
            src={chrome.runtime.getURL("icons/icon48.png")}
            width={28}
            height={28}
            alt=""
          />
          <h1>KokoroRead</h1>
        </div>
        <span className={`badge badge-${progress.status}`}>{progress.status}</span>
      </header>

      <section className="panel">
        <label className="field">
          <span>Engine</span>
          <select
            value={settings.engine}
            disabled={busy}
            onChange={(e) => void changeEngine(e.target.value as TtsEngineId)}
          >
            <option value="system">System voices (fast)</option>
            <option value="kokoro">Kokoro neural (higher quality)</option>
          </select>
        </label>

        <div className="field">
          <span>Voice</span>
          <div className="voice-row">
            <select
              value={settings.voice}
              disabled={voices.length === 0 || busy}
              onChange={(e) => void persist({ voice: e.target.value })}
            >
              {voices.length === 0 ? (
                <option value={settings.voice || ""}>
                  {settings.voice || "Loading voices…"}
                </option>
              ) : (
                voices.map((v) => {
                  const markers = formatKokoroVoiceMarkers(v.gender, v.traits);
                  return (
                    <option key={v.id} value={v.id}>
                      {v.name}
                      {markers ? ` · ${markers}` : ""}
                      {v.language ? ` · ${v.language}` : ""}
                    </option>
                  );
                })
              )}
            </select>
            <button
              type="button"
              className="sample-btn"
              title="Play sample"
              aria-label="Play sample"
              disabled={busy}
              onClick={() => void playSample()}
            >
              <SampleIcon />
            </button>
          </div>
        </div>

        <div className="backend-indicator">
          Active: <strong>{activeLabel}</strong>
          {diagnostics?.fallbackWarning ? (
            <div className="warn">{diagnostics.fallbackWarning}</div>
          ) : null}
        </div>
      </section>

      <section className="actions">
        <button type="button" disabled={busy} onClick={() => void openPlayer()}>
          Open player
        </button>
      </section>

      {error ? <div className="error">{error}</div> : null}

      <section className="footer">
        <button
          type="button"
          className="linkish"
          onClick={() => void refreshDiagnostics()}
        >
          {showDiag ? "Refresh diagnostics" : "Diagnostics"}
        </button>
        <span className="privacy">Local-only · no cloud TTS</span>
      </section>

      {showDiag && diagnostics ? (
        <section className="diagnostics">
          <pre>{JSON.stringify(diagnostics, null, 2)}</pre>
        </section>
      ) : null}
    </div>
  );
}
