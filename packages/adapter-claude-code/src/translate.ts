import type { LoomEvent, ToolAction, Verdict } from "@loom/schema";

/** The subset of Claude Code's hook stdin payload Loom reads. */
export interface HookPayload {
  session_id: string;
  cwd: string;
  hook_event_name: string;
  tool_name?: string;
  tool_input?: Record<string, any>;
  error?: string;
}

function toAction(tool: string, input: Record<string, any>, readFile: (p: string) => string | undefined): ToolAction {
  switch (tool) {
    case "Write":
      return { type: "write", path: input.file_path, before: readFile(input.file_path), after: input.content ?? "" };
    case "Edit":
      return { type: "write", path: input.file_path, before: input.old_string, after: input.new_string ?? "" };
    case "MultiEdit": {
      const edits: { old_string: string; new_string: string }[] = input.edits ?? [];
      return {
        type: "write",
        path: input.file_path,
        before: edits.map((e) => e.old_string).join("\n"),
        after: edits.map((e) => e.new_string).join("\n"),
      };
    }
    case "NotebookEdit":
      return { type: "write", path: input.notebook_path, after: input.new_source ?? "" };
    case "Read":
      return { type: "read", path: input.file_path };
    case "Bash":
      return { type: "shell", command: input.command ?? "" };
    default:
      return { type: "other", tool };
  }
}

/**
 * Claude Code hook payload → unified Loom event. `readFile` supplies the current
 * content of a file a Write is about to replace, so rules can compare before/after.
 */
export function toLoomEvent(
  payload: HookPayload,
  readFile: (p: string) => string | undefined = () => undefined,
  now = new Date(),
): LoomEvent | null {
  const base = { platform: "claude-code" as const, sessionId: payload.session_id, at: now.toISOString() };
  const action = () => toAction(payload.tool_name ?? "", payload.tool_input ?? {}, readFile);
  switch (payload.hook_event_name) {
    case "PreToolUse":
      return { kind: "tool.before", ...base, action: action() };
    case "PostToolUse":
      return { kind: "tool.after", ...base, action: action(), ok: true };
    case "PostToolUseFailure":
      return { kind: "tool.after", ...base, action: action(), ok: false, error: payload.error };
    case "Stop":
      return { kind: "turn.end", ...base };
    default:
      return null;
  }
}

const reasonOf = (verdict: Verdict) =>
  verdict.findings
    .filter((f) => f.level !== "log" && f.level !== "off")
    .map((f) => `[Loom ${f.rule}] ${f.message}`)
    .join("\n");

/**
 * Verdict → what the hook prints on stdout (exit code is always 0).
 * Before a tool runs: block → deny, ask → ask the user, warn → extra context.
 * After it ran nothing can be undone, so every finding becomes context for Claude.
 */
export function toHookOutput(hookEventName: string, verdict: Verdict): string | null {
  const reason = reasonOf(verdict);
  if (!reason) return null;
  if (hookEventName === "PreToolUse" && (verdict.level === "block" || verdict.level === "ask")) {
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName,
        permissionDecision: verdict.level === "block" ? "deny" : "ask",
        permissionDecisionReason: reason,
      },
    });
  }
  if (hookEventName === "Stop") return JSON.stringify({ systemMessage: reason });
  return JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext: reason } });
}
