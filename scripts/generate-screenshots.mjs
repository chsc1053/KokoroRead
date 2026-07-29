#!/usr/bin/env node
/**
 * Regenerate README screenshots from docs/demo/*.html
 *
 * Usage:
 *   npx --yes serve docs/demo -p 8765
 *   # In another terminal, open the demos in a browser and capture:
 *   #   docs/screenshots/popup.png       ← #popup on popup.html
 *   #   docs/screenshots/player.png      ← full page on player.html
 *   #   docs/screenshots/player-panel.png← #player on player.html
 *
 * Or use Cursor's browser tools / Playwright against http://127.0.0.1:8765/
 */
console.log(`KokoroRead screenshot demos:
  docs/demo/popup.html
  docs/demo/player.html

Serve them, then capture into docs/screenshots/:
  npx --yes serve docs/demo -l 8765
`);
