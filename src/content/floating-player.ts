/**
 * @file floating-player.ts
 * @description Minimal on-page floating player for KokoroRead.
 *
 * Compact Shadow DOM panel: drag to move, transport, rate −/+, close(=stop).
 * While open, selecting text anywhere on the page jumps playback to that selection.
 * Voice lives in the toolbar popup.
 */

import { sendMessage, type ExtensionMessage } from "../shared/messages";
import type { KokoroSettings, ProgressInfo, VoiceInfo } from "../shared/types";
import { errorMessage } from "../shared/utils";
import { extractArticle, extractSelection } from "./extract";

const HOST_ID = "kokororead-floating-player";
const RATE_MIN = 0.5;
const RATE_MAX = 2;
const RATE_STEP = 0.05;

let host: HTMLElement | null = null;
let shadow: ShadowRoot | null = null;
let settings: KokoroSettings | null = null;
let progress: ProgressInfo | null = null;
let busy = false;

/** Last dragged panel position (viewport coords); null = default bottom-right. */
let panelPos: { left: number; top: number } | null = null;

/** True while the primary mouse button is down (drag-select in progress). */
let mouseSelecting = false;
let keyboardSelectTimer: ReturnType<typeof setTimeout> | null = null;
let lastAutoPlayText = "";
let lastAutoPlayAt = 0;
let selectionListenersAttached = false;

export function isPlayerVisible(): boolean {
  return Boolean(host?.isConnected);
}

export function showFloatingPlayer(init: {
  settings: KokoroSettings;
  voices: VoiceInfo[];
  progress: ProgressInfo;
}): void {
  settings = init.settings;
  progress = init.progress;
  ensureHost();
  render();
  attachSelectionListeners();
}

export function hideFloatingPlayer(): void {
  detachSelectionListeners();
  host?.remove();
  host = null;
  shadow = null;
  // Scrub any orphan hosts left behind by a previous extension incarnation.
  document
    .querySelectorAll(`#${HOST_ID}, [data-kokororead="player"]`)
    .forEach((el) => el.remove());
}

export function syncFloatingPlayer(patch: {
  settings?: KokoroSettings;
  voices?: VoiceInfo[];
  progress?: ProgressInfo;
}): void {
  if (patch.settings) settings = patch.settings;
  if (patch.progress) {
    const prevStatus = progress?.status;
    const prevTotal = progress?.totalChunks;
    progress = patch.progress;
    if (isPlayerVisible() && shadow) {
      // Rebuild when play/pause icon or session bounds change; otherwise patch live UI.
      if (prevStatus !== progress.status || prevTotal !== progress.totalChunks) {
        render();
      } else {
        updateLiveProgress();
      }
      return;
    }
  }
  if (isPlayerVisible()) render();
}

function ensureHost(): void {
  if (host?.isConnected && shadow) return;
  host?.remove();
  host = document.createElement("div");
  host.id = HOST_ID;
  host.setAttribute("data-kokororead", "player");
  shadow = host.attachShadow({ mode: "open" });
  document.documentElement.appendChild(host);
}

function attachSelectionListeners(): void {
  if (selectionListenersAttached) return;
  selectionListenersAttached = true;
  document.addEventListener("mousedown", onMouseDown, true);
  document.addEventListener("mouseup", onMouseUp, true);
  document.addEventListener("dblclick", onDoubleClick, true);
  document.addEventListener("selectionchange", onSelectionChange);
}

function detachSelectionListeners(): void {
  if (!selectionListenersAttached) return;
  selectionListenersAttached = false;
  document.removeEventListener("mousedown", onMouseDown, true);
  document.removeEventListener("mouseup", onMouseUp, true);
  document.removeEventListener("dblclick", onDoubleClick, true);
  document.removeEventListener("selectionchange", onSelectionChange);
  if (keyboardSelectTimer !== null) {
    clearTimeout(keyboardSelectTimer);
    keyboardSelectTimer = null;
  }
  mouseSelecting = false;
}

function onMouseDown(event: MouseEvent): void {
  if (!isPlayerVisible()) return;
  if (event.button !== 0) return;
  if (isEventInsidePlayer(event.target)) return;
  mouseSelecting = true;
}

