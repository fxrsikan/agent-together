import fs from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Scenario } from "@agent-together/schema";
import { globRe, matchFiles, parseBeats, runScenario, scenarioLayers, type AcceptanceEnv, type Beat, type PageDriver, type Target } from "@agent-together/core";

/** A pretend product page: elements with text or a label, clicks that change state. */
interface El {
  text?: string;
  label?: string;
  css?: string;
  value?: string;
  onClick?: (page: FakePage) => void;
}
class FakePage implements PageDriver {
  els: El[] = [];
  extra = "";
  focused: El | null = null;
  dialogsSeen: string[] = [];
  answer = true;
  visited: string[] = [];
  problems: string[] = [];
  constructor(build: (p: FakePage) => void) {
    build(this);
  }
  private find(t: Target): El[] {
    return this.els.filter((e) => (t.css ? e.css === t.css : t.label ? e.label === t.label : t.text ? e.text === t.text : false));
  }
  text() {
    return [this.extra, ...this.els.map((e) => e.text ?? ""), ...this.els.map((e) => e.value ?? "")].join("\n");
  }
  async goto(url: string) {
    this.visited.push(url);
  }
  async reload() {
    this.visited.push("reload");
  }
  async eval<T>(js: string): Promise<T> {
    if (js === "document.readyState") return "complete" as T;
    const target = (re: RegExp) => JSON.parse(re.exec(js)![1]) as Target;
    if (js.includes("window.__atTarget = el")) {
      const t = target(/const t = (.*);\nconst r = find/);
      const el = this.find(t)[t.nth ?? 0];
      if (!el) return { error: `页面上找不到 ${t.text ?? t.label ?? t.css}` } as T;
      this.focused = el;
      return { x: this.els.indexOf(el), y: 0 } as T;
    }
    if (js.includes("el.select()")) return true as T;
    if (js.includes("return textOf(document.body)")) {
      const t = target(/const t = (.*);\nif \(!t\)/s);
      if (!t) return this.text() as T;
      const el = this.find(t)[0];
      return (el ? `${el.text ?? ""}${el.value ?? ""}` : { error: "找不到范围" }) as T;
    }
    if (js.includes("r.found.length")) return this.find(target(/const r = find\((.*)\); return/)).length as T;
    if (js.includes("String(el.value ?? el.innerText")) return String(this.focused?.value ?? this.focused?.text ?? "") as T;
    return "页面快照" as T;
  }
  async click(x: number) {
    this.els[x]?.onClick?.(this);
  }
  async type(text: string) {
    if (this.focused) this.focused.value = text;
  }
  async press() {}
  answerDialogs(accept: boolean) {
    this.answer = accept;
  }
  dialogs() {
    return this.dialogsSeen;
  }
  async screenshot() {
    return null;
  }
  url() {
    return "http://127.0.0.1:1000/novel";
  }
  takeProblems() {
    const p = this.problems;
    this.problems = [];
    return p;
  }
  downloads() {
    return [];
  }
}

const scenario = Scenario.parse({ id: "S-01", name: "写小说并保存", steps: ["新建", "保存"], expected: ["显示已保存"], dataChecks: ["重启后还在"] });

function env(page: FakePage, root = os.tmpdir()): AcceptanceEnv & { restarts: number } {
  const e = {
    driver: page,
    root,
    base: () => `http://127.0.0.1:${1000 + e.restarts}`,
    restart: async () => {
      e.restarts++;
      return e.base();
    },
    saveShot: () => null,
    settleMs: 0,
    restarts: 0,
  };
  return e;
}

const beat = (id: string, source: Beat["source"], actions: Beat["actions"], extra: Partial<Beat> = {}): Beat => ({ id, source, ref: id, say: id, actions, ...extra });

