import fs from "node:fs";
import path from "node:path";
import { Canvas, type CanvasEdge, type Level, type LoomEvent } from "@loom/schema";

/**
 * Everything Loom knows lives in files under <project>/.loom so it can be
 * diffed, reviewed and shared through git:
 *   canvas/_edges.json   edges between nodes
 *   canvas/<id>.json     one file per node
 *   rules.json           { "<rule id>": "<level>" } overrides
 *   events/<date>.jsonl  event log (git-ignored)
 *   context/<id>.md      context handed to the last agent dispatched on a node (git-ignored)
 *   runtime.json         daemon port (git-ignored)
 */
export class LoomStore {
  readonly dir: string;

  constructor(readonly root: string) {
    this.dir = path.join(root, ".loom");
  }

  static find(start: string): LoomStore | null {
    let dir = path.resolve(start);
    for (;;) {
      if (fs.existsSync(path.join(dir, ".loom"))) return new LoomStore(dir);
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

  loadRuleLevels(): Record<string, Level> {
    const file = path.join(this.dir, "rules.json");
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  }

  appendEvent(record: { event: LoomEvent; verdict?: unknown }): void {
    const eventsDir = path.join(this.dir, "events");
    fs.mkdirSync(eventsDir, { recursive: true });
    const day = record.event.at.slice(0, 10);
    fs.appendFileSync(path.join(eventsDir, `${day}.jsonl`), JSON.stringify(record) + "\n");
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
    return `.loom/context/${nodeId}.md`;
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
