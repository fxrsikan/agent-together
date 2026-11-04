import path from "node:path";
import type { BrowserWindow } from "electron";
import { installHooks } from "@agent-together/adapter-claude-code";
import { installCodexHooks } from "@agent-together/adapter-codex";
import { installCursorHooks } from "@agent-together/adapter-cursor";
import { auditChanges, Checkpoints, createLlm, Daemon, loadLlmConfig, Race, readProjectInfo, writtenPaths, type AuditResult, type Llm } from "@agent-together/core";
import type { AgentEvent } from "@agent-together/schema";

/** Everything that belongs to one open project; closing it stops its daemon. */
export class Session {
  readonly daemon: Daemon;
  readonly llm: Llm | null;
  readonly checkpoints: Checkpoints;
  readonly hasGit: boolean;
  readonly race: Race | null;
  port = 0;
  /** Node id while a race runs; one at a time. */
  racing: string | null = null;
  /** The agent running in the app, if any; one at a time. */
  running: { nodeId: string; agent: string; stop: AbortController } | null = null;
  /** Per node: the checkpoint taken before its last dispatch and the events the observer saw since. */
  private watches = new Map<string, { base: string; events: AgentEvent[] }>();

  private constructor(
    readonly root: string,
    private readonly win: BrowserWindow,
  ) {
    const llmConfig = loadLlmConfig(root);
    this.llm = createLlm(llmConfig);
    this.daemon = new Daemon(root, { llm: this.llm, maxL2CallsPerSession: llmConfig.maxCallsPerSession });
    this.checkpoints = new Checkpoints(root);
    this.hasGit = this.checkpoints.available();
    this.race = this.hasGit ? new Race(root) : null;
    const send = (channel: string) => (payload: unknown) => win.webContents.send(`agent-together:${channel}`, payload);
    this.daemon.on("event", send("event"));
    this.daemon.on("event", ({ event }: { event: AgentEvent }) => {
      for (const w of this.watches.values()) w.events.push(event);
    });
    this.daemon.on("active", send("active"));
    this.daemon.on("memory", send("memoryDrafts"));
    this.daemon.on("judgment", send("judgment"));
    this.daemon.on("l2error", send("l2error"));
  }

  static async open(root: string, win: BrowserWindow): Promise<Session> {
    const session = new Session(root, win);
    session.port = await session.daemon.start();
    return session;
  }

  get name(): string {
    return readProjectInfo(this.root).name;
  }

  info() {
    return {
      root: this.root,
      name: this.name,
      port: this.port,
      hasGit: this.hasGit,
      l2: this.llm?.name ?? null,
      activeNodeId: this.daemon.observer.activeNodeId,
    };
  }

  /** Registers the hook program with Claude Code (and so Grok Build), Codex and Cursor; returns the files written. */
  installHooks(hookProgram: string): string[] {
    return [
      installHooks(this.root, `node "${hookProgram}"`),
      installCodexHooks(this.root, `node "${hookProgram}" --platform codex`),
      ...installCursorHooks(this.root, `node "${hookProgram}" --platform cursor`),
    ].map((f) => path.relative(this.root, f) || f);
  }

  /** Saves the pre-dispatch checkpoint and starts remembering what the observer sees for this node. */
  startDispatch(nodeId: string, agent: string) {
    if (!this.hasGit) return;
    const checkpoint = this.checkpoints.create(`交给 AI 之前（${agent}）`, nodeId);
    this.watches.set(nodeId, { base: checkpoint.commit, events: [] });
  }

  /** Every change since the node's last dispatch, put through the observer; null without git or a dispatch. */
  audit(nodeId: string | null): AuditResult | null {
    const w = nodeId ? this.watches.get(nodeId) : undefined;
    if (!w || !nodeId) return null;
    try {
      return auditChanges(this.root, w.base, nodeId, writtenPaths(this.root, w.events), this.daemon.canvas);
    } catch {
      return null;
    }
  }

  /** The canvas changed on disk: the observer judges against the new one, the window redraws. */
  canvasChanged() {
    this.daemon.reload();
    this.win.webContents.send("agent-together:canvasChanged", null);
  }

  async close() {
    this.running?.stop.abort();
    this.daemon.removeAllListeners();
    await this.daemon.stop();
  }
}
