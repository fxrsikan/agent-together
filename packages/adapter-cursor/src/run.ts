import fs from "node:fs";
import path from "node:path";
import { cleanEnv, execCli, streamJsonResult, streamJsonText } from "@agent-together/core";
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
 * On Windows, when SHELL or MSYSTEM is set (anything started from Git Bash),
 * cursor-agent 2026.10 runs hooks under bash yet still prefixes them with
 * PowerShell: every hook fails to start and Cursor blocks every tool. Without
 * them it uses PowerShell. Each one alone is enough to break it.
 */
function cursorEnv(): NodeJS.ProcessEnv {
  const env = cleanEnv(process.env);
  if (process.platform === "win32") {
    delete env.SHELL;
    delete env.MSYSTEM;
  }
  return env;
}

/**
 * Cursor headless: `cursor-agent -p --output-format stream-json`, prompt on stdin,
 * the agent's text streaming to `onText`. File edits apply in print mode; shell
 * commands still need approval, so the agent cannot run them (Agent Together runs
 * the tests itself). `--trust` because a race worktree is a folder Cursor has not
 * seen. Cursor reports tokens, not cost.
 */
export function cursorRunner(model?: string): AgentRunner {
  return {
    id: "cursor",
    async run(cwd, prompt, timeoutMs, options = {}): Promise<RunResult> {
      const args = ["-p", "--trust", "--output-format", "stream-json", ...(model ? ["--model", model] : [])];
      const r = await execCli(cursorAgentCommand(), args, {
        cwd,
        env: cursorEnv(),
        input: prompt,
        timeoutMs,
        signal: options.signal,
        onLine: (line) => {
          const text = options.onText && streamJsonText(line);
          if (text) options.onText!(text);
        },
      });
      if (r.aborted) return { ok: false, summary: "已停止", durationMs: r.durationMs };
      if (r.timedOut) return { ok: false, summary: `timed out after ${Math.round(timeoutMs / 1000)}s`, durationMs: r.durationMs };
      const j = streamJsonResult(r.stdout);
      if (!j) return { ok: false, summary: (r.stderr || r.stdout).trim().slice(0, 500), durationMs: r.durationMs };
      return {
        ok: r.code === 0 && !j.is_error,
        summary: String(j.result ?? ""),
        durationMs: r.durationMs,
        inputTokens: (j.usage?.inputTokens ?? 0) + (j.usage?.cacheReadTokens ?? 0) + (j.usage?.cacheWriteTokens ?? 0),
        outputTokens: j.usage?.outputTokens,
      };
    },
  };
}
