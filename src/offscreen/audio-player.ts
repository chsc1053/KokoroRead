/**
 * @file audio-player.ts
 * @description Gapless Web Audio playback for Kokoro PCM buffers.
 *
 * Buffers are scheduled on the AudioContext timeline end-to-end so chunk
 * boundaries do not insert silence. Pause uses ctx.suspend() so the whole
 * timeline freezes cleanly.
 */

export interface PlayableAudio {
  samples: Float32Array;
  sampleRate: number;
}

export interface EnqueueResult {
  /** Resolves when this buffer finishes audible playback. */
  done: Promise<void>;
  /** AudioContext time when this buffer starts. */
  startAt: number;
  /** Duration in seconds. */
  duration: number;
}

export class AudioPlayer {
  private ctx: AudioContext | null = null;
  /** Context time when the next enqueued buffer should start. */
  private nextStartTime = 0;
  private sources = new Set<AudioBufferSourceNode>();
  private drainWaiters: Array<() => void> = [];
  private paused = false;

  private ensureContext(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext();
    }
    return this.ctx;
  }

  async warm(): Promise<void> {
    const ctx = this.ensureContext();
    if (ctx.state === "suspended" && !this.paused) {
      await ctx.resume();
    }
  }

  /** Reset the schedule cursor (call before a new read session). */
  resetTimeline(): void {
    this.nextStartTime = 0;
  }

  /** Current AudioContext time (0 if not created). */
  currentTime(): number {
    return this.ctx?.currentTime ?? 0;
  }

  /**
   * Schedule PCM to play immediately after previously enqueued audio.
   */
  enqueue(audio: PlayableAudio): EnqueueResult {
    const ctx = this.ensureContext();
    const samples = audio.samples.slice();
    const buffer = ctx.createBuffer(1, samples.length, audio.sampleRate);
    buffer.copyToChannel(samples, 0);

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);

    const now = ctx.currentTime;
    // Small lead so the first buffer never starts in the past.
    const startAt = Math.max(now + 0.02, this.nextStartTime);
    this.nextStartTime = startAt + buffer.duration;
    const duration = buffer.duration;

    const done = new Promise<void>((resolve) => {
      source.onended = () => {
        this.sources.delete(source);
        try {
          source.disconnect();
        } catch {
          // ignore
        }
        resolve();
        this.flushDrain();
      };
      this.sources.add(source);
      source.start(startAt);
    });

    return { done, startAt, duration };
  }

  /** Resolve when every scheduled source has ended. */
  async drain(): Promise<void> {
    if (this.sources.size === 0) return;
    await new Promise<void>((resolve) => {
      this.drainWaiters.push(resolve);
      this.flushDrain();
    });
  }

  async pause(): Promise<void> {
    const ctx = this.ensureContext();
    this.paused = true;
    if (ctx.state === "running") {
      await ctx.suspend();
    }
  }

  async resume(): Promise<void> {
    const ctx = this.ensureContext();
    this.paused = false;
    if (ctx.state === "suspended") {
      await ctx.resume();
    }
  }

  async stop(): Promise<void> {
    // Must resolve each source's `done` promise. Clearing `onended` before
    // `stop()` left those promises pending, which hung SynthesisQueue on
    // `Promise.all(finishTrackers)` after skip-back / restart.
    for (const source of [...this.sources]) {
      const finish = source.onended;
      source.onended = null;
      try {
        source.stop();
      } catch {
        // already stopped
      }
      try {
        source.disconnect();
      } catch {
        // ignore
      }
      this.sources.delete(source);
      if (typeof finish === "function") {
        try {
          finish.call(source, new Event("ended"));
        } catch {
          // ignore listener errors
        }
      }
    }
    this.sources.clear();
    this.nextStartTime = 0;
    this.paused = false;
    if (this.ctx && this.ctx.state === "suspended") {
      try {
        await this.ctx.resume();
      } catch {
        // ignore
      }
    }
    this.flushDrain();
  }

  isPaused(): boolean {
    return this.paused;
  }

  isPlaying(): boolean {
    return this.sources.size > 0 && !this.paused;
  }

  private flushDrain(): void {
    if (this.sources.size > 0) return;
    const waiters = this.drainWaiters;
    this.drainWaiters = [];
    for (const w of waiters) w();
  }
}
