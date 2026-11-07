import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Canvas, Spec } from "@agent-together/schema";
import { Engine, failureSignature, integrationGrants, versionCards, type EngineDeps, type StepOutcome } from "@agent-together/core";

/** Waits (up to a few seconds) until the condition holds: timing-independent under a busy test run. */
const until = async (ok: () => boolean) => {
  for (let i = 0; i < 400 && !ok(); i++) await new Promise((r) => setTimeout(r, 10));
};

const canvas = () =>
  Canvas.parse({
    version: 1,
    nodes: [
      { id: "integration", kind: "flow", title: "集成", files: ["server.js"], scenarios: ["S-01", "S-02"] },
      { id: "pages", kind: "feature", title: "页面", files: ["public/**"], scenarios: ["S-01"] },
      { id: "store", kind: "module", title: "存储", files: ["src/store/**"], scenarios: ["S-02"] },
      { id: "setup", kind: "module", title: "项目骨架", files: ["package.json"] },
      { id: "old", kind: "module", title: "旧卡片", files: ["bin/**"] },
    ],
    edges: [
      { from: "integration", to: "pages" },
      { from: "integration", to: "store" },
      { from: "store", to: "setup" },
      { from: "pages", to: "setup" },
    ],
  });
const spec = Spec.parse({ status: "confirmed", scenarios: [{ id: "S-01", name: "a" }, { id: "S-02", name: "b" }] });

const pass: StepOutcome = { run: { ok: true, summary: "做好了", costUsd: 0.01, durationMs: 10 }, tests: { passed: true, pass: 3, fail: 0, command: "node --test" }, audit: { findings: [] } };
const fail = (line = "AssertionError: expected 2 to equal 3 at 12ms"): StepOutcome => ({
  run: { ok: true, summary: "改了", costUsd: 0.01, durationMs: 10 },
  tests: { passed: false, pass: 1, fail: 1, command: "node --test", output: `✖ save works\n${line}`, failingFiles: ["src/store/a.test.js"] },
  audit: { findings: [] },
});

function harness(script: (nodeId: string, n: number) => StepOutcome | Promise<StepOutcome>, extra: Partial<EngineDeps> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "at-engine-"));
  const c = canvas();
  const calls: { nodeId: string; task: string; grants: string[] }[] = [];
  const done: string[] = [];
  const rolledBack: string[] = [];
  let checkpoints = 0;
  const deps: EngineDeps = {
    exec: async (s) => (calls.push({ nodeId: s.nodeId, task: s.task, grants: s.grants }), script(s.nodeId, calls.filter((c) => c.nodeId === s.nodeId).length)),
    canvas: () => c,
    spec: () => spec,
    markDone: (id) => {
      done.push(id);
      c.nodes.find((n) => n.id === id)!.status = "done";
    },
    checkpoint: () => `cp${++checkpoints}`,
    rollback: (commit) => rolledBack.push(commit),
    auditRequired: true,
    ...extra,
  };
  return { root, deps, calls, done, rolledBack, engine: () => new Engine(root, deps) };
}

describe("which cards a version needs, in what order", () => {
  it("takes the scenarios' cards and what they depend on, dependencies first, done ones out", () => {
    expect(versionCards(canvas(), spec).map((n) => n.id)).toEqual(["setup", "pages", "store", "integration"]);
    const c = canvas();
    c.nodes.find((n) => n.id === "setup")!.status = "done";
    expect(versionCards(c, spec).map((n) => n.id)).toEqual(["pages", "store", "integration"]);
    expect(versionCards(canvas(), null).map((n) => n.id)).toContain("old");
  });

  it("lets the integration card also write the files of the cards it connects", () => {
    expect(integrationGrants(canvas(), "integration").sort()).toEqual(["public/**", "src/store/**"]);
    expect(integrationGrants(canvas(), "store")).toEqual([]);
  });

  it("recognises the same failure despite changing numbers and paths", () => {
    expect(failureSignature("tests-failed", fail("AssertionError: expected 2 to equal 3 at 12ms"))).toBe(failureSignature("tests-failed", fail("AssertionError: expected 5 to equal 7 at 30ms")));
    expect(failureSignature("tests-failed", fail("TypeError: x is undefined"))).not.toBe(failureSignature("tests-failed", fail()));
  });
});

