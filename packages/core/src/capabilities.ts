import fs from "node:fs";
import path from "node:path";
import picomatch from "picomatch";
import { Capability, type Canvas, type CapabilityCompiler, type Memory } from "@loom/schema";
import { buildNodeGuide } from "./context.js";
import { formatFrontmatter, parseFrontmatter } from "./frontmatter.js";
import { relativeToRoot } from "./paths.js";
import type { Rule } from "./rules/types.js";

const FIELDS = ["id", "kind", "description", "version", "nodeId", "scope", "tools", "model", "forbid", "level"] as const;

/** Capabilities as Markdown files in .loom/capabilities/<id>.md, shared through git. */
export class CapabilityStore {
  readonly dir: string;

  constructor(readonly root: string) {
    this.dir = path.join(root, ".loom", "capabilities");
  }

  list(): Capability[] {
    if (!fs.existsSync(this.dir)) return [];
    return fs
      .readdirSync(this.dir)
      .filter((f) => f.endsWith(".md"))
      .sort()
      .map((f) => {
        const { fields, body } = parseFrontmatter(fs.readFileSync(path.join(this.dir, f), "utf8"));
        return Capability.parse({ ...fields, body });
      });
  }

  save(input: Capability): Capability {
    const capability = Capability.parse(input);
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(
      path.join(this.dir, `${capability.id}.md`),
      formatFrontmatter(FIELDS.map((k) => [k, capability[k]]), capability.body),
    );
    return capability;
  }
}

/**
 * Node gene → capability: a finished node becomes a skill holding its goal,
 * file scope, neighbours, approved memories and Loom's rules. Its version goes
 * up each time the node is exported again with different content.
 */
export function capabilityFromNode(canvas: Canvas, nodeId: string, memories: Memory[], previous?: Capability): Capability {
  const node = canvas.nodes.find((n) => n.id === nodeId);
  if (!node) throw new Error(`unknown node: ${nodeId}`);
  const id = `loom-${node.id}`.slice(0, 64);
  const scope = node.files.join(", ") || "its files";
  const body = buildNodeGuide(canvas, nodeId, memories);
  const description = `Work on "${node.title}"${node.intent.goal ? `: ${node.intent.goal}` : ""}. Use when changing ${scope}.`.slice(0, 1024);
  const version = previous && previous.body !== body ? String(Number(previous.version) + 1 || 2) : (previous?.version ?? "1");
  return Capability.parse({ id, kind: "skill", description, version, nodeId, scope: node.files, body });
}

export interface CheckResult {
  errors: string[];
  warnings: string[];
}

const KNOWN_TOOLS = new Set(["Read", "Write", "Edit", "MultiEdit", "Bash", "Glob", "Grep", "WebFetch", "WebSearch", "NotebookEdit", "TodoWrite"]);

/** Checks run before a capability is compiled: errors stop it, warnings are shown. */
export function checkCapability(c: Capability): CheckResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!/\b(use when|use for|when)\b|当|用于|适用/i.test(c.description)) {
    warnings.push("description 最好写明什么时候使用（Use when… / 用于…），agent 靠它决定是否加载");
  }
  for (const glob of c.scope) {
    try {
      picomatch(glob);
    } catch {
      errors.push(`scope 里的 "${glob}" 不是合法的 glob`);
    }
  }
  if (c.kind === "observer") {
    if (!c.forbid) errors.push("observer 需要 forbid（禁止出现的正则）");
    else
      try {
        new RegExp(c.forbid);
      } catch {
        errors.push(`forbid 不是合法的正则：${c.forbid}`);
      }
  }
  if (c.kind === "agent") {
    for (const t of c.tools ?? []) if (!KNOWN_TOOLS.has(t) && !t.startsWith("mcp__")) warnings.push(`未知工具 "${t}"`);
  }
  if (c.body.length > 20_000) warnings.push("正文超过 2 万字，会占用很多上下文，考虑拆分");
  return { errors, warnings };
}

export interface CompileReport {
  id: string;
  kind: Capability["kind"];
  errors: string[];
  warnings: string[];
  /** Project-relative paths written, by target. */
  written: Record<string, string[]>;
  /** Targets with no equivalent for this kind. */
  skipped: string[];
}

/** Checks and compiles capabilities with every compiler, writing the files under root. */
export function compileCapabilities(root: string, capabilities: Capability[], compilers: CapabilityCompiler[]): CompileReport[] {
  return capabilities.map((c) => {
    const { errors, warnings } = checkCapability(c);
    const report: CompileReport = { id: c.id, kind: c.kind, errors, warnings, written: {}, skipped: [] };
    // Observers are enforced by Loom itself on every platform; there is nothing to write.
    if (errors.length || c.kind === "observer") return report;
    for (const compiler of compilers) {
      const files = compiler.compile(c);
      if (!files.length) {
        report.skipped.push(compiler.target);
        continue;
      }
      for (const f of files) {
        const full = path.join(root, f.path);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, f.content);
      }
      report.written[compiler.target] = files.map((f) => f.path);
    }
    return report;
  });
}

/**
 * Observer capabilities become L0 rules: a write inside `scope` whose new text
 * matches `forbid` is flagged at `level`. Platform-independent by construction.
 */
export function capabilityRules(capabilities: Capability[]): Rule[] {
  return capabilities
    .filter((c) => c.kind === "observer" && c.forbid && checkCapability(c).errors.length === 0)
    .map((c) => {
      const pattern = new RegExp(c.forbid!);
      const inScope = c.scope.length ? picomatch(c.scope) : () => true;
      return {
        id: `capability:${c.id}`,
        defaultLevel: c.level ?? "warn",
        check(event, { root, activeNode }) {
          if (event.kind !== "tool.before" || event.action.type !== "write") return null;
          const rel = relativeToRoot(root, event.action.path);
          if (!rel || !inScope(rel)) return null;
          // Only text the agent adds: matches already in "before" are not its doing.
          const added = event.action.after.split("\n").filter((line) => !(event.action.type === "write" && event.action.before?.includes(line)));
          if (!added.some((line) => pattern.test(line))) return null;
          return { nodeId: activeNode?.id, message: `${rel}: ${c.body}` };
        },
      } satisfies Rule;
    });
}
