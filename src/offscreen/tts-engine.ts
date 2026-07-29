/**
 * @file tts-engine.ts
 * @description TTS lifecycle for Kokoro (Worker) and system Web Speech voices.
 *
 * engine=system → OS/browser speechSynthesis (fast, no model download)
 * engine=kokoro → Kokoro ONNX in a Worker (higher quality, heavier)
 */

import { chunkText } from "../shared/chunking";
import {
  charIndexAtProgress,
  highlightAt,
  type HighlightState,
} from "../shared/highlight";
import {
  APP_VERSION,
  DEFAULT_KOKORO_VOICE,
  DEFAULT_SETTINGS,
  KOKORO_MODEL_ID,
  type DiagnosticsInfo,
  type KokoroSettings,
  type PlaybackStatus,
  type ProgressInfo,
  type TextChunk,
  type TtsEngineId,
  type VoiceInfo,
} from "../shared/types";
import { clamp, errorMessage, normalizeWhitespace, previewText } from "../shared/utils";
import { planBackends, toResolvedBackend, isWebGpuAvailable } from "./backend";
import type { PlayableAudio } from "./audio-player";
import { SynthesisQueue, type PlayTiming } from "./queue";
import { SynthClient } from "./synth-client";
import {
  loadSystemVoices,
  pauseSystemSpeech,
  resumeSystemSpeech,
  speakSystemChunk,
  stopSystemSpeech,
  systemVoicesToInfo,
} from "./system-speech";

export type ProgressListener = (progress: ProgressInfo) => void;
export type HighlightListener = (highlight: HighlightState) => void;

export class TtsEngine {
  private client = new SynthClient();
  private kokoroReady = false;
  private systemReady = false;
  private systemVoiceList: SpeechSynthesisVoice[] = [];
  private settings: KokoroSettings = { ...DEFAULT_SETTINGS };
  private status: PlaybackStatus = "idle";
  private resolvedBackend: DiagnosticsInfo["resolvedBackend"] = "unknown";
  private activeDtype: DiagnosticsInfo["dtype"] = null;
  private fallbackWarning: string | null = null;
  private lastError: string | null = null;
  private modelLoadProgress = 0;
  private listeners = new Set<ProgressListener>();
  private highlightListeners = new Set<HighlightListener>();
  private queue: SynthesisQueue;
  private initPromise: Promise<void> | null = null;
  private wasmPaths = "";
  private systemChunkIndex = 0;
  private systemChunkTotal = 0;
  private systemStopped = false;
  private playChunk = 0;
  private synthChunk = 0;
  private playPreview = "";
  private synthMessage = "";
  private synthesizing = false;
  private sessionText = "";
  private sessionChunks: TextChunk[] = [];
  private highlightEnabled = true;
  private systemRestartFrom: number | null = null;
  private readProgress = 0;
  private lastReadProgressEmit = 0;
  private wordClockTimer: ReturnType<typeof setInterval> | null = null;
  private activePlayChunk: TextChunk | null = null;
  private activePlayTiming: PlayTiming | null = null;

