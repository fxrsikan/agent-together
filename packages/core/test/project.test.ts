import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildNodeContext,
  canvasFromDraft,
  createProject,
  newNodeId,
  openProject,
  planCanvas,
  ProjectStore,
  readProjectInfo,
  writeProjectInfo,
  type Llm,
} from "@agent-together/core";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "agent-together-project-"));

describe("createProject", () => {
  it("makes a git repository with an empty canvas, default rules and ignores for machine-local files", () => {
    const root = createProject(path.join(tmp(), "todo-app"), "待办清单");
    expect(execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: root, encoding: "utf8" }).trim()).toBe("true");
    expect(new ProjectStore(root).loadCanvas().nodes).toEqual([]);
    expect(Object.keys(new ProjectStore(root).loadRuleLevels())).toContain("scope-fence");
    expect(readProjectInfo(root).name).toBe("待办清单");
    expect(fs.readFileSync(path.join(root, ".gitignore"), "utf8")).toContain(".claude/settings.local.json");
    expect(fs.readFileSync(path.join(root, ".agent-together/.gitignore"), "utf8")).toContain("runtime.json");
  });

  it("refuses a folder that already has files", () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "a.txt"), "x");
    expect(() => createProject(dir)).toThrow("不是空的");
  });
});

describe("openProject", () => {
  it("sets up an existing folder once, with a canvas from its code", () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, "src/auth"), { recursive: true });
    fs.writeFileSync(path.join(dir, "src/auth/login.ts"), "export const x = 1;");
    expect(openProject(dir)).toMatchObject({ created: true, git: false });
    expect(new ProjectStore(dir).loadCanvas().nodes.map((n) => n.id)).toContain("auth");
    expect(openProject(dir).created).toBe(false);
  });
});

describe("canvas editing", () => {
  const root = createProject(path.join(tmp(), "p"));
  const store = new ProjectStore(root);
  const node = (id: string) => ({ id, kind: "module", title: id, files: [`src/${id}/**`] });

  it("adds nodes, connects them, and drops a node's edges with it", () => {
    store.saveNode(node("cli"));
    store.saveNode(node("store"));
    store.saveEdges([{ from: "cli", to: "store" }, { from: "cli", to: "store" }, { from: "cli", to: "cli" }]);
    expect(store.loadCanvas().edges).toEqual([{ from: "cli", to: "store" }]);
    store.deleteNode("store");
    expect(store.loadCanvas()).toMatchObject({ nodes: [{ id: "cli" }], edges: [] });
  });

  it("rejects an edge to a node that does not exist, and changes nothing", () => {
    expect(() => store.saveEdges([{ from: "cli", to: "ghost" }])).toThrow("unknown node");
    expect(store.loadCanvas().edges).toEqual([]);
  });
});

describe("newNodeId", () => {
  it("slugs ASCII titles and numbers the rest", () => {
    expect(newNodeId("Login Form", [])).toBe("login-form");
    expect(newNodeId("登录表单", [])).toBe("node");
    expect(newNodeId("登录表单", ["node", "node-2"])).toBe("node-3");
  });
});

const draft = {
  stack: "Node.js + TypeScript，测试用 node:test",
  nodes: [
    { id: "cli", kind: "feature", title: "命令行", goal: "增删查待办", acceptance: ["add 后 list 能看到"], tasks: ["解析参数"], files: ["./src/cli/**"] },
    { id: "store", kind: "weird", title: "存储", goal: "读写 JSON 文件", files: ["src\\store\\**"] },
  ],
  edges: [{ from: "cli", to: "store", label: "调用" }, { from: "cli", to: "ghost" }, { from: "store", to: "store" }],
};

describe("canvasFromDraft", () => {
  it("cleans globs and kinds, drops bad edges, lays nodes out by dependency", () => {
    const canvas = canvasFromDraft(draft);
    expect(canvas.nodes.map((n) => [n.id, n.kind, n.files[0]])).toEqual([
      ["cli", "feature", "src/cli/**"],
      ["store", "module", "src/store/**"],
    ]);
    expect(canvas.edges).toEqual([{ from: "cli", to: "store", label: "调用" }]);
    expect(canvas.nodes[1].position!.x).toBeGreaterThan(canvas.nodes[0].position!.x);
  });

  it("refuses a plan without nodes", () => {
    expect(() => canvasFromDraft({ nodes: [] })).toThrow("没有给出任何节点");
  });
});

describe("planCanvas", () => {
  it("asks the model once and tolerates prose around the JSON", async () => {
    const prompts: string[] = [];
    const llm: Llm = { name: "fake", complete: async (p) => (prompts.push(p), `好的：\n${JSON.stringify(draft)}`) };
    const plan = await planCanvas(llm, "一个命令行待办清单");
    expect(prompts[0]).toContain("一个命令行待办清单");
    expect(plan.stack).toContain("node:test");
    expect(plan.canvas.nodes).toHaveLength(2);
  });
});

describe("project context", () => {
  it("tells every dispatched agent what the project is", () => {
    const root = createProject(path.join(tmp(), "q"), "待办清单");
    writeProjectInfo(root, { description: "一个命令行待办清单", stack: "Node.js" });
    const store = new ProjectStore(root);
    store.writeCanvas(canvasFromDraft(draft));
    const md = buildNodeContext(store.loadCanvas(), "cli", "先做 add", [], readProjectInfo(root));
    expect(md).toContain("## 项目：待办清单");
    expect(md).toContain("一个命令行待办清单");
    expect(md).toContain("技术栈：Node.js");
  });
});
