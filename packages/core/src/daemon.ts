import { EventEmitter } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Canvas, Finding, AgentEvent, Memory, Verdict } from "@agent-together/schema";
import { CapabilityStore, capabilityRules } from "./capabilities.js";
import { judgeTurn, refineMemory, turnWorthJudging } from "./judge.js";
import { builtinRules } from "./rules/index.js";
import type { Llm } from "./llm.js";
import { draftsFromFindings, MemoryStore } from "./memory.js";
import { Observer } from "./observer.js";
import { ProjectStore } from "./store.js";

/** An L2 verdict on one agent turn. */
export interface Judgment {
  sessionId: string;
  nodeId: string;
  at: string;
  onTrack: boolean;
  reason: string;
  by: string;
}

export interface DaemonEvents {
  event: [{ event: AgentEvent; verdict: Verdict }];
  active: [string | null];
  /** Memory drafts written, or refined by L2, at the end of an agent turn. */
  memory: [Memory[]];
  judgment: [Judgment];
  /** L2 could not run (model missing, timeout…); judging is skipped, agents are never blocked. */
  l2error: [string];
}

export interface DaemonOptions {
  /** L2 model; without one, Agent Together runs on L0 rules only. */
  llm?: Llm | null;
  maxL2CallsPerSession?: number;
}

/**
 * The local daemon. Hooks POST unified events to /event and get a verdict back.
 * It listens on 127.0.0.1 only and announces its port in .agent-together/runtime.json.
 * L2 work (refining memories, judging turns) runs after the hook has its answer,
 * so a slow model never slows the agent down.
 */
export class Daemon extends EventEmitter<DaemonEvents> {
  readonly store: ProjectStore;
  readonly observer: Observer;
  readonly memory: MemoryStore;
  readonly capabilities: CapabilityStore;
  readonly llm: Llm | null;
  private server: http.Server | null = null;
  /** Findings and events of each agent session since its last turn ended. */
  private pending = new Map<string, { findings: Finding[]; events: AgentEvent[] }>();
  private l2Calls = new Map<string, number>();
  private background = new Set<Promise<void>>();
  private readonly maxL2Calls: number;

  constructor(root: string, options: DaemonOptions = {}) {
    super();
    this.store = new ProjectStore(root);
    this.memory = new MemoryStore(root);
    this.capabilities = new CapabilityStore(root);
    this.observer = new Observer(root, this.store.loadCanvas(), this.store.loadRuleLevels(), this.rules());
    this.llm = options.llm ?? null;
    this.maxL2Calls = options.maxL2CallsPerSession ?? 20;
  }

  get canvas(): Canvas {
    return this.store.loadCanvas();
  }

  /** Built-in L0 rules plus the project's observer capabilities. */
  private rules() {
    return [...builtinRules, ...capabilityRules(this.capabilities.list())];
  }

  reload() {
    this.observer.setCanvas(this.store.loadCanvas());
    this.observer.setLevels(this.store.loadRuleLevels());
    this.observer.setRules(this.rules());
  }

  setActiveNode(nodeId: string | null) {
    this.observer.activeNodeId = nodeId;
    this.emit("active", nodeId);
  }

  handle(event: AgentEvent): Verdict {
    const verdict = this.observer.evaluate(event);
    this.store.appendEvent({ event, verdict });
    const turn = this.pending.get(event.sessionId) ?? { findings: [], events: [] };
    turn.findings.push(...verdict.findings);
    turn.events.push(event);
    this.pending.set(event.sessionId, turn);
    this.emit("event", { event, verdict });
    if (event.kind === "turn.end") {
      // 记忆官: what the observer caught this turn becomes drafts waiting for approval.
      this.pending.delete(event.sessionId);
      const drafts = draftsFromFindings(this.observer.canvasNow, turn.findings, event.sessionId)
        .map((d) => this.memory.add(d))
        .filter((m): m is Memory => m !== null);
      if (drafts.length) this.emit("memory", drafts);
      if (this.llm) this.inBackground(this.runL2(event.sessionId, drafts, turn.events));
    }
    return verdict;
  }

  /** Resolves when all background L2 work has finished (tests, shutdown). */
  async settled(): Promise<void> {
    while (this.background.size) await Promise.all([...this.background]);
  }

  private inBackground(work: Promise<void>) {
    const tracked = work.catch((err) => void this.emit("l2error", String(err?.message ?? err))).finally(() => this.background.delete(tracked));
    this.background.add(tracked);
  }

  /** Spends one L2 call of the session's budget; false when the budget is used up. */
  private spend(sessionId: string): boolean {
    const used = this.l2Calls.get(sessionId) ?? 0;
    if (used >= this.maxL2Calls) return false;
    this.l2Calls.set(sessionId, used + 1);
    return true;
  }

  private async runL2(sessionId: string, drafts: Memory[], events: AgentEvent[]) {
    const llm = this.llm!;
    const canvas = this.observer.canvasNow;
    const refined: Memory[] = [];
    for (const draft of drafts) {
      if (!this.spend(sessionId)) break;
      const node = canvas.nodes.find((n) => n.id === draft.nodeId) ?? null;
      const text = await refineMemory(llm, draft.content, node);
      if (text) refined.push(this.memory.update(draft.id, { content: text, evidence: draft.content }));
    }
    if (refined.length) this.emit("memory", refined);

    const node = canvas.nodes.find((n) => n.id === this.observer.activeNodeId);
    if (!node || !turnWorthJudging(events) || !this.spend(sessionId)) return;
    const verdict = await judgeTurn(llm, node, this.store.readTask(node.id), events);
    if (!verdict) return;
    const judgment: Judgment = { sessionId, nodeId: node.id, at: new Date().toISOString(), by: llm.name, ...verdict };
    this.store.appendJudgment(judgment);
    this.emit("judgment", judgment);
  }

  async start(port = 0): Promise<number> {
    this.server = http.createServer((req, res) => {
      const reply = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.method === "GET" && req.url === "/state") {
        return reply(200, { activeNodeId: this.observer.activeNodeId });
      }
      if (req.method !== "POST") return reply(404, { error: "not found" });
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        try {
          const data = JSON.parse(body);
          if (req.url === "/event") return reply(200, this.handle(data as AgentEvent));
          if (req.url === "/active") {
            this.setActiveNode(data.nodeId ?? null);
            return reply(200, { activeNodeId: this.observer.activeNodeId });
          }
          reply(404, { error: "not found" });
        } catch (err) {
          reply(400, { error: String(err) });
        }
      });
    });
    const server = this.server;
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
    const actual = (server.address() as AddressInfo).port;
    this.store.writeRuntime({ port: actual, pid: process.pid });
    return actual;
  }

  async stop() {
    this.store.clearRuntime();
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
