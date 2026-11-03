import { EventEmitter } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Canvas, Finding, LoomEvent, Memory, Verdict } from "@loom/schema";
import { draftsFromFindings, MemoryStore } from "./memory.js";
import { Observer } from "./observer.js";
import { LoomStore } from "./store.js";

export interface DaemonEvents {
  event: [{ event: LoomEvent; verdict: Verdict }];
  active: [string | null];
  /** New memory drafts written at the end of an agent turn. */
  memory: [Memory[]];
}

/**
 * The local daemon. Hooks POST unified events to /event and get a verdict back.
 * It listens on 127.0.0.1 only and announces its port in .loom/runtime.json.
 */
export class Daemon extends EventEmitter<DaemonEvents> {
  readonly store: LoomStore;
  readonly observer: Observer;
  readonly memory: MemoryStore;
  private server: http.Server | null = null;
  /** Findings of each agent session since its last turn ended. */
  private pending = new Map<string, Finding[]>();

  constructor(root: string) {
    super();
    this.store = new LoomStore(root);
    this.memory = new MemoryStore(root);
    this.observer = new Observer(root, this.store.loadCanvas(), this.store.loadRuleLevels());
  }

  get canvas(): Canvas {
    return this.store.loadCanvas();
  }

  reload() {
    this.observer.setCanvas(this.store.loadCanvas());
    this.observer.setLevels(this.store.loadRuleLevels());
  }

  setActiveNode(nodeId: string | null) {
    this.observer.activeNodeId = nodeId;
    this.emit("active", nodeId);
  }

  handle(event: LoomEvent): Verdict {
    const verdict = this.observer.evaluate(event);
    this.store.appendEvent({ event, verdict });
    const findings = [...(this.pending.get(event.sessionId) ?? []), ...verdict.findings];
    this.pending.set(event.sessionId, findings);
    this.emit("event", { event, verdict });
    if (event.kind === "turn.end") {
      // 记忆官: what the observer caught this turn becomes drafts waiting for approval.
      this.pending.delete(event.sessionId);
      const drafts = draftsFromFindings(this.observer.canvasNow, findings, event.sessionId)
        .map((d) => this.memory.add(d))
        .filter((m): m is Memory => m !== null);
      if (drafts.length) this.emit("memory", drafts);
    }
    return verdict;
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
          if (req.url === "/event") return reply(200, this.handle(data as LoomEvent));
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
