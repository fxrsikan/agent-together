#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installHooks, toHookOutput, toLoomEvent, type HookPayload } from "@loom/adapter-claude-code";
import { LoomStore } from "@loom/core";
import type { Verdict } from "@loom/schema";

// `loom-hook install [projectDir]` registers this program in the project's Claude Code settings.
if (process.argv[2] === "install") {
  const self = fileURLToPath(import.meta.url);
  const file = installHooks(path.resolve(process.argv[3] ?? "."), `node "${self}"`);
  console.log(`Loom hooks written to ${file}`);
  process.exit(0);
}

/**
 * Called by Claude Code for every hooked event. Fails open: if there is no
 * .loom project, no running daemon, or anything goes wrong, it prints nothing
 * and exits 0 so the agent is never stuck because Loom is down.
 */
async function main() {
  const payload: HookPayload = JSON.parse(fs.readFileSync(0, "utf8"));
  const store = LoomStore.find(payload.cwd);
  const runtime = store?.readRuntime();
  if (!runtime) return;

  const readFile = (p: string) => (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : undefined);
  const event = toLoomEvent(payload, readFile);
  if (!event) return;

  const res = await fetch(`http://127.0.0.1:${runtime.port}/event`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(event),
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) return;
  const output = toHookOutput(payload.hook_event_name, (await res.json()) as Verdict);
  if (output) process.stdout.write(output);
}

main().catch(() => {}).finally(() => process.exit(0));
