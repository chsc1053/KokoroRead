/**
 * @file backend.ts
 * @description WebGPU / WASM backend detection and dtype defaults.
 *
 * auto  → try WebGPU (fp32), fall back to WASM (q8)
 * webgpu → try WebGPU, fall back to WASM with warning
 * wasm  → WASM only (q8)
 */

import type {
  BackendPreference,
  ModelDtype,
  ResolvedBackend,
} from "../shared/types";

export interface BackendPlan {
  device: "webgpu" | "wasm";
  dtype: ModelDtype;
  requested: BackendPreference;
  /** Non-null when we fell back from the preferred device. */
  fallbackWarning: string | null;
}

/**
 * Detect whether WebGPU is available in this document.
 */
export async function isWebGpuAvailable(): Promise<boolean> {
  try {
    const nav = navigator as Navigator & {
      gpu?: { requestAdapter: () => Promise<unknown> };
    };
    if (!nav.gpu) return false;
    const adapter = await nav.gpu.requestAdapter();
    return Boolean(adapter);
  } catch {
    return false;
  }
}

/**
 * Build an ordered list of backend attempts for the given preference.
 */
export async function planBackends(
  preference: BackendPreference,
  dtypeOverride: ModelDtype | null,
): Promise<BackendPlan[]> {
  const webgpuOk = await isWebGpuAvailable();
  const plans: BackendPlan[] = [];

  const webgpuPlan = (warning: string | null): BackendPlan => ({
    device: "webgpu",
    dtype: dtypeOverride ?? "fp32",
    requested: preference,
    fallbackWarning: warning,
  });

  const wasmPlan = (warning: string | null): BackendPlan => ({
    device: "wasm",
    dtype: dtypeOverride ?? "q8",
    requested: preference,
    fallbackWarning: warning,
  });

  if (preference === "wasm") {
    plans.push(wasmPlan(null));
    return plans;
  }

  if (preference === "webgpu") {
    if (webgpuOk) {
      plans.push(webgpuPlan(null));
      plans.push(
        wasmPlan(
          "WebGPU init failed; fell back to WASM (q8). Performance may be slower.",
        ),
      );
    } else {
      plans.push(
        wasmPlan(
          "WebGPU unavailable; using WASM (q8). Enable WebGPU for better performance.",
        ),
      );
    }
    return plans;
  }

  // auto
  if (webgpuOk) {
    plans.push(webgpuPlan(null));
    plans.push(wasmPlan("WebGPU init failed; automatically fell back to WASM (q8)."));
  } else {
    plans.push(wasmPlan(null));
  }
  return plans;
}

export function toResolvedBackend(device: "webgpu" | "wasm"): ResolvedBackend {
  return device;
}
