import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const src = (p: string) => fileURLToPath(new URL(`./packages/${p}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@agent-together/schema": src("schema"),
      "@agent-together/core": src("core"),
      "@agent-together/adapter-claude-code": src("adapter-claude-code"),
      "@agent-together/adapter-codex": src("adapter-codex"),
      "@agent-together/adapter-cursor": src("adapter-cursor"),
      "@agent-together/adapter-grok": src("adapter-grok"),
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"],
  },
});
