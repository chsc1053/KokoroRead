/**
 * @file vite.content.config.ts
 * @description Separate IIFE build for the content script.
 *
 * Chrome content scripts (and scripting.executeScript files) are classic
 * scripts — they cannot use ESM `import`. The main Vite build code-splits
 * shared helpers into ./assets/*.js, which breaks content.js at runtime
 * ("Receiving end does not exist"). This config emits a single self-contained
 * content.js into dist/ after the main build.
 */

import { defineConfig } from "vite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  publicDir: false,
  build: {
    outDir: "dist",
    emptyOutDir: false,
    sourcemap: true,
    target: "esnext",
    minify: true,
    rollupOptions: {
      input: resolve(rootDir, "src/content/content-script.ts"),
      output: {
        format: "iife",
        name: "KokoroReadContent",
        entryFileNames: "content.js",
        inlineDynamicImports: true,
      },
    },
  },
});
