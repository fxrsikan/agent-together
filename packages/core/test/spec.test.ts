import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Canvas, Spec } from "@agent-together/schema";
import {
  backupCanvas,
  draftSpec,
  linkScenarios,
  normalizeSpec,
  parseRequirementsTurn,
  planFromDraft,
  planFromSpec,
  requirementsPrompt,
  requirementsTurn,
  SpecStore,
  specImpact,
} from "@agent-together/core";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "at-spec-"));
const fake = (...replies: string[]) => {
  const prompts: string[] = [];
  return { prompts, llm: { name: "fake", complete: async (p: string) => (prompts.push(p), replies.shift() ?? "") } };
};

const scenario = (id: string, name: string, extra: object = {}) => ({ id, name, steps: ["打开"], expected: ["看到"], ...extra });
const spec = (scenarios: object[], extra: object = {}) => Spec.parse({ goal: "把小说变成分镜", inScope: ["输入小说"], pages: [{ name: "小说编辑" }], scenarios, ...extra });

describe("SpecStore", () => {
  it("keeps the conversation, the draft, the confirmed version and decisions apart", () => {
    const store = new SpecStore(tmp());
    expect(store.load()).toBeNull();
    store.say({ role: "user", text: "我想把小说变成分镜" });
    store.say({ role: "assistant", text: "好的", questions: [{ id: "q1", question: "给谁用？", options: ["自己"] }] });
    expect(store.conversation().map((m) => m.role)).toEqual(["user", "assistant"]);

    const draft = store.save(spec([scenario("S-01", "生成分镜")]));
    expect(draft.status).toBe("draft");
    const confirmed = store.confirm(draft);
    expect(confirmed.status).toBe("confirmed");
    expect(store.confirmed()?.scenarios[0].id).toBe("S-01");
    expect(store.decisions().map((d) => d.kind)).toEqual(["confirm-scope"]);

    // Saving it unchanged (or only its progress) keeps it confirmed; changing the scope makes it a draft again.
    expect(store.save({ ...confirmed, scenarios: [{ ...confirmed.scenarios[0], status: "mock-passed" }] }).status).toBe("confirmed");
    expect(store.save({ ...confirmed, inScope: ["输入小说", "导出 CSV"] }).status).toBe("draft");
    expect(store.confirmed()?.inScope).toEqual(["输入小说"]);
    store.confirm(store.load()!);
    expect(store.decisions().map((d) => d.kind)).toEqual(["confirm-scope", "change-scope"]);
  });
});

describe("the requirements conversation", () => {
  it("asks at most three questions with clickable answers", () => {
    const turn = parseRequirementsTurn(
      JSON.stringify({
        reply: "你想做一个分镜工具。",
        questions: [1, 2, 3, 4].map((i) => ({ question: `问题${i}`, options: ["a", "b", "c", "d", "e"], why: "影响范围" })),
        ready: false,
      }),
    )!;
    expect(turn.questions).toHaveLength(3);
    expect(turn.questions[0]).toEqual({ id: "q1", question: "问题1", options: ["a", "b", "c", "d"], why: "影响范围" });
    expect(parseRequirementsTurn("我先想想")).toBeNull();
  });

  it("states this phase's limits and the existing cards, and retries a reply it cannot read", async () => {
    const canvas = Canvas.parse({ version: 1, nodes: [{ id: "novel", kind: "module", title: "小说结构", files: ["src/novel/**"] }], edges: [] });
    const prompt = requirementsPrompt([{ role: "user", text: "做短剧", at: "" }], { name: "短剧", canvas });
    expect(prompt).toContain("本地网页应用");
    expect(prompt).toContain("小说结构（novel");
    const { llm, prompts } = fake("嗯……", JSON.stringify({ reply: "明白了", questions: [], ready: true }));
    expect(await requirementsTurn(llm, [], { name: "短剧" })).toEqual({ text: "明白了", questions: [], ready: true });
    expect(prompts[1]).toContain("不是要求的 JSON");
  });
});

describe("the requirements spec", () => {
  it("keeps scenario ids stable across rewrites and numbers new ones after the highest", () => {
    const previous = spec([scenario("S-01", "生成分镜", { status: "mock-passed", tasks: ["storyboard"] }), scenario("S-02", "导出文件")]);
    const next = normalizeSpec(
      {
        goal: "g",
        pages: ["小说编辑：输入和保存小说", { name: "分镜编辑", purpose: "改分镜" }],
        services: [{ name: "分镜生成", purpose: "AI", mode: "whatever" }],
        scenarios: [
          { name: "导出文件", steps: "点导出" }, // same name, no id: keeps S-02
          { id: "S-01", name: "生成并编辑分镜", verify: ["browser", "telepathy"] }, // same id, renamed
          { name: "重新打开项目" }, // new: S-03
        ],
      },
      previous,
    );
    expect(next.scenarios.map((s) => [s.id, s.name])).toEqual([
      ["S-02", "导出文件"],
      ["S-01", "生成并编辑分镜"],
      ["S-03", "重新打开项目"],
    ]);
    expect(next.scenarios[0].steps).toEqual(["点导出"]);
    expect(next.scenarios[1]).toMatchObject({ verify: ["browser"], status: "mock-passed", tasks: ["storyboard"] });
    expect(next.pages).toEqual([{ name: "小说编辑", purpose: "输入和保存小说" }, { name: "分镜编辑", purpose: "改分镜" }]);
    expect(next.services[0].mode).toBe("mock");
    expect(next.status).toBe("draft");
  });

  it("will not write a spec before the user said anything, or one without scenarios", async () => {
    await expect(draftSpec(fake().llm, [], { name: "x" }, null)).rejects.toThrow("先说说");
    const said = [{ role: "user" as const, text: "做个工具", at: "" }];
    await expect(draftSpec(fake(JSON.stringify({ goal: "g", scenarios: [] })).llm, said, { name: "x" }, null)).rejects.toThrow("没有使用场景");
  });
});

