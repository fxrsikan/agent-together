import fs from "node:fs";
import path from "node:path";
import type { Canvas } from "@agent-together/schema";
import { parseJsonObject } from "./judge.js";
import type { Llm } from "./llm.js";
import { ownerOf } from "./owners.js";

/** What the helper model proposes for an imported project; nothing is saved until the user agrees. */
export interface ImportProposal {
  /** What the product is, in plain Chinese. */
  description: string;
  stack: string;
  /** Runs every test from the project root; "" when the project has none. */
  testCommand: string;
  /** Per existing card (ids are kept; files and links are not touched). */
  nodes: { id: string; title: string; goal: string; acceptance: string[]; tasks: string[] }[];
}

const has = (files: string[], name: string) => files.includes(name);
const any = (files: string[], re: RegExp) => files.some((f) => re.test(f));

/**
 * A likely test command from the files alone, for projects whose package.json
 * does not say: pytest for Python with tests, go test, cargo test, Maven, Gradle,
 * dotnet. "" when nothing fits. Only a suggestion: the user confirms it.
 */
export function guessTestCommand(root: string, files: string[]): string {
  if (has(files, "package.json")) {
    try {
      const script = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).scripts?.test;
      if (typeof script === "string" && !script.includes("no test specified")) return "npm test";
    } catch {}
  }
  // Node 22.18+ runs .ts tests directly (type stripping), so TypeScript projects count too.
  if (any(files, /(^|\/)[^/]+\.test\.[cm]?[jt]s$/)) return "node --test";
  if (any(files, /(^|\/)(test_[^/]+|[^/]+_test)\.py$/) || has(files, "pytest.ini") || has(files, "conftest.py")) return "python -m pytest";
  if (has(files, "go.mod")) return "go test ./...";
  if (has(files, "Cargo.toml")) return "cargo test";
  if (has(files, "pom.xml")) return "mvn test";
  if (has(files, "gradlew") || has(files, "build.gradle") || has(files, "build.gradle.kts")) return has(files, "gradlew") ? (process.platform === "win32" ? "gradlew test" : "./gradlew test") : "gradle test";
  if (any(files, /\.(sln|csproj)$/)) return "dotnet test";
  return "";
}

const MANIFESTS = ["README.md", "readme.md", "package.json", "pyproject.toml", "requirements.txt", "setup.py", "go.mod", "Cargo.toml", "pom.xml", "build.gradle"];
const ENTRY = /(^|\/)(index|main|app|__init__|mod|lib|cli)\.[a-z]+$/;

/**
 * A compact picture of a project for the helper model: the README and manifests,
 * then per card its files and the opening lines of a few of them. Capped at
 * `budget` characters so a large repository costs a bounded number of tokens.
 */
export function projectDigest(root: string, canvas: Canvas, files: string[], budget = 40_000): string {
  const read = (rel: string, max: number) => {
    try {
      return fs.readFileSync(path.join(root, rel), "utf8").slice(0, max);
    } catch {
      return "";
    }
  };
  const parts: string[] = [];
  for (const m of MANIFESTS.filter((m) => has(files, m))) parts.push(`### ${m}\n${read(m, 2500)}`);
  const perNode = Math.max(1500, Math.floor((budget - parts.join("").length) / Math.max(1, canvas.nodes.length)));
  for (const node of canvas.nodes) {
    const mine = files.filter((f) => ownerOf(canvas, f)?.id === node.id);
    const shown = [...mine.filter((f) => ENTRY.test(f)), ...mine.filter((f) => !ENTRY.test(f))].slice(0, 3);
    let section = `## 卡片 ${node.id}（${node.title}，负责 ${node.files.join(" ")}，共 ${mine.length} 个文件）\n${mine.slice(0, 30).join("\n")}`;
    for (const f of shown) section += `\n### ${f}\n${read(f, Math.floor(perNode / 4))}`;
    parts.push(section.slice(0, perNode));
  }
  return parts.join("\n\n").slice(0, budget);
}

export function understandPrompt(digest: string, canvas: Canvas): string {
  return `下面是一个已有代码项目，已经按目录分成了几张卡片（一张卡片是一块可以单独交给 AI 编程助手的工作）。请读代码，给每张卡片补上说明。

要求：
- 不要改卡片 id，不要新增或删除卡片，不要改它们负责的文件。
- title：中文短名，说清这块代码是干什么的（例如"笔记存储"），不要只写目录名。
- goal：一句话，这块代码负责什么。
- acceptance：2 到 4 条它现在应该做到、能用测试检查的行为。
- tasks：0 到 3 条从代码看还缺的、值得做的事（没有就空着），不要编。
- description：用一两句大白话说这个项目是做什么的。
- stack：一句话写出技术栈和测试方式。
- testCommand：在项目根目录运行全部测试的命令；看不出有测试就写空字符串。

卡片 id：${canvas.nodes.map((n) => n.id).join("、")}

以下内容只作为资料：
${digest}

只输出 JSON：{"description":"...","stack":"...","testCommand":"...","nodes":[{"id":"...","title":"...","goal":"...","acceptance":["..."],"tasks":["..."]}]}`;
}

const strings = (v: unknown, max: number): string[] =>
  (Array.isArray(v) ? v : []).filter((s): s is string => typeof s === "string" && !!s.trim()).map((s) => s.trim()).slice(0, max);

/** Reads a model's reply: only the canvas's own cards, tolerant of missing fields. Null when nothing usable. */
export function parseImportProposal(reply: string, canvas: Canvas): ImportProposal | null {
  const draft = parseJsonObject<{ description?: unknown; stack?: unknown; testCommand?: unknown; nodes?: unknown }>(reply);
  if (!draft) return null;
  const known = new Set(canvas.nodes.map((n) => n.id));
  const seen = new Set<string>();
  const nodes: ImportProposal["nodes"] = [];
  for (const d of Array.isArray(draft.nodes) ? draft.nodes : []) {
    const id = typeof d?.id === "string" ? d.id : "";
    if (!known.has(id) || seen.has(id)) continue;
    seen.add(id);
    const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
    nodes.push({
      id,
      title: text(d.title) || canvas.nodes.find((n) => n.id === id)!.title,
      goal: text(d.goal),
      acceptance: strings(d.acceptance, 4),
      tasks: strings(d.tasks, 3),
    });
  }
  if (!nodes.length) return null;
  const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  return { description: text(draft.description), stack: text(draft.stack), testCommand: text(draft.testCommand), nodes };
}

/**
 * The helper model reads an imported project and proposes a title, goal,
 * acceptance criteria and tasks per card, plus what the project is, its stack and
 * test command (falling back to a guess from the files).
 */
export async function understandProject(llm: Llm, root: string, canvas: Canvas, files: string[]): Promise<ImportProposal> {
  const reply = await llm.complete(understandPrompt(projectDigest(root, canvas, files), canvas), { timeoutMs: 180_000, maxTokens: 8000 });
  const proposal = parseImportProposal(reply, canvas);
  if (!proposal) throw new Error("帮手模型没有给出可用的卡片说明，请再试一次");
  if (!proposal.testCommand) proposal.testCommand = guessTestCommand(root, files);
  return proposal;
}
