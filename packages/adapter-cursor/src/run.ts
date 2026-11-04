import fs from "node:fs";
import path from "node:path";
import { cleanEnv, execCli } from "@agent-together/core";
import type { AgentRunner, RunResult } from "@agent-together/schema";

/**
 * AGENT_TOGETHER_CURSOR_AGENT, else the Windows installer's default location (a process
 * started before the install still has the old PATH), else "cursor-agent".
 */
export function cursorAgentCommand(env: NodeJS.ProcessEnv = process.env): string {
  if (env.AGENT_TOGETHER_CURSOR_AGENT) return env.AGENT_TOGETHER_CURSOR_AGENT;
  if (process.platform === "win32" && env.LOCALAPPDATA) {
    const installed = path.join(env.LOCALAPPDATA, "cursor-agent", "cursor-agent.cmd");
    if (fs.existsSync(installed)) return installed;
  }
  return "cursor-agent";
}

/**
 * Cursor headless: `cursor-agent -p --output-format json`, prompt on stdin.
 * File edits apply in print mode; shell commands still need approval, so the
 * agent cannot run them (Agent Together runs the tests itself). `--trust` because each
 * race worktree is a folder Cursor has not seen. Cursor reports tokens, not cost.
 */
export function cursorRunner(model?: string): AgentRunner {
  return {
    id: "cursor",
    async run(cwd, prompt, timeoutMs): Promise<RunResult> {
      const args = ["-p", "--trust", "--output-format", "json", ...(model ? ["--model", model] : [])];
      const r = await execCli(cursorAgentCommand(), args, { cwd, env: cleanEnv(process.env), input: prompt, timeoutMs });
      if (r.timedOut) return { ok: false, summary: `timed out after ${Math.round(timeoutMs / 1000)}s`, durationMs: r.durationMs };
      try {
        const j = JSON.parse(r.stdout.trim().split("\n").pop() ?? "");
        return {
          ok: r.code === 0 && !j.is_error,
          summary: String(j.result ?? ""),
          durationMs: r.durationMs,
          inputTokens: (j.usage?.inputTokens ?? 0) + (j.usage?.cacheReadTokens ?? 0) + (j.usage?.cacheWriteTokens ?? 0),
          outputTokens: j.usage?.outputTokens,
        };
      } catch {
        return { ok: false, summary: (r.stderr || r.stdout).trim().slice(0, 500), durationMs: r.durationMs };
      }
    },
  };
}
