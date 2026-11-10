import fs from "node:fs";
import path from "node:path";
import { workVerdict, type AuditEvidence, type Canvas, type CanvasNode, type Spec, type TestEvidence, type WorkStatus } from "@agent-together/schema";

/**
 * Automatic progress (phase one, M3): once a version's scope is confirmed, the
 * engine works through its cards one at a time, in dependency order: hand the card
 * to the assistant, check the result (agent finished, tests exist and pass, the
 * after-run check is clean, the product still starts), hand failures back with the
 * evidence, and stop with a decision card when it cannot go on by itself. Every
 * step is recorded in .agent-together/runs/<id>.json, so a run survives a restart.
 *
 * The engine decides; the executor (the desktop app) does the dispatching.
 */

export interface EngineLimits {
  /** Hand-backs per card after the first try. */
  maxRepairs: number;
  /** Assistant calls per run. Exact. */
  maxCalls: number;
  /** One assistant call's time limit. Exact. */
  callTimeoutMs: number;
  /** Spend per run in US dollars, as far as assistants report it. Checked before each call, not exact. */
  budgetUsd: number;
}

export const DEFAULT_LIMITS: EngineLimits = { maxRepairs: 3, maxCalls: 40, callTimeoutMs: 20 * 60_000, budgetUsd: 3 };

export interface StepRecord {
  id: string;
  nodeId: string;
  title: string;
  /** 0 for the first try, then 1, 2, … per hand-back. */
  attempt: number;
  task: string;
  startedAt: string;
  endedAt?: string;
  /** The checkpoint taken just before the step: where a retry or a recovery starts from. */
  checkpoint: string | null;
  state: "running" | "passed" | "failed" | "interrupted";
  status?: WorkStatus | "product-failed" | "unchanged";
  reasons?: string[];
  summary?: string;
  costUsd?: number;
  durationMs?: number;
  /** What identifies this failure, to notice the same one coming back. */
  signature?: string;
  /** Files this step may also write (pre-authorised integration). Valid only for the step. */
  grants: string[];
  testsTail?: string;
}

export type DecisionOption = "retry" | "skip" | "stop" | "raise";

export interface EngineDecision {
  id: string;
  at: string;
  nodeId: string | null;
  question: string;
  why: string;
  recommended: DecisionOption;
  impact: string;
  options: { id: DecisionOption; label: string }[];
  /** What the user chose, once they did. */
  chosen?: DecisionOption;
}

export type RunStatus = "running" | "paused" | "waiting" | "interrupted" | "done" | "stopped";

export interface RunRecord {
  id: string;
  version: number;
  agent: string;
  model?: string;
  createdAt: string;
  updatedAt: string;
  status: RunStatus;
  /** "build": the version's cards; "fix": changes handed over from acceptance (M4). */
  kind?: "build" | "fix";
  tasks: { nodeId: string; title: string; state: "todo" | "doing" | "done" | "skipped"; attempts: number; fix?: string; grants?: string[] }[];
  steps: StepRecord[];
  limits: EngineLimits;
  usage: { calls: number; costUsd: number; callsWithoutCost: number; ms: number };
  decision: EngineDecision | null;
  decisions: EngineDecision[];
  /** A line for people about where the run stands. */
  note: string;
}

/** What the executor reports back for one step. */
export interface StepOutcome {
  run: { ok: boolean; summary: string; costUsd?: number; durationMs: number };
  tests: (TestEvidence & { output?: string; failingFiles?: string[] }) | null;
  audit: (AuditEvidence & { findings?: { level: string; rule?: string; path?: string; message?: string }[] }) | null;
  /** Why the product would not start after this step, if it was tried. */
  productError?: string | null;
}

export type StepExecutor = (step: { nodeId: string; task: string; grants: string[]; timeoutMs: number; signal: AbortSignal; runId: string }) => Promise<StepOutcome>;

