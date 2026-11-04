import { cleanEnv, execCli, streamJsonResult, streamJsonText } from "@agent-together/core";
import type { AgentRunner, RunResult } from "@agent-together/schema";

/**
 * Claude Code headless: `claude -p --output-format stream-json`, edits auto-accepted
 * inside the folder. The prompt goes in on stdin; the agent's text streams to `onText`.
 */
export function claudeCodeRunner(model?: string): AgentRunner {
  return {
    id: "claude-code",
    async run(cwd, prompt, timeoutMs, options = {}): Promise<RunResult> {
      const args = ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "acceptEdits", ...(model ? ["--model", model] : [])];
      const r = await execCli("claude", args, {
        cwd,
        env: cleanEnv(process.env),
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
        costUsd: j.total_cost_usd,
        inputTokens: (j.usage?.input_tokens ?? 0) + (j.usage?.cache_creation_input_tokens ?? 0) + (j.usage?.cache_read_input_tokens ?? 0),
        outputTokens: j.usage?.output_tokens,
      };
    },
  };
}
