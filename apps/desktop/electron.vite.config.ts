import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";

// Workspace packages are bundled into main (they are ESM, main is CJS); everything else stays external.
const bundled = ["@agent-together/core", "@agent-together/schema", "@agent-together/adapter-claude-code", "@agent-together/adapter-codex", "@agent-together/adapter-cursor"];

export default defineConfig({
  main: { build: { externalizeDeps: { exclude: bundled } } },
  preload: { build: { externalizeDeps: { exclude: bundled } } },
  renderer: { plugins: [react()] },
});