export interface EngineDeps {
  exec: StepExecutor;
  canvas: () => Canvas;
  spec: () => Spec | null;
  /** The card passed: mark it done on the canvas. */
  markDone: (nodeId: string) => void;
  /** Saves a checkpoint; returns its commit, or null without git. */
  checkpoint: (label: string, nodeId: string | null) => string | null;
  /** Puts the files back as they were at a checkpoint commit. */
  rollback: (commit: string) => void;
  /** The after-run check is expected (the project uses git). */
  auditRequired: boolean;
  onChange?: (run: RunRecord) => void;
  now?: () => Date;
}

const stamp = (d: Date) => d.toISOString().replace(/[-:.Z]/g, "").replace("T", "-");

/**
 * The cards of this version, dependencies first: those serving a scenario of the
 * confirmed spec plus what they depend on (all cards without a spec). Done cards
 * are left out; the integration card comes after the cards it connects.
 */
export function versionCards(canvas: Canvas, spec: Spec | null): CanvasNode[] {
  const ids = new Set(spec?.scenarios.map((s) => s.id) ?? []);
  const byId = new Map(canvas.nodes.map((n) => [n.id, n]));
  const deps = (id: string) => canvas.edges.filter((e) => e.from === id).map((e) => e.to);
  const wanted = new Set<string>();
  const want = (id: string) => {
    if (wanted.has(id) || !byId.has(id)) return;
    wanted.add(id);
    deps(id).forEach(want);
  };
  for (const n of canvas.nodes) if (!spec || n.scenarios?.some((s) => ids.has(s))) want(n.id);
  // Depth-first: a card after everything it depends on; cycles fall back to canvas order.
  const order: string[] = [];
  const seen = new Set<string>();
  const visit = (id: string, path: Set<string>) => {
    if (seen.has(id) || path.has(id) || !wanted.has(id)) return;
    path.add(id);
    deps(id).forEach((d) => visit(d, path));
    path.delete(id);
    seen.add(id);
    order.push(id);
  };
  const integrationLast = [...canvas.nodes].sort((a, b) => Number(a.id === "integration") - Number(b.id === "integration"));
  for (const n of integrationLast) visit(n.id, new Set());
  return order.map((id) => byId.get(id)!).filter((n) => n.status !== "done");
}

/** Files an integration card may also write this run: those of the cards it connects (its direct dependencies). */
export function integrationGrants(canvas: Canvas, nodeId: string): string[] {
  const node = canvas.nodes.find((n) => n.id === nodeId);
  if (!node || (node.id !== "integration" && node.kind !== "flow")) return [];
  const targets = canvas.edges.filter((e) => e.from === nodeId).map((e) => e.to);
  return [...new Set(canvas.nodes.filter((n) => targets.includes(n.id)).flatMap((n) => n.files))];
}

/**
 * What identifies a failure, without what changes every run (times, counts,
 * ports, absolute paths): the verdict, the failing files, the first error line.
 */
