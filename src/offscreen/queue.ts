/**
 * @file queue.ts
 * @description Pipelined chunk synthesis + gapless playback for KokoroRead.
 *
 * Strategy:
 * 1. Synthesize chunk 0, enqueue it on the audio timeline.
 * 2. While it plays, synthesize a few chunks ahead in the Kokoro Worker.
 * 3. Enqueue each buffer to start exactly when the previous ends (gapless).
 * 4. Pause synthesis once the lookahead buffer is full; resume as playback advances.
 * 5. Keep the last few played chunks (+ lookahead) in an audio cache so skip-back
 *    can replay without waiting on the model.
 * 6. On voice/rate change, clear the cache and restartFrom(playIndex).
 */

import type { TextChunk } from "../shared/types";
import type { PlayableAudio } from "./audio-player";
import { AudioPlayer } from "./audio-player";

export type SynthFn = (chunk: TextChunk) => Promise<PlayableAudio>;

/** Max chunks synthesized ahead of the currently playing chunk. */
export const MAX_SYNTH_AHEAD = 2;

/** How many already-played chunks to keep for instant skip-back. */
export const CACHE_BEHIND = 2;

export interface PlayTiming {
  startAt: number;
  duration: number;
}

export interface QueueCallbacks {
  /** Fired when synthesis of a chunk begins. */
  onSynthStart?: (chunk: TextChunk, index: number, total: number) => void;
  /** Fired when synthesis pauses because the lookahead buffer is full. */
  onSynthPaused?: (readyThrough: number, playIndex: number, total: number) => void;
  /** Fired when every chunk has been synthesized (playback may still be running). */
  onSynthComplete?: (total: number) => void;
  /** Fired when a chunk begins audible playback. */
  onPlayStart?: (
    chunk: TextChunk,
    index: number,
    total: number,
    timing: PlayTiming,
  ) => void;
  /** Fired when a chunk finishes audible playback. */
  onPlayEnd?: (chunk: TextChunk, index: number, total: number) => void;
  onComplete?: () => void;
  onError?: (err: unknown, chunk?: TextChunk) => void;
}

export class SynthesisQueue {
  private chunks: TextChunk[] = [];
  private playIndex = 0;
  private synthIndex = 0;
  private stopped = false;
  private running = false;
  private sessionActive = false;
  private runGeneration = 0;
  private restartRequest: number | null = null;
  private player = new AudioPlayer();
  private synth: SynthFn;
  private callbacks: QueueCallbacks;
  private playAdvanceWaiters: Array<() => void> = [];
  private timings = new Map<number, PlayTiming>();
  /** Cached PCM for recent / upcoming chunks (keyed by chunk index). */
  private audioCache = new Map<number, PlayableAudio>();

  constructor(synth: SynthFn, callbacks: QueueCallbacks = {}) {
    this.synth = synth;
    this.callbacks = callbacks;
  }

  get currentIndex(): number {
    return this.playIndex;
  }

  get playingIndex(): number {
    return this.playIndex;
  }

  get synthesizingIndex(): number {
    return this.synthIndex;
  }

  get total(): number {
    return this.chunks.length;
  }

  get isRunning(): boolean {
    return this.running || this.sessionActive;
  }

  get isPaused(): boolean {
    return this.player.isPaused();
  }

  audioTime(): number {
    return this.player.currentTime();
  }

  timingFor(index: number): PlayTiming | undefined {
    return this.timings.get(index);
  }

  async warmAudio(): Promise<void> {
    await this.player.warm();
  }

  async start(chunks: TextChunk[]): Promise<void> {
    await this.stop();
    this.chunks = chunks;
    this.playIndex = 0;
    this.synthIndex = 0;
    this.timings.clear();
    this.audioCache.clear();
    this.restartRequest = null;
    this.sessionActive = true;
    this.player.resetTimeline();
    await this.player.warm();

    while (this.sessionActive) {
      const gen = ++this.runGeneration;
      const startIndex = this.restartRequest ?? 0;
      this.restartRequest = null;
      this.stopped = false;
      this.running = true;
      this.timings.clear();
      this.player.resetTimeline();
      await this.player.warm();
      await this.run(gen, startIndex);

      if (!this.sessionActive) break;
      if (this.restartRequest != null) continue;
      break;
    }
  }

  /**
   * Jump playback to `index`. Cached PCM is reused when available so skip-back
   * does not wait on the model. Pass `clearCache` after a voice/rate change.
   */
  async restartFrom(
    index: number,
    options: { clearCache?: boolean } = {},
  ): Promise<void> {
    if (!this.sessionActive || this.chunks.length === 0) return;
    if (options.clearCache) this.audioCache.clear();
    this.restartRequest = Math.max(0, Math.min(index, this.chunks.length - 1));
    this.playIndex = this.restartRequest;
    this.stopped = true;
    this.notifyPlayAdvance();
    await this.player.stop();
  }

  pause(): void {
    void this.player.pause();
  }

  async resume(): Promise<void> {
    if (this.player.isPaused()) {
      await this.player.resume();
      return;
    }
  }

  async stop(): Promise<void> {
    this.sessionActive = false;
    this.restartRequest = null;
    this.stopped = true;
    this.running = false;
    this.runGeneration += 1;
    this.audioCache.clear();
    this.notifyPlayAdvance();
    await this.player.stop();
  }

