/**
 * The unified event every adapter emits. Observers only ever see these,
 * never a platform's raw hook payload.
 */
export type AgentPlatform = "claude-code" | "codex" | "grok-build" | "cursor";

export type ToolAction =
  | { type: "write"; path: string; before?: string; after: string }
  | { type: "read"; path: string }
  | { type: "shell"; command: string }
  | { type: "other"; tool: string };

export type LoomEvent =
  | {
      kind: "tool.before";
      platform: AgentPlatform;
      sessionId: string;
      at: string;
      action: ToolAction;
    }
  | {
      kind: "tool.after";
      platform: AgentPlatform;
      sessionId: string;
      at: string;
      action: ToolAction;
      ok: boolean;
      error?: string;
    }
  | { kind: "turn.end"; platform: AgentPlatform; sessionId: string; at: string };

/** Intervention ladder from the design doc: log → warn → ask (pause for a human) → block. */
export type Level = "off" | "log" | "warn" | "ask" | "block";

export interface Finding {
  rule: string;
  level: Level;
  message: string;
  nodeId?: string;
}

/** What the daemon answers a hook with: the strongest finding wins. */
export interface Verdict {
  level: Level;
  findings: Finding[];
}

const order: Level[] = ["off", "log", "warn", "ask", "block"];

export function strongest(findings: Finding[]): Level {
  return findings.reduce<Level>(
    (max, f) => (order.indexOf(f.level) > order.indexOf(max) ? f.level : max),
    "off",
  );
}
