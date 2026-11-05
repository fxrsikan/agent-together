import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Memory, type Canvas, type Finding } from "@agent-together/schema";
import { formatFrontmatter, parseFrontmatter } from "./frontmatter.js";
import { ruleLabel } from "./setup.js";

const FIELDS = ["id", "nodeId", "kind", "status", "source", "createdAt", "evidence", "verifiedWith"] as const;
const BLOCK_START = "<!-- agent-together:memory:start -->";
const BLOCK_END = "<!-- agent-together:memory:end -->";

const KIND_LABEL: Record<Memory["kind"], string> = { decision: "决策", constraint: "约束", pitfall: "踩过的坑", preference: "偏好" };

/** How a memory records what it was proven with: "claude-code/haiku", or "claude-code" for its default model. */
export function verifierKey(agent: string, model?: string): string {
  return model?.trim() ? `${agent}/${model.trim()}` : agent;
}

const AGENT_NAMES: Record<string, string> = { "claude-code": "Claude Code", codex: "Codex", cursor: "Cursor", "grok-build": "Grok Build" };

/** "claude-code/haiku" → "Claude Code · haiku"; "codex" → "Codex · 默认模型". */
export function verifierLabel(key: string): string {
  const [agent, ...model] = key.split("/");
  return `${AGENT_NAMES[agent] ?? agent} · ${model.length ? model.join("/") : "默认模型"}`;
}

/**
 * Splits memories into the ones to hand an assistant using `key` and the ones proven
 * with another assistant or model. Memories that name no verifier apply to any.
 */
export function splitByVerifier(memories: Memory[], key: string): { fit: Memory[]; other: Memory[] } {
  const fit: Memory[] = [];
  const other: Memory[] = [];
  for (const m of memories) (!m.verifiedWith || m.verifiedWith === key ? fit : other).push(m);
  return { fit, other };
}

const serialize = (m: Memory) => formatFrontmatter(FIELDS.map((k) => [k, m[k]]), m.content);

function parse(text: string): Memory {
  const { fields, body } = parseFrontmatter(text);
  return Memory.parse({ ...fields, content: body });
}

/**
 * Memories as reviewable Markdown files: .agent-together/memory/<id>.md with a small
 * frontmatter. Shared through git like the canvas.
 */
export class MemoryStore {
  readonly dir: string;

  constructor(readonly root: string) {
    this.dir = path.join(root, ".agent-together", "memory");
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

  update(id: string, patch: Partial<Pick<Memory, "status" | "content" | "kind" | "nodeId" | "evidence" | "verifiedWith">>): Memory {
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
   * Mirrors active project-wide memories into a Agent Together-managed block of the
   * project's agent instruction files — CLAUDE.md (Claude Code) and AGENTS.md (Codex,
   * Cursor, Grok Build) — so agents started without Agent Together still see them. Text
   * outside the block is kept. Returns the files written.
   *
   * A card's own memories stay out: agents read these files on every start, so they
   * would carry every card's memories into every dispatch, and the card being worked
   * on gets its memories in its context file anyway. `canvas` is no longer needed.
   */
  syncAgentFiles(_canvas?: Canvas): string[] {
    const active = this.list().filter((m) => m.status === "active" && m.nodeId === null);
    const body = active.map((m) => `- （${KIND_LABEL[m.kind]}）${m.content}`).join("\n");
    const block =
      `${BLOCK_START}\n## Agent Together 全项目记忆（由 Agent Together 维护，请在 Agent Together 中修改）\n\n` +
      `${body || "（暂无）"}\n\n每张卡片自己的记忆，在交给 AI 时随任务说明一起给出。\n${BLOCK_END}`;

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

  /**
   * Rewrites the managed block where one already exists, so a project opened after an
   * update matches what syncAgentFiles writes now. Creates no files. Returns the files written.
   */
  refreshAgentFiles(): string[] {
    const has = (name: string) => {
      const file = path.join(this.root, name);
      return fs.existsSync(file) && fs.readFileSync(file, "utf8").includes(BLOCK_START);
    };
    return has("CLAUDE.md") || has("AGENTS.md") ? this.syncAgentFiles() : [];
  }

  private write(m: Memory) {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(path.join(this.dir, `${m.id}.md`), serialize(m));
  }
}

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
      content: `${ruleLabel(f.rule)}：${f.message}`,
      source: `observer:${f.rule} session ${sessionId.slice(0, 8)}`,
    });
  }
  return drafts;
}