describe("the engine", () => {
  it("does every card in order, marks each done, and finishes", async () => {
    const h = harness(() => pass);
    const e = h.engine();
    e.start({ agent: "claude-code" });
    await e.settled();
    expect(h.calls.map((c) => c.nodeId)).toEqual(["setup", "pages", "store", "integration"]);
    expect(h.done).toEqual(["setup", "pages", "store", "integration"]);
    expect(h.calls[3].grants.sort()).toEqual(["public/**", "src/store/**"]);
    const r = e.current!;
    expect(r.status).toBe("done");
    expect(r.usage).toMatchObject({ calls: 4, callsWithoutCost: 0 });
    expect(r.usage.costUsd).toBeCloseTo(0.04);
    expect(r.steps.every((s) => s.checkpoint)).toBe(true);
    expect(fs.readdirSync(path.join(h.root, ".agent-together", "runs"))).toHaveLength(1);
  });

  it("hands a failure back with the evidence, and counts a 0/0 test run as not passing", async () => {
    const noTests: StepOutcome = { ...pass, tests: { passed: true, pass: 0, fail: 0, command: "node --test" } };
    const h = harness((id, n) => (id === "setup" && n === 1 ? noTests : id === "store" && n === 1 ? fail() : pass));
    const e = h.engine();
    e.start({ agent: "claude-code" });
    await e.settled();
    expect(e.current!.status).toBe("done");
    const retries = h.calls.filter((c) => c.task.includes("上一次做这张卡片没有通过"));
    expect(retries.map((c) => c.nodeId)).toEqual(["setup", "store"]);
    expect(retries[0].task).toContain("一个测试都没有");
    expect(retries[1].task).toContain("AssertionError");
  });

  it("stops with a decision when the same failure comes back, and goes on as decided", async () => {
    const h = harness((id) => (id === "store" ? fail() : pass));
    const e = h.engine();
    e.start({ agent: "claude-code" });
    await e.settled();
    let r = e.current!;
    expect(r.status).toBe("waiting");
    expect(r.decision).toMatchObject({ nodeId: "store", recommended: "skip" });
    expect(r.decision!.question).toContain("同一个问题又出现了");
    expect(h.calls.filter((c) => c.nodeId === "store")).toHaveLength(2);

    e.decide("skip");
    await e.settled();
    r = e.current!;
    expect(r.status).toBe("done");
    expect(r.tasks.find((t) => t.nodeId === "store")!.state).toBe("skipped");
    expect(r.decisions.map((d) => d.chosen)).toEqual(["skip"]);
    expect(r.note).toContain("跳过了 1 张");
  });

  it("asks after the repair limit even when the failures differ", async () => {
    let n = 0;
    const h = harness((id) => (id === "setup" ? fail(`Error: different ${"x".repeat(++n)}`) : pass));
    const e = h.engine();
    e.start({ agent: "claude-code", limits: { maxRepairs: 2 } });
    await e.settled();
    expect(e.current!.decision!.question).toContain("改了 3 次还没通过");
    expect(h.calls).toHaveLength(3);
  });

  it("never starts a call past the call limit or the known budget", async () => {
    const h = harness(() => pass);
    const e = h.engine();
    e.start({ agent: "claude-code", limits: { maxCalls: 2 } });
    await e.settled();
    expect(h.calls).toHaveLength(2);
    expect(e.current!.decision).toMatchObject({ recommended: "raise" });
    e.decide("raise");
    await e.settled();
    expect(e.current!.status).toBe("done");
    expect(e.current!.limits.maxCalls).toBe(22);

    const costly = harness(() => ({ ...pass, run: { ...pass.run, costUsd: 0.6 } }));
    const c = costly.engine();
    c.start({ agent: "claude-code", limits: { budgetUsd: 1 } });
    await c.settled();
    expect(costly.calls).toHaveLength(2);
    expect(c.current!.decision!.question).toContain("到了预算");
  });

  it("pauses after the current step, resumes, and stops on request", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const h = harness(async (id) => (id === "setup" ? (await gate, pass) : pass));
    const e = h.engine();
    e.start({ agent: "claude-code" });
    await until(() => h.calls.length === 1);
    e.pause();
    expect(e.current!.status).toBe("running"); // the step in progress finishes first
    release();
    await e.settled();
    expect(e.current!.status).toBe("paused");
    expect(h.calls).toHaveLength(1);
    expect(() => e.start({ agent: "claude-code" })).toThrow("上一次制作还没结束");
    e.resume();
    await e.settled();
    expect(e.current!.status).toBe("done");

    const s = harness(() => new Promise<StepOutcome>(() => undefined));
    const stopping = s.engine();
    stopping.start({ agent: "claude-code" });
    stopping.stop();
    expect(stopping.current!.status).toBe("stopped");
  });

  it("after a restart, treats a running run as interrupted and redoes its step from the checkpoint before it", async () => {
    const h = harness(() => new Promise<StepOutcome>(() => undefined)); // the app "dies" during the first step
    h.engine().start({ agent: "claude-code" });
    await until(() => h.calls.length === 1);

    const after = harness(() => pass);
    const deps = { ...after.deps, checkpoint: () => "cp-new" };
    const reopened = new Engine(h.root, deps);
    const r = reopened.current!;
    expect(r.status).toBe("interrupted");
    expect(r.steps[0].state).toBe("interrupted");
    expect(r.note).toContain("项目骨架");
    reopened.resumeInterrupted();
    await reopened.settled();
    expect(after.rolledBack).toEqual(["cp1"]);
    expect(after.calls[0].nodeId).toBe("setup");
    expect(reopened.current!.status).toBe("done");
  });

  it("refuses to start when the version's cards are all done", () => {
    const h = harness(() => pass);
    for (const n of h.deps.canvas().nodes) n.status = "done";
    expect(() => h.engine().start({ agent: "claude-code" })).toThrow("都已经完成了");
  });
});
