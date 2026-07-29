# KokoroRead

<p align="center">
  <img src="docs/screenshots/icon.png" width="96" height="96" alt="KokoroRead icon — a heart for 心 (kokoro)" />
</p>

<p align="center">
  <strong>Private, local-first Chrome TTS</strong> for articles and newsletters.<br />
  Powered by <a href="https://www.npmjs.com/package/kokoro-js">Kokoro.js</a> — on-device after the first model cache.
</p>

<p align="center">
  <img src="docs/screenshots/player.png" width="720" alt="Floating player reading a page with highlighted text" />
</p>

**Kokoro** (心) is Japanese for “heart” or “spirit.” The extension keeps your words in the browser: no cloud TTS APIs, no sending page text to a remote speech service.

## Screenshots

| Toolbar popup | Floating player |
| --- | --- |
| <img src="docs/screenshots/popup.png" width="280" alt="KokoroRead settings popup" /> | <img src="docs/screenshots/player-panel.png" width="180" alt="Compact floating player controls" /> |

Demo HTML used for these captures lives in [`docs/demo/`](docs/demo/).

## Features

- **System voices (fast)** — OS/browser `speechSynthesis`, no model download
- **Kokoro neural TTS** — higher-quality on-device voices (auto WebGPU → WASM)
- Floating on-page player: play/pause, skip chunks, rate −/+, **Read all**
- Selection highlight while reading; extract main article / newsletter content
- Voice picker with Kokoro gender markers (🚺 / 🚹) and trait emojis
- Sample preview from the popup; settings in `chrome.storage.local`
- Diagnostics for resolved backend, dtype, and model status
- Offline synthesis after the model is cached in the browser

## Privacy

- **No cloud TTS.** Page text stays inside Chrome extension contexts.
- Network is used only to download Kokoro ONNX assets from Hugging Face (via Transformers.js) on first load.
- Permissions: `activeTab`, `scripting`, `storage`, `offscreen`, `tabs`, plus `<all_urls>` for content extraction.

## Install (unpacked)

```bash
npm install
npm run build
```

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select the `dist/` folder
4. Pin **KokoroRead**, open the popup → **Open player**

> Always load `dist/` after rebuilding. The content script is emitted as a self-contained IIFE (Chrome cannot load ESM imports in content scripts).

### Package a zip

```bash
npm run package
```

Creates `kokororead.zip` from `dist/` for sharing or Chrome Web Store upload.

## Develop

```bash
npm install
npm run dev      # rebuild on change — reload the extension in Chrome after builds
npm run typecheck
npm run lint
```

## Architecture

```
popup (React)     →  settings, voice, open player
service worker    →  orchestration, offscreen lifecycle, tab relay
content script    →  extraction, highlight, floating player UI
offscreen + worker→  Kokoro / system TTS, chunk queue, Web Audio
shared/           →  typed messages, storage, chunking, types
```

Kokoro backend selection is **auto** (WebGPU when available, otherwise WASM). System engine uses the Web Speech API.

## Project layout

```
public/manifest.json     MV3 manifest
public/icons/            Extension icons (心 / heart mark)
src/popup/               React popup
src/background/          Service worker
src/content/             Extraction + floating player
src/offscreen/           TTS engine, synth worker, audio
src/shared/              Messages, storage, utils, chunking
docs/demo/               Static UI demos for screenshots
docs/screenshots/        README images
```

## Manual test checklist

1. Load unpacked `dist/`; popup status leaves “Starting…”; no service-worker errors.
2. On an article: **Open player** → **Read all**; select text and confirm it reads.
3. First Kokoro run downloads the model (progress / diagnostics). Play sample from the popup.
4. Pause / resume / skip / rate controls; highlight tracks the spoken span.
5. Diagnostics show resolved backend (`webgpu` or `wasm`) and dtype.
6. After a successful load, go offline and play again (model from cache).

## Notes & limitations

- Restricted pages (`chrome://`, Chrome Web Store, etc.) cannot be scripted.
- Mail/app DOMs vary; extraction is heuristic.
- First Kokoro download can be roughly 80–300MB depending on dtype.
- Streaming via `tts.stream()` is not wired yet — synthesis is chunked batch today.

## License

Extension code: [MIT](LICENSE).  
Kokoro model / [`kokoro-js`](https://www.npmjs.com/package/kokoro-js): Apache-2.0 (upstream).