function onMouseUp(event: MouseEvent): void {
  if (!isPlayerVisible()) return;
  if (event.button !== 0) return;
  const wasSelecting = mouseSelecting;
  mouseSelecting = false;
  if (!wasSelecting) return;
  if (isEventInsidePlayer(event.target)) return;
  // Let the browser finalize the selection, then act.
  window.requestAnimationFrame(() => {
    void playCurrentSelection();
  });
}

/** Double-click word select — selection is often finalized after the second mouseup. */
function onDoubleClick(event: MouseEvent): void {
  if (!isPlayerVisible()) return;
  if (isEventInsidePlayer(event.target)) return;
  window.requestAnimationFrame(() => {
    void playCurrentSelection();
  });
}

function onSelectionChange(): void {
  if (!isPlayerVisible()) return;
  // Mouse drag is handled on mouseup so we don't fire mid-drag.
  if (mouseSelecting) return;
  if (keyboardSelectTimer !== null) clearTimeout(keyboardSelectTimer);
  keyboardSelectTimer = setTimeout(() => {
    keyboardSelectTimer = null;
    void playCurrentSelection();
  }, 350);
}

function isEventInsidePlayer(target: EventTarget | null): boolean {
  if (!host || !(target instanceof Node)) return false;
  return host === target || host.contains(target);
}

function selectionIsInsidePlayer(): boolean {
  if (!host) return false;
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return false;
  const node = sel.anchorNode;
  if (!node) return false;
  return host === node || host.contains(node);
}

/**
 * If the page has a real (non-collapsed) text selection, jump playback there.
 * Clicks that don't create a selection are ignored.
 */
async function playCurrentSelection(): Promise<void> {
  if (!isPlayerVisible() || busy) return;

  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
  if (selectionIsInsidePlayer()) return;

  // Prefer mapped extraction (for highlighting); fall back to raw string
  // so a single-word selection still plays even if mapping fails.
  let selected = extractSelection();
  if (!selected || !selected.text) {
    const raw = (sel.toString() ?? "").replace(/\s+/g, " ").trim();
    if (!raw) return;
    selected = {
      text: raw,
      title: document.title || "Selection",
      source: "selection",
      url: location.href,
      charCount: raw.length,
    };
  }

  // Ignore duplicate fires for the same selection within a short window.
  const now = Date.now();
  if (selected.text === lastAutoPlayText && now - lastAutoPlayAt < 600) return;
  lastAutoPlayText = selected.text;
  lastAutoPlayAt = now;

  await runAction(async () => {
    await sendMessage({
      type: "READ_TEXT",
      text: selected!.text,
      title: selected!.title,
      settings: settings ?? undefined,
    });
  });
}

function render(): void {
  if (!shadow || !settings || !progress) return;

  const total = progress.totalChunks;
  const playChunk = progress.playChunk ?? progress.currentChunk ?? 0;
  const playPct = computePlayPct(progress);
  const synthPct = computeSynthPct(progress);
  const isPaused = progress.status === "paused";
  const isPlaying =
    progress.status === "playing" || progress.status === "synthesizing";
  const canTogglePause = isPlaying || isPaused;
  const playPauseLabel = isPlaying ? "Pause" : "Play";
  const playPauseIcon = isPlaying ? pauseIconSvg() : playIconSvg();

  shadow.innerHTML = `
    <style>${playerCss()}</style>
    <div class="panel" role="dialog" aria-label="KokoroRead player">
      <button type="button" class="icon-btn close" data-action="close" title="Close and stop" aria-label="Close and stop">×</button>

      <div class="transport">
        <div class="transport-row">
          <button
            type="button"
            class="skip"
            data-action="skip-back"
            title="Previous chunk"
            aria-label="Previous chunk"
            ${!canTogglePause || busy || playChunk <= 0 ? "disabled" : ""}
          >${prevIconSvg()}</button>
          <div class="play-wrap">
            ${circularProgressSvg(playPct, synthPct)}
            <button
              type="button"
              class="play-pause"
              data-action="pause-toggle"
              title="${playPauseLabel}"
              aria-label="${playPauseLabel}"
              ${!canTogglePause || busy ? "disabled" : ""}
            >${playPauseIcon}</button>
          </div>
          <button
            type="button"
            class="skip"
            data-action="skip-forward"
            title="Next chunk"
            aria-label="Next chunk"
            ${!canTogglePause || busy || (total > 0 && playChunk >= total - 1) ? "disabled" : ""}
          >${nextIconSvg()}</button>
        </div>
        <p class="status-msg">${escapeHtml(progress.message || "Ready")}</p>
      </div>

      <div class="footer">
        <button type="button" class="full-page" data-action="read-article" title="Extract and read the full article" ${busy ? "disabled" : ""}>Read all</button>
        <div class="rate" title="Speaking rate">
          <button
            type="button"
            class="rate-btn"
            data-action="rate-down"
            aria-label="Slower"
            ${busy || settings.rate <= RATE_MIN ? "disabled" : ""}
          >−</button>
          <span class="rate-value" data-rate-label>${settings.rate.toFixed(2)}×</span>
          <button
            type="button"
            class="rate-btn"
            data-action="rate-up"
            aria-label="Faster"
            ${busy || settings.rate >= RATE_MAX ? "disabled" : ""}
          >+</button>
        </div>
      </div>

      <div class="error" data-error hidden></div>
    </div>
  `;

  applyPanelPosition();
  wireEvents();
}

