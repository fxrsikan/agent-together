/** What one headless agent run reports back. */
export interface RunResult {
  ok: boolean;
  /** The agent's final message (or the error). */
  summary: string;
  durationMs: number;
  /** Reported by the CLI when it knows it (Claude Code does). */
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
}

/** Runs one agent non-interactively in a folder until it finishes its turn. */
export interface AgentRunner {
  /** Contestant name, e.g. "claude-code" or "codex". */
  id: string;
  run(cwd: string, prompt: string, timeoutMs: number): Promise<RunResult>;
}
