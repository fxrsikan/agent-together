import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";

// Workspace packages are bundled into main (they are ESM, main is CJS); everything else stays external.
const bundled = ["@loom/core", "@loom/schema", "@loom/adapter-claude-code", "@loom/adapter-codex", "@loom/adapter-cursor"];

export default defineConfig({
  main: { build: { externalizeDeps: { exclude: bundled } } },
  preload: { build: { externalizeDeps: { exclude: bundled } } },
  renderer: { plugins: [react()] },
});
