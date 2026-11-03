import type { Canvas, CanvasNode, Finding, Level, LoomEvent } from "@loom/schema";

export interface RuleContext {
  root: string;
  canvas: Canvas;
  activeNode: CanvasNode | null;
  /** Earlier events of the same agent session, oldest first. */
  history: LoomEvent[];
}

/** An L0 rule: deterministic, cheap, runs on every event. */
export interface Rule {
  id: string;
  defaultLevel: Level;
  check(event: LoomEvent, ctx: RuleContext): Omit<Finding, "rule" | "level"> | null;
}
