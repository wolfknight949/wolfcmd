/// <reference types="vitest/config" />
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Tauri loads http://localhost:1420 in dev (crates/wcmd-app/tauri.conf.json): saving a file
// hot-reloads the UI; a Rust change rebuilds and restarts the app (`pnpm dev`).
export default defineConfig({
  plugins: [react(), babel({ presets: [reactCompilerPreset()] }), tailwindcss()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  // WebView2 is evergreen Chromium.
  build: { target: "chrome130", sourcemap: true },
  test: { environment: "jsdom" },
});
