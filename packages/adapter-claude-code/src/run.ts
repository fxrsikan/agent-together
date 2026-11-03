import { cleanEnv, execCli } from "@loom/core";
import type { AgentRunner, RunResult } from "@loom/schema";

/**
 * Claude Code headless: `claude -p --output-format json`, edits auto-accepted
 * inside the folder. The prompt goes in on stdin.
 */
export function claudeCodeRunner(model?: string): AgentRunner {
  return {
    id: "claude-code",
    async run(cwd, prompt, timeoutMs): Promise<RunResult> {
      const args = ["-p", "--output-format", "json", "--permission-mode", "acceptEdits", ...(model ? ["--model", model] : [])];
      const r = await execCli("claude", args, { cwd, env: cleanEnv(process.env), input: prompt, timeoutMs });
      if (r.timedOut) return { ok: false, summary: `timed out after ${Math.round(timeoutMs / 1000)}s`, durationMs: r.durationMs };
      try {
        const j = JSON.parse(r.stdout);
        return {
          ok: r.code === 0 && !j.is_error,
          summary: String(j.result ?? ""),
          durationMs: r.durationMs,
          costUsd: j.total_cost_usd,
          inputTokens:
            (j.usage?.input_tokens ?? 0) + (j.usage?.cache_creation_input_tokens ?? 0) + (j.usage?.cache_read_input_tokens ?? 0),
          outputTokens: j.usage?.output_tokens,
        };
      } catch {
        return { ok: false, summary: (r.stderr || r.stdout).trim().slice(0, 500), durationMs: r.durationMs };
      }
    },
  };
}
