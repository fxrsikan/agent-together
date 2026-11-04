import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanEnv, execCli } from "@agent-together/core";
import type { AgentRunner, RunResult } from "@agent-together/schema";

/**
 * AGENT_TOGETHER_GROK, else the installer's default location (a process started
 * before the install still has the old PATH), else "grok".
 */
export function grokAgentCommand(env: NodeJS.ProcessEnv = process.env): string {
  if (env.AGENT_TOGETHER_GROK) return env.AGENT_TOGETHER_GROK;
  const home = env.USERPROFILE ?? env.HOME;
  if (home) {
    const installed = path.join(home, ".grok", "bin", process.platform === "win32" ? "grok.exe" : "grok");
    if (fs.existsSync(installed)) return installed;
  }
  return "grok";
}

/**
 * Grok's `--output-format json` result → RunResult (verified against Grok Build 1.0.70).
 * A run that did not end its turn says why: its stopReason and the first line of stderr.
 */
export function parseGrokResult(stdout: string, code: number | null, durationMs: number, stderr = ""): RunResult {
  const j = JSON.parse(stdout.slice(stdout.indexOf("{")));
  const ok = code === 0 && j.stopReason === "end_turn";
  const why = ok ? "" : `\n[grok stopReason: ${j.stopReason}${stderr.trim() ? `; ${stderr.trim().split("\n")[0]}` : ""}]`;
  return {
    ok,
    summary: String(j.text ?? "") + why,
    durationMs,
    costUsd: j.total_cost_usd,
    inputTokens: (j.usage?.input_tokens ?? 0) + (j.usage?.cache_read_input_tokens ?? 0) + (j.usage?.cache_creation_input_tokens ?? 0),
    outputTokens: j.usage?.output_tokens,
  };
}

/**
 * Grok Build headless: `grok --prompt-file <file> --output-format json`, the prompt
 * in a temporary file so no task text goes through shell quoting. `--trust`
 * because each race worktree is a new folder; `--allow Edit --allow Write` lets
 * it edit without asking. The shell and monitor tools are removed: a headless run that reaches
 * a command it may not run is cancelled mid-turn, and Agent Together runs the tests itself.
 */
export function grokRunner(model?: string): AgentRunner {
  return {
    id: "grok-build",
    async run(cwd, prompt, timeoutMs, options = {}): Promise<RunResult> {
      const promptFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agent-together-grok-")), "prompt.md");
      fs.writeFileSync(promptFile, prompt);
      const args = ["--prompt-file", promptFile, "--output-format", "json", "--trust", "--allow", "Edit", "--allow", "Write", "--disallowed-tools", "run_terminal_command,monitor", ...(model ? ["-m", model] : [])];
      try {
        const r = await execCli(grokAgentCommand(), args, { cwd, env: cleanEnv(process.env), input: "", timeoutMs, signal: options.signal });
        if (r.aborted) return { ok: false, summary: "已停止", durationMs: r.durationMs };
        if (r.timedOut) return { ok: false, summary: `timed out after ${Math.round(timeoutMs / 1000)}s`, durationMs: r.durationMs };
        try {
          const result = parseGrokResult(r.stdout, r.code, r.durationMs, r.stderr);
          options.onText?.(result.summary); // Grok's JSON output arrives whole at the end
          return result;
        } catch {
          return { ok: false, summary: (r.stderr || r.stdout).trim().slice(0, 500), durationMs: r.durationMs };
        }
      } finally {
        fs.rmSync(path.dirname(promptFile), { recursive: true, force: true });
      }
    },
  };
}
