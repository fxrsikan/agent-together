import type { Canvas, CanvasNode, Finding, Level, AgentEvent } from "@agent-together/schema";

export interface RuleContext {
  root: string;
  canvas: Canvas;
  activeNode: CanvasNode | null;
  /** Extra globs the active card may write during this run (pre-authorised integration work); empty otherwise. */
  grants?: string[];
  /** Earlier events of the same agent session, oldest first. */
  history: AgentEvent[];
}

/** An L0 rule: deterministic, cheap, runs on every event. */
export interface Rule {
  id: string;
  defaultLevel: Level;
  check(event: AgentEvent, ctx: RuleContext): Omit<Finding, "rule" | "level"> | null;
}
