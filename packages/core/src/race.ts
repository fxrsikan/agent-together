import { exec as execShell, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { AgentRunner, Finding, AgentEvent, Memory, RunResult } from "@agent-together/schema";
import { capabilityRules, CapabilityStore } from "./capabilities.js";
import { Checkpoints } from "./checkpoints.js";
import { buildNodeContext } from "./context.js";
import { readProjectInfo } from "./project.js";
import { failingTestFiles, testCommandFor } from "./tests.js";
import { ownerOf } from "./owners.js";
import { Observer } from "./observer.js";
import { builtinRules } from "./rules/index.js";
import { ProjectStore } from "./store.js";
import { ruleLabel } from "./setup.js";
import { dispatchPrompt } from "./terminal.js";

/** .agent-together/race.json */
export interface RaceConfig {
  /** Run in each contestant's copy of the project after it finishes, e.g. "npm test"; default: the project's test command. */
  testCommand?: string;
  /** Per agent, default 15 minutes. */
  timeoutMs?: number;
  /** Who races, by agent id; default ["claude-code", "codex"]. */
  agents?: string[];
  /** Model per agent id, e.g. { "claude-code": "haiku" }; used when the caller names none. */
  models?: Record<string, string>;
}

export function loadRaceConfig(root: string): RaceConfig {
  const file = path.join(root, ".agent-together", "race.json");
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
}

export interface ScorePart {
  label: string;
  points: number;
}

export interface ContestantResult {
  id: string;
  /** Snapshot of the contestant's project after its run (kept under refs/agent-together/races/). */
  commit: string;
  worktree: string;
  run: RunResult;
  files: { path: string; added: number; removed: number }[];
  findings: Finding[];
  tests: {
    command: string;
    passed: boolean;
    output: string;
    /** Test files still failing and the node that owns each (absent when tests pass). */
    failing?: { path: string; owner: string | null }[];
  } | null;
  score: { total: number; parts: ScorePart[] };
}

export interface RaceContestant {
  id: string;
  runner: AgentRunner;
  extraContext?: string;
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
  /** Worktrees removed without adopting anyone. */
  discarded?: boolean;
}

const SKIP = (rel: string) => rel.startsWith(".agent-together/") || rel.split("/").includes("node_modules");

function git(cwd: string, args: string[], input?: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 }).trim();
}