describe("what a change touches", () => {
  const canvas = Canvas.parse({
    version: 1,
    nodes: [
      { id: "storyboard", kind: "module", title: "分镜生成", status: "done", scenarios: ["S-01"] },
      { id: "export", kind: "module", title: "导出", scenarios: ["S-02"] },
      { id: "integration", kind: "flow", title: "集成", scenarios: ["S-01", "S-02"] },
    ],
    edges: [],
  });

  it("names added, removed and changed scenarios, scope items, and the cards they touch", () => {
    const before = spec([scenario("S-01", "生成分镜"), scenario("S-02", "导出文件")]);
    const after = spec([scenario("S-01", "生成分镜", { expected: ["看到三个场景"] }), scenario("S-03", "重新打开")], { inScope: ["输入小说", "导出 CSV"] });
    const impact = specImpact(before, after, canvas);
    expect(impact.none).toBe(false);
    expect(impact.scenarios.added.map((s) => s.id)).toEqual(["S-03"]);
    expect(impact.scenarios.removed.map((s) => s.id)).toEqual(["S-02"]);
    expect(impact.scenarios.changed.map((s) => s.id)).toEqual(["S-01"]);
    expect(impact.scope).toEqual({ added: ["做：导出 CSV"], removed: [] });
    expect(impact.cards.map((c) => [c.id, c.status])).toEqual([
      ["storyboard", "done"],
      ["export", "todo"],
      ["integration", "todo"],
    ]);
    expect(specImpact(before, { ...before, scenarios: before.scenarios.map((s) => ({ ...s, status: "failed" as const })) }, canvas).none).toBe(true);
  });
});

describe("the canvas from the confirmed spec", () => {
  const confirmed = Spec.parse({ ...spec([scenario("S-01", "生成分镜"), scenario("S-02", "导出文件"), scenario("S-03", "重新打开")]), status: "confirmed" });
  const existing = Canvas.parse({
    version: 1,
    nodes: [
      { id: "novel", kind: "module", title: "小说结构", status: "done", files: ["src/novel/**"], evidence: { at: "t", sources: [], files: {}, unknowns: [] } },
      { id: "storyboard", kind: "module", title: "分镜生成", status: "in_progress", files: ["src/storyboard/**"] },
      { id: "cli", kind: "feature", title: "命令行工作台", files: ["bin/**"] },
      { id: "video", kind: "module", title: "视频生成", files: ["src/provider/**"] },
    ],
    edges: [],
  });

  it("keeps the ids, progress and evidence of cards it keeps, and says what it drops", () => {
    const plan = planFromDraft(
      {
        stack: "Node.js",
        testCommand: "node --test",
        nodes: [
          { id: "novel-model", from: "novel", change: "keep", reason: "能用", title: "小说结构", scenarios: ["S-01"] },
          { id: "shots", from: "storyboard", change: "change", reason: "改成接口", title: "分镜服务", goal: "新目标", files: ["src/storyboard/**"], scenarios: ["S-01", "S-99"] },
          { id: "pages", from: null, change: "new", title: "页面", files: ["public/**"], scenarios: ["S-02"] },
          { id: "integration", kind: "flow", title: "集成", files: ["server.js"] },
        ],
        edges: [{ from: "shots", to: "novel-model", label: "读取" }, { from: "integration", to: "shots" }],
        removed: [{ id: "cli", reason: "第一版做网页" }],
      },
      confirmed,
      existing,
    );
    const byId = Object.fromEntries(plan.canvas.nodes.map((n) => [n.id, n]));
    expect(Object.keys(byId).sort()).toEqual(["integration", "novel", "pages", "storyboard"]);
    expect(byId.novel).toMatchObject({ status: "done", evidence: { at: "t" }, scenarios: ["S-01"] });
    expect(byId.storyboard).toMatchObject({ title: "分镜服务", status: "in_progress", scenarios: ["S-01"], intent: { goal: "新目标" } });
    expect(byId.integration.scenarios).toEqual(["S-01", "S-02", "S-03"]);
    expect(plan.canvas.edges.map((e) => `${e.from}>${e.to}`)).toEqual(["storyboard>novel", "integration>storyboard"]);
    expect(plan.changes.map((c) => [c.id, c.change])).toEqual([["novel", "keep"], ["storyboard", "change"], ["pages", "new"], ["integration", "new"]]);
    expect(plan.removed.map((r) => [r.id, r.reason])).toEqual([["cli", "第一版做网页"], ["video", "新方案里没有它"]]);
    expect(plan.uncovered).toEqual([]);

    const linked = linkScenarios(confirmed, plan.canvas);
    expect(linked.scenarios.find((s) => s.id === "S-02")!.tasks).toEqual(["pages", "integration"]);
  });

  it("reports scenarios no card covers when there is no integration card", () => {
    const plan = planFromDraft({ nodes: [{ id: "pages", title: "页面", scenarios: ["S-01"] }] }, confirmed, null);
    expect(plan.uncovered).toEqual(["S-02", "S-03"]);
  });

  it("plans only from a confirmed spec", async () => {
    await expect(planFromSpec(fake().llm, { ...confirmed, status: "draft" }, null)).rejects.toThrow("先确认需求说明");
  });

  it("backs up the canvas folder before a migration", () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, ".agent-together", "canvas"), { recursive: true });
    fs.writeFileSync(path.join(root, ".agent-together", "canvas", "novel.json"), "{}");
    const to = backupCanvas(root)!;
    expect(fs.readdirSync(to)).toEqual(["novel.json"]);
    expect(backupCanvas(tmp())).toBeNull();
  });
});
