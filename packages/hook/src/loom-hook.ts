#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installHooks, toHookOutput, toLoomEvent, type HookPayload } from "@loom/adapter-claude-code";
import { exitCodeFromTranscript, installCodexHooks, toCodexOutput, toLoomEvents, type CodexHookPayload } from "@loom/adapter-codex";
import {
  cursorCwd,
  installCursorHooks,
  parseHookInput,
  toCursorEvents,
  toCursorOutput,
  type CursorHookPayload,
} from "@loom/adapter-cursor";
import { LoomStore } from "@loom/core";
import { strongest, type LoomEvent, type Verdict } from "@loom/schema";

type Platform = "claude-code" | "codex" | "cursor";

interface Adapter {
  parse?(raw: string): any;
  /** Where to look for .loom; default payload.cwd. */
  cwd?(payload: any): string;
  toEvents(payload: any, readFile: (p: string) => string | undefined): LoomEvent[];
  toOutput(hookEventName: string, verdict: Verdict): string | null;
}

const adapters: Record<Platform, Adapter> = {
  "claude-code": {
    toEvents: (p: HookPayload, readFile) => [toLoomEvent(p, readFile)].filter((e): e is LoomEvent => e !== null),
    toOutput: toHookOutput,
  },
  codex: {
    toEvents: (p: CodexHookPayload) => toLoomEvents(p, new Date(), codexExitCode),
    toOutput: toCodexOutput,
  },
  // Cursor blocks a preToolUse whose reply does not parse, so toOutput always answers it, even with no findings.
  cursor: {
    parse: parseHookInput,
    cwd: (p: CursorHookPayload) => cursorCwd(p),
    toEvents: (p: CursorHookPayload, readFile) => toCursorEvents(p, readFile),
    toOutput: toCursorOutput,
  },
};

/** Exit code of a Codex shell call from its transcript, waiting briefly in case the line is not written yet. */
function codexExitCode(p: CodexHookPayload): number | null {
  if (!p.transcript_path || !p.tool_use_id || !fs.existsSync(p.transcript_path)) return null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = exitCodeFromTranscript(fs.readFileSync(p.transcript_path, "utf8"), p.tool_use_id);
    if (code !== null) return code;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  return null;
}

const args = process.argv.slice(2);
const flag = args.indexOf("--platform");
const platform = (flag >= 0 ? args[flag + 1] : "claude-code") as Platform;
const self = fileURLToPath(import.meta.url);

// `loom-hook install [projectDir] [--platform codex]` registers this program with that agent.
if (args[0] === "install") {
  const root = path.resolve(args[1] && !args[1].startsWith("--") ? args[1] : ".");
  const file =
    platform === "codex"
      ? installCodexHooks(root, `node "${self}" --platform codex`)
      : platform === "cursor"
        ? installCursorHooks(root, `node "${self}" --platform cursor`)
        : installHooks(root, `node "${self}"`);
  console.log(`Loom hooks for ${platform} written to ${file}`);
  if (platform === "codex") console.log("Codex runs them only after you trust them: open codex in the project and use /hooks.");
  if (platform === "cursor") console.log("Cursor runs project hooks only in a trusted workspace.");
  process.exit(0);
}

/**
 * Called by the agent for every hooked event. Fails open: if there is no .loom
 * project, no running daemon, or anything goes wrong, it prints nothing and
 * exits 0 so the agent is never stuck because Loom is down.
 * LOOM_HOOK_LOG=<file> appends each raw payload, for building and checking adapters.
 */
async function main() {
  const adapter = adapters[platform];
  if (!adapter) return;
  const raw = fs.readFileSync(0, "utf8");
  const payload = adapter.parse ? adapter.parse(raw) : JSON.parse(raw);
  if (process.env.LOOM_HOOK_LOG) fs.appendFileSync(process.env.LOOM_HOOK_LOG, `${JSON.stringify({ platform, raw: payload })}\n`);
  allow = () => {
    const output = adapter.toOutput(payload.hook_event_name, { level: "off", findings: [] });
    if (output) process.stdout.write(output);
  };
  const store = LoomStore.find(adapter.cwd ? adapter.cwd(payload) : payload.cwd);
  const runtime = store?.readRuntime();
  if (!runtime) return allow();

  const readFile = (p: string) => (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : undefined);
  const findings: Verdict["findings"] = [];
  for (const event of adapter.toEvents(payload, readFile)) {
    const res = await fetch(`http://127.0.0.1:${runtime.port}/event`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) findings.push(...((await res.json()) as Verdict).findings);
  }
  const output = adapter.toOutput(payload.hook_event_name, { level: strongest(findings), findings });
  if (output) process.stdout.write(output);
}

/**
 * The reply when Loom cannot judge: nothing, except where the platform needs an
 * explicit allow. Before the payload is known, Cursor gets a bare allow (it
 * ignores fields an event does not use).
 */
let allow = platform === "cursor" ? () => void process.stdout.write('{"permission":"allow"}') : () => {};

main()
  .catch(() => allow())
  .finally(() => process.exit(0));
