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

/** Optional live view of a run: what the agent says as it works, and a way to stop it. */
export interface RunOptions {
  /** Called with each piece of the agent's own text, as it arrives (not every CLI streams). */
  onText?: (text: string) => void;
  /** Aborting kills the agent process; the run then reports ok: false. */
  signal?: AbortSignal;
}

/** Runs one agent non-interactively in a folder until it finishes its turn. */
export interface AgentRunner {
  /** Contestant name, e.g. "claude-code" or "codex". */
  id: string;
  run(cwd: string, prompt: string, timeoutMs: number, options?: RunOptions): Promise<RunResult>;
}
