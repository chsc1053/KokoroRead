/**
 * @file transformers-chrome.ts
 * @description Chrome-extension-safe Transformers.js / ONNX Runtime setup.
 *
 * Chrome's extensions page surfaces these as Warnings / Errors during model load:
 *
 * 1. `Unable to determine content-length from response headers…`
 *    Transformers.js reads `Content-Length` to size its download buffer. The
 *    Cache API strips that header from stored Responses, so every cache hit
 *    triggers a console.warn (and Chrome lists it on the extension Errors page).
 *
 * 2. `Unable to add response to browser cache: Request scheme 'chrome-extension'
 *    is unsupported`
 *    Packaged WASM/ORT assets are fetched from `chrome-extension://…`. The
 *    Cache API only accepts http(s) keys, so `cache.put` rejects.
 *
 * 3. `[W:onnxruntime:] VerifyEachNodeIsAssignedToAnEp …`
 *    Benign WebGPU session note (shape ops stay on CPU by design). Session
 *    options default `logSeverityLevel` to 2 (warning), independent of
 *    `env.logLevel`. ORT WASM prints those via stderr → `console.error`, so
 *    Chrome lists them as Errors. We force session severity ≥ error and
 *    filter any remaining ORT warning lines from console.
 *
 * Fix: wrap the Cache API, restore Content-Length, skip non-http puts, raise
 * ORT session log severity, and filter residual ORT [W:] console noise.
 */

import { env } from "@huggingface/transformers";
import { InferenceSession } from "onnxruntime-common";

/** Same name Transformers.js uses so previously downloaded weights stay warm. */
const CACHE_NAME = "transformers-cache";

/** ORT severity: 0=verbose … 2=warning … 3=error … 4=fatal */
const ORT_LOG_ERROR = 3 as const;

function requestUrl(request: RequestInfo | URL): string {
  if (typeof request === "string") return request;
  if (request instanceof URL) return request.href;
  return request.url;
}

function isHttpUrl(url: string): boolean {
  return url.startsWith("http://") || url.startsWith("https://");
}

function isExtensionScheme(url: string): boolean {
  return (
    url.startsWith("chrome-extension:") ||
    url.startsWith("moz-extension:") ||
    url.startsWith("safari-web-extension:")
  );
}

/** Rebuild a Response with an explicit Content-Length from the body bytes. */
async function withContentLength(response: Response): Promise<Response> {
  const buffer = await response.arrayBuffer();
  const headers = new Headers(response.headers);
  headers.set("Content-Length", String(buffer.byteLength));
  return new Response(buffer, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

function isBenignOrtWarning(...args: unknown[]): boolean {
  const text = stripAnsi(
    args
      .map((a) => {
        if (typeof a === "string") return a;
        if (a instanceof Error) return a.message;
        try {
          return String(a);
        } catch {
          return "";
        }
      })
      .join(" "),
  );
  return (
    /\[W:onnxruntime:/i.test(text) ||
    /VerifyEachNodeIsAssignedToAnEp/i.test(text) ||
    /Rerunning with verbose output on a non-minimal build/i.test(text)
  );
}

/**
 * ORT WASM prints [W:] lines through stderr → console.error. Chrome's
 * extension Errors page treats that as a publish-blocking Error even though
 * the message is only a warning. Drop those known-benign lines.
 *
 * Idempotent; also run on module load so it is in place before ORT WASM binds
 * printErr to console.error.
 */
let consoleFilterInstalled = false;

function installOrtConsoleFilter(): void {
  if (consoleFilterInstalled) return;
  consoleFilterInstalled = true;
  for (const method of ["error", "warn", "log", "info", "debug"] as const) {
    const original = console[method].bind(console);
    console[method] = (...args: unknown[]) => {
      if (isBenignOrtWarning(...args)) return;
      original(...args);
    };
  }
}

/** Public alias for the worker entry to call before other inits. */
export function installOrtConsoleFilterEarly(): void {
  installOrtConsoleFilter();
}

// Install as soon as this module evaluates (before Kokoro/ORT session create).
installOrtConsoleFilter();


/**
 * Session create defaults logSeverityLevel=2 (warning). Force ≥ error so the
 * C++ EP-assignment notes are not emitted when this InferenceSession is used.
 */
function installOrtSessionLogPatch(): void {
  const originalCreate = InferenceSession.create.bind(InferenceSession);
  InferenceSession.create = ((
    uriOrBuffer: Parameters<typeof InferenceSession.create>[0],
    options?: InferenceSession.SessionOptions,
  ) => {
    const next: InferenceSession.SessionOptions = {
      ...(options ?? {}),
      logSeverityLevel: ORT_LOG_ERROR,
    };
    return originalCreate(uriOrBuffer, next);
  }) as typeof InferenceSession.create;
}

let installed = false;

/**
 * Install once per worker / document before any `from_pretrained` call.
 */
export async function installTransformersChromeFixes(): Promise<void> {
  if (installed) return;
  installed = true;

  // Never probe `/models/…` inside the extension package (404 noise).
  env.allowLocalModels = false;

  // JS-side ORT logger (does not alone silence session C++ warnings).
  const onnxEnv = env.backends?.onnx as { logLevel?: string } | undefined;
  if (onnxEnv) {
    onnxEnv.logLevel = "error";
  }

  // Install console filter first — this is what clears the Chrome Errors badge.
  installOrtConsoleFilter();
  installOrtSessionLogPatch();

  // Extension-packaged WASM/ORT fetches often omit Content-Length.
  const nativeFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const response = await nativeFetch(input, init);
    const url = requestUrl(input);
    if (!isExtensionScheme(url)) return response;
    try {
      return await withContentLength(response);
    } catch {
      return response;
    }
  }) as typeof fetch;

  const cache = await caches.open(CACHE_NAME);

  env.useBrowserCache = false;
  env.useCustomCache = true;
  env.customCache = {
    async match(request: RequestInfo | URL) {
      const url = requestUrl(request);
      // Relative / extension keys are not valid Cache API keys for our use;
      // always fall through to network / package fetch.
      if (!isHttpUrl(url)) return undefined;
      const hit = await cache.match(url);
      if (!hit) return undefined;
      // Cache API strips Content-Length on stored responses — restore it.
      return withContentLength(hit);
    },

    async put(
      request: RequestInfo | URL,
      response: Response,
      _onProgress?: (data: {
        progress: number;
        loaded: number;
        total: number;
      }) => void,
    ) {
      const url = requestUrl(request);
      // Cache API rejects chrome-extension:// (and similar) keys — skip cleanly.
      if (!isHttpUrl(url)) return;
      if (!response || response.status !== 200) return;
      const toStore = await withContentLength(response);
      await cache.put(url, toStore);
    },
  };
}