function computePlayPct(info: ProgressInfo): number {
  if (typeof info.readProgress === "number" && Number.isFinite(info.readProgress)) {
    return Math.round(Math.min(100, Math.max(0, info.readProgress * 100)));
  }
  const total = info.totalChunks;
  const playChunk = info.playChunk ?? info.currentChunk ?? 0;
  if (total > 0) {
    return Math.round(
      ((playChunk + (info.status === "playing" ? 0.35 : 0)) / total) * 100,
    );
  }
  return 0;
}

/** Synthesis / buffer progress 0–100 (sits behind playback on the ring). */
function computeSynthPct(info: ProgressInfo): number {
  if (info.status === "loading_model") {
    return Math.round((info.modelLoadProgress ?? 0) * 100);
  }
  const total = info.totalChunks;
  if (total <= 0) {
    if (typeof info.readProgress === "number" && info.readProgress >= 1) return 100;
    return 0;
  }
  const synthChunk = info.synthChunk ?? 0;
  // Mid-chunk credit while actively synthesizing; completed through synthChunk otherwise.
  const waiting =
    typeof info.synthMessage === "string" &&
    /waiting for playback/i.test(info.synthMessage);
  const partial = info.synthesizing && !waiting ? 0.45 : 1;
  const filled = Math.min(total, synthChunk + partial);
  return Math.round((filled / total) * 100);
}

function setRingOffset(ring: SVGCircleElement | null, pct: number): void {
  if (!ring) return;
  const circumference = Number(ring.dataset.circumference ?? "0");
  ring.style.strokeDashoffset = String(
    circumference * (1 - Math.min(100, Math.max(0, pct)) / 100),
  );
}

/** Patch ring + status text without rebuilding the whole player. */
function updateLiveProgress(): void {
  if (!shadow || !progress) return;
  setRingOffset(
    shadow.querySelector<SVGCircleElement>(".ring-synth"),
    computeSynthPct(progress),
  );
  setRingOffset(
    shadow.querySelector<SVGCircleElement>(".ring-progress"),
    computePlayPct(progress),
  );
  const msg = shadow.querySelector(".status-msg");
  if (msg) msg.textContent = progress.message || "Ready";

  const total = progress.totalChunks;
  const playChunk = progress.playChunk ?? progress.currentChunk ?? 0;
  const isPlaying =
    progress.status === "playing" || progress.status === "synthesizing";
  const isPaused = progress.status === "paused";
  const canToggle = isPlaying || isPaused;

  const back = shadow.querySelector<HTMLButtonElement>('[data-action="skip-back"]');
  const forward = shadow.querySelector<HTMLButtonElement>('[data-action="skip-forward"]');
  const toggle = shadow.querySelector<HTMLButtonElement>('[data-action="pause-toggle"]');
  if (back) back.disabled = !canToggle || busy || playChunk <= 0;
  if (forward) {
    forward.disabled = !canToggle || busy || (total > 0 && playChunk >= total - 1);
  }
  if (toggle) {
    toggle.disabled = !canToggle || busy;
    toggle.title = isPlaying ? "Pause" : "Play";
    toggle.setAttribute("aria-label", isPlaying ? "Pause" : "Play");
    toggle.innerHTML = isPlaying ? pauseIconSvg() : playIconSvg();
  }
  syncRateControls();
}

