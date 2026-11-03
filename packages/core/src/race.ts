import { exec as execShell, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentRunner, Finding, LoomEvent, Memory, RunResult } from "@loom/schema";
import { capabilityRules, CapabilityStore } from "./capabilities.js";
import { Checkpoints } from "./checkpoints.js";
import { buildNodeContext } from "./context.js";
import { Observer } from "./observer.js";
import { builtinRules } from "./rules/index.js";
import { LoomStore } from "./store.js";
import { dispatchPrompt } from "./terminal.js";

/** .loom/race.json */
export interface RaceConfig {
  /** Run in each contestant's copy of the project after it finishes, e.g. "npm test". */
  testCommand?: string;
  /** Per agent, default 15 minutes. */
  timeoutMs?: number;
}

export interface ScorePart {
  label: string;
  points: number;
}

export interface ContestantResult {
  id: string;
  /** Snapshot of the contestant's project after its run (kept under refs/loom/races/). */
  commit: string;
  worktree: string;
  run: RunResult;
  files: { path: string; added: number; removed: number }[];
  findings: Finding[];
  tests: { command: string; passed: boolean; output: string } | null;
  score: { total: number; parts: ScorePart[] };
}

export interface RaceReport {
  id: string;
  nodeId: string;
  task: string;
  /** Common starting point: a snapshot of the project when the race began. */
  base: string;
  startedAt: string;
  finishedAt: string;
  contestants: ContestantResult[];
  adopted?: string;
}

const SKIP = (rel: string) => rel.startsWith(".loom/") || rel.split("/").includes("node_modules");

function git(cwd: string, args: string[], input?: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 }).trim();
}

function runShell(command: string, cwd: string, timeoutMs: number): Promise<{ passed: boolean; output: string }> {
  return new Promise((resolve) =>
    execShell(command, { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) =>
      resolve({ passed: !err, output: `${stdout}${stderr}`.trim().slice(-2000) }),
    ),
  );
}

/**
 * Transparent, deterministic score. Everything starts at 100; each part says
 * why points were taken or given. Cost and time are shown, not scored: the
 * human picks the winner.
 */
export function scoreContestant(c: Pick<ContestantResult, "run" | "files" | "findings" | "tests">): { total: number; parts: ScorePart[] } {
  const parts: ScorePart[] = [];
  if (!c.run.ok) parts.push({ label: "agent 没有正常结束", points: -30 });
  if (!c.files.length) parts.push({ label: "没有任何改动", points: -30 });
  if (c.tests) parts.push(c.tests.passed ? { label: "测试通过", points: 40 } : { label: "测试失败", points: -40 });
  for (const f of c.findings) {
    if (f.level === "ask" || f.level === "block") parts.push({ label: `违反 ${f.rule}`, points: -15 });
    else if (f.level === "warn") parts.push({ label: `提醒 ${f.rule}`, points: -5 });
  }
  const lines = c.files.reduce((n, f) => n + f.added + f.removed, 0);
  const sizePenalty = Math.min(15, Math.floor(lines / 20));
  if (sizePenalty) parts.push({ label: `改动 ${lines} 行`, points: -sizePenalty });
  return { total: 100 + parts.reduce((n, p) => n + p.points, 0), parts };
}

export class Race {
  private readonly store: LoomStore;
  private readonly top: string;
  /** The project folder relative to the repository root ("" when they are the same). */
  private readonly rel: string;

  constructor(readonly root: string) {
    this.store = new LoomStore(root);
    this.top = git(root, ["rev-parse", "--show-toplevel"]);
    this.rel = path.relative(this.top, root).split(path.sep).join("/");
  }

  private reportFile(id: string) {
    return path.join(this.store.dir, "races", `${id}.json`);
  }

  load(id: string): RaceReport {
    return JSON.parse(fs.readFileSync(this.reportFile(id), "utf8"));
  }

  private save(report: RaceReport) {
    fs.mkdirSync(path.dirname(this.reportFile(report.id)), { recursive: true });
    fs.writeFileSync(this.reportFile(report.id), JSON.stringify(report, null, 2));
  }

  /** Repo-relative path → project-relative, or null outside the project. */
  private toProject(repoRel: string): string | null {
    if (!this.rel) return repoRel;
    return repoRel.startsWith(`${this.rel}/`) ? repoRel.slice(this.rel.length + 1) : null;
  }

