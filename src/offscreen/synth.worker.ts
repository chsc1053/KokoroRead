/**
 * @file synth.worker.ts
 * @description Web Worker that owns the Kokoro model and runs generate().
 *
 * Running synthesis off the offscreen document's main thread lets audio
 * playback overlap with the next chunk's inference without stuttering.
 */

// Chrome ORT console filter must install before onnxruntime WASM loads.
import {
  installOrtConsoleFilterEarly,
  installTransformersChromeFixes,
} from "./transformers-chrome";
installOrtConsoleFilterEarly();

import { env as transformersEnv } from "@huggingface/transformers";
import { KokoroTTS, env as kokoroEnv } from "kokoro-js";
import { KOKORO_MODEL_ID } from "../shared/types";
import { resolveKokoroGender } from "../shared/utils";

export type WorkerRequest =
  | {
      type: "init";
      id: string;
      device: "webgpu" | "wasm";
      dtype: "fp32" | "fp16" | "q8" | "q4" | "q4f16";
      wasmPaths: string;
      voice: string;
    }
  | {
      type: "generate";
      id: string;
      text: string;
      voice: string;
      speed: number;
    }
  | { type: "list_voices"; id: string };

export type WorkerResponse =
  | {
      type: "ready";
      id: string;
      voices: Array<{
        id: string;
        name: string;
        language: string;
        gender: string;
        traits?: string;
        overallGrade?: string;
      }>;
    }
  | {
      type: "audio";
      id: string;
      sampleRate: number;
      /** Transferred Float32Array buffer. */
      samples: Float32Array;
    }
  | {
      type: "voices";
      id: string;
      voices: Array<{
        id: string;
        name: string;
        language: string;
        gender: string;
        traits?: string;
        overallGrade?: string;
      }>;
    }
  | {
      type: "progress";
      id: string;
      loaded?: number;
      total?: number;
      progress?: number;
    }
  | { type: "error"; id: string; error: string };

let tts: KokoroTTS | null = null;
let chain: Promise<void> = Promise.resolve();
let chromeFixesReady: Promise<void> | null = null;

function ensureChromeFixes(): Promise<void> {
  if (!chromeFixesReady) {
    chromeFixesReady = installTransformersChromeFixes();
  }
  return chromeFixesReady;
}

function listVoiceInfos() {
  if (!tts) return [];
  const voices = tts.voices as Record<
    string,
    {
      name?: string;
      language?: string;
      gender?: string;
      traits?: string;
      overallGrade?: string;
    }
  >;
  return Object.entries(voices).map(([id, meta]) => ({
    id,
    name: meta.name ?? id,
    language: meta.language ?? "",
    gender: resolveKokoroGender(id, meta.gender),
    traits: meta.traits,
    overallGrade: meta.overallGrade,
  }));
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data;
  // Serialize all worker tasks — Kokoro/ORT is not re-entrant.
  chain = chain.then(async () => {
    try {
      switch (msg.type) {
        case "init": {
          await ensureChromeFixes();
          // Point ORT at packaged WASM (chrome-extension://…/wasm/).
          kokoroEnv.wasmPaths = msg.wasmPaths;
          if (transformersEnv.backends?.onnx) {
            const onnx = transformersEnv.backends.onnx as {
              logLevel?: string;
              wasm?: { wasmPaths?: string };
            };
            // Quiet ORT [W:] EP-assignment notes (WASM prints them via console.error).
            onnx.logLevel = "error";
            onnx.wasm = { ...onnx.wasm, wasmPaths: msg.wasmPaths };
          }
          tts = await KokoroTTS.from_pretrained(KOKORO_MODEL_ID, {
            device: msg.device,
            dtype: msg.dtype,
            progress_callback: (data) => {
              const payload: WorkerResponse = {
                type: "progress",
                id: msg.id,
              };
              if (data && typeof data === "object") {
                if ("loaded" in data) {
                  payload.loaded = Number((data as { loaded: number }).loaded);
                }
                if ("total" in data) {
                  payload.total = Number((data as { total: number }).total);
                }
                if ("progress" in data) {
                  payload.progress = Number(
                    (data as { progress: number }).progress,
                  );
                }
              }
              self.postMessage(payload);
            },
          });
          await tts.generate("Hi.", {
            voice: msg.voice as "af_heart",
            speed: 1,
          });
          const response: WorkerResponse = {
            type: "ready",
            id: msg.id,
            voices: listVoiceInfos(),
          };
          self.postMessage(response);
          return;
        }
        case "generate": {
          if (!tts) throw new Error("Worker TTS not initialized");
          const raw = await tts.generate(msg.text, {
            voice: msg.voice as "af_heart",
            speed: msg.speed,
          });
          const src = (raw as { audio: Float32Array }).audio;
          const sampleRate = (raw as { sampling_rate: number }).sampling_rate;
          // Copy into a fresh buffer and sanitize — never pass ORT-backed views out.
          const samples = new Float32Array(src.length);
          for (let i = 0; i < src.length; i += 1) {
            const v = src[i]!;
            samples[i] = Number.isFinite(v) ? v : 0;
          }
          const response: WorkerResponse = {
            type: "audio",
            id: msg.id,
            sampleRate,
            samples,
          };
          self.postMessage(response);
          return;
        }
        case "list_voices": {
          const response: WorkerResponse = {
            type: "voices",
            id: msg.id,
            voices: listVoiceInfos(),
          };
          self.postMessage(response);
          return;
        }
        default:
          throw new Error("Unknown worker message");
      }
    } catch (err) {
      const response: WorkerResponse = {
        type: "error",
        id: msg.id,
        error: err instanceof Error ? err.message : String(err),
      };
      self.postMessage(response);
    }
  });
};