function syncRateControls(): void {
  if (!shadow || !settings) return;
  const rate = settings.rate;
  const label = shadow.querySelector("[data-rate-label]");
  if (label) label.textContent = `${rate.toFixed(2)}×`;
  const down = shadow.querySelector<HTMLButtonElement>('[data-action="rate-down"]');
  const up = shadow.querySelector<HTMLButtonElement>('[data-action="rate-up"]');
  if (down) down.disabled = busy || rate <= RATE_MIN;
  if (up) up.disabled = busy || rate >= RATE_MAX;
}

function clampRate(value: number): number {
  const stepped = Math.round(value / RATE_STEP) * RATE_STEP;
  return Math.min(RATE_MAX, Math.max(RATE_MIN, Number(stepped.toFixed(2))));
}

function applyPanelPosition(): void {
  const panel = shadow?.querySelector<HTMLElement>(".panel");
  if (!panel) return;
  if (!panelPos) {
    panel.style.left = "";
    panel.style.top = "";
    panel.style.right = "";
    panel.style.bottom = "";
    return;
  }
  panel.style.right = "auto";
  panel.style.bottom = "auto";
  panel.style.left = `${panelPos.left}px`;
  panel.style.top = `${panelPos.top}px`;
}

function wireDrag(panel: HTMLElement): void {
  let dragging = false;
  let startX = 0;
  let startY = 0;
  let originLeft = 0;
  let originTop = 0;

  const onMove = (event: PointerEvent) => {
    if (!dragging) return;
    const dx = event.clientX - startX;
    const dy = event.clientY - startY;
    const nextLeft = originLeft + dx;
    const nextTop = originTop + dy;
    const maxLeft = Math.max(0, window.innerWidth - panel.offsetWidth);
    const maxTop = Math.max(0, window.innerHeight - panel.offsetHeight);
    panelPos = {
      left: Math.min(maxLeft, Math.max(0, nextLeft)),
      top: Math.min(maxTop, Math.max(0, nextTop)),
    };
    applyPanelPosition();
  };

  const onUp = (event: PointerEvent) => {
    if (!dragging) return;
    dragging = false;
    panel.classList.remove("dragging");
    try {
      panel.releasePointerCapture(event.pointerId);
    } catch {
      // ignore
    }
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
  };

  panel.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest("button, input, a, textarea, select, [data-no-drag]")) return;

    const rect = panel.getBoundingClientRect();
    dragging = true;
    panel.classList.add("dragging");
    startX = event.clientX;
    startY = event.clientY;
    originLeft = rect.left;
    originTop = rect.top;
    panelPos = { left: originLeft, top: originTop };
    applyPanelPosition();
    panel.setPointerCapture(event.pointerId);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    event.preventDefault();
  });
}

function wireEvents(): void {
  if (!shadow) return;

  const panel = shadow.querySelector<HTMLElement>(".panel");
  if (panel) wireDrag(panel);

  shadow.querySelector('[data-action="close"]')?.addEventListener("click", () => {
    void closeAndStop();
  });

  shadow.querySelector('[data-action="read-article"]')?.addEventListener("click", () => {
    void runAction(async () => {
      const article = extractArticle();
      if (!article.text) throw new Error("Could not extract readable content");
      await sendMessage({
        type: "READ_TEXT",
        text: article.text,
        title: article.title,
        settings: settings ?? undefined,
      });
    });
  });

  shadow.querySelector('[data-action="pause-toggle"]')?.addEventListener("click", () => {
    void runAction(async () => {
      if (progress?.status === "paused") {
        await sendMessage({ type: "RESUME" });
      } else {
        await sendMessage({ type: "PAUSE" });
      }
    });
  });

  shadow.querySelector('[data-action="skip-back"]')?.addEventListener("click", () => {
    void runAction(async () => {
      await sendMessage({ type: "SKIP_BACK" });
    });
  });

  shadow.querySelector('[data-action="skip-forward"]')?.addEventListener("click", () => {
    void runAction(async () => {
      await sendMessage({ type: "SKIP_FORWARD" });
    });
  });

  shadow.querySelector('[data-action="rate-down"]')?.addEventListener("click", () => {
    void nudgeRate(-RATE_STEP);
  });

  shadow.querySelector('[data-action="rate-up"]')?.addEventListener("click", () => {
    void nudgeRate(RATE_STEP);
  });
}

async function nudgeRate(delta: number): Promise<void> {
  if (!settings || busy) return;
  const next = clampRate(settings.rate + delta);
  if (next === settings.rate) {
    syncRateControls();
    return;
  }
  settings = { ...settings, rate: next };
  syncRateControls();
  await persist({ rate: next });
  syncRateControls();
}

