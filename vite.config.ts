/**
 * @file vite.config.ts
 * @description Multi-entry Vite build for the KokoroRead Chrome extension.
 *
 * Entrypoints:
 * - popup.html / offscreen.html (HTML shells at repo root)
 * - background service worker
 * - content script
 *
 * Copies manifest, icons, and ONNX Runtime WASM assets into dist/.
 */

import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(fileURLToPath(import.meta.url));

function extensionStaticAssets(): Plugin {
  return {
    name: "kokororead-extension-assets",
    closeBundle() {
      const dist = resolve(rootDir, "dist");
      mkdirSync(dist, { recursive: true });

      copyFileSync(
        resolve(rootDir, "public/manifest.json"),
        resolve(dist, "manifest.json"),
      );

      const iconsSrc = resolve(rootDir, "public/icons");
      if (existsSync(iconsSrc)) {
        cpSync(iconsSrc, resolve(dist, "icons"), { recursive: true });
      }

      const wasmDest = resolve(dist, "wasm");
      mkdirSync(wasmDest, { recursive: true });
      const candidates = [
        resolve(rootDir, "node_modules/onnxruntime-web/dist"),
        resolve(rootDir, "node_modules/@huggingface/transformers/dist"),
      ];
      for (const dir of candidates) {
        if (!existsSync(dir)) continue;
        for (const file of readdirSync(dir)) {
          if (file.endsWith(".wasm") || /^ort-wasm.*\.(mjs|js)$/.test(file)) {
            copyFileSync(resolve(dir, file), resolve(wasmDest, file));
          }
        }
      }
    },
  };
}

export default defineConfig({
  base: "./",
  plugins: [react(), extensionStaticAssets()],
  publicDir: false,
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
    target: "esnext",
    modulePreload: false,
    chunkSizeWarningLimit: 3000,
    rollupOptions: {
      input: {
        popup: resolve(rootDir, "popup.html"),
        offscreen: resolve(rootDir, "offscreen.html"),
        background: resolve(rootDir, "src/background/service-worker.ts"),
        // content.js is built separately as IIFE (see vite.content.config.ts)
      },
      output: {
        entryFileNames: (chunk) => {
          if (chunk.name === "background") return "background.js";
          return "assets/[name]-[hash].js";
        },
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
  worker: {
    format: "es",
  },
  optimizeDeps: {
    exclude: ["kokoro-js"],
  },
});