  constructor() {
    this.queue = new SynthesisQueue((chunk) => this.generateChunk(chunk.text), {
      onSynthStart: (chunk, index, total) => {
        this.synthesizing = true;
        this.synthChunk = index;
        this.synthMessage = "Synthesizing…";
        // Show synthesizing when this chunk is needed for the playhead (e.g. skip
        // beyond the PCM cache). Keep "Playing" for quiet lookahead synth.
        const blocking = index <= this.playChunk;
        this.emitProgress({
          status: blocking
            ? "synthesizing"
            : this.status === "playing" || this.status === "paused"
              ? this.status
              : "synthesizing",
          totalChunks: total,
          message: blocking
            ? "Synthesizing…"
            : this.status === "playing" || this.status === "paused"
              ? "Playing"
              : this.synthMessage,
          preview: this.playPreview || previewText(chunk.text),
          synthesizing: true,
        });
      },
      onSynthPaused: (readyThrough, _playIndex, total) => {
        this.synthesizing = true;
        this.synthChunk = readyThrough;
        this.synthMessage = "Waiting for playback to catch up…";
        this.emitProgress({
          status: this.status,
          totalChunks: total,
          synthesizing: true,
          synthMessage: this.synthMessage,
          message:
            this.status === "playing" || this.status === "paused"
              ? "Playing"
              : this.statusLabel(),
        });
      },
      onSynthComplete: (total) => {
        this.synthesizing = false;
        this.synthChunk = Math.max(0, total - 1);
        this.synthMessage = "";
        this.emitProgress({
          status: this.status,
          totalChunks: total,
          synthesizing: false,
          synthMessage: undefined,
          message:
            this.status === "playing" || this.status === "paused"
              ? "Playing"
              : this.statusLabel(),
        });
      },
      onPlayStart: (chunk, index, total, timing) => {
        this.playChunk = index;
        this.playPreview = previewText(chunk.text);
        this.synthesizing = false;
        this.synthMessage = "";
        this.setStatus("playing", {
          totalChunks: total,
          message: "Playing",
          preview: this.playPreview,
          synthesizing: false,
          synthMessage: undefined,
        });
        this.startKokoroWordClock(chunk, timing);
      },
      onPlayEnd: (_chunk, index, total) => {
        if (index + 1 >= total) {
          this.playChunk = index;
        }
      },
      onComplete: () => {
        this.stopWordClock();
        this.emitHighlight({ active: false });
        this.sessionChunks = [];
        this.synthesizing = false;
        this.synthMessage = "";
        this.readProgress = 1;
        this.setStatus("ready", {
          currentChunk: 0,
          totalChunks: 0,
          message: "Finished",
          synthesizing: false,
          readProgress: 1,
        });
      },
      onError: (err) => {
        this.stopWordClock();
        this.emitHighlight({ active: false });
        this.sessionChunks = [];
        this.synthesizing = false;
        this.lastError = errorMessage(err);
        this.setStatus("error", {
          message: this.lastError,
          synthesizing: false,
        });
      },
    });
  }

