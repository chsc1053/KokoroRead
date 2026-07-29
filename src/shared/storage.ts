/**
 * @file storage.ts
 * @description chrome.storage.local helpers for KokoroRead settings.
 *
 * All persisted preferences live under a single key. Defaults are merged
 * on read so partial upgrades remain compatible.
 *
 * Note: Prefer calling these from the service worker or popup. Some extension
 * contexts (notably certain offscreen + bundler setups) may not expose
 * chrome.storage even when the permission is granted — offscreen should
 * receive settings via messages instead.
 */

import {
  DEFAULT_SETTINGS,
  type KokoroSettings,
} from "./types";

const SETTINGS_KEY = "kokoroRead.settings";

/**
 * Resolve chrome.storage.local, or null when unavailable in this context.
 */
export function getLocalStorageArea(): chrome.storage.LocalStorageArea | null {
  try {
    const api = (globalThis as typeof globalThis & { chrome?: typeof chrome })
      .chrome;
    return api?.storage?.local ?? null;
  } catch {
    return null;
  }
}

/**
 * Load settings from chrome.storage.local, merging with defaults.
 * Returns defaults when storage is unavailable.
 */
export async function loadSettings(): Promise<KokoroSettings> {
  const area = getLocalStorageArea();
  if (!area) {
    console.warn(
      "[KokoroRead] chrome.storage.local unavailable; using default settings",
    );
    return { ...DEFAULT_SETTINGS };
  }
  const stored = await area.get(SETTINGS_KEY);
  const raw = stored[SETTINGS_KEY] as Partial<KokoroSettings> | undefined;
  return {
    ...DEFAULT_SETTINGS,
    ...raw,
  };
}

/**
 * Persist a partial settings update and return the merged result.
 * Throws if storage is unavailable (callers should run in SW/popup).
 */
export async function saveSettings(
  patch: Partial<KokoroSettings>,
): Promise<KokoroSettings> {
  const area = getLocalStorageArea();
  if (!area) {
    throw new Error(
      "chrome.storage.local is unavailable in this context; save settings from the service worker or popup",
    );
  }
  const current = await loadSettings();
  const next: KokoroSettings = {
    ...current,
    ...patch,
  };
  await area.set({ [SETTINGS_KEY]: next });
  return next;
}

/**
 * Subscribe to settings changes from storage events.
 * No-op unsubscribe when storage is unavailable.
 */
export function onSettingsChanged(
  listener: (settings: KokoroSettings) => void,
): () => void {
  const api = (globalThis as typeof globalThis & { chrome?: typeof chrome })
    .chrome;
  if (!api?.storage?.onChanged) {
    return () => undefined;
  }
  const handler: Parameters<typeof chrome.storage.onChanged.addListener>[0] = (
    changes,
    areaName,
  ) => {
    if (areaName !== "local") return;
    const change = changes[SETTINGS_KEY];
    if (!change) return;
    const next = {
      ...DEFAULT_SETTINGS,
      ...(change.newValue as Partial<KokoroSettings> | undefined),
    };
    listener(next);
  };
  api.storage.onChanged.addListener(handler);
  return () => api.storage.onChanged.removeListener(handler);
}