describe("acceptance scripts from the helper model", () => {
  it("keeps beats and actions that fit the grammar, numbers them, and keeps manual ones", () => {
    const beats = parseBeats(
      JSON.stringify({
        beats: [
          { source: "step", ref: "点新建", say: "点新建", actions: [{ do: "click", target: { text: "新建" } }, { do: "fly" }, { check: "text" }] },
          { source: "error", ref: "没有写权限", manual: "要改文件夹权限", actions: [] },
          { source: "expected", ref: "空的", actions: [] },
          { source: "data", ref: "重启", actions: [{ do: "restart" }, { check: "file", path: "manuscript/*.md", contains: ["第一章"] }] },
        ],
      }),
      "S-01",
    )!;
    expect(beats.map((b) => b.id)).toEqual(["S-01-01", "S-01-02", "S-01-03"]);
    expect(beats[0].actions).toEqual([{ do: "click", target: { text: "新建" } }]);
    expect(beats[1]).toMatchObject({ source: "error", manual: "要改文件夹权限", actions: [] });
    expect(parseBeats("不是 JSON", "S-01")).toBeNull();
  });

  it("matches files by path and glob", () => {
    expect(globRe("manuscript/*.md").test("manuscript/第一章.md")).toBe(true);
    expect(globRe("manuscript/*.md").test("manuscript/a/b.md")).toBe(false);
    expect(globRe("data/**").test("data/a/b.json")).toBe(true);
    expect(globRe("**/x.json").test("x.json")).toBe(true);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "at-glob-"));
    fs.mkdirSync(path.join(root, "manuscript"));
    fs.writeFileSync(path.join(root, "manuscript", "第一章.md"), "x");
    expect(matchFiles(root, "manuscript/*.md")).toEqual(["manuscript/第一章.md"]);
    expect(matchFiles(root, "manuscript/第一章.md")).toEqual(["manuscript/第一章.md"]);
    expect(() => matchFiles(root, "../outside.txt")).toThrow("不在项目里");
  });
});

describe("running a scenario on the page", () => {
  const app = () =>
    new FakePage((p) => {
      p.els = [
        { text: "新建小说", onClick: (pg) => pg.els.push({ label: "正文", value: "" }) },
        { text: "保存", onClick: (pg) => (pg.extra = "已保存 字数 42") },
      ];
    });

  it("does the steps with real input, checks the page, remembers values, and restarts the product", async () => {
    const page = app();
    const e = env(page);
    const plan = [
      beat("pre", "pre", [{ do: "goto", path: "/" }]),
      beat("new", "step", [{ do: "click", target: { text: "新建小说" } }, { do: "fill", target: { label: "正文" }, value: "雨夜" }]),
      beat("save", "step", [{ do: "click", target: { text: "保存" } }, { do: "wait", text: "已 保存", timeoutMs: 500 }]),
      beat("words", "expected", [{ do: "remember", name: "body", target: { label: "正文" } }, { check: "text", text: "{{body}}" }, { check: "count", target: { label: "正文" }, count: 1 }]),
      beat("restart", "data", [{ do: "restart" }, { check: "text", text: "雨夜" }]),
      beat("perm", "error", [], { manual: "要改权限" }),
    ];
    const { result } = await runScenario(scenario, plan, e, { replan: null });
    expect(result.status).toBe("passed");
    expect(result.beats.map((b) => b.status)).toEqual(["passed", "passed", "passed", "passed", "passed", "manual"]);
    expect(page.els.find((x) => x.label === "正文")!.value).toBe("雨夜");
    expect(e.restarts).toBe(1);
    expect(page.visited).toEqual(["http://127.0.0.1:1000/", "http://127.0.0.1:1001/novel"]);
  });

  it("fails a check with what it saw, goes on after a failed check, stops after a failed step", async () => {
    const e = env(app());
    const { result } = await runScenario(
      scenario,
      [
        beat("check", "expected", [{ check: "text", text: "不存在的字", present: true }]),
        beat("step", "step", [{ do: "click", target: { text: "保存" } }]),
        beat("gone", "expected", [{ check: "text", text: "已保存", present: false }]),
        beat("broken", "step", [{ do: "click", target: { text: "删除" } }]),
        beat("after", "expected", [{ check: "text", text: "x" }]),
      ],
      e,
      { replan: null },
    );
    expect(result.status).toBe("failed");
    expect(result.beats.map((b) => b.status)).toEqual(["failed", "passed", "failed", "failed", "skipped"]);
    expect(result.beats[0]).toMatchObject({ failure: "check", error: "页面上没有「不存在的字」" });
    expect(result.beats[2].error).toContain("不该有「已保存」");
    expect(result.beats[3]).toMatchObject({ failure: "locate" });
  }, 20_000);

  it("rewrites the rest of the plan once when an element is not where the plan said", async () => {
    const page = app();
    const calls: string[] = [];
    const { result, beats } = await runScenario(scenario, [beat("old", "step", [{ do: "click", target: { text: "新建" } }]), beat("tail", "expected", [{ check: "text", text: "旧的" }])], env(page), {
      replan: async (_done, failed, rest) => {
        calls.push(`${failed.say}|${rest.map((b) => b.id).join(",")}`);
        return [beat("new", "step", [{ do: "click", target: { text: "新建小说" } }])];
      },
    });
    expect(calls).toEqual(["old|tail"]);
    expect(result).toMatchObject({ status: "passed", replans: 1 });
    expect(beats.map((b) => b.id)).toEqual(["S-01-r1-01"]);
  }, 20_000);
});

