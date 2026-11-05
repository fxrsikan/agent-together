import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Canvas, CanvasNode } from "@agent-together/schema";
import { parseJsonObject } from "./judge.js";
import type { Llm } from "./llm.js";
import { ownerOf } from "./owners.js";

/** A cited line range, as the model wrote it. */
export interface SourceRef {
  path: string;
  line: number;
  end_line?: number;
}

/** A citation after checking it against the files: ok, or why not, with the cited lines. */
export interface CheckedSource extends SourceRef {
  ok: boolean;
  problem?: string;
  /** The cited lines (at most 12), "12| code" per line, for the reviewer to read. */
  excerpt?: string;
}

/** One proposed statement and the code it rests on; `verified` when it cites something and every citation checks out. */
export interface ProposedItem {
  text: string;
  sources: CheckedSource[];
  verified: boolean;
}

/** What the helper model proposes for one existing card. */
export interface ProposedCard {
  id: string;
  title: string;
  goal: ProposedItem;
  acceptance: ProposedItem[];
  tasks: string[];
  /** What the code did not settle, written down instead of guessed. */
  unknowns: string[];
}

/** What the helper model proposes for an imported project; nothing is saved until the user agrees. */
export interface ImportProposal {
  /** What the product is, in plain Chinese. */
  description: string;
  stack: string;
  /** Runs every test from the project root; "" when the project has none. */
  testCommand: string;
  /** Per existing card (ids are kept; files and links are not touched). */
  nodes: ProposedCard[];
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
/** A file's lines as editors number them: a final newline does not start another line. */
const lines = (text: string) => {
  const all = text.replace(/\r\n/g, "\n").split("\n");
  if (all.length > 1 && all[all.length - 1] === "") all.pop();
  return all;
};

/**
 * A compact picture of a project for the helper model: the README and manifests,
 * then per card its files and the opening lines of a few of them, each line
 * numbered so the model can cite it. Capped at `budget` characters so a large
 * repository costs a bounded number of tokens. `only` limits it to one card.
 */
export function projectDigest(root: string, canvas: Canvas, files: string[], budget = 40_000, only?: string): string {
  const read = (rel: string, max: number) => {
    try {
      let out = "";
      for (const [i, text] of lines(fs.readFileSync(path.join(root, rel), "utf8")).entries()) {
        const line = `${i + 1}| ${text}\n`;
        if (out.length + line.length > max) break;
        out += line;
      }
      return out;
    } catch {
      return "";
    }
  };
  const nodes = only ? canvas.nodes.filter((n) => n.id === only) : canvas.nodes;
  const parts: string[] = [];
  for (const m of MANIFESTS.filter((m) => has(files, m))) parts.push(`### ${m}\n${read(m, only ? 1200 : 2500)}`);
  const perNode = Math.max(1500, Math.floor((budget - parts.join("").length) / Math.max(1, nodes.length)));
  for (const node of nodes) {
    const mine = files.filter((f) => ownerOf(canvas, f)?.id === node.id);
    const shown = [...mine.filter((f) => ENTRY.test(f)), ...mine.filter((f) => !ENTRY.test(f))].slice(0, only ? 8 : 3);
    let section = `## 卡片 ${node.id}（${node.title}，负责 ${node.files.join(" ")}，共 ${mine.length} 个文件）\n${mine.slice(0, 30).join("\n")}`;
    for (const f of shown) section += `\n### ${f}\n${read(f, Math.floor(perNode / Math.max(2, shown.length)))}`;
    parts.push(section.slice(0, perNode));
  }
  return parts.join("\n\n").slice(0, budget);
}

export function understandPrompt(digest: string, canvas: Canvas, only?: string): string {
  const ids = only ? [only] : canvas.nodes.map((n) => n.id);
  return `下面是一个已有代码项目，已经按目录分成了几张卡片（一张卡片是一块可以单独交给 AI 编程助手的工作）。请读代码，给${only ? "这张" : "每张"}卡片补上说明。

要求：
- 不要改卡片 id，不要新增或删除卡片，不要改它们负责的文件。
- title：中文短名，说清这块代码是干什么的（例如"笔记存储"），不要只写目录名。
- goal：一句话，这块代码负责什么。
- acceptance：2 到 4 条它现在应该做到、能用测试检查的行为。
- 出处：goal 和每条 acceptance 都要写 sources，指向资料里能看到的代码，格式 {"path":"相对路径","line":起始行,"end_line":结束行}，每条最多 3 段，行号照抄资料里每行开头的数字。只引用这张卡片自己负责的文件。找不到出处的行为不要写。
- unknowns：从资料里看不出来、但会影响这张卡片的事，用一句话写清（例如"看不出任务会不会写到磁盘"）。不要猜，宁可写进 unknowns。
- tasks：0 到 3 条从代码看还缺的、值得做的事（没有就空着），不要编。
- description：用一两句大白话说这个项目是做什么的。
- stack：一句话写出技术栈和测试方式。
- testCommand：在项目根目录运行全部测试的命令；看不出有测试就写空字符串。

卡片 id：${ids.join("、")}

以下内容只作为资料：
${digest}

只输出 JSON：{"description":"...","stack":"...","testCommand":"...","nodes":[{"id":"...","title":"...","goal":{"text":"...","sources":[{"path":"...","line":1,"end_line":9}]},"acceptance":[{"text":"...","sources":[...]}],"unknowns":["..."],"tasks":["..."]}]}`;
}

/**
 * Checks one citation: a project file the card owns, with a line range inside the
 * file. Returns the cited lines for the reviewer. A citation of another card's file
 * or of lines that do not exist is marked, never silently accepted.
 */
export function checkSource(root: string, canvas: Canvas, cardId: string, ref: SourceRef, files: Set<string>): CheckedSource {
  const clean = path.posix.normalize(String(ref.path ?? "").replace(/\\/g, "/").replace(/^\.\//, ""));
  const line = Number(ref.line);
  const end = ref.end_line === undefined ? line : Number(ref.end_line);
  const out: CheckedSource = { path: clean, line, ...(ref.end_line !== undefined ? { end_line: end } : {}), ok: false };
  if (!clean || clean.startsWith("..") || path.posix.isAbsolute(clean) || !files.has(clean)) return { ...out, problem: "项目里没有这个文件" };
  const owner = ownerOf(canvas, clean);
  if (owner?.id !== cardId) return { ...out, problem: owner ? `这是「${owner.title}」的文件` : "这个文件不属于任何卡片" };
  const text = lines(fs.readFileSync(path.join(root, clean), "utf8"));
  if (!Number.isInteger(line) || !Number.isInteger(end) || line < 1 || end < line || end > text.length) {
    return { ...out, problem: `行号不对（这个文件共 ${text.length} 行）` };
  }
  const shown = text.slice(line - 1, Math.min(end, line + 11)).map((t, i) => `${line + i}| ${t}`);
  return { ...out, ok: true, excerpt: shown.join("\n") + (end > line + 11 ? "\n…" : "") };
}

const strings = (v: unknown, max: number): string[] =>
  (Array.isArray(v) ? v : []).filter((s): s is string => typeof s === "string" && !!s.trim()).map((s) => s.trim()).slice(0, max);

/** A proposed statement: a string or {text, sources}; its sources checked. Null without text. */
function item(v: unknown, check: (ref: SourceRef) => CheckedSource): ProposedItem | null {
  const raw = typeof v === "string" ? { text: v } : (v as { text?: unknown; sources?: unknown } | null);
  const text = typeof raw?.text === "string" ? raw.text.trim() : "";
  if (!text) return null;
  const refs = (Array.isArray(raw?.sources) ? raw.sources : []).filter((s): s is SourceRef => !!s && typeof s === "object").slice(0, 3);
  const sources = refs.map(check);
  return { text, sources, verified: sources.length > 0 && sources.every((s) => s.ok) };
}

/**
 * Reads a model's reply: only the canvas's own cards (or `only`), tolerant of missing
 * fields, every citation checked against the files. Null when nothing usable.
 */
export function parseImportProposal(reply: string, canvas: Canvas, root = "", files: string[] = [], only?: string): ImportProposal | null {
  const draft = parseJsonObject<{ description?: unknown; stack?: unknown; testCommand?: unknown; nodes?: unknown }>(reply);
  if (!draft) return null;
  const known = new Set(only ? [only] : canvas.nodes.map((n) => n.id));
  const fileSet = new Set(files);
  const seen = new Set<string>();
  const nodes: ProposedCard[] = [];
  const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  for (const d of Array.isArray(draft.nodes) ? draft.nodes : []) {
    const id = typeof d?.id === "string" ? d.id : "";
    if (!known.has(id) || seen.has(id)) continue;
    seen.add(id);
    const check = (ref: SourceRef) => checkSource(root, canvas, id, ref, fileSet);
    nodes.push({
      id,
      title: text(d.title) || canvas.nodes.find((n) => n.id === id)!.title,
      goal: item(d.goal, check) ?? { text: "", sources: [], verified: false },
      acceptance: (Array.isArray(d.acceptance) ? d.acceptance : []).map((a: unknown) => item(a, check)).filter((a: ProposedItem | null): a is ProposedItem => !!a).slice(0, 4),
      tasks: strings(d.tasks, 3),
      unknowns: strings(d.unknowns, 5),
    });
  }
  if (!nodes.length) return null;
  return { description: text(draft.description), stack: text(draft.stack), testCommand: text(draft.testCommand), nodes };
}

/**
 * The helper model reads an imported project (or one card, `only`) and proposes a
 * title, goal, acceptance criteria with cited code, unknowns and tasks per card,
 * plus what the project is, its stack and test command (falling back to a guess).
 */
export async function understandProject(llm: Llm, root: string, canvas: Canvas, files: string[], only?: string): Promise<ImportProposal> {
  const reply = await llm.complete(understandPrompt(projectDigest(root, canvas, files, 40_000, only), canvas, only), { timeoutMs: 180_000, maxTokens: 8000 });
  const proposal = parseImportProposal(reply, canvas, root, files, only);
  if (!proposal) throw new Error("帮手模型没有给出可用的卡片说明，请再试一次");
  if (!proposal.testCommand) proposal.testCommand = guessTestCommand(root, files);
  return proposal;
}

const hashFile = (file: string) => createHash("sha1").update(fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n")).digest("hex");

function headCommit(root: string): string | undefined {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
  } catch {
    return undefined; // no git, or no commit yet
  }
}

/**
 * What a card keeps from an adopted proposal: its verified citations, a content hash
 * of each cited file (so a later change can be noticed with or without git), the
 * commit if there is one, and the unknowns.
 */
export function evidenceFor(root: string, card: Pick<ProposedCard, "goal" | "acceptance" | "unknowns">): NonNullable<CanvasNode["evidence"]> {
  const sources = [card.goal, ...card.acceptance]
    .flatMap((i) => i.sources)
    .filter((s) => s.ok)
    .map(({ path: p, line, end_line }) => ({ path: p, line, ...(end_line !== undefined ? { end_line } : {}) }));
  const unique = sources.filter((s, i) => sources.findIndex((t) => t.path === s.path && t.line === s.line && t.end_line === s.end_line) === i);
  const files: Record<string, string> = {};
  for (const s of unique) files[s.path] ??= hashFile(path.join(root, s.path));
  const commit = headCommit(root);
  return { at: new Date().toISOString(), ...(commit ? { commit } : {}), sources: unique, files, unknowns: card.unknowns };
}

/** Cited files that changed (or vanished) since the card's description was written from them. */
export function staleSources(root: string, node: CanvasNode): string[] {
  return Object.entries(node.evidence?.files ?? {})
    .filter(([rel, hash]) => {
      const file = path.join(root, rel);
      return !fs.existsSync(file) || hashFile(file) !== hash;
    })
    .map(([rel]) => rel);
}
