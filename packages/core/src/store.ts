import fs from "node:fs";
import path from "node:path";
import { Canvas, CanvasNode, type CanvasEdge, type Level, type AgentEvent } from "@agent-together/schema";

/**
 * Everything Agent Together knows lives in files under <project>/.agent-together so it can be
 * diffed, reviewed and shared through git:
 *   canvas/_edges.json   edges between nodes
 *   canvas/<id>.json     one file per node
 *   rules.json           { "<rule id>": "<level>" } overrides
 *   events/<date>.jsonl  event log (git-ignored)
 *   context/<id>.md      context handed to the last agent dispatched on a node (git-ignored)
 *   runtime.json         daemon port (git-ignored)
 */
export class ProjectStore {
  readonly dir: string;

  constructor(readonly root: string) {
    this.dir = path.join(root, ".agent-together");
  }

  static find(start: string): ProjectStore | null {
    let dir = path.resolve(start);
    for (;;) {
      if (fs.existsSync(path.join(dir, ".agent-together"))) return new ProjectStore(dir);
      const parent = path.dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  }

  loadCanvas(): Canvas {
    const canvasDir = path.join(this.dir, "canvas");
    const nodes: unknown[] = [];
    let edges: CanvasEdge[] = [];
    if (fs.existsSync(canvasDir)) {
      for (const name of fs.readdirSync(canvasDir).sort()) {
        if (!name.endsWith(".json")) continue;
        const data = JSON.parse(fs.readFileSync(path.join(canvasDir, name), "utf8"));
        if (name === "_edges.json") edges = data;
        else nodes.push(data);
      }
    }
    const parsed = Canvas.safeParse({ version: 1, nodes, edges });
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
      throw new Error(`invalid canvas in ${canvasDir}\n${issues.join("\n")}`);
    }
    return parsed.data;
  }

  private get canvasDir() {
    return path.join(this.dir, "canvas");
  }

  /** Validates the whole canvas as it would be after a change, then writes only what changed. */
  private check(canvas: Canvas): Canvas {
    const parsed = Canvas.safeParse(canvas);
    if (!parsed.success) throw new Error(parsed.error.issues.map((i) => i.message).join("; "));
    return parsed.data;
  }

  /** Adds or replaces one node (its own file). */
  saveNode(input: unknown): CanvasNode {
    const node = CanvasNode.parse(input);
    const canvas = this.loadCanvas();
    this.check({ ...canvas, nodes: [...canvas.nodes.filter((n) => n.id !== node.id), node] });
    fs.mkdirSync(this.canvasDir, { recursive: true });
    fs.writeFileSync(path.join(this.canvasDir, `${node.id}.json`), JSON.stringify(node, null, 2) + "\n");
    return node;
  }

  /** Removes a node and every edge that touches it. */
  deleteNode(id: string): void {
    const canvas = this.loadCanvas();
    this.saveEdges(canvas.edges.filter((e) => e.from !== id && e.to !== id));
    fs.rmSync(path.join(this.canvasDir, `${id}.json`), { force: true });
  }

  /** Replaces the edge list; every end must be an existing node, no duplicates or self-loops. */
  saveEdges(edges: CanvasEdge[]): CanvasEdge[] {
    const seen = new Set<string>();
    const unique = edges.filter((e) => e.from !== e.to && !seen.has(`${e.from}>${e.to}`) && seen.add(`${e.from}>${e.to}`));
    const canvas = this.check({ ...this.loadCanvas(), edges: unique });
    fs.mkdirSync(this.canvasDir, { recursive: true });
    fs.writeFileSync(path.join(this.canvasDir, "_edges.json"), JSON.stringify(canvas.edges, null, 2) + "\n");
    return canvas.edges;
  }

  /** Replaces the whole canvas (a generated plan). */
  writeCanvas(input: Canvas): Canvas {
    const canvas = this.check(input);
    fs.rmSync(this.canvasDir, { recursive: true, force: true });
    fs.mkdirSync(this.canvasDir, { recursive: true });
    for (const node of canvas.nodes) {
      fs.writeFileSync(path.join(this.canvasDir, `${node.id}.json`), JSON.stringify(node, null, 2) + "\n");
    }
    fs.writeFileSync(path.join(this.canvasDir, "_edges.json"), JSON.stringify(canvas.edges, null, 2) + "\n");
    return canvas;
  }

  loadRuleLevels(): Record<string, Level> {
    const file = path.join(this.dir, "rules.json");
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  }

  appendEvent(record: { event: AgentEvent; verdict?: unknown }): void {
    const eventsDir = path.join(this.dir, "events");
    fs.mkdirSync(eventsDir, { recursive: true });
    const day = record.event.at.slice(0, 10);
    fs.appendFileSync(path.join(eventsDir, `${day}.jsonl`), JSON.stringify(record) + "\n");
  }

  /**
   * The newest records of the daily logs, newest first: `{event, verdict}` lines and
   * `{judgment}` lines, up to `limit` of each. Used to show history when a project opens.
   */
  recentLog(limit = 100): { events: { event: AgentEvent; verdict: unknown }[]; judgments: { at: string }[] } {
    const eventsDir = path.join(this.dir, "events");
    const events: { event: AgentEvent; verdict: unknown }[] = [];
    const judgments: { at: string }[] = [];
    if (!fs.existsSync(eventsDir)) return { events, judgments };
    const days = fs.readdirSync(eventsDir).filter((f) => f.endsWith(".jsonl")).sort().reverse();
    for (const day of days) {
      const lines = fs.readFileSync(path.join(eventsDir, day), "utf8").trimEnd().split("\n").reverse();
      for (const line of lines) {
        try {
          const record = JSON.parse(line);
          if (record.event && events.length < limit) events.push(record);
          else if (record.judgment && judgments.length < limit) judgments.push(record.judgment);
        } catch {} // a line cut short by a crash
      }
      if (events.length >= limit && judgments.length >= limit) break;
    }
    return { events, judgments };
  }

  /** Appends an L2 judgment to the same daily log as events. */
  appendJudgment(judgment: { at: string }): void {
    const eventsDir = path.join(this.dir, "events");
    fs.mkdirSync(eventsDir, { recursive: true });
    fs.appendFileSync(path.join(eventsDir, `${judgment.at.slice(0, 10)}.jsonl`), JSON.stringify({ judgment }) + "\n");
  }

  /** The task text of the last dispatch to a node (the "# 任务" section of its context file), if any. */
  readTask(nodeId: string): string | null {
    const file = path.join(this.dir, "context", `${nodeId}.md`);
    if (!fs.existsSync(file)) return null;
    const match = /^# 任务\s*\n([\s\S]*?)\n## /m.exec(fs.readFileSync(file, "utf8"));
    return match ? match[1].trim() : null;
  }

  /** Writes the dispatch context for a node; returns its project-relative path. */
  writeContext(nodeId: string, markdown: string): string {
    const contextDir = path.join(this.dir, "context");
    fs.mkdirSync(contextDir, { recursive: true });
    fs.writeFileSync(path.join(contextDir, `${nodeId}.md`), markdown);
    return `.agent-together/context/${nodeId}.md`;
  }

  writeRuntime(runtime: { port: number; pid: number }): void {
    fs.writeFileSync(path.join(this.dir, "runtime.json"), JSON.stringify(runtime));
  }

  readRuntime(): { port: number; pid: number } | null {
    const file = path.join(this.dir, "runtime.json");
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
  }

  clearRuntime(): void {
    fs.rmSync(path.join(this.dir, "runtime.json"), { force: true });
  }
}