describe("error checks do not leak into the next scenario", () => {
  it("saves the data before the first error check and puts it back after the scenario", async () => {
    const calls: string[] = [];
    const page = new FakePage((p) => (p.els = [{ text: "保存", onClick: () => calls.push("click") }]));
    await runScenario(
      scenario,
      [
        beat("s", "step", [{ do: "click", target: { text: "保存" } }]),
        beat("m", "error", [], { manual: "权限" }),
        beat("e1", "error", [{ do: "click", target: { text: "保存" } }]),
        beat("e2", "error", [{ do: "click", target: { text: "保存" } }]),
      ],
      env(page),
      { replan: null, beforeErrors: async () => void calls.push("before"), afterErrors: async () => void calls.push("after") },
    );
    expect(calls).toEqual(["click", "before", "click", "click", "after"]);
  });
});

describe("evidence layers from the scenario runs", () => {
  it("passes interaction, persistence, interface and scenarios only on real evidence", () => {
    const s1 = Scenario.parse({ id: "S-01", name: "a", verify: ["browser", "api"] });
    const ok = { id: "S-01", name: "a", status: "passed" as const, replans: 0, networkProblems: [], beats: [
      { id: "1", source: "step" as const, ref: "", say: "保存", status: "passed" as const, actions: [] },
      { id: "2", source: "data" as const, ref: "", say: "重启后还在", status: "passed" as const, actions: [] },
      { id: "3", source: "error" as const, ref: "", say: "权限", status: "manual" as const, actions: [] },
    ] };
    const layers = scenarioLayers([ok], [s1], "mock");
    expect(layers.map((l) => [l.id, l.status])).toEqual([
      ["interface", "passed"],
      ["interaction", "passed"],
      ["persistence", "passed"],
      ["scenarios", "passed"],
    ]);
    expect(layers[3].detail).toContain("示例服务");
    expect(layers[3].detail).toContain("1 项自动化做不到");

    const noData = { ...ok, beats: ok.beats.filter((b) => b.source !== "data"), networkProblems: ["POST 请求返回 500"] };
    const bad = scenarioLayers([noData], [s1], "mock");
    expect(bad.find((l) => l.id === "persistence")!.status).toBe("failed");
    expect(bad.find((l) => l.id === "interface")!.detail).toContain("500");
  });
});