/** Full output; callers keep only the tail they show. */
function runShell(command: string, cwd: string, timeoutMs: number): Promise<{ passed: boolean; output: string }> {
  return new Promise((resolve) =>
    execShell(command, { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) =>
      resolve({ passed: !err, output: `${stdout}${stderr}`.trim() }),
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
  if (!c.run.ok) parts.push({ label: "AI 助手没有正常结束", points: -30 });
  if (!c.files.length) parts.push({ label: "没有任何改动", points: -30 });
  if (c.tests) parts.push(c.tests.passed ? { label: "测试通过", points: 40 } : { label: "测试失败", points: -40 });
  for (const f of c.findings) {
    // ruleLabel is already plain Chinese (e.g. "越界写入"); prefix without repeating "违反".
    if (f.level === "ask" || f.level === "block") parts.push({ label: `拦下：${ruleLabel(f.rule)}`, points: -15 });
    else if (f.level === "warn") parts.push({ label: `提醒：${ruleLabel(f.rule)}`, points: -5 });
  }
  const lines = c.files.reduce((n, f) => n + f.added + f.removed, 0);
  const sizePenalty = Math.min(15, Math.floor(lines / 20));
  if (sizePenalty) parts.push({ label: `改动 ${lines} 行`, points: -sizePenalty });
  return { total: 100 + parts.reduce((n, p) => n + p.points, 0), parts };
}

export class Race {
  private readonly store: ProjectStore;
  private readonly top: string;
  /** The project folder relative to the repository root ("" when they are the same). */
  private readonly rel: string;

  constructor(readonly root: string) {
    this.store = new ProjectStore(root);
    this.top = git(root, ["rev-parse", "--show-toplevel"]);
    this.rel = path.relative(this.top, root).split(path.sep).join("/");
  }

  private reportFile(id: string) {
    return path.join(this.store.dir, "races", `${id}.json`);
  }

  load(id: string): RaceReport {
    return JSON.parse(fs.readFileSync(this.reportFile(id), "utf8"));
  }

  /** Saved reports, newest first. */
  list(): RaceReport[] {
    const dir = path.join(this.store.dir, "races");
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as RaceReport)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
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
    runners: (AgentRunner | RaceContestant)[],
    memories: Memory[] = [],
    onProgress: (message: string) => void = () => {},
    /** The context file to hand out instead of the generated one (edited in the context inspector). */
    contextOverride?: string,
  ): Promise<RaceReport> {
    const config = loadRaceConfig(this.root);
    const testCommand = config.testCommand ?? testCommandFor(this.root);
    const canvas = this.store.loadCanvas();
    const startedAt = new Date().toISOString();
    const id = `${randomUUID().slice(0, 8)}-${startedAt.replace(/[-:.]/g, "").replace("T", "-").slice(0, 15)}-${nodeId}`.slice(0, 80);
    const base = new Checkpoints(this.root).snapshot(`赛马起点 ${id}`);
    git(this.top, ["update-ref", `refs/agent-together/races/${id}/base`, base]);
    const context = contextOverride ?? buildNodeContext(canvas, nodeId, task, memories, readProjectInfo(this.root));

    const contestants = await Promise.all(
      runners.map(async (entry): Promise<ContestantResult> => {
        const runner = "runner" in entry ? entry.runner : entry;
        const contestantId = entry.id;
        if (!/^[a-zA-Z0-9_-]+$/.test(contestantId)) throw new Error("参赛名称不合法");
        const extra = "runner" in entry ? entry.extraContext : undefined;
        const worktree = path.join(os.tmpdir(), `agent-together-race-${id}`, contestantId);
        git(this.top, ["worktree", "add", "--detach", worktree, base]);
        const project = path.join(worktree, this.rel);
        fs.mkdirSync(path.join(project, ".agent-together", "context"), { recursive: true });
        fs.writeFileSync(path.join(project, ".agent-together", "context", `${nodeId}.md`), context + (extra ? `\n\n## 这次尝试的做法\n${extra}` : ""));
        const deps = path.join(this.root, "node_modules");
        if (fs.existsSync(deps) && !fs.existsSync(path.join(project, "node_modules"))) {
          fs.symlinkSync(deps, path.join(project, "node_modules"), "junction");
        }
        onProgress(`${contestantId} 开始`);
        const started = Date.now();
        let run: RunResult;
        try {
          run = await runner.run(project, dispatchPrompt(`.agent-together/context/${nodeId}.md`), config.timeoutMs ?? 15 * 60_000);
        } catch (error) {
          run = { ok: false, summary: String(error), durationMs: Date.now() - started };
        }
        onProgress(`${contestantId} 结束（${Math.round(run.durationMs / 1000)}s）`);

        const commit = new Checkpoints(project).snapshot(`赛马 ${id} ${contestantId}`);
        git(this.top, ["update-ref", `refs/agent-together/races/${id}/${contestantId}`, commit]);
        const files = git(this.top, ["diff-tree", "-r", "--numstat", base, commit])
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            const [added, removed, repoPath] = line.split("\t");
            return { path: this.toProject(repoPath), added: Number(added) || 0, removed: Number(removed) || 0 };
          })
          .filter((f): f is { path: string; added: number; removed: number } => f.path !== null && !SKIP(f.path));

        const findings = this.replay(project, nodeId, base, files.map((f) => f.path), runner.id);
        let tests: ContestantResult["tests"] = null;
        if (testCommand) {
          const { passed, output } = await runShell(testCommand, project, 5 * 60_000);
          tests = { command: testCommand, passed, output: output.slice(-2000) };
          if (!passed) tests.failing = failingTestFiles(output, project).map((p) => ({ path: p, owner: ownerOf(canvas, p)?.id ?? null }));
        }
        const result = { id: contestantId, commit, worktree, run, files, findings, tests };
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
      const event: AgentEvent = {
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
    const exclude = [`:(exclude)${this.rel ? `${this.rel}/` : ""}.agent-together`, ":(exclude)**/node_modules"];
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
    const report = this.load(id);
    this.save({ ...report, discarded: true });
    this.cleanup(report);
  }

  private cleanup(report: RaceReport) {
    for (const c of report.contestants) {
      try {
        git(this.top, ["worktree", "remove", "--force", c.worktree]);
      } catch {
        fs.rmSync(c.worktree, { recursive: true, force: true });
      }
      try {
        git(this.top, ["update-ref", "-d", `refs/agent-together/races/${report.id}/${c.id}`]);
      } catch {}
    }
    try {
      git(this.top, ["update-ref", "-d", `refs/agent-together/races/${report.id}/base`]);
    } catch {}
    git(this.top, ["worktree", "prune"]);
  }
}
