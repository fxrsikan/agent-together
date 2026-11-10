import path from "node:path";
import type { BrowserWindow } from "electron";
import { installHooks } from "@agent-together/adapter-claude-code";
import { installCodexHooks } from "@agent-together/adapter-codex";
import { installCursorHooks } from "@agent-together/adapter-cursor";
import { allowTestCommands, auditChanges, Checkpoints, createLlm, Daemon, loadLlmConfig, Race, readProjectInfo, writtenPaths, ProductProcess, type Acceptance, type Engine, type AuditOutcome, type Llm, type SpecPlan } from "@agent-together/core";
import type { AgentEvent } from "@agent-together/schema";
import { ProductPreview } from "./preview";

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
  /** A canvas migration planned from the confirmed spec, waiting for the user to look at it. */
  pendingPlan: SpecPlan | null = null;
  /** The product being built, running locally (M2), and its page shown in the window. */
  readonly product: ProductProcess;
  readonly preview: ProductPreview;
  /** Automatic progress through the version's cards (M3); set up by the main process, which owns the assistants. */
  engine: Engine | null = null;
  /** Scenario acceptance and delivery (M4); set up by the main process. */
  acceptance: Acceptance | null = null;
  /** The agent running in the app, if any; one at a time. */
  running: { nodeId: string; agent: string; stop: AbortController } | null = null;
  /** Per node: the checkpoint taken before its last dispatch and the events the observer saw since. */
  private watches = new Map<string, { base: string; events: AgentEvent[]; grants: string[] }>();

  private constructor(
    readonly root: string,
    private readonly win: BrowserWindow,
  ) {
    const llmConfig = loadLlmConfig(root);
    let llm: Llm | null = null;
    try {
      llm = createLlm(llmConfig);
    } catch {} // an incomplete llm.json: run without the helper model rather than not open the project
    this.llm = llm;
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
    this.product = new ProductProcess(root, send("productStatus"));
    this.preview = new ProductPreview(win, root, send("previewProblem"));
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

  /**
   * Lets the agent run the project's tests (headless runs refuse commands that need
   * approval), saves the pre-dispatch checkpoint and starts remembering what the
   * observer sees for this node.
   */
  startDispatch(nodeId: string, agent: string, grants: string[] = []) {
    try {
      allowTestCommands(this.root);
    } catch {} // an unreadable settings file: the agent just can't run tests itself
    if (!this.hasGit) return;
    const checkpoint = this.checkpoints.create(`交给 AI 之前（${agent}）`, nodeId);
    this.watches.set(nodeId, { base: checkpoint.commit, events: [], grants });
  }

  /** Every change since the node's last dispatch, put through the observer; null without git or a dispatch. */
  /** null when there is nothing to check (no dispatch watched, no git); an error when the check itself failed. */
  audit(nodeId: string | null): AuditOutcome | null {
    const w = nodeId ? this.watches.get(nodeId) : undefined;
    if (!w || !nodeId) return null;
    try {
      return auditChanges(this.root, w.base, nodeId, writtenPaths(this.root, w.events), this.daemon.canvas, w.grants);
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * What the project is doing that must not overlap with anything else: an agent
   * run, tests, a rollback, a race or evolution, adopting a result. One at a time;
   * the window greys out the other actions while it lasts.
   */
  busy: string | null = null;

  async exclusive<T>(what: string, work: () => Promise<T> | T): Promise<T> {
    if (this.busy) throw new Error(`正在${this.busy}，等它结束再试`);
    this.setBusy(what);
    try {
      return await work();
    } finally {
      this.setBusy(null);
    }
  }

  /** Holds or releases the project lock without a callback: the automatic run holds it while it runs. */
  setBusy(what: string | null) {
    this.busy = what;
    this.win.webContents.send("agent-together:busy", what);
  }

  /** A run is bound to its card: the observer's current card cannot change under it. */
  setActiveNode(nodeId: string | null) {
    if (this.running && nodeId !== this.running.nodeId) {
      const title = this.daemon.canvas.nodes.find((n) => n.id === this.running!.nodeId)?.title ?? this.running.nodeId;
      throw new Error(`AI 正在做「${title}」，做完之前不能换当前卡片`);
    }
    this.daemon.setActiveNode(nodeId);
  }

  /** The canvas changed on disk: the observer judges against the new one, the window redraws. */
  canvasChanged() {
    this.daemon.reload();
    this.win.webContents.send("agent-together:canvasChanged", null);
  }

  async close() {
    // The run stays "running" on disk: next time it opens as interrupted, to resume from a safe step.
    this.engine?.halt();
    this.acceptance?.stop();
    this.running?.stop.abort();
    await this.product.stop();
    this.preview.destroy();
    this.daemon.removeAllListeners();
    await this.daemon.stop();
  }
}