async function persist(patch: Partial<KokoroSettings>): Promise<void> {
  try {
    const reply = await sendMessage<Extract<ExtensionMessage, { type: "SETTINGS_UPDATED" }>>({
      type: "SAVE_SETTINGS",
      settings: patch,
    });
    settings = reply.settings;
  } catch (err) {
    showError(errorMessage(err));
  }
}

async function closeAndStop(): Promise<void> {
  try {
    await sendMessage({ type: "CLOSE_PLAYER" });
  } catch {
    // Still hide locally if messaging fails.
  }
  hideFloatingPlayer();
}

async function runAction(fn: () => Promise<void>): Promise<void> {
  if (busy) return;
  busy = true;
  showError(null);
  render();
  try {
    await fn();
  } catch (err) {
    showError(errorMessage(err));
  } finally {
    busy = false;
    render();
  }
}

function showError(message: string | null): void {
  const el = shadow?.querySelector<HTMLElement>("[data-error]");
  if (!el) return;
  if (!message) {
    el.hidden = true;
    el.textContent = "";
    return;
  }
  el.hidden = false;
  el.textContent = message;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function playIconSvg(): string {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l11-6.5L8 5.5z"/></svg>`;
}

function pauseIconSvg(): string {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h3.5v14H7V5zm6.5 0H17v14h-3.5V5z"/></svg>`;
}

function prevIconSvg(): string {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6h2.2v12H6V6zm3.3 6 8.7 6.2V5.8L9.3 12z"/></svg>`;
}

function nextIconSvg(): string {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15.8 6H18v12h-2.2V6zM6 18.2 14.7 12 6 5.8v12.4z"/></svg>`;
}

/** Soft dual glow arcs hugging the play button. Percents are 0–100. */
function circularProgressSvg(playPct: number, synthPct: number): string {
  // Button is 46px; ring sits on its rim with room for blur bloom.
  const size = 64;
  const radius = 23; // ~play-pause radius so glow reads as attached
  const circumference = 2 * Math.PI * radius;
  const clampPct = (pct: number) => Math.min(100, Math.max(0, pct));
  const offsetFor = (pct: number) =>
    circumference * (1 - clampPct(pct) / 100);
  const c = size / 2;
  const dash = `stroke-dasharray:${circumference}`;
  return `
<svg class="ring" viewBox="0 0 ${size} ${size}" aria-hidden="true">
  <defs>
    <filter id="glow-soft" x="-40%" y="-40%" width="180%" height="180%">
      <feGaussianBlur in="SourceGraphic" stdDeviation="2.4" result="blur" />
      <feMerge>
        <feMergeNode in="blur" />
        <feMergeNode in="blur" />
        <feMergeNode in="SourceGraphic" />
      </feMerge>
    </filter>
    <filter id="glow-core" x="-35%" y="-35%" width="170%" height="170%">
      <feGaussianBlur in="SourceGraphic" stdDeviation="1.35" result="blur" />
      <feMerge>
        <feMergeNode in="blur" />
        <feMergeNode in="SourceGraphic" />
      </feMerge>
    </filter>
  </defs>
  <circle class="ring-track" cx="${c}" cy="${c}" r="${radius}" filter="url(#glow-soft)" />
  <circle
    class="ring-synth"
    cx="${c}" cy="${c}" r="${radius}"
    data-circumference="${circumference}"
    filter="url(#glow-soft)"
    style="${dash};stroke-dashoffset:${offsetFor(synthPct)}"
  />
  <circle
    class="ring-progress"
    cx="${c}" cy="${c}" r="${radius}"
    data-circumference="${circumference}"
    filter="url(#glow-core)"
    style="${dash};stroke-dashoffset:${offsetFor(playPct)}"
  />
</svg>`;
}

function playerCss(): string {
  return `
:host { all: initial; }
.panel {
  position: fixed;
  right: 16px;
  bottom: 16px;
  z-index: 2147483646;
  width: min(168px, calc(100vw - 24px));
  padding: 8px 10px 10px;
  border-radius: 12px;
  border: 1px solid #d9d2c5;
  background: linear-gradient(160deg, #f7f2e8, #efe7d8);
  color: #1c1914;
  font: 12px/1.35 "Avenir Next", "Segoe UI", system-ui, sans-serif;
  box-shadow: 0 10px 30px rgba(28, 25, 20, 0.18);
  cursor: grab;
  user-select: none;
  touch-action: none;
}
.panel.dragging { cursor: grabbing; }
.icon-btn {
  border: none;
  background: transparent;
  color: #5c564c;
  font-size: 16px;
  line-height: 1;
  width: 24px;
  height: 24px;
  border-radius: 6px;
  cursor: pointer;
}
.icon-btn.close {
  position: absolute;
  top: 4px;
  right: 4px;
  z-index: 2;
}
.icon-btn:hover { background: rgba(0,0,0,0.06); color: #8b2e2e; }
.transport {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  margin: 4px 0 8px;
}
.transport-row {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
}
.status-msg {
  margin: 0;
  color: #5c564c;
  font-size: 10px;
  text-align: center;
  line-height: 1.3;
  min-height: 1.3em;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.play-wrap {
  position: relative;
  width: 64px;
  height: 64px;
  display: grid;
  place-items: center;
}
.ring {
  position: absolute;
  inset: 0;
  width: 64px;
  height: 64px;
  transform: rotate(-90deg);
  pointer-events: none;
  overflow: visible;
}
.ring-track,
.ring-synth,
.ring-progress {
  fill: none;
  stroke-linecap: round;
}
.ring-track {
  stroke: rgba(180, 83, 9, 0.14);
  stroke-width: 5.5;
}
.ring-synth {
  stroke: rgba(232, 184, 109, 0.9);
  stroke-width: 6;
  transition: stroke-dashoffset 160ms linear;
}
.ring-progress {
  stroke: rgba(180, 83, 9, 0.95);
  stroke-width: 4.5;
  transition: stroke-dashoffset 120ms linear;
}
.play-pause {
  position: relative;
  z-index: 1;
  width: 46px;
  height: 46px;
  border-radius: 50%;
  border: 1px solid color-mix(in srgb, #b45309 35%, #fff8eb);
  background: linear-gradient(180deg, #d97706, #b45309);
  color: #fffaf0;
  display: grid;
  place-items: center;
  padding: 0;
  cursor: pointer;
  box-shadow:
    0 1px 0 rgba(255, 250, 240, 0.22) inset,
    0 4px 14px rgba(180, 83, 9, 0.22);
}
.play-pause svg {
  width: 20px;
  height: 20px;
  fill: currentColor;
  display: block;
  pointer-events: none;
}
.play-pause:hover:not(:disabled) { filter: brightness(1.05); }
.play-pause:disabled { opacity: 0.45; cursor: not-allowed; box-shadow: none; }
.skip {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  border: 1px solid #d9d2c5;
  background: #fffdf8;
  color: #1c1914;
  display: grid;
  place-items: center;
  padding: 0;
  cursor: pointer;
}
.skip svg {
  width: 14px;
  height: 14px;
  fill: currentColor;
  display: block;
  pointer-events: none;
}
.skip:hover:not(:disabled) { background: #f5efe3; }
.skip:disabled { opacity: 0.4; cursor: not-allowed; }
.footer {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
}
.full-page {
  border: 1px solid #d9d2c5;
  background: #fffdf8;
  color: #1c1914;
  border-radius: 7px;
  padding: 5px 8px;
  font: inherit;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  flex: none;
  width: auto;
  white-space: nowrap;
}
.full-page:hover:not(:disabled) { filter: brightness(1.02); }
.full-page:disabled { opacity: 0.55; cursor: not-allowed; }
.rate {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  flex: none;
  border: 1px solid #d9d2c5;
  border-radius: 7px;
  background: #fffdf8;
  padding: 1px;
}
.rate-btn {
  width: 22px;
  height: 22px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: #1c1914;
  font: inherit;
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
  padding: 0;
}
.rate-btn:hover:not(:disabled) { background: #f5efe3; }
.rate-btn:disabled { opacity: 0.35; cursor: not-allowed; }
.rate-value {
  min-width: 2.6em;
  text-align: center;
  font-size: 10px;
  color: #5c564c;
  font-variant-numeric: tabular-nums;
}
.error {
  margin-top: 6px;
  border: 1px solid color-mix(in srgb, #8b2e2e 35%, #d9d2c5);
  background: #fff5f3;
  color: #8b2e2e;
  border-radius: 8px;
  padding: 5px 7px;
  font-size: 10px;
}
`;
}
