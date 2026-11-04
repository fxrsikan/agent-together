import { execCli } from "@agent-together/core";
import type { AgentRunner, RunResult } from "@agent-together/schema";

/**
 * Codex headless: `codex exec --json` with a workspace-write sandbox. Agent messages
 * stream to `onText`; the last one and the token usage come from the JSONL events.
 */
export function codexRunner(model?: string): AgentRunner {
  return {
    id: "codex",
    async run(cwd, prompt, timeoutMs, options = {}): Promise<RunResult> {
      const args = ["exec", "--json", "--skip-git-repo-check", "-s", "workspace-write", ...(model ? ["-m", model] : []), "-"];
      const r = await execCli("codex", args, {
        cwd,
        env: process.env,
        input: prompt,
        timeoutMs,
        signal: options.signal,
        onLine: (line) => {
          if (!options.onText) return;
          try {
            const e = JSON.parse(line);
            if (e.type === "item.completed" && e.item?.type === "agent_message" && e.item.text) options.onText(e.item.text);
          } catch {}
        },
      });
      if (r.aborted) return { ok: false, summary: "已停止", durationMs: r.durationMs };
      if (r.timedOut) return { ok: false, summary: `timed out after ${Math.round(timeoutMs / 1000)}s`, durationMs: r.durationMs };
      let summary = "";
      let inputTokens: number | undefined;
      let outputTokens: number | undefined;
      let failed = false;
      for (const line of r.stdout.split("\n")) {
        let e: any;
        try {
          e = JSON.parse(line);
        } catch {
          continue;
        }
        if (e.type === "item.completed" && e.item?.type === "agent_message") summary = e.item.text ?? summary;
        if (e.type === "turn.completed") {
          inputTokens = e.usage?.input_tokens;
          outputTokens = (e.usage?.output_tokens ?? 0) + (e.usage?.reasoning_output_tokens ?? 0);
        }
        if (e.type === "turn.failed" || e.type === "error") {
          failed = true;
          summary = e.error?.message ?? e.message ?? summary;
        }
      }
      return { ok: r.code === 0 && !failed, summary: summary || r.stderr.trim().slice(0, 500), durationMs: r.durationMs, inputTokens, outputTokens };
    },
  };
}
