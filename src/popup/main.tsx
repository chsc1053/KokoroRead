/**
 * @file main.tsx
 * @description Popup React entry point for KokoroRead.
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

const root = document.getElementById("root");
if (!root) {
  throw new Error("Popup root element missing");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