  /**
   * Gives every runner the same node, task and starting snapshot, each in its own
   * git worktree, runs them in parallel, then scores what each one changed.
   */
  async run(
    nodeId: string,
    task: string,
    runners: AgentRunner[],
    memories: Memory[] = [],
    onProgress: (message: string) => void = () => {},
  ): Promise<RaceReport> {
    const config: RaceConfig = fs.existsSync(path.join(this.store.dir, "race.json"))
      ? JSON.parse(fs.readFileSync(path.join(this.store.dir, "race.json"), "utf8"))
      : {};
    const canvas = this.store.loadCanvas();
    const startedAt = new Date().toISOString();
    const id = `${startedAt.replace(/[-:.]/g, "").replace("T", "-").slice(0, 15)}-${nodeId}`.slice(0, 80);
    const base = new Checkpoints(this.root).snapshot(`赛马起点 ${id}`);
    git(this.top, ["update-ref", `refs/loom/races/${id}/base`, base]);
    const context = buildNodeContext(canvas, nodeId, task, memories);

    const contestants = await Promise.all(
      runners.map(async (runner): Promise<ContestantResult> => {
        const worktree = path.join(os.tmpdir(), `loom-race-${id}`, runner.id);
        git(this.top, ["worktree", "add", "--detach", worktree, base]);
        const project = path.join(worktree, this.rel);
        fs.mkdirSync(path.join(project, ".loom", "context"), { recursive: true });
        fs.writeFileSync(path.join(project, ".loom", "context", `${nodeId}.md`), context);
        const deps = path.join(this.root, "node_modules");
        if (fs.existsSync(deps) && !fs.existsSync(path.join(project, "node_modules"))) {
          fs.symlinkSync(deps, path.join(project, "node_modules"), "junction");
        }
        onProgress(`${runner.id} 开始`);
        const run = await runner.run(project, dispatchPrompt(`.loom/context/${nodeId}.md`), config.timeoutMs ?? 15 * 60_000);
        onProgress(`${runner.id} 结束（${Math.round(run.durationMs / 1000)}s）`);

        const commit = new Checkpoints(project).snapshot(`赛马 ${id} ${runner.id}`);
        git(this.top, ["update-ref", `refs/loom/races/${id}/${runner.id}`, commit]);
        const files = git(this.top, ["diff-tree", "-r", "--numstat", base, commit])
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            const [added, removed, repoPath] = line.split("\t");
            return { path: this.toProject(repoPath), added: Number(added) || 0, removed: Number(removed) || 0 };
          })
          .filter((f): f is { path: string; added: number; removed: number } => f.path !== null && !SKIP(f.path));

        const findings = this.replay(project, nodeId, base, files.map((f) => f.path), runner.id);
        const tests = config.testCommand
          ? { command: config.testCommand, ...(await runShell(config.testCommand, project, 5 * 60_000)) }
          : null;
        const result = { id: runner.id, commit, worktree, run, files, findings, tests };
        return { ...result, score: scoreContestant(result) };
      }),
    );

    const report: RaceReport = { id, nodeId, task, base, startedAt, finishedAt: new Date().toISOString(), contestants };
    this.save(report);
    return report;
  }

  /** Runs each changed file through the observer as if the agent had written it live. */
  private replay(project: string, nodeId: string, base: string, files: string[], sessionId: string): Finding[] {
    const capabilities = new CapabilityStore(this.root).list();
    const observer = new Observer(
      project,
      this.store.loadCanvas(),
      this.store.loadRuleLevels(),
      [...builtinRules, ...capabilityRules(capabilities)],
      nodeId,
    );
    const findings: Finding[] = [];
    for (const rel of files) {
      const repoPath = this.rel ? `${this.rel}/${rel}` : rel;
      let before: string | undefined;
      try {
        before = git(this.top, ["show", `${base}:${repoPath}`]);
      } catch {
        before = undefined; // new file
      }
      const full = path.join(project, rel);
      const after = fs.existsSync(full) ? fs.readFileSync(full, "utf8") : "";
      const event: LoomEvent = {
        kind: "tool.before",
        platform: sessionId === "codex" ? "codex" : "claude-code",
        sessionId,
        at: new Date().toISOString(),
        action: { type: "write", path: full, before, after },
      };
      findings.push(...observer.evaluate(event).findings);
    }
    return findings;
  }

  /**
   * Applies a contestant's changes to the real project (after saving a
   * checkpoint), then removes the race's worktrees.
   */
  adopt(id: string, contestantId: string): void {
    const report = this.load(id);
    const winner = report.contestants.find((c) => c.id === contestantId);
    if (!winner) throw new Error(`no contestant ${contestantId} in race ${id}`);
    new Checkpoints(this.root).create(`采用赛马 ${contestantId} 之前`, report.nodeId);
    const scope = this.rel || ".";
    const exclude = [`:(exclude)${this.rel ? `${this.rel}/` : ""}.loom`, ":(exclude)**/node_modules"];
    const patch = execFileSync("git", ["diff", "--binary", report.base, winner.commit, "--", scope, ...exclude], {
      cwd: this.top,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    if (patch.trim()) git(this.top, ["apply", "--whitespace=nowarn", "-"], patch);
    this.save({ ...report, adopted: contestantId });
    this.cleanup(report);
  }

  /** Removes the race's worktrees and refs; the report stays. */
  discard(id: string): void {
    this.cleanup(this.load(id));
  }

  private cleanup(report: RaceReport) {
    for (const c of report.contestants) {
      try {
        git(this.top, ["worktree", "remove", "--force", c.worktree]);
      } catch {
        fs.rmSync(c.worktree, { recursive: true, force: true });
      }
      try {
        git(this.top, ["update-ref", "-d", `refs/loom/races/${report.id}/${c.id}`]);
      } catch {}
    }
    try {
      git(this.top, ["update-ref", "-d", `refs/loom/races/${report.id}/base`]);
    } catch {}
    git(this.top, ["worktree", "prune"]);
  }
}