describe("one acceptance of a version", () => {
  it("collects every layer of evidence, keeps the script for replays, builds the package and hands failures over", async () => {
    const { Acceptance, Checkpoints } = await import("@agent-together/core");
    const { Canvas, Spec } = await import("@agent-together/schema");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "at-accept-"));
    fs.writeFileSync(path.join(root, "server.js"), "// server");
    fs.writeFileSync(path.join(root, "package.json"), '{"scripts":{"start":"node server.js"}}');
    fs.mkdirSync(path.join(root, "data"));
    fs.writeFileSync(path.join(root, "data", "real.json"), "用户的真实数据");
    execFileSync("git", ["init", "-q"], { cwd: root });
    const spec = Spec.parse({ status: "confirmed", goal: "写小说", scenarios: [{ id: "S-01", name: "写小说并保存", steps: ["新建", "保存"], tasks: ["writer", "integration"] }] });
    const canvas = Canvas.parse({ version: 1, nodes: [{ id: "writer", kind: "feature", title: "写作页", status: "done", scenarios: ["S-01"] }] });
    const plan = { beats: [
      { source: "step", ref: "新建", say: "点新建小说", actions: [{ do: "click", target: { text: "新建小说" } }, { do: "fill", target: { label: "正文" }, value: "雨夜" }] },
      { source: "step", ref: "保存", say: "点保存", actions: [{ do: "click", target: { text: "保存" } }, { check: "text", text: "已保存" }] },
      { source: "data", ref: "重启后还在", say: "重启再看", actions: [{ do: "restart" }, { check: "text", text: "雨夜" }] },
    ] };
    let llmCalls = 0;
    let saveWorks = true;
    const sandboxes: string[] = [];
    const deps = {
      llm: { name: "fake", complete: async () => (llmCalls++, JSON.stringify(plan)) },
      spec: () => spec,
      canvas: () => canvas,
      runConfig: () => ({ start: "node server.js" }),
      serviceMode: () => "mock" as const,
      checkpoint: (label: string) => new Checkpoints(root).create(label),
      runTests: async () => ({ command: "node --test", passed: true, pass: 5, fail: 0, output: "", nodeId: null, at: "", durationMs: 1 }),
      openDriver: async () => {
        const page = new FakePage((p) => {
          p.els = [
            { text: "新建小说", onClick: (pg) => pg.els.push({ label: "正文", value: "" }) },
            { text: "保存", onClick: (pg) => (pg.extra = saveWorks ? "已保存" : "保存失败") },
          ];
        });
        return Object.assign(page, { close: () => undefined });
      },
      product: (dir: string) => {
        sandboxes.push(dir);
        return { start: async () => ({ state: "running", url: "http://127.0.0.1:4000/" }), stop: async () => undefined } as never;
      },
    };
    const a = new Acceptance(root, deps);
    a.start();
    await a.settled();
    let r = a.current!;
    expect(r.layers.map((l) => `${l.id}:${l.status}`)).toEqual([
      "tests:passed",
      "audit:passed",
      "build:skipped",
      "interface:passed",
      "interaction:passed",
      "persistence:passed",
      "scenarios:passed",
      "delivery:passed",
    ]);
    expect(r.status).toBe("passed");
    expect(r.checkpoint).not.toBeNull();
    expect(fs.existsSync(path.join(root, r.package!.zip))).toBe(true);
    // The data folder was found, kept out of the copy, and the user's data never touched.
    expect(fs.readFileSync(path.join(root, "data", "real.json"), "utf8")).toBe("用户的真实数据");
    expect(fs.existsSync(path.join(sandboxes[0], "data", "real.json"))).toBe(false);
    expect(a.missing()).toEqual(["还要你亲手确认：S-01"]);

    // The user walks through it: does not match → a fix task with their words.
    expect(() => a.confirm("S-01", false)).toThrow("哪里不符合");
    a.confirm("S-01", false, "编辑页底部多了 nullnullnull");
    expect(a.fixes()).toEqual([{ scenarioId: "S-01", tasks: ["writer", "integration"], task: expect.stringContaining("nullnullnull") }]);
    a.start();
    await a.settled();
    expect(a.current!.user["S-01"]).toMatchObject({ ok: false, note: "编辑页底部多了 nullnullnull" });
    a.confirm("S-01", true);
    expect(a.missing()).toEqual([]);

    // Replay: the script is kept, no model call; a broken save fails with the evidence.
    saveWorks = false;
    a.start();
    await a.settled();
    r = a.current!;
    expect(llmCalls).toBe(1);
    // "Matches" is asked again after a new acceptance; an open "doesn't match" stays.
    expect(r.user["S-01"]).toBeUndefined();
    expect(r.status).toBe("failed");
    expect(r.scenarios[0].beats[1]).toMatchObject({ status: "failed", error: "页面上没有「已保存」" });
    expect(a.fixes()[0].task).toContain("「保存」");
    expect(a.missing()).toContain("自动验收还没有全部通过");
  }, 60_000);
});

describe("the judge check", () => {
  it("asks again when the reply does not parse or says no, fails only on two noes or no clear answer", async () => {
    const { judgePage } = await import("@agent-together/core");
    const replies = ["嗯……", '{"ok":true,"why":"页面上有「3 秒」"}'];
    expect(await judgePage({ name: "f", complete: async () => replies.shift()! }, "有 3 秒吗", "3 秒")).toEqual({ ok: true, why: "页面上有「3 秒」" });
    expect(await judgePage({ name: "f", complete: async () => "不知道" }, "q", "p")).toMatchObject({ ok: false });
    const second = ['{"why":"没看到","ok":false}', '{"why":"有「5 秒」","ok":true}'];
    expect(await judgePage({ name: "f", complete: async () => second.shift()! }, "q", "p")).toEqual({ ok: true, why: "有「5 秒」" });
    expect(await judgePage({ name: "f", complete: async () => '{"why":"没有","ok":false}' }, "q", "p")).toEqual({ ok: false, why: "没有" });
  });
});
