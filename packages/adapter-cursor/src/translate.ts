import type { LoomEvent, ToolAction, Verdict } from "@loom/schema";
import { asciiJson } from "./encoding.js";

/** The subset of Cursor's hook stdin payload Loom reads (verified against Cursor 3.19 on Windows). */
export interface CursorHookPayload {
  conversation_id: string;
  hook_event_name: string;
  /** Posix-style even on Windows: "/d:/AI/project". */
  workspace_roots?: string[];
  cwd?: string;
  tool_name?: string;
  tool_input?: Record<string, any>;
  /** A JSON string, e.g. {"output":"…","exitCode":0} for Shell. */
  tool_output?: string;
  error_message?: string;
}

/** "/d:/AI/project" → "d:/AI/project"; posix roots stay as they are. */
const fromCursorPath = (p: string) => (/^\/[a-zA-Z]:/.test(p) ? p.slice(1) : p);

/** The folder to look for .loom from: the tool's cwd, else the first workspace root. */
export function cursorCwd(payload: CursorHookPayload): string {
  const root = payload.workspace_roots?.[0];
  return payload.tool_input?.cwd ?? payload.cwd ?? (root ? fromCursorPath(root) : process.cwd());
}

function toAction(payload: CursorHookPayload, readFile: (p: string) => string | undefined): ToolAction {
  const tool = payload.tool_name ?? "";
  const input = payload.tool_input ?? {};
  switch (tool) {
    // Cursor reports in-place edits as Write too, with the whole new file.
    case "Write":
      return { type: "write", path: input.file_path, before: readFile(input.file_path), after: String(input.content ?? "") };
    case "Delete":
      return { type: "write", path: input.file_path, before: readFile(input.file_path), after: "" };
    case "Read":
      return { type: "read", path: input.file_path };
    case "Shell":
      return { type: "shell", command: String(input.command ?? "") };
    default:
      return { type: "other", tool };
  }
}

function shellResult(output: string | undefined): { ok: boolean; error?: string } {
  try {
    const code = JSON.parse(output ?? "{}").exitCode;
    if (typeof code === "number" && code !== 0) return { ok: false, error: `exit ${code}` };
  } catch {}
  return { ok: true };
}

/**
 * Cursor hook payload → unified Loom events. `readFile` supplies a file's
 * current content, the "before" of a write.
 */
export function toCursorEvents(
  payload: CursorHookPayload,
  readFile: (p: string) => string | undefined = () => undefined,
  now = new Date(),
): LoomEvent[] {
  const base = { platform: "cursor" as const, sessionId: payload.conversation_id, at: now.toISOString() };
  switch (payload.hook_event_name) {
    case "preToolUse":
      return [{ kind: "tool.before", ...base, action: toAction(payload, readFile) }];
    case "postToolUse": {
      const result = payload.tool_name === "Shell" ? shellResult(payload.tool_output) : { ok: true };
      return [{ kind: "tool.after", ...base, action: toAction(payload, () => undefined), ...result }];
    }
    case "postToolUseFailure":
      return [{ kind: "tool.after", ...base, action: toAction(payload, () => undefined), ok: false, error: payload.error_message }];
    case "stop":
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
 * Verdict → Cursor hook stdout. Cursor does not enforce "ask" from preToolUse,
 * so it becomes a deny telling the agent to get the user's decision. After a
 * tool ran, findings become additional context. Stop prints nothing (a
 * followup_message would make Cursor keep going). Output is ASCII-only JSON.
 */
export function toCursorOutput(hookEventName: string, verdict: Verdict): string | null {
  const reason = reasonOf(verdict);
  if (hookEventName === "preToolUse") {
    if (verdict.level === "block" || verdict.level === "ask") {
      const prefix = verdict.level === "ask" ? "Loom needs the user's decision before this runs. Ask the user, do not work around it.\n" : "";
      return asciiJson({ permission: "deny", user_message: reason, agent_message: prefix + reason });
    }
    return asciiJson(reason ? { permission: "allow", agent_message: reason } : { permission: "allow" });
  }
  if (!reason || hookEventName === "stop") return null;
  if (hookEventName === "postToolUse" || hookEventName === "postToolUseFailure") return asciiJson({ additional_context: reason });
  return null;
}
