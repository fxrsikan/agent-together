import { strongest, type Canvas, type Finding, type Level, type AgentEvent, type Verdict } from "@agent-together/schema";
import { builtinRules, type Rule } from "./rules/index.js";

const HISTORY_LIMIT = 500;

/** Runs every rule on every event and keeps a short per-session history. */
export class Observer {
  private sessions = new Map<string, AgentEvent[]>();

  constructor(
    private readonly root: string,
    private canvas: Canvas,
    private levels: Record<string, Level> = {},
    private rules: Rule[] = builtinRules,
    public activeNodeId: string | null = null,
  ) {}

  get canvasNow(): Canvas {
    return this.canvas;
  }

  setCanvas(canvas: Canvas) {
    this.canvas = canvas;
  }

  setRules(rules: Rule[]) {
    this.rules = rules;
  }

  setLevels(levels: Record<string, Level>) {
    this.levels = levels;
  }

  evaluate(event: AgentEvent): Verdict {
    const history = this.sessions.get(event.sessionId) ?? [];
    const ctx = {
      root: this.root,
      canvas: this.canvas,
      activeNode: this.canvas.nodes.find((n) => n.id === this.activeNodeId) ?? null,
      history,
    };
    const findings: Finding[] = [];
    for (const rule of this.rules) {
      const level = this.levels[rule.id] ?? rule.defaultLevel;
      if (level === "off") continue;
      const hit = rule.check(event, ctx);
      if (hit) findings.push({ rule: rule.id, level, ...hit });
    }
    history.push(event);
    if (history.length > HISTORY_LIMIT) history.shift();
    this.sessions.set(event.sessionId, history);
    return { level: strongest(findings), findings };
  }
}