  private notifyPlayAdvance(): void {
    const waiters = this.playAdvanceWaiters;
    this.playAdvanceWaiters = [];
    for (const waiter of waiters) waiter();
  }

  private waitForLookahead(nextIndex: number, gen: number): Promise<boolean> {
    if (this.stopped || gen !== this.runGeneration) return Promise.resolve(false);
    if (nextIndex <= this.playIndex + MAX_SYNTH_AHEAD) {
      return Promise.resolve(true);
    }

    return new Promise((resolve) => {
      const check = (): void => {
        if (this.stopped || gen !== this.runGeneration) {
          resolve(false);
          return;
        }
        if (nextIndex <= this.playIndex + MAX_SYNTH_AHEAD) {
          resolve(true);
          return;
        }
        this.playAdvanceWaiters.push(check);
      };
      this.playAdvanceWaiters.push(check);
    });
  }

  private cloneAudio(audio: PlayableAudio): PlayableAudio {
    return {
      samples: audio.samples.slice(),
      sampleRate: audio.sampleRate,
    };
  }

  private storeCache(index: number, audio: PlayableAudio): void {
    this.audioCache.set(index, this.cloneAudio(audio));
    this.pruneCache(this.playIndex);
  }

  /** Keep [playIndex - CACHE_BEHIND, playIndex + MAX_SYNTH_AHEAD]. */
  private pruneCache(around: number): void {
    const min = around - CACHE_BEHIND;
    const max = around + MAX_SYNTH_AHEAD;
    for (const key of [...this.audioCache.keys()]) {
      if (key < min || key > max) this.audioCache.delete(key);
    }
  }

  /**
   * Return cached audio when present; otherwise synthesize and cache.
   * Cache hits skip onSynthStart so skip-back stays snappy in the UI.
   */
  private async audioForChunk(
    index: number,
    total: number,
  ): Promise<PlayableAudio | null> {
    const cached = this.audioCache.get(index);
    if (cached) {
      this.pruneCache(this.playIndex);
      return this.cloneAudio(cached);
    }

    const chunk = this.chunks[index]!;
    this.callbacks.onSynthStart?.(chunk, index, total);
    const audio = await this.synth(chunk);
    if (!audio) return null;
    this.storeCache(index, audio);
    return audio;
  }

  private async run(gen: number, startIndex: number): Promise<void> {
    const finishTrackers: Promise<void>[] = [];

    try {
      if (this.chunks.length === 0) {
        if (gen === this.runGeneration && this.restartRequest == null) {
          this.callbacks.onComplete?.();
        }
        return;
      }

      const total = this.chunks.length;
      let i = Math.max(0, Math.min(startIndex, total - 1));

      this.synthIndex = i;
      let audio: PlayableAudio | null = await this.audioForChunk(i, total);
      if (this.stopped || !audio || gen !== this.runGeneration) return;

      while (audio && !this.stopped && gen === this.runGeneration) {
        const chunkIndex = i;
        const chunk = this.chunks[chunkIndex]!;

        const { done, startAt, duration } = this.player.enqueue(audio);
        const timing: PlayTiming = { startAt, duration };
        this.timings.set(chunkIndex, timing);

        // Fire play-start for the first chunk of this run immediately.
        if (chunkIndex === startIndex) {
          this.playIndex = chunkIndex;
          this.pruneCache(this.playIndex);
          this.callbacks.onPlayStart?.(chunk, chunkIndex, total, timing);
        }

        finishTrackers.push(
          done.then(() => {
            if (this.stopped || gen !== this.runGeneration) return;
            this.callbacks.onPlayEnd?.(chunk, chunkIndex, total);
            const next = chunkIndex + 1;
            if (next < total) {
              this.playIndex = next;
              this.pruneCache(this.playIndex);
              const nextTiming = this.timings.get(next) ?? {
                startAt: this.player.currentTime(),
                duration: 0,
              };
              this.callbacks.onPlayStart?.(this.chunks[next]!, next, total, nextTiming);
            } else {
              this.playIndex = chunkIndex;
            }
            this.notifyPlayAdvance();
          }),
        );

        i += 1;
        if (i >= total) {
          audio = null;
          if (gen === this.runGeneration) {
            this.callbacks.onSynthComplete?.(total);
          }
          break;
        }

        if (i > this.playIndex + MAX_SYNTH_AHEAD) {
          this.callbacks.onSynthPaused?.(i - 1, this.playIndex, total);
          const canContinue = await this.waitForLookahead(i, gen);
          if (!canContinue || this.stopped || gen !== this.runGeneration) {
            audio = null;
            break;
          }
        }

        this.synthIndex = i;
        audio = await this.audioForChunk(i, total);
        if (this.stopped || gen !== this.runGeneration) {
          audio = null;
          break;
        }
      }

      if (
        !this.stopped &&
        gen === this.runGeneration &&
        this.restartRequest == null
      ) {
        await this.player.drain();
        if (
          this.stopped ||
          gen !== this.runGeneration ||
          this.restartRequest != null
        ) {
          return;
        }
        await Promise.all(finishTrackers);
        if (gen === this.runGeneration && this.restartRequest == null) {
          this.callbacks.onComplete?.();
          this.sessionActive = false;
        }
      }
    } catch (err) {
      if (gen === this.runGeneration) {
        this.callbacks.onError?.(err, this.chunks[this.synthIndex]);
        this.sessionActive = false;
      }
    } finally {
      if (gen === this.runGeneration) {
        this.running = false;
      }
    }
  }
}
