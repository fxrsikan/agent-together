import { Canvas, NodeKind, type CanvasEdge, type CanvasNode } from "@agent-together/schema";
import { layoutCanvas } from "./init.js";
import { parseJsonObject } from "./judge.js";
import type { Llm } from "./llm.js";
import { newNodeId } from "./project.js";

export interface CanvasPlan {
  canvas: Canvas;
  /** The stack the plan builds on, in a few words ("Node.js + TypeScript, node:test"). */
  stack: string;
  /** The command that runs every test from the project root, e.g. "node --test". */
  testCommand: string;
}

interface DraftNode {
  id?: string;
  kind?: string;
  title?: string;
  goal?: string;
  acceptance?: string[];
  tasks?: string[];
  files?: string[];
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string" && !!s.trim()).map((s) => s.trim()) : []);

/** A project-relative glob as the observer expects it: forward slashes, no leading "./" or "/". */
const cleanGlob = (g: string) => g.replace(/\\/g, "/").replace(/^(\.\/|\/)+/, "");

export function planPrompt(description: string): string {
  return `你在为一个新软件项目画"开发画布"。画布上每个节点是一块可以单独交给 AI 编码 agent 完成的工作，节点之间的连线表示依赖（A → B 表示 A 可以调用 B）。agent 只能修改自己节点的文件，只能通过连线引用别的节点。

项目描述：
${description.trim()}

要求：
- 3 到 8 个节点，按"能独立实现、独立测试"来切分；最先能跑起来的核心放在被依赖的一侧。
- 每个节点：id（小写英文短横线，如 todo-store）、kind（module 代码模块 / feature 用户可见的功能）、title（中文短名）、goal（一句话）、acceptance（2 到 4 条可以用测试验证的验收标准）、tasks（2 到 4 条任务）、files（这个节点拥有的文件 glob，如 "src/store/**"，节点之间不要重叠，测试文件放在各自节点的目录里）。
- edges：from 依赖 to，label 用两三个字说明关系（如"调用""读取"）。不要有环。
- 描述里没指定技术栈时，选最简单够用的（例如 Node.js + TypeScript，测试用 node:test），不要引入数据库或框架，除非描述需要。
- stack：用一句话写出技术栈和测试方式。
- testCommand：在项目根目录运行全部测试的命令（如 "node --test" 或 "npm test"），要能在 Windows 和 macOS 上直接运行。

只输出 JSON：{"stack": "...", "testCommand": "...", "nodes": [{"id": "...", "kind": "module", "title": "...", "goal": "...", "acceptance": ["..."], "tasks": ["..."], "files": ["..."]}], "edges": [{"from": "...", "to": "...", "label": "..."}]}`;
}

/** Turns a model's draft into a valid, laid-out canvas; tolerant of small mistakes, strict about structure. */
export function canvasFromDraft(draft: { nodes?: DraftNode[]; edges?: Partial<CanvasEdge>[] } | null): Canvas {
  const ids = new Map<string, string>();
  const nodes: CanvasNode[] = [];
  for (const d of draft?.nodes ?? []) {
    const title = d.title?.trim() || d.id?.trim();
    if (!title) continue;
    const id = newNodeId(d.id ?? title, nodes.map((n) => n.id));
    if (d.id) ids.set(d.id, id);
    ids.set(title, id);
    nodes.push({
      id,
      kind: NodeKind.safeParse(d.kind).success ? (d.kind as CanvasNode["kind"]) : "module",
      title,
      intent: { goal: d.goal?.trim() ?? "", acceptance: strings(d.acceptance), tasks: strings(d.tasks) },
      files: strings(d.files).map(cleanGlob),
      status: "todo",
    });
  }
  if (!nodes.length) throw new Error("模型没有给出任何节点");
  const edges: CanvasEdge[] = [];
  for (const e of draft?.edges ?? []) {
    const from = e.from && ids.get(e.from);
    const to = e.to && ids.get(e.to);
    if (from && to && from !== to && !edges.some((x) => x.from === from && x.to === to)) {
      edges.push(e.label ? { from, to, label: e.label } : { from, to });
    }
  }
  layoutCanvas(nodes, edges);
  return Canvas.parse({ version: 1, nodes, edges });
}

/** 规划官: one paragraph about the product → a canvas of nodes and dependencies, for a person to review. */
export async function planCanvas(llm: Llm, description: string): Promise<CanvasPlan> {
  const draft = parseJsonObject<{ stack?: string; testCommand?: string; nodes?: DraftNode[]; edges?: Partial<CanvasEdge>[] }>(
    await llm.complete(planPrompt(description), { timeoutMs: 180_000, maxTokens: 8000 }),
  );
  if (!draft) throw new Error("模型的回复不是 JSON，请重试");
  return { canvas: canvasFromDraft(draft), stack: draft.stack?.trim() ?? "", testCommand: draft.testCommand?.trim() ?? "" };
}
