import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Canvas } from "@loom/schema";
import { buildNodeContext, draftsFromFindings, MemoryStore } from "@loom/core";

const canvas = Canvas.parse({
  version: 1,
  nodes: [
    { id: "login-form", kind: "feature", title: "登录表单", files: ["src/auth/**"] },
    { id: "database", kind: "module", title: "数据库", files: ["src/db/**"] },
  ],
  edges: [],
});

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "loom-mem-"));
const base = { nodeId: "login-form", kind: "pitfall" as const, status: "draft" as const, source: "user" };

describe("MemoryStore", () => {
  it("round-trips memories as Markdown files and skips duplicates", () => {
    const store = new MemoryStore(tmp());
    const m = store.add({ ...base, content: "校验统一用 zod" })!;
    expect(store.add({ ...base, content: "校验统一用 zod" })).toBeNull();
    expect(store.list()).toEqual([m]);
    expect(fs.readFileSync(path.join(store.dir, `${m.id}.md`), "utf8")).toContain("status: draft");
  });

  it("only hands active memories of the node or the whole project to agents", () => {
    const store = new MemoryStore(tmp());
    const a = store.add({ ...base, content: "a" })!;
    store.add({ ...base, content: "b" });
    const g = store.add({ ...base, nodeId: null, content: "global" })!;
    store.add({ ...base, nodeId: "database", content: "other node" });
    store.update(a.id, { status: "active" });
    store.update(g.id, { status: "active" });
    expect(store.forNode("login-form").map((m) => m.content).sort()).toEqual(["a", "global"]);
  });

  it("keeps a Loom-managed block in CLAUDE.md and leaves the rest alone", () => {
    const root = tmp();
    fs.writeFileSync(path.join(root, "CLAUDE.md"), "# My project\n\nOwn notes.\n");
    const store = new MemoryStore(root);
    store.update(store.add({ ...base, content: "不要直连数据库" })!.id, { status: "active" });
    store.syncClaudeMd(canvas);
    store.syncClaudeMd(canvas);
    const md = fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8");
    expect(md.startsWith("# My project\n\nOwn notes.\n")).toBe(true);
    expect(md.match(/loom:memory:start/g)).toHaveLength(1);
    expect(md).toContain("### 登录表单");
    expect(md).toContain("（踩过的坑）不要直连数据库");
  });
});

describe("draftsFromFindings", () => {
  it("drafts one memory per distinct warning, skipping log-only findings", () => {
    const f = { rule: "design-guard", level: "ask" as const, message: "no edge", nodeId: "login-form" };
    const drafts = draftsFromFindings(canvas, [f, f, { ...f, level: "log" as const, message: "quiet" }], "abcdef123");
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ nodeId: "login-form", status: "draft", source: "observer:design-guard session abcdef12" });
    expect(drafts[0].content).toContain("违反依赖关系");
  });
});

describe("buildNodeContext with memories", () => {
  it("lists approved memories", () => {
    const memory = { ...base, id: "x", status: "active" as const, content: "校验统一用 zod", createdAt: "" };
    expect(buildNodeContext(canvas, "login-form", "t", [memory])).toContain("（踩过的坑）校验统一用 zod");
  });
});
