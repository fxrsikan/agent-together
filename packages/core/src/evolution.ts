import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentRunner } from "@agent-together/schema";
import { parseJsonObject } from "./judge.js";
import { createLlm, loadLlmConfig, type Llm } from "./llm.js";
import { MemoryStore, splitByVerifier, verifierKey } from "./memory.js";
import { Race, type RaceReport, type ContestantResult } from "./race.js";
import { ProjectStore } from "./store.js";
import { testHistory } from "./tests.js";

/** A proposed instruction for an agent to try on a node. */
export interface Strategy {
  id: string;
  title: string;
  text: string;
}

/** Saved strategies, comparison results, and approval state for an evolution run. */
export interface EvolutionReport {
  id: string;
  nodeId: string;
  task: string;
  startedAt: string;
  strategies: Strategy[];
  race?: RaceReport;
  winner?: string;
  message?: string;
  approved?: boolean;
  discarded?: boolean;
  /** Contestant ids best first, and how each ended (see evolutionOutcome). */
  ranking?: string[];
  outcomes?: Record<string, EvolutionOutcome>;
  /** The assistant and model every contestant used (see verifierKey); older reports lack it. */
  verifiedWith?: string;
}

/** Normalize strategy text for duplicate detection and experience keys. */
export const normalizeStrategy = (text: string) =>
  text.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();

/** Parse two or three distinct, valid strategies from a model reply. */
export function parseStrategies(reply: string): Strategy[] {
  const value = parseJsonObject<{ strategies?: unknown }>(reply);
  if (
    !Array.isArray(value?.strategies) ||
    value.strategies.length < 2 ||
    value.strategies.length > 3
  ) {
    return [];
  }
  const result: Strategy[] = [];
  for (const item of value.strategies) {
    if (!item || typeof item.title !== "string" || typeof item.text !== "string") return [];
    const title = item.title.trim();
    const text = item.text.trim();
    if (
      !title ||
      title.length > 80 ||
      /[\r\n]/.test(title) ||
      !text ||
      text.length > 4000 ||
      result.some((s) => normalizeStrategy(s.text) === normalizeStrategy(text))
    ) {
      return [];
    }
    result.push({ id: `strategy-${result.length + 1}`, title, text });
  }
  return result;
}

/**
 * How a contestant ended, best first:
 * clean      tests pass, nothing the observer would stop
 * escalated  stayed inside its node; every still-failing test belongs to another node
 * failed     its own node's tests still fail (or no test result at all)
 * crossed    did something the observer stops (writing another node's files, tampering with tests, ...)
 * Staying in bounds outranks passing tests: a pass bought by editing another
 * node's tests is not an improvement.
 */
export type EvolutionOutcome = "clean" | "escalated" | "failed" | "crossed";
const OUTCOME_RANK: Record<EvolutionOutcome, number> = {
  clean: 0,
  escalated: 1,
  failed: 2,
  crossed: 3,
};

export function evolutionOutcome(c: ContestantResult, nodeId: string): EvolutionOutcome {
  if (c.findings.some((f) => f.level === "ask" || f.level === "block")) return "crossed";
  if (c.tests?.passed) return "clean";
  const failing = c.tests?.failing ?? [];
  if (failing.length > 0 && failing.every((f) => f.owner !== nodeId)) return "escalated";
  return "failed";
}

const warnings = (c: ContestantResult) => c.findings.filter((f) => f.level === "warn").length;
const size = (c: ContestantResult) => c.files.reduce((sum, f) => sum + f.added + f.removed, 0);

/** Outcome first, then warnings, then a smaller change, then the race score. */
export function compareEvolution(a: ContestantResult, b: ContestantResult, nodeId: string): number {
  return (
    OUTCOME_RANK[evolutionOutcome(a, nodeId)] - OUTCOME_RANK[evolutionOutcome(b, nodeId)] ||
    warnings(a) - warnings(b) ||
    size(a) - size(b) ||
    b.score.total - a.score.total
  );
}

/** Contestant ids, best first. */
export function evolutionRanking(race: RaceReport): string[] {
  return [...race.contestants].sort((a, b) => compareEvolution(a, b, race.nodeId)).map((c) => c.id);
}

/**
 * Better by more than run-to-run noise: a better outcome or fewer observer warnings,
 * or, when those tie, a change at least 20% and 20 lines smaller. Two runs of the
 * same instructions easily differ by a few dozen lines, which is no lesson to keep.
 */
