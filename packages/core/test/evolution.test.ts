import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRunner } from "@agent-together/schema";
import { Evolution, ExperienceStore, MemoryStore, Race, evolutionOutcome, evolutionRanking, evolutionWinner, parseStrategies, scoreContestant, type ContestantResult, type RaceReport } from "@agent-together/core";

const dirs: string[] = [];
const tmp = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "at-evolution-")); dirs.push(dir); return dir; };
afterEach(() => { vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const proposals = JSON.stringify({ strategies: [{ title: "先看测试", text: "先读旧测试再改" }, { title: "缩小改动", text: "只改失败的那条路径" }] });
const llm = { name: "fake", complete: async () => proposals };
function project() {
  const root = tmp();
  fs.mkdirSync(path.join(root, ".agent-together/canvas"), { recursive: true });
  fs.writeFileSync(path.join(root, ".agent-together/canvas/task.json"), JSON.stringify({ id: "task", kind: "feature", title: "任务", files: ["answer.txt"] }));
  return root;
}
function contestant(id: string, passed: boolean | null, lines = 1, extra: { crossed?: boolean; failingOwner?: string } = {}): ContestantResult {
  const findings = extra.crossed ? [{ rule: "scope-fence", level: "ask" as const, message: "outside" }] : [];
  const tests = passed === null ? null : { command: "fake", passed, output: "", ...(passed ? {} : { failing: [{ path: "x.test.ts", owner: extra.failingOwner ?? "task" }] }) };
  const result = { id, commit: "", worktree: "", run: { ok: true, summary: "", durationMs: 1 }, files: [{ path: "answer.txt", added: lines, removed: 0 }], findings, tests };
  return { ...result, score: scoreContestant(result) };
}
const report = (...contestants: ContestantResult[]): RaceReport => ({ id: "fake-race", nodeId: "task", task: "任务", base: "", startedAt: "", finishedAt: "", contestants });
const runner: AgentRunner = { id: "fake", run: async () => ({ ok: true, durationMs: 1, summary: "" }) };

describe("evolution proposals", () => {
  it("parses fenced output and rejects malformed, duplicate or incomplete proposals", () => {
    expect(parseStrategies('```json\n' + proposals + '\n```')).toHaveLength(2);
    for (const bad of ["oops", "null", "{}", '{"strategies":[null,null]}', '{"strategies":[{"title":2,"text":"x"},{}]}', JSON.stringify({ strategies: [{ title: "a", text: " X " }, { title: "b", text: "x" }] })]) expect(parseStrategies(bad)).toEqual([]);
  });
  it("only counts a tested, strictly better strategy as effective", () => {
    expect(evolutionWinner(report(contestant("baseline", false), contestant("strategy-1", true)))).toBe("strategy-1");
    expect(evolutionWinner(report(contestant("baseline", true), contestant("strategy-1", true)))).toBeUndefined();
    expect(evolutionWinner(report(contestant("baseline", true), contestant("strategy-1", false)))).toBeUndefined();
    expect(evolutionWinner(report(contestant("baseline", null, 100), contestant("strategy-1", null)))).toBeUndefined();
    expect(evolutionWinner(report(contestant("baseline", true, 100), contestant("strategy-1", true)))).toBe("strategy-1");
  });
  it("ranks staying in bounds above passing tests", () => {
    // The real add-message run: the baseline passed by editing another node's test, the strategy stayed inside and left that test failing.
    const crossedPass = contestant("baseline", true, 5, { crossed: true });
    const escalated = contestant("strategy-1", false, 2, { failingOwner: "cli-entry" });
    const ownFailure = contestant("strategy-2", false, 1);
    const race = report(crossedPass, escalated, ownFailure);
    expect(evolutionRanking(race)).toEqual(["strategy-1", "strategy-2", "baseline"]);
    expect(evolutionWinner(race)).toBe("strategy-1");
    expect(evolutionOutcome(escalated, "task")).toBe("escalated");
    expect(evolutionOutcome(crossedPass, "task")).toBe("crossed");
  });
  it("never counts a crossing or own-test failure as effective", () => {
    expect(evolutionWinner(report(contestant("baseline", false, 1, { crossed: true }), contestant("strategy-1", false)))).toBeUndefined();
    expect(evolutionWinner(report(contestant("baseline", false), contestant("strategy-1", true, 1, { crossed: true })))).toBeUndefined();
  });
  it("saves a plain explanation without running agents when no model is available", async () => {
    const root = project(); const factory = vi.fn();
    const evolution = new Evolution(root, null, factory);
    const result = await evolution.run("task", "任务", runner);
    expect(result.message).toContain("还没有可用的模型");
    expect(factory).not.toHaveBeenCalled();
    expect(evolution.load(result.id)).toEqual(result);
  });
  it("handles bad replies and model errors without starting contestants", async () => {
    for (const complete of [async () => "bad", async (): Promise<string> => { throw new Error("offline"); }]) {
      const root = project(); const factory = vi.fn();
      const evolution = new Evolution(root, { name: "fake", complete }, factory);
      const result = await evolution.run("task", "任务", runner);
      expect(result.message).toBeTruthy(); expect(factory).not.toHaveBeenCalled();
      expect(new MemoryStore(root).list()).toEqual([]);
    }
  });
});
describe("approval and experience", () => {
  it("writes memory and global evidence only on approval, and approval is idempotent", async () => {
    const root = project(); const experiences = new ExperienceStore(tmp());
    const fake = { run: vi.fn(async () => report(contestant("baseline", false), contestant("strategy-1", true))), adopt: vi.fn() };
    const evolution = new Evolution(root, llm, () => fake as unknown as Race, experiences);
    const result = await evolution.run("task", "任务", runner);
    expect(fake.run.mock.calls).toHaveLength(1);
    expect(new MemoryStore(root).list()).toEqual([]); expect(experiences.list()).toEqual([]);
    evolution.approve(result.id); evolution.approve(result.id);
    const memories = new MemoryStore(root).forNode("task");
    expect(memories).toHaveLength(1); expect(memories[0].content).toBe("先读旧测试再改");
    expect(memories[0].source).toContain(result.id); expect(memories[0].evidence).toContain(result.id);
    expect(experiences.list()[0].projects).toHaveLength(1); expect(fake.adopt).not.toHaveBeenCalled();
  });
  it("counts distinct canonical projects, normalizes strategy keys and uses the env override", () => {
    const dir = tmp(); vi.stubEnv("AGENT_TOGETHER_EXPERIENCE_DIR", dir);
    const store = new ExperienceStore(); const a = project(), b = project(), c = project();
    const strategy = { id: "s", title: "先看测试", text: " Read   TESTS " };
    store.record(strategy, a, "one"); store.record(strategy, path.join(a, "."), "two");
    expect(store.list()[0].projects).toHaveLength(1); expect(store.suggestions(c)).toEqual([]);
    store.record({ ...strategy, text: "read tests" }, b, "three");
    expect(store.list()).toHaveLength(1); expect(store.suggestions(c)).toHaveLength(1); expect(store.suggestions(a)).toEqual([]);
  });
  it("refuses approval when no strategy beats the baseline", async () => {
    const root = project();
    const fake = { run: async () => report(contestant("baseline", true), contestant("strategy-1", true)) };
    const evolution = new Evolution(root, llm, () => fake as unknown as Race, new ExperienceStore(tmp()));
    const result = await evolution.run("task", "任务", runner);
    expect(() => evolution.approve(result.id)).toThrow(); expect(new MemoryStore(root).list()).toEqual([]);
  });
});
it("reuses worktrees for the same runner with distinct strategy contexts and a shared start", async () => {
  const root = project();
  execFileSync("git", ["init", "-q"], { cwd: root });
  fs.writeFileSync(path.join(root, "answer.txt"), "old");
  fs.writeFileSync(path.join(root, ".agent-together/race.json"), JSON.stringify({ testCommand: `node -e "process.exit(require('fs').readFileSync('answer.txt','utf8')==='good'?0:1)"` }));
  const contexts: string[] = [], worktrees: string[] = [];
  const fakeRunner: AgentRunner = { id: "same-agent", async run(cwd) {
    expect(fs.readFileSync(path.join(cwd, "answer.txt"), "utf8")).toBe("old");
    const context = fs.readFileSync(path.join(cwd, ".agent-together/context/task.md"), "utf8");
    contexts.push(context); worktrees.push(cwd);
    fs.writeFileSync(path.join(cwd, "answer.txt"), context.includes("先读旧测试再改") ? "good" : "bad");
    return { ok: true, durationMs: 1, summary: "fake", costUsd: 0 };
  } };
  const evolution = new Evolution(root, llm, undefined, new ExperienceStore(tmp()));
  const result = await evolution.run("task", "修好任务", fakeRunner);
  expect(result.race?.contestants).toHaveLength(3); expect(result.winner).toBe("strategy-1");
  expect(new Set(worktrees).size).toBe(3); expect(contexts.filter(c => c.includes("这次尝试的做法"))).toHaveLength(2);
  expect(fs.readFileSync(path.join(root, "answer.txt"), "utf8")).toBe("old");
  expect(new MemoryStore(root).list()).toEqual([]);
  evolution.approve(result.id, true);
  expect(fs.readFileSync(path.join(root, "answer.txt"), "utf8")).toBe("good");
  expect(worktrees.every(w => !fs.existsSync(w))).toBe(true);
}, 60000);

it("records consecutive failures per node and resets the streak on success", async () => {
  const { runProjectTests, testHistory } = await import("@agent-together/core");
  const root = project();
  const config = path.join(root, ".agent-together/project.json");
  fs.writeFileSync(config, JSON.stringify({ testCommand: 'node -e "process.exit(1)"' }));
  await runProjectTests(root, "task"); await runProjectTests(root, "task");
  expect(testHistory(root).consecutiveFailures?.task).toBe(2);
  expect(testHistory(root).recent?.task).toHaveLength(2);
  fs.writeFileSync(config, JSON.stringify({ testCommand: 'node -e "process.exit(0)"' }));
  await runProjectTests(root, "task");
  expect(testHistory(root).consecutiveFailures?.task).toBe(0);
});