export function failureSignature(status: string, outcome: StepOutcome): string {
  const output = outcome.tests?.output ?? "";
  // The error itself first; a failing test's name ("✖ save works") only when there is no error line.
  const lines = output.split("\n");
  const first = lines.find((l) => /error|expected|assert/i.test(l)) ?? lines.find((l) => /✖|not ok|fail/i.test(l)) ?? "";
  const normal = (s: string) =>
    s
      .replace(/[A-Za-z]:\\[^\s'"]+|\/[^\s'"]+\//g, "<path>")
      .replace(/\d+(\.\d+)?/g, "#")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 160);
  const audit = (outcome.audit?.findings ?? []).map((f) => `${f.rule}:${f.path}`).sort().join(",");
  return [status, [...(outcome.tests?.failingFiles ?? [])].sort().join(","), normal(first), audit, outcome.productError ? normal(outcome.productError) : ""].join("|");
}

const tail = (s: string | undefined, n = 1500) => (s ? s.slice(-n) : "");

function taskText(node: CanvasNode, version: number, previous: StepRecord | null, fix?: string, grants: string[] = []): string {
  const todo = node.intent.tasks.length ? `\n\n任务清单：\n${node.intent.tasks.map((t) => `- ${t}`).join("\n")}` : "";
  // Said in the task, because the card's context only names the card's own files.
  const allowed = grants.length ? `\n\n这一步除了本卡片的文件，还允许修改这些文件（只在这一步有效，观察者不会把它算作越界）：\n${grants.map((g) => `- ${g}`).join("\n")}` : "";
  const base = fix
    ? `第 ${version} 版验收后要改的地方，在「${node.title}」这张卡片上改（相关使用场景见下文）：\n\n${fix}\n\n问题在哪个文件就改哪个文件。改完自己跑一遍项目的测试，原来的测试也要继续通过。${allowed}`
    : `按卡片的目标和验收标准完成「${node.title}」。这是自动制作第 ${version} 版的一步，相关使用场景见下文。做完自己跑一遍项目的测试。${todo}${allowed}`;
  if (!previous) return base;
  return `${base}

上一次做这张卡片没有通过，请先修好这些问题：
${(previous.reasons ?? []).map((r) => `- ${r}`).join("\n")}${previous.testsTail ? `\n\n测试输出的最后部分：\n\`\`\`\n${previous.testsTail}\n\`\`\`` : ""}`;
}

export class Engine {
  private record: RunRecord | null;
  private abort: AbortController | null = null;
  private looping: Promise<void> | null = null;
  private pauseAsked = false;
  private halted = false;
  private readonly dir: string;

  constructor(
    readonly root: string,
    private readonly deps: EngineDeps,
  ) {
    this.dir = path.join(root, ".agent-together", "runs");
    this.record = this.latestOnDisk();
    // Running when the app went away: the process is gone, the step's result unknown.
    if (this.record?.status === "running") {
      const step = this.record.steps.find((s) => s.state === "running");
      if (step) step.state = "interrupted";
      this.record.status = "interrupted";
      this.record.note = step ? `上次制作被中断了，停在「${step.title}」。继续会先回到这一步开始前的状态，再重做这一步。` : "上次制作被中断了。";
      this.save();
    }
  }

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  private latestOnDisk(): RunRecord | null {
    if (!fs.existsSync(this.dir)) return null;
    const files = fs.readdirSync(this.dir).filter((f) => f.endsWith(".json")).sort();
    for (const f of files.reverse()) {
      try {
        return JSON.parse(fs.readFileSync(path.join(this.dir, f), "utf8")) as RunRecord;
      } catch {}
    }
    return null;
  }

  get current(): RunRecord | null {
    return this.record ? structuredClone(this.record) : null;
  }

  /** A run that has not finished: one at a time. */
  get open(): boolean {
    return !!this.record && ["running", "paused", "waiting", "interrupted"].includes(this.record.status);
  }

  private save() {
    if (!this.record) return;
    this.record.updatedAt = this.now().toISOString();
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(path.join(this.dir, `${this.record.id}.json`), JSON.stringify(this.record, null, 2) + "\n");
    this.deps.onChange?.(this.current!);
  }

  /** Starts working through this version's cards. */
  start(opts: { agent: string; model?: string; limits?: Partial<EngineLimits>; fixes?: { nodeId: string; task: string; grants?: string[] }[] }): RunRecord {
    if (this.open) throw new Error("上一次制作还没结束：先继续、暂停后结束，或者放弃它");
    const spec = this.deps.spec();
    const canvas = this.deps.canvas();
    // Fixes: one task per card, its changes together, in canvas order.
    const fixes = new Map<string, string[]>();
    const fixGrants = new Map<string, Set<string>>();
    for (const f of opts.fixes ?? []) {
      if (!canvas.nodes.some((n) => n.id === f.nodeId)) continue;
      fixes.set(f.nodeId, [...(fixes.get(f.nodeId) ?? []), f.task]);
      for (const g of f.grants ?? []) fixGrants.set(f.nodeId, (fixGrants.get(f.nodeId) ?? new Set<string>()).add(g));
    }
    if (opts.fixes && !fixes.size) throw new Error("要改的地方对不上画布上的卡片");
    const cards = opts.fixes ? canvas.nodes.filter((n) => fixes.has(n.id)) : versionCards(canvas, spec);
    if (!cards.length) throw new Error(spec ? "这一版的卡片都已经完成了" : "画布上没有要做的卡片");
    const at = this.now();
    this.record = {
      id: `${stamp(at)}-run`,
      version: spec?.version ?? 1,
      agent: opts.agent,
      ...(opts.model ? { model: opts.model } : {}),
      createdAt: at.toISOString(),
      updatedAt: at.toISOString(),
      status: "running",
      kind: opts.fixes ? "fix" : "build",
      tasks: cards.map((n) => ({ nodeId: n.id, title: n.title, state: "todo", attempts: 0, ...(fixes.has(n.id) ? { fix: fixes.get(n.id)!.join("\n\n---\n\n") } : {}),
        ...(fixGrants.has(n.id) ? { grants: [...fixGrants.get(n.id)!] } : {}),
      })),
      steps: [],
      limits: { ...DEFAULT_LIMITS, ...opts.limits },
      usage: { calls: 0, costUsd: 0, callsWithoutCost: 0, ms: 0 },
      decision: null,
      decisions: [],
      note: opts.fixes ? `按验收结果修改：${cards.length} 张卡片` : `开始制作第 ${spec?.version ?? 1} 版：${cards.length} 张卡片`,
    };
    this.save();
    this.kick();
    return this.current!;
  }

  /** Runs the loop unless it already runs; resolves when it stops for any reason. */
  private kick(): Promise<void> {
    if (!this.looping) this.looping = this.loop().finally(() => (this.looping = null));
    return this.looping;
  }

  /** For tests and the app: wait until the loop has stopped (done, paused, waiting, stopped). */
  settled(): Promise<void> {
    return this.looping ?? Promise.resolve();
  }

  private ask(decision: Omit<EngineDecision, "id" | "at">) {
    const r = this.record!;
    r.decision = { ...decision, id: `${stamp(this.now())}-decision`, at: this.now().toISOString() };
    r.status = "waiting";
    r.note = decision.question;
    this.save();
  }

  private async loop(): Promise<void> {
    while (this.record?.status === "running" && !this.halted) {
      const r = this.record;
      if (this.pauseAsked) {
        this.pauseAsked = false;
        r.status = "paused";
        r.note = "已暂停，可以随时继续";
        this.save();
        return;
      }
      const task = r.tasks.find((t) => t.state === "todo" || t.state === "doing");
      if (!task) {
        r.status = "done";
        const skipped = r.tasks.filter((t) => t.state === "skipped").length;
        r.note =
          r.kind === "fix"
            ? `验收后要改的地方改完了${skipped ? `（跳过了 ${skipped} 张）` : ""}。下一步：重新验收。`
            : `第 ${r.version} 版的卡片都做完了${skipped ? `（跳过了 ${skipped} 张）` : ""}。下一步：按使用场景验收。`;
        this.save();
        return;
      }
      // Limits come before the call: the run never starts a call it is not allowed to make.
      if (r.usage.calls >= r.limits.maxCalls) {
        this.ask({
          nodeId: task.nodeId,
          question: `已经调用了 ${r.usage.calls} 次助手，到了这次制作的上限`,
          why: "上限是为了不让自动制作无限地花钱、花时间",
          recommended: "raise",
          impact: `还剩 ${r.tasks.filter((t) => t.state === "todo" || t.state === "doing").length} 张卡片没做；提高上限会多花一些时间和费用`,
          options: [
            { id: "raise", label: "提高上限后继续" },
            { id: "stop", label: "结束这次制作" },
          ],
        });
        return;
      }
      if (r.usage.costUsd >= r.limits.budgetUsd) {
        this.ask({
          nodeId: task.nodeId,
          question: `已知花费 $${r.usage.costUsd.toFixed(2)}，到了预算 $${r.limits.budgetUsd}`,
          why: `预算按助手报告的费用算${r.usage.callsWithoutCost ? `，另有 ${r.usage.callsWithoutCost} 次调用没有报告费用` : ""}`,
          recommended: "raise",
          impact: "提高预算会继续花钱；结束后已做好的卡片都保留",
          options: [
            { id: "raise", label: "提高预算后继续" },
            { id: "stop", label: "结束这次制作" },
          ],
        });
        return;
      }
      const node = this.deps.canvas().nodes.find((n) => n.id === task.nodeId);
      if (!node) {
        task.state = "skipped";
        this.save();
        continue;
      }
      const previous = [...r.steps].reverse().find((s) => s.nodeId === node.id && s.state === "failed") ?? null;
      // A fix may also write the files it was granted (the scenario's cards), for this run only.
      const grants = [...new Set([...integrationGrants(this.deps.canvas(), node.id), ...(task.grants ?? [])])].filter((g) => !node.files.includes(g));
      const step: StepRecord = {
        id: `${stamp(this.now())}-${node.id}-${task.attempts}`,
        nodeId: node.id,
        title: node.title,
        attempt: task.attempts,
        task: taskText(node, r.version, task.attempts > 0 ? previous : null, task.fix, grants),
        startedAt: this.now().toISOString(),
        checkpoint: this.deps.checkpoint(`自动制作：${node.title} 之前`, node.id),
        state: "running",
        grants,
      };
      task.state = "doing";
      r.steps.push(step);
      r.note = `正在做「${node.title}」${task.attempts ? `（第 ${task.attempts + 1} 次）` : ""}`;
      this.save();

      this.abort = new AbortController();
      let outcome: StepOutcome;
      try {
        outcome = await this.deps.exec({ nodeId: node.id, task: step.task, grants, timeoutMs: r.limits.callTimeoutMs, signal: this.abort.signal, runId: r.id });
      } catch (err) {
        outcome = { run: { ok: false, summary: err instanceof Error ? err.message : String(err), durationMs: 0 }, tests: null, audit: null };
      }
      this.abort = null;
      if (this.record !== r || this.halted) return;
      r.usage.calls++;
      r.usage.ms += outcome.run.durationMs;
      if (outcome.run.costUsd !== undefined) r.usage.costUsd += outcome.run.costUsd;
      else r.usage.callsWithoutCost++;
      step.endedAt = this.now().toISOString();
      step.summary = outcome.run.summary.slice(0, 2000);
      step.costUsd = outcome.run.costUsd;
      step.durationMs = outcome.run.durationMs;
      step.testsTail = tail(outcome.tests?.output);

      if ((r.status as RunStatus) === "stopped") {
        step.state = "failed";
        step.reasons = ["制作被结束了"];
        this.save();
        return;
      }

      const verdict = workVerdict({ run: outcome.run, tests: outcome.tests, audit: outcome.audit, auditRequired: this.deps.auditRequired });
      // A fix that changed nothing has not fixed anything, whatever the tests say.
      const changed = (outcome.audit as { files?: unknown[] } | null)?.files;
      const unchanged = !!task.fix && Array.isArray(changed) && changed.length === 0;
      const reasons = [
        ...verdict.reasons,
        ...(outcome.productError ? [`产品启动不了：${outcome.productError}`] : []),
        ...(unchanged ? ["这次没有改任何文件，验收里的问题还在"] : []),
      ];
      const passed = verdict.status === "passed" && !outcome.productError && !unchanged;
      step.status = passed ? "passed" : verdict.status !== "passed" ? verdict.status : outcome.productError ? "product-failed" : "unchanged";
      step.reasons = reasons;
      if (passed) {
        step.state = "passed";
        task.state = "done";
        this.deps.markDone(node.id);
        this.save();
        continue;
      }
      step.state = "failed";
      step.signature = failureSignature(step.status, outcome);
      task.attempts++;
      const same = previous?.signature === step.signature;
      if (same || task.attempts > r.limits.maxRepairs) {
        this.ask({
          nodeId: node.id,
          question: same ? `「${node.title}」同一个问题又出现了` : `「${node.title}」改了 ${task.attempts} 次还没通过`,
          why: reasons.join("；").slice(0, 300) || "没有通过检查",
          recommended: same ? "skip" : "retry",
          impact: "跳过的话，依赖它的卡片可能也做不好；再试会多调用几次助手；结束后已做好的卡片都保留，可以回到这一步之前的检查点",
          options: [
            { id: "retry", label: "再试几次" },
            { id: "skip", label: "先跳过这张卡片" },
            { id: "stop", label: "结束这次制作" },
          ],
        });
        return;
      }
      this.save();
    }
  }

  /**
   * The app is closing: stop the assistant and the loop without writing anything
   * more, as if the process had died. The run stays "running" on disk and opens
   * next time as interrupted.
   */
  halt() {
    this.halted = true;
    this.abort?.abort();
  }

  /** Pauses after the current step finishes (or now, when nothing runs). */
  pause() {
    const r = this.record;
    if (!r || r.status !== "running") return this.current;
    if (this.looping) this.pauseAsked = true;
    else {
      r.status = "paused";
      r.note = "已暂停，可以随时继续";
      this.save();
    }
    return this.current;
  }

  resume() {
    const r = this.record;
    if (!r || (r.status !== "paused" && r.status !== "running")) throw new Error("没有可以继续的制作");
    r.status = "running";
    r.note = "继续制作";
    this.save();
    void this.kick();
    return this.current;
  }

  /** Ends the run: stops the assistant now; finished cards stay done, the current step is not kept as passed. */
  stop() {
    const r = this.record;
    if (!r || !this.open) return this.current;
    r.status = "stopped";
    r.note = "已结束这次制作。做好的卡片都保留；要撤掉最后一步，可以回到它开始前的检查点";
    this.pauseAsked = false;
    this.abort?.abort();
    for (const t of r.tasks) if (t.state === "doing") t.state = "todo";
    this.save();
    return this.current;
  }

  /** The user answered the decision card. */
  decide(option: DecisionOption) {
    const r = this.record;
    if (!r?.decision || r.status !== "waiting") throw new Error("现在没有要你决定的事");
    const decision = { ...r.decision, chosen: option };
    r.decisions.push(decision);
    r.decision = null;
    const task = r.tasks.find((t) => t.nodeId === decision.nodeId);
    if (option === "stop") return this.stop();
    if (option === "skip" && task) task.state = "skipped";
    if (option === "retry" && task) {
      task.attempts = 0;
      // A fresh start: the next failure is not "the same again" just because the last one was.
      const last = [...r.steps].reverse().find((s) => s.nodeId === task.nodeId && s.state === "failed");
      if (last) last.signature = undefined;
    }
    if (option === "raise") {
      r.limits = { ...r.limits, maxCalls: r.limits.maxCalls + 20, budgetUsd: Math.round((r.limits.budgetUsd + 2) * 100) / 100 };
    }
    r.status = "running";
    r.note = "按你的决定继续";
    this.save();
    void this.kick();
    return this.current;
  }

  /**
   * Continues a run the app lost: back to the checkpoint taken before the
   * interrupted step, then that step again. The assistant's own conversation is
   * not resumed, and nothing past that step is repeated.
   */
  resumeInterrupted() {
    const r = this.record;
    if (!r || r.status !== "interrupted") throw new Error("没有被中断的制作");
    const step = [...r.steps].reverse().find((s) => s.state === "interrupted");
    if (step?.checkpoint) this.deps.rollback(step.checkpoint);
    for (const t of r.tasks) if (t.state === "doing") t.state = "todo";
    r.status = "running";
    r.note = step ? `回到「${step.title}」开始前的状态，重做这一步` : "继续制作";
    this.save();
    void this.kick();
    return this.current;
  }
}