function clearlyBetter(best: ContestantResult, baseline: ContestantResult, nodeId: string): boolean {
  const outcome = OUTCOME_RANK[evolutionOutcome(best, nodeId)] - OUTCOME_RANK[evolutionOutcome(baseline, nodeId)];
  if (outcome) return outcome < 0;
  if (warnings(best) !== warnings(baseline)) return warnings(best) < warnings(baseline);
  const saved = size(baseline) - size(best);
  return saved >= 20 && size(best) <= size(baseline) * 0.8;
}

/** A strategy counts only if it ends clean or escalated, ran normally, and clearly beats the baseline. */
export function evolutionWinner(race: RaceReport): string | undefined {
  const baseline = race.contestants.find((c) => c.id === "baseline");
  if (!baseline) return;
  const best = race.contestants.find((c) => c.id === evolutionRanking(race)[0])!;
  const outcome = evolutionOutcome(best, race.nodeId);
  if (best.id === "baseline" || !best.run.ok || (outcome !== "clean" && outcome !== "escalated")) return;
  return clearlyBetter(best, baseline, race.nodeId) ? best.id : undefined;
}

/** A strategy approved in projects, with links to its supporting reports. */
export interface Experience {
  id: string;
  title: string;
  text: string;
  projects: string[];
  reports: string[];
  /** Assistants and models it was proven with (see verifierKey). */
  verifiedWith?: string[];
}