  onProgress(listener: ProgressListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onHighlight(listener: HighlightListener): () => void {
    this.highlightListeners.add(listener);
    return () => this.highlightListeners.delete(listener);
  }

  getProgress(): ProgressInfo {
    if (this.settings.engine === "system") {
      return {
        status: this.status,
        playChunk: this.systemChunkIndex,
        synthChunk: this.systemChunkIndex,
        currentChunk: this.systemChunkIndex,
        totalChunks: this.systemChunkTotal,
        message: this.statusLabel(),
        modelLoadProgress: 1,
        readProgress: this.readProgress,
      };
    }
    return {
      status: this.status,
      playChunk: this.playChunk,
      synthChunk: this.synthChunk,
      currentChunk: this.playChunk,
      totalChunks: this.queue.total,
      message: this.statusLabel(),
      synthMessage: this.synthesizing ? this.synthMessage || undefined : undefined,
      preview: this.playPreview || undefined,
      modelLoadProgress: this.modelLoadProgress,
      synthesizing: this.synthesizing,
      readProgress: this.readProgress,
    };
  }

  async applySettings(patch: Partial<KokoroSettings>): Promise<void> {
    const prevEngine = this.settings.engine;
    const prevBackend = this.settings.backend;
    const prevDtype = this.settings.dtype;
    const prevVoice = this.settings.voice;
    const prevRate = this.settings.rate;
    this.settings = {
      ...this.settings,
      ...patch,
      rate: clamp(patch.rate ?? this.settings.rate, 0.5, 2.0),
    };

    if (patch.engine !== undefined && patch.engine !== prevEngine) {
      await this.stop();
      if (patch.engine === "kokoro" && !this.settings.voice) {
        this.settings.voice = DEFAULT_KOKORO_VOICE;
      }
      this.kokoroReady = false;
      this.systemReady = false;
      this.resolvedBackend = "unknown";
      await this.init();
      return;
    }

    if (
      this.settings.engine === "kokoro" &&
      this.kokoroReady &&
      ((patch.backend !== undefined && patch.backend !== prevBackend) ||
        (patch.dtype !== undefined && patch.dtype !== prevDtype))
    ) {
      this.kokoroReady = false;
      this.resolvedBackend = "unknown";
      await this.init();
    }

    const voiceChanged =
      patch.voice !== undefined && patch.voice !== prevVoice && Boolean(patch.voice);
    const rateChanged =
      patch.rate !== undefined && Math.abs(this.settings.rate - prevRate) > 0.001;

    if (voiceChanged || rateChanged) {
      await this.reloadSynthesizedAudio();
    }
  }

  /**
   * Drop already-buffered audio and re-synthesize from the current chunk
   * so a mid-read voice/rate change takes effect immediately.
   */
  private async reloadSynthesizedAudio(): Promise<void> {
    if (this.sessionChunks.length === 0) return;

    const active =
      this.status === "playing" ||
      this.status === "paused" ||
      this.status === "synthesizing";
    if (!active) return;

    if (this.settings.engine === "system") {
      this.systemRestartFrom = this.systemChunkIndex;
      stopSystemSpeech();
      if (this.status === "paused") {
        // Cancel clears the paused utterance; loop will restart that chunk.
        this.setStatus("playing", {
          message: "Playing",
        });
      }
      return;
    }

    if (!this.queue.isRunning) return;
    const from = Math.max(0, this.playChunk);
    this.setStatus("synthesizing", {
      totalChunks: this.sessionChunks.length,
      playChunk: from,
      synthChunk: from,
      message: `Reloading voice from chunk ${from + 1}…`,
    });
    this.synthMessage = "Synthesizing…";
    this.synthesizing = true;
    await this.queue.restartFrom(from, { clearCache: true });
  }

  getSettings(): KokoroSettings {
    return { ...this.settings };
  }

  async init(settings?: Partial<KokoroSettings>): Promise<void> {
    if (settings) {
      await this.applySettings(settings);
    }
    if (this.isReady()) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = this.initInternal();
    try {
      await this.initPromise;
    } finally {
      this.initPromise = null;
    }
  }

  private isReady(): boolean {
    return this.settings.engine === "system" ? this.systemReady : this.kokoroReady;
  }

  private async initInternal(): Promise<void> {
    if (this.settings.engine === "system") {
      await this.initSystem();
      return;
    }
    await this.initKokoro();
  }

  private async initSystem(): Promise<void> {
    this.setStatus("loading_model", {
      message: "Loading system voices…",
      modelLoadProgress: 0,
    });
    this.systemVoiceList = await loadSystemVoices();
    if (this.systemVoiceList.length === 0) {
      throw new Error("No system voices available in this browser");
    }
    if (
      !this.settings.voice ||
      !this.systemVoiceList.some((v) => v.voiceURI === this.settings.voice)
    ) {
      const preferred =
        this.systemVoiceList.find((v) => v.default) ?? this.systemVoiceList[0]!;
      this.settings.voice = preferred.voiceURI;
    }
    this.systemReady = true;
    this.resolvedBackend = "system";
    this.modelLoadProgress = 1;
    this.lastError = null;
    this.fallbackWarning = null;
    this.setStatus("ready", {
      message: "Ready (system voices)",
      modelLoadProgress: 1,
    });
  }

  private async initKokoro(): Promise<void> {
    this.wasmPaths = chrome.runtime.getURL("wasm/");
    this.setStatus("loading_model", {
      message: "Loading Kokoro model…",
      modelLoadProgress: 0,
    });

    if (!this.settings.voice || this.settings.voice.includes("://")) {
      this.settings.voice = DEFAULT_KOKORO_VOICE;
    }

    const plans = await planBackends(this.settings.backend, this.settings.dtype);
    let lastErr: unknown = null;

    for (const plan of plans) {
      try {
        this.fallbackWarning = plan.fallbackWarning;
        this.activeDtype = plan.dtype;
        await this.client.init({
          device: plan.device,
          dtype: plan.dtype,
          wasmPaths: this.wasmPaths,
          voice: this.settings.voice,
          onProgress: (data) => {
            if (data.loaded != null && data.total != null && data.total > 0) {
              this.modelLoadProgress = data.loaded / data.total;
            } else if (data.progress != null) {
              const raw = data.progress;
              this.modelLoadProgress = raw > 1 ? raw / 100 : raw;
            }
            const pct = (this.modelLoadProgress * 100).toFixed(1);
            this.emit({
              ...this.getProgress(),
              status: "loading_model",
              message: `Downloading / loading model… ${pct}%`,
              modelLoadProgress: this.modelLoadProgress,
            });
          },
        });
        this.kokoroReady = true;
        this.resolvedBackend = toResolvedBackend(plan.device);
        this.modelLoadProgress = 1;
        this.lastError = null;
        this.setStatus("ready", {
          message: `Ready (Kokoro ${this.resolvedBackend}/${plan.dtype})`,
          modelLoadProgress: 1,
        });
        void this.queue.warmAudio();
        return;
      } catch (err) {
        lastErr = err;
        this.kokoroReady = false;
        await this.client.dispose();
        console.warn(`[KokoroRead] backend ${plan.device} failed`, err);
      }
    }

    this.lastError = errorMessage(lastErr);
    this.setStatus("error", { message: `Model init failed: ${this.lastError}` });
    throw lastErr instanceof Error ? lastErr : new Error(this.lastError);
  }

  listVoices(): VoiceInfo[] {
    if (this.settings.engine === "system") {
      return systemVoicesToInfo(this.systemVoiceList);
    }
    return this.client.getVoices();
  }

  async sample(text?: string): Promise<void> {
    await this.init();
    const sampleText =
      text?.trim() ||
      (this.settings.engine === "system"
        ? "This is your system voice from the browser or operating system. It starts instantly and never downloads a neural model."
        : "This is Kokoro, the on-device neural voice. After the model is cached, synthesis stays private and local in your browser.");
    await this.read(sampleText, "Sample", { highlight: false });
  }

  async read(
    text: string,
    _title?: string,
    options: { highlight?: boolean } = {},
  ): Promise<void> {
    await this.init();
    this.sessionText = normalizeWhitespace(text);
    this.highlightEnabled = options.highlight !== false;
    if (!this.highlightEnabled) {
      this.emitHighlight({ active: false });
    }
    if (this.settings.engine === "system") {
      await this.readWithSystem(this.sessionText);
      return;
    }
    void this.queue.warmAudio();
    const chunks = chunkText(this.sessionText);
    if (chunks.length === 0) {
      throw new Error("Nothing to read");
    }
    this.sessionChunks = chunks;
    this.readProgress = 0;
    this.setStatus("synthesizing", {
      currentChunk: 0,
      playChunk: 0,
      synthChunk: 0,
      totalChunks: chunks.length,
      message: `Preparing ${chunks.length} chunk(s)…`,
      preview: previewText(chunks[0]!.text),
      readProgress: 0,
    });
    this.playChunk = 0;
    this.synthChunk = 0;
    this.playPreview = "";
    this.synthMessage = "Synthesizing…";
    await this.queue.start(chunks);
  }

  private async readWithSystem(text: string): Promise<void> {
    stopSystemSpeech();
    this.stopWordClock();
    this.systemStopped = false;
    this.systemRestartFrom = null;
    const chunks = chunkText(text, {
      targetChars: 220,
      maxChars: 320,
      quickStartChars: 120,
    });
    if (chunks.length === 0) {
      throw new Error("Nothing to read");
    }
    this.sessionChunks = chunks;
    this.systemChunkTotal = chunks.length;
    this.systemChunkIndex = 0;
    this.readProgress = 0;

    for (let i = 0; i < chunks.length; ) {
      if (this.systemStopped) break;

      if (this.systemRestartFrom !== null) {
        i = this.systemRestartFrom;
        this.systemRestartFrom = null;
      }

      const chunk = chunks[i]!;
      this.systemChunkIndex = i;
      this.setStatus("playing", {
        currentChunk: i,
        playChunk: i,
        synthChunk: i,
        totalChunks: chunks.length,
        message: "Playing",
        preview: previewText(chunk.text),
      });
      this.emitHighlight(highlightAt(this.sessionText, chunk.start));
      await speakSystemChunk(chunk.text, {
        voiceURI: this.settings.voice,
        rate: this.settings.rate,
        voices: this.systemVoiceList,
        onBoundary: (charIndex) => {
          const absolute = chunk.start + Math.max(0, Math.min(charIndex, chunk.text.length - 1));
          this.emitHighlight(highlightAt(this.sessionText, absolute));
        },
      });

      // Voice/rate change cancelled this utterance — replay the same chunk.
      if (this.systemRestartFrom !== null) continue;
      if (this.systemStopped) break;
      i += 1;
    }

    this.emitHighlight({ active: false });
    if (!this.systemStopped) {
      this.sessionChunks = [];
      this.readProgress = 1;
      this.setStatus("ready", {
        currentChunk: 0,
        totalChunks: 0,
        message: "Finished",
        readProgress: 1,
      });
    }
  }

  pause(): void {
    if (this.settings.engine === "system") {
      pauseSystemSpeech();
      this.setStatus("paused", { message: "Paused" });
      return;
    }
    this.queue.pause();
    this.setStatus("paused", { message: "Paused" });
  }

  async resume(): Promise<void> {
    if (this.settings.engine === "system") {
      resumeSystemSpeech();
      this.setStatus("playing", { message: "Resumed" });
      return;
    }
    await this.queue.resume();
    this.setStatus("playing", { message: "Resumed" });
    if (this.activePlayChunk && this.activePlayTiming) {
      this.startKokoroWordClock(this.activePlayChunk, this.activePlayTiming);
    }
  }

  /** Jump one chunk backward (or restart the first chunk). */
  async skipBack(): Promise<void> {
    await this.skipBy(-1);
  }

  /** Jump one chunk forward (no-op on the last chunk). */
  async skipForward(): Promise<void> {
    await this.skipBy(1);
  }

  private async skipBy(delta: number): Promise<void> {
    const active =
      this.status === "playing" ||
      this.status === "paused" ||
      this.status === "synthesizing";
    if (!active || this.sessionChunks.length === 0) return;

    const total = this.sessionChunks.length;
    const current =
      this.settings.engine === "system" ? this.systemChunkIndex : this.playChunk;
    const target = clamp(current + delta, 0, total - 1);
    if (delta > 0 && target === current && current >= total - 1) return;

    this.stopWordClock();

    if (this.settings.engine === "system") {
      this.systemRestartFrom = target;
      stopSystemSpeech();
      if (this.status === "paused") {
        this.setStatus("playing", {
          playChunk: target,
          currentChunk: target,
          totalChunks: total,
          message: "Playing",
        });
      }
      return;
    }

    if (!this.queue.isRunning) return;
    this.playChunk = target;
    // Always show synthesizing until onPlayStart. Forward skips often hit the
    // lookahead cache, so a cache-only check left a silent restart gap that
    // looked stuck; skip-back beyond the behind-cache still needs real synth.
    this.synthesizing = true;
    this.synthChunk = target;
    this.synthMessage = "Synthesizing…";
    this.setStatus("synthesizing", {
      playChunk: target,
      currentChunk: target,
      totalChunks: total,
      message: "Synthesizing…",
      preview: previewText(this.sessionChunks[target]!.text),
      synthesizing: true,
      synthMessage: "Synthesizing…",
    });
    // Ensure audio is running after a skip from paused.
    if (this.queue.isPaused) {
      await this.queue.resume();
    }
    await this.queue.restartFrom(target);
  }

  async stop(): Promise<void> {
    this.setStatus("stopping", { message: "Stopping…" });
    this.stopWordClock();
    this.emitHighlight({ active: false });
    this.systemRestartFrom = null;
    this.sessionChunks = [];
    this.readProgress = 0;
    if (this.settings.engine === "system") {
      this.systemStopped = true;
      stopSystemSpeech();
    } else {
      await this.queue.stop();
    }
    this.setStatus("ready", {
      currentChunk: 0,
      totalChunks: 0,
      message: "Stopped",
      readProgress: 0,
    });
  }

  async diagnostics(): Promise<DiagnosticsInfo> {
    const webgpuAvailable = await isWebGpuAvailable();
    const engine: TtsEngineId = this.settings.engine;
    return {
      engine,
      resolvedBackend: this.resolvedBackend,
      requestedBackend: this.settings.backend,
      dtype: engine === "kokoro" ? this.activeDtype : null,
      modelId: engine === "kokoro" ? KOKORO_MODEL_ID : "speechSynthesis",
      modelReady: this.isReady(),
      webgpuAvailable,
      fallbackWarning: this.fallbackWarning,
      lastError: this.lastError,
      offlineCapable:
        engine === "system"
          ? this.systemReady
          : this.modelLoadProgress >= 1 && this.kokoroReady,
      chunkCount:
        engine === "system" ? this.systemChunkTotal : this.queue.total,
      queuedChunks:
        engine === "system"
          ? Math.max(0, this.systemChunkTotal - this.systemChunkIndex)
          : Math.max(0, this.queue.total - this.playChunk),
      version: APP_VERSION,
    };
  }

  private async generateChunk(text: string): Promise<PlayableAudio> {
    if (!this.kokoroReady) throw new Error("Kokoro TTS not initialized");
    return this.client.generate(text, this.settings.voice, this.settings.rate);
  }

  private statusLabel(): string {
    switch (this.status) {
      case "idle":
        return "Idle";
      case "loading_model":
        return this.settings.engine === "system"
          ? "Loading system voices…"
          : "Loading model…";
      case "ready":
        return "Ready";
      case "synthesizing":
        return this.synthMessage || "Synthesizing…";
      case "playing":
        return "Playing";
      case "paused":
        return "Paused";
      case "stopping":
        return "Stopping…";
      case "error":
        return this.lastError ?? "Error";
      default:
        return this.status;
    }
  }

  private setStatus(
    status: PlaybackStatus,
    patch: Partial<ProgressInfo> = {},
  ): void {
    this.status = status;
    this.emitProgress({ status, ...patch });
  }

  private emitProgress(patch: Partial<ProgressInfo> & { status?: PlaybackStatus }): void {
    const status = patch.status ?? this.status;
    const totalChunks =
      patch.totalChunks ??
      (this.settings.engine === "system"
        ? this.systemChunkTotal
        : this.queue.total);
    const playChunk =
      patch.playChunk ??
      (this.settings.engine === "system"
        ? this.systemChunkIndex
        : this.playChunk);
    const synthChunk =
      patch.synthChunk ??
      (this.settings.engine === "system"
        ? this.systemChunkIndex
        : this.synthChunk);

    this.emit({
      status,
      totalChunks,
      playChunk,
      synthChunk,
      currentChunk: playChunk,
      message: patch.message ?? this.statusLabel(),
      synthMessage: this.synthesizing
        ? (patch.synthMessage ?? (this.synthMessage || undefined))
        : undefined,
      preview: patch.preview ?? (this.playPreview || undefined),
      modelLoadProgress: patch.modelLoadProgress ?? this.modelLoadProgress,
      synthesizing: patch.synthesizing ?? this.synthesizing,
      readProgress: patch.readProgress ?? this.readProgress,
    });
  }

  private emit(progress: ProgressInfo): void {
    for (const listener of this.listeners) {
      try {
        listener(progress);
      } catch (err) {
        console.warn("[KokoroRead] progress listener error", err);
      }
    }
  }

  private emitHighlight(highlight: HighlightState): void {
    if (!this.highlightEnabled && highlight.active) return;

    if (highlight.active && this.sessionText.length > 0) {
      const pos = highlight.wordEnd ?? highlight.wordStart ?? 0;
      this.readProgress = Math.min(1, Math.max(0, pos / this.sessionText.length));
      const now = Date.now();
      if (now - this.lastReadProgressEmit >= 80) {
        this.lastReadProgressEmit = now;
        this.emitProgress({ readProgress: this.readProgress });
      }
    }

    for (const listener of this.highlightListeners) {
      try {
        listener(highlight);
      } catch (err) {
        console.warn("[KokoroRead] highlight listener error", err);
      }
    }
  }

  private startKokoroWordClock(chunk: TextChunk, timing: PlayTiming): void {
    this.stopWordClock();
    this.activePlayChunk = chunk;
    this.activePlayTiming = timing;
    this.emitHighlight(highlightAt(this.sessionText, chunk.start));

    this.wordClockTimer = setInterval(() => {
      if (this.status === "paused") return;
      const elapsed = this.queue.audioTime() - timing.startAt;
      if (elapsed < 0) return;
      const progress = timing.duration > 0 ? Math.min(1, elapsed / timing.duration) : 1;
      const local = charIndexAtProgress(chunk.text, progress);
      this.emitHighlight(highlightAt(this.sessionText, chunk.start + local));
      if (progress >= 1) this.stopWordClock();
    }, 50);
  }

  private stopWordClock(): void {
    if (this.wordClockTimer !== null) {
      clearInterval(this.wordClockTimer);
      this.wordClockTimer = null;
    }
  }
}
