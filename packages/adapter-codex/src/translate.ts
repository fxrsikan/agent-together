import path from "node:path";
import type { LoomEvent, ToolAction, Verdict } from "@loom/schema";
import { parsePatch } from "./patch.js";

/** The subset of Codex's hook stdin payload Loom reads. */
export interface CodexHookPayload {
  session_id: string;
  cwd: string;
  hook_event_name: string;
  transcript_path?: string;
  tool_name?: string;
  tool_use_id?: string;
  tool_input?: Record<string, any>;
  tool_response?: unknown;
}

/**
 * Finds a command's exit code in a Codex transcript (rollout JSONL): the
 * CommandExecution item whose id is the hook's tool_use_id. Null when absent.
 */
export function exitCodeFromTranscript(transcript: string, toolUseId: string): number | null {
  const lines = transcript.trimEnd().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes(toolUseId)) continue;
    try {
      const item = JSON.parse(lines[i]).payload?.item;
      if (item?.type === "CommandExecution" && item.id === toolUseId && typeof item.exit_code === "number") return item.exit_code;
    } catch {}
  }
  return null;
}

/** Best effort: Codex reports a shell result without a separate failure event. */
function shellFailed(response: unknown): { failed: boolean; error?: string } {
  if (response && typeof response === "object") {
    const r = response as Record<string, unknown>;
    const code = r.exit_code ?? r.exitCode ?? r.status;
    if (typeof code === "number") return { failed: code !== 0, error: code !== 0 ? `exit ${code}` : undefined };
    if (r.success === false || r.is_error === true) return { failed: true, error: String(r.error ?? r.stderr ?? "failed") };
  }
  if (typeof response === "string") {
    const m = /exit(?:ed with)? code:?\s*(-?\d+)/i.exec(response);
    if (m) return { failed: m[1] !== "0", error: m[1] !== "0" ? `exit ${m[1]}` : undefined };
  }
  return { failed: false };
}

function toActions(payload: CodexHookPayload): ToolAction[] {
  const tool = payload.tool_name ?? "";
  const input = payload.tool_input ?? {};
  if (tool === "apply_patch") {
    // One patch may touch several files: each becomes its own write.
    return parsePatch(String(input.command ?? input.patch ?? "")).flatMap((f) => {
      const abs = (p: string) => path.resolve(payload.cwd, p);
      const write: ToolAction = { type: "write", path: abs(f.path), before: f.op === "add" ? undefined : f.before, after: f.after };
      return f.moveTo ? [write, { type: "write", path: abs(f.moveTo), after: f.after } as ToolAction] : [write];
    });
  }
  if (tool === "Bash" || tool === "shell" || tool === "local_shell") {
    const command = Array.isArray(input.command) ? input.command.join(" ") : String(input.command ?? "");
    return [{ type: "shell", command }];
  }
  return [{ type: "other", tool }];
}

/**
 * Codex hook payload → unified Loom events (several for a multi-file patch).
 * Codex's Bash tool_response is only the command's output, so `exitCode` lets
 * the caller look the exit code up elsewhere (the transcript) when needed.
 */
export function toLoomEvents(
  payload: CodexHookPayload,
  now = new Date(),
  exitCode: (payload: CodexHookPayload) => number | null = () => null,
): LoomEvent[] {
  const base = { platform: "codex" as const, sessionId: payload.session_id, at: now.toISOString() };
  switch (payload.hook_event_name) {
    case "PreToolUse":
      return toActions(payload).map((action) => ({ kind: "tool.before" as const, ...base, action }));
    case "PostToolUse": {
      const code = payload.tool_name === "Bash" ? exitCode(payload) : null;
      const { failed, error } =
        code === null ? shellFailed(payload.tool_response) : { failed: code !== 0, error: code !== 0 ? `exit ${code}` : undefined };
      return toActions(payload).map((action) => ({ kind: "tool.after" as const, ...base, action, ok: !failed, error }));
    }
    case "Stop":
      return [{ kind: "turn.end", ...base }];
    default:
      return [];
  }
}

const reasonOf = (verdict: Verdict) =>
  verdict.findings
    .filter((f) => f.level !== "log" && f.level !== "off")
    .map((f) => `[Loom ${f.rule}] ${f.message}`)
    .join("\n");

/**
 * Verdict → Codex hook stdout. Codex cannot ask the user from a hook yet, so
 * "ask" becomes a deny whose reason tells the agent to get the user's decision.
 * After a tool ran, findings become extra context. Stop prints nothing (a Stop
 * "block" would make Codex keep going).
 */
export function toCodexOutput(hookEventName: string, verdict: Verdict): string | null {
  const reason = reasonOf(verdict);
  if (!reason || hookEventName === "Stop") return null;
  if (hookEventName === "PreToolUse" && (verdict.level === "block" || verdict.level === "ask")) {
    const prefix = verdict.level === "ask" ? "Loom needs the user's decision before this runs. Ask the user, do not work around it.\n" : "";
    return JSON.stringify({
      hookSpecificOutput: { hookEventName, permissionDecision: "deny", permissionDecisionReason: prefix + reason },
    });
  }
  return JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext: reason } });
}