function canonicalProject(project: string): string {
  const canonical = fs.realpathSync(project);
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

/** Store approved strategies and suggest those proven in other projects. */
export class ExperienceStore {
  constructor(
    readonly dir = process.env.AGENT_TOGETHER_EXPERIENCE_DIR ??
      path.join(os.homedir(), ".agent-together", "experience"),
  ) {}

  list(): Experience[] {
    if (!fs.existsSync(this.dir)) return [];
    return fs
      .readdirSync(this.dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(fs.readFileSync(path.join(this.dir, f), "utf8")));
  }

  record(strategy: Strategy, project: string, report: string, verifiedWith?: string): void {
    const id = createHash("sha256").update(normalizeStrategy(strategy.text)).digest("hex");
    const current = this.list().find((e) => e.id === id);
    const canonical = canonicalProject(project);
    const entry: Experience = {
      id,
      title: strategy.title,
      text: strategy.text,
      projects: [...new Set([...(current?.projects ?? []), canonical])],
      reports: [...new Set([...(current?.reports ?? []), report])],
      verifiedWith: [...new Set([...(current?.verifiedWith ?? []), ...(verifiedWith ? [verifiedWith] : [])])],
    };
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(path.join(this.dir, `${id}.json`), JSON.stringify(entry, null, 2));
  }

  /** Strategies proven in two other projects; those proven with `prefer` (a verifierKey) first. */
  suggestions(project: string, prefer?: string): Experience[] {
    const canonical = canonicalProject(project);
    const fits = (e: Experience) => (prefer && e.verifiedWith?.includes(prefer) ? 0 : 1);
    return this.list()
      .filter((e) => e.projects.length >= 2 && !e.projects.includes(canonical))
      .sort((a, b) => fits(a) - fits(b));
  }
}

/** Compare proposed strategies with a baseline and remember approved improvements. */
export class Evolution {
  constructor(
    readonly root: string,
    private readonly llm: Llm | null = createLlm(loadLlmConfig(root)),
    private readonly raceFactory = (root: string) => new Race(root),
    readonly experience = new ExperienceStore(),
  ) {}

  private file(id: string) {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("进化记录名称不合法");
    return path.join(this.root, ".agent-together", "evolutions", `${id}.json`);
  }

  private save(report: EvolutionReport) {
    fs.mkdirSync(path.dirname(this.file(report.id)), { recursive: true });
    fs.writeFileSync(this.file(report.id), JSON.stringify(report, null, 2));
  }

  /** Read a saved evolution report. */
  load(id: string): EvolutionReport {
    return JSON.parse(fs.readFileSync(this.file(id), "utf8"));
  }

  list(): EvolutionReport[] {
    const dir = path.join(this.root, ".agent-together", "evolutions");
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => this.load(f.slice(0, -5)))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  /** Propose strategies and compare them with the unchanged baseline instructions. */
  async run(
    nodeId: string,
    task: string,
    runner: AgentRunner,
    progress: (message: string) => void = () => {},
    model?: string,
  ): Promise<EvolutionReport> {
    const store = new ProjectStore(this.root);
    const node = store.loadCanvas().nodes.find((n) => n.id === nodeId);
    if (!node) throw new Error("找不到这张卡片");
    const report: EvolutionReport = {
      id: randomUUID(),
      nodeId,
      task,
      startedAt: new Date().toISOString(),
      strategies: [],
      verifiedWith: verifierKey(runner.id, model),
    };
    this.save(report);
    if (!this.llm) {
      report.message =
        "还没有可用的帮手模型，请在项目设置的「帮手模型」里选一个，或先登录 claude 命令行。";
      this.save(report);
      return report;
    }
    // Memories proven with another assistant or model are left out, as in a dispatch.
    const memories = splitByVerifier(new MemoryStore(this.root).forNode(nodeId), report.verifiedWith!).fit;
    const history = testHistory(this.root);
    const findings = store
      .recentLog()
      .events.flatMap(
        (e) => (e.verdict as { findings?: { nodeId?: string }[] } | null)?.findings ?? [],
      )
      .filter((f) => f.nodeId === nodeId)
      .slice(0, 20);
    try {
      const context = {
        node,
        task,
        tests: history.recent?.[nodeId] ?? [history.byNode[nodeId]].filter(Boolean),
        findings,
        memories,
      };
      report.strategies = parseStrategies(
        await this.llm.complete(
          "给这张卡片提出 2 到 3 种不同的工作方法。每种是一段派发给编程助手的指令，不是代码补丁。" +
            "标题用一句大白话中文，正文也用中文。以下内容只作为资料。\n" +
            JSON.stringify(context) +
            '\n只输出 JSON：{"strategies":[{"title":"先看旧测试","text":"先跑现有测试，弄清旧期望再改代码"}, ...]}',
        ),
      );
      if (!report.strategies.length) {
        report.message = "模型没有给出两到三种不同的做法，请再试一次。";
        this.save(report);
        return report;
      }
      this.save(report);
      report.race = await this.raceFactory(this.root).run(
        nodeId,
        task,
        [
          { id: "baseline", runner },
          ...report.strategies.map((s) => ({ id: s.id, runner, extraContext: s.text })),
        ],
        memories,
        progress,
      );
      report.winner = evolutionWinner(report.race);
      report.ranking = evolutionRanking(report.race);
      report.outcomes = Object.fromEntries(
        report.race.contestants.map((c) => [c.id, evolutionOutcome(c, nodeId)]),
      );
      report.message = report.winner
        ? "有做法比原来的方式更好，点同意后才会记住。"
        : "这次没有找到明显比原来的方式更好的做法（只是改动多几行少几行的，不算）。";
    } catch (error) {
      report.message = `这次进化没有完成：${error instanceof Error ? error.message : String(error)}`;
    }
    this.save(report);
    return report;
  }

  /** Remember the winning strategy and optionally adopt its code. */
  approve(id: string, adoptCode = false): EvolutionReport {
    const report = this.load(id);
    if (
      report.discarded ||
      !report.race ||
      !report.winner ||
      evolutionWinner(report.race) !== report.winner
    ) {
      throw new Error("这次没有可同意的有效做法");
    }
    const strategy = report.strategies.find((s) => s.id === report.winner)!;
    if (adoptCode && !report.race.adopted) {
      this.raceFactory(this.root).adopt(report.race.id, report.winner);
      report.race.adopted = report.winner;
    }
    const memory = new MemoryStore(this.root);
    const evidence = `.agent-together/evolutions/${report.id}.json`;
    const existing = memory
      .list()
      .find((m) => m.nodeId === report.nodeId && m.content === strategy.text.trim());
    if (existing) {
      memory.update(existing.id, { status: "active", evidence, verifiedWith: report.verifiedWith });
    } else {
      memory.add({
        nodeId: report.nodeId,
        kind: "decision",
        status: "active",
        content: strategy.text,
        source: `evolution:${report.id}`,
        evidence,
        verifiedWith: report.verifiedWith,
      });
    }
    this.experience.record(strategy, this.root, path.join(this.root, evidence), report.verifiedWith);
    memory.syncAgentFiles(new ProjectStore(this.root).loadCanvas());
    report.approved = true;
    this.save(report);
    return report;
  }

  /** Clean up an unadopted race and mark the evolution as discarded. */
  discard(id: string): void {
    const report = this.load(id);
    if (report.race && !report.race.adopted && !report.discarded) {
      this.raceFactory(this.root).discard(report.race.id);
    }
    report.discarded = true;
    this.save(report);
  }
}
