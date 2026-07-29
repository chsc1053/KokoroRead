/**
 * @file docs/MILESTONES.md
 * @description Build milestones for KokoroRead (reference for contributors).
 */

# KokoroRead milestones

## Milestone 1 — Scaffold & messaging

- Vite + React + TypeScript MV3 project
- Popup shell, service worker, offscreen HTML, typed messages
- `ENSURE_OFFSCREEN` / `PING` / `PONG` plumbing

## Milestone 2 — Extraction & settings

- Content script selection + article/newsletter extraction
- `chrome.storage.local` settings load/save
- Popup voice/rate/backend controls persist

## Milestone 3 — Kokoro.js

- Offscreen `KokoroTTS.from_pretrained`
- Backend auto / webgpu / wasm with dtype defaults
- Voice listing + sample synthesis

## Milestone 4 — Chunked reading

- Paragraph/segment chunking
- Synthesis queue + Web Audio playback
- Pause / resume / stop + progress events

## Milestone 5 — Polish

- Diagnostics panel
- README, packaging script, WASM asset copy
- Reinjection guards, relative asset paths, CSP for wasm
