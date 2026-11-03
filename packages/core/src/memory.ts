import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Memory, type Canvas, type Finding } from "@loom/schema";
import { formatFrontmatter, parseFrontmatter } from "./frontmatter.js";

const FIELDS = ["id", "nodeId", "kind", "status", "source", "createdAt", "evidence"] as const;
const BLOCK_START = "<!-- loom:memory:start -->";
const BLOCK_END = "<!-- loom:memory:end -->";

const KIND_LABEL: Record<Memory["kind"], string> = { decision: "决策", constraint: "约束", pitfall: "踩过的坑", preference: "偏好" };

const serialize = (m: Memory) => formatFrontmatter(FIELDS.map((k) => [k, m[k]]), m.content);

function parse(text: string): Memory {
  const { fields, body } = parseFrontmatter(text);
  return Memory.parse({ ...fields, content: body });
}

/**
 * Memories as reviewable Markdown files: .loom/memory/<id>.md with a small
 * frontmatter. Shared through git like the canvas.
 */
export class MemoryStore {
  readonly dir: string;

  constructor(readonly root: string) {
    this.dir = path.join(root, ".loom", "memory");
  }

  list(): Memory[] {
    if (!fs.existsSync(this.dir)) return [];
    return fs
      .readdirSync(this.dir)
      .filter((f) => f.endsWith(".md"))
      .sort()
      .map((f) => parse(fs.readFileSync(path.join(this.dir, f), "utf8")));
  }

  /** Adds a memory unless one with the same node and content already exists (in any status). */
  add(input: Omit<Memory, "id" | "createdAt"> & { createdAt?: string }): Memory | null {
    const content = input.content.trim();
    if (this.list().some((m) => m.nodeId === input.nodeId && m.content === content)) return null;
    const createdAt = input.createdAt ?? new Date().toISOString();
    const hash = createHash("sha1").update(`${input.nodeId}\n${content}`).digest("hex").slice(0, 8);
    const memory = Memory.parse({ ...input, content, createdAt, id: `${createdAt.slice(0, 10)}-${hash}` });
    this.write(memory);
    return memory;
  }

  update(id: string, patch: Partial<Pick<Memory, "status" | "content" | "kind" | "nodeId" | "evidence">>): Memory {
    const current = this.list().find((m) => m.id === id);
    if (!current) throw new Error(`unknown memory: ${id}`);
    const next = Memory.parse({ ...current, ...patch });
    this.write(next);
    return next;
  }

  /** Active memories an agent working on a node should know: the node's own plus project-wide ones. */
  forNode(nodeId: string): Memory[] {
    return this.list().filter((m) => m.status === "active" && (m.nodeId === nodeId || m.nodeId === null));
  }

  /**
   * Mirrors active memories into a Loom-managed block of the project's agent
   * instruction files — CLAUDE.md (Claude Code) and AGENTS.md (Codex, Cursor,
   * Grok Build) — so agents started without Loom still see them. Text outside
   * the block is kept. Returns the files written.
   */
  syncAgentFiles(canvas: Canvas): string[] {
    const active = this.list().filter((m) => m.status === "active");
    const title = (id: string | null) => (id ? canvas.nodes.find((n) => n.id === id)?.title ?? id : "全项目");
    const groups = new Map<string, Memory[]>();
    for (const m of active) groups.set(title(m.nodeId), [...(groups.get(title(m.nodeId)) ?? []), m]);
    const body = [...groups]
      .map(([t, ms]) => `### ${t}\n\n${ms.map((m) => `- （${KIND_LABEL[m.kind]}）${m.content}`).join("\n")}`)
      .join("\n\n");
    const block = `${BLOCK_START}\n## Loom 记忆（由 Loom 维护，请在 Loom 中修改）\n\n${body || "（暂无）"}\n${BLOCK_END}`;

    return ["CLAUDE.md", "AGENTS.md"].map((name) => {
      const file = path.join(this.root, name);
      const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
      const start = existing.indexOf(BLOCK_START);
      const end = existing.indexOf(BLOCK_END);
      const next =
        start >= 0 && end > start
          ? existing.slice(0, start) + block + existing.slice(end + BLOCK_END.length)
          : `${existing}${existing && !existing.endsWith("\n") ? "\n" : ""}${existing ? "\n" : ""}${block}\n`;
      fs.writeFileSync(file, next);
      return file;
    });
  }

  private write(m: Memory) {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(path.join(this.dir, `${m.id}.md`), serialize(m));
  }
}

const RULE_LABEL: Record<string, string> = {
  "scope-fence": "越界写入",
  "design-guard": "违反依赖关系",
  "test-tampering": "篡改测试",
  "repeated-failure": "命令反复失败",
  "repeated-read": "反复读取同一文件",
};

/**
 * 记忆官 (rule-based for v0.1): turns what the observer caught during one agent
 * session into memory drafts for a human to approve. LLM summarisation is L2.
 */
export function draftsFromFindings(canvas: Canvas, findings: Finding[], sessionId: string): Omit<Memory, "id" | "createdAt">[] {
  const seen = new Set<string>();
  const drafts: Omit<Memory, "id" | "createdAt">[] = [];
  for (const f of findings) {
    if (f.level === "off" || f.level === "log") continue;
    const key = `${f.rule}\n${f.nodeId}\n${f.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const node = canvas.nodes.find((n) => n.id === f.nodeId);
    drafts.push({
      nodeId: node?.id ?? null,
      kind: "pitfall",
      status: "draft",
      content: `${RULE_LABEL[f.rule] ?? f.rule}：${f.message}`,
      source: `observer:${f.rule} session ${sessionId.slice(0, 8)}`,
    });
  }
  return drafts;
}
