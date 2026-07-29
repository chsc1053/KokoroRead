/**
 * @file synth-client.ts
 * @description Main-thread client for the Kokoro synth worker.
 */

import type { ModelDtype, VoiceInfo } from "../shared/types";
import { createRequestId } from "../shared/utils";
import type { PlayableAudio } from "./audio-player";
import type { WorkerRequest, WorkerResponse } from "./synth.worker";

type ProgressCb = (info: {
  loaded?: number;
  total?: number;
  progress?: number;
}) => void;

export class SynthClient {
  private worker: Worker | null = null;
  private pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (err: Error) => void;
      onProgress?: ProgressCb;
    }
  >();
  private voices: VoiceInfo[] = [];

  getVoices(): VoiceInfo[] {
    return this.voices;
  }

  async init(options: {
    device: "webgpu" | "wasm";
    dtype: ModelDtype;
    wasmPaths: string;
    voice: string;
    onProgress?: ProgressCb;
  }): Promise<void> {
    await this.dispose();
    this.worker = new Worker(new URL("./synth.worker.ts", import.meta.url), {
      type: "module",
    });
    this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      this.handleMessage(event.data);
    };
    this.worker.onerror = (event) => {
      console.error("[KokoroRead] synth worker error", event);
    };

    const id = createRequestId();
    await this.send<WorkerResponse & { type: "ready" }>(
      {
        type: "init",
        id,
        device: options.device,
        dtype: options.dtype,
        wasmPaths: options.wasmPaths,
        voice: options.voice,
      },
      options.onProgress,
    );
  }

  async generate(
    text: string,
    voice: string,
    speed: number,
  ): Promise<PlayableAudio> {
    const id = createRequestId();
    const result = await this.send<WorkerResponse & { type: "audio" }>({
      type: "generate",
      id,
      text,
      voice,
      speed,
    });
    return {
      samples: result.samples,
      sampleRate: result.sampleRate,
    };
  }

  async dispose(): Promise<void> {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    for (const [, p] of this.pending) {
      p.reject(new Error("Synth worker disposed"));
    }
    this.pending.clear();
    this.voices = [];
  }

  private handleMessage(data: WorkerResponse): void {
    if (data.type === "progress") {
      const pending = this.pending.get(data.id);
      pending?.onProgress?.(data);
      return;
    }

    const pending = this.pending.get(data.id);
    if (!pending) return;
    this.pending.delete(data.id);

    if (data.type === "error") {
      pending.reject(new Error(data.error));
      return;
    }

    if (data.type === "ready") {
      this.voices = data.voices;
      pending.resolve(data);
      return;
    }

    if (data.type === "voices") {
      this.voices = data.voices;
      pending.resolve(data);
      return;
    }

    if (data.type === "audio") {
      pending.resolve(data);
    }
  }

  private send<T>(
    message: WorkerRequest,
    onProgress?: ProgressCb,
  ): Promise<T> {
    if (!this.worker) {
      return Promise.reject(new Error("Synth worker not started"));
    }
    const { id } = message;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        onProgress,
      });
      this.worker!.postMessage(message);
    });
  }
}
