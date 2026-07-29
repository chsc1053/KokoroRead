/**
 * @file system-speech.ts
 * @description On-device system TTS via the Web Speech API (speechSynthesis).
 *
 * Uses OS/browser voices already installed on the machine — no model download,
 * typically much lower latency than Kokoro. Still fully local (no cloud TTS).
 */

import type { VoiceInfo } from "../shared/types";
import { clamp } from "../shared/utils";

export interface SystemSpeakOptions {
  voiceURI: string;
  rate: number;
  voices: SpeechSynthesisVoice[];
  /** Fired on word (and sometimes sentence) boundaries with char index into the utterance. */
  onBoundary?: (charIndex: number, name: string) => void;
}

/** Wait until speechSynthesis voices are populated (Chrome loads them async). */
export async function loadSystemVoices(): Promise<SpeechSynthesisVoice[]> {
  const synth = window.speechSynthesis;
  const existing = synth.getVoices();
  if (existing.length > 0) return existing;

  await new Promise<void>((resolve) => {
    const done = () => {
      synth.removeEventListener("voiceschanged", done);
      resolve();
    };
    synth.addEventListener("voiceschanged", done);
    // Fallback if the event never fires.
    window.setTimeout(done, 750);
  });

  return synth.getVoices();
}

export function systemVoicesToInfo(voices: SpeechSynthesisVoice[]): VoiceInfo[] {
  return voices
    .slice()
    .sort((a, b) => {
      if (a.default !== b.default) return a.default ? -1 : 1;
      return a.name.localeCompare(b.name);
    })
    .map((v) => ({
      id: v.voiceURI,
      name: v.name,
      language: v.lang || "",
      gender: "",
      traits: v.localService ? "on-device" : "network",
    }));
}

export function pickSystemVoice(
  voices: SpeechSynthesisVoice[],
  voiceURI: string,
): SpeechSynthesisVoice | null {
  return voices.find((v) => v.voiceURI === voiceURI) ?? voices.find((v) => v.default) ?? voices[0] ?? null;
}

/**
 * Speak one utterance with the system voice. Resolves on end/error/cancel.
 */
export function speakSystemChunk(
  text: string,
  options: SystemSpeakOptions,
): Promise<void> {
  const synth = window.speechSynthesis;
  const voice = pickSystemVoice(options.voices, options.voiceURI);

  return new Promise<void>((resolve, reject) => {
    const utterance = new SpeechSynthesisUtterance(text);
    if (voice) utterance.voice = voice;
    utterance.rate = clamp(options.rate, 0.5, 2);
    utterance.onboundary = (event) => {
      options.onBoundary?.(event.charIndex, event.name);
    };
    utterance.onend = () => resolve();
    utterance.onerror = (event) => {
      if (event.error === "canceled" || event.error === "interrupted") {
        resolve();
        return;
      }
      reject(new Error(`System TTS error: ${event.error}`));
    };
    synth.speak(utterance);
  });
}

export function pauseSystemSpeech(): void {
  window.speechSynthesis.pause();
}

export function resumeSystemSpeech(): void {
  window.speechSynthesis.resume();
}

export function stopSystemSpeech(): void {
  window.speechSynthesis.cancel();
}
