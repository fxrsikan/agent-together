import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { AgentEvent, Canvas, Finding } from "@agent-together/schema";
import { capabilityRules, CapabilityStore } from "./capabilities.js";
import { Checkpoints } from "./checkpoints.js";
import { Observer } from "./observer.js";
import { ownerOf } from "./owners.js";
import { zNumstat } from "./paths.js";
import { builtinRules } from "./rules/index.js";
import { ProjectStore } from "./store.js";

/** Agent Together's and the agents' own bookkeeping, never judged. */
const SKIP = (rel: string) =>
  [".agent-together/", ".claude/", ".cursor/", ".codex/", ".agents/"].some((p) => rel.startsWith(p)) ||
  rel.split("/").includes("node_modules");

export interface AuditFinding extends Finding {
  path: string;
  /** The observer saw a write to this file while the agent worked; false means it slipped past (a shell command, a script). */
  seenLive: boolean;
}

export interface AuditResult {
  base: string;
  files: { path: string; added: number; removed: number; owner: string | null }[];
  findings: AuditFinding[];
}

/** The after-run check's answer: its result, or why it could not run (never silently nothing). */
export type AuditOutcome = AuditResult | { error: string };

const git = (cwd: string, args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 }).trim();

const toRel = (root: string, file: string) => {
  const rel = path.isAbsolute(file) ? path.relative(root, file) : file;
  return rel.split(path.sep).join("/").replace(/^\.\//, "");
};

/** Project-relative paths of the files a stream of observer events wrote. */
export function writtenPaths(root: string, events: AgentEvent[]): Set<string> {
  const seen = new Set<string>();
  for (const e of events) if (e.kind === "tool.before" && e.action.type === "write") seen.add(toRel(root, e.action.path).toLowerCase());
  return seen;
}

/**
 * After an agent ran: compare the project with the checkpoint taken before it
 * started and put every changed file through the observer, however it was
 * changed. Hooks only see the agent's file tools; this also catches writes made
 * through shell commands or scripts.
 */
export function auditChanges(root: string, base: string, nodeId: string | null, seen: Set<string> = new Set(), canvas?: Canvas, grants: string[] = []): AuditResult {
  const store = new ProjectStore(root);
  const now = canvas ?? store.loadCanvas();
  const after = new Checkpoints(root).snapshot("事后检查");
  const files = zNumstat(git(root, ["diff", "--numstat", "-z", "--relative", "--no-renames", base, after]))
    .map((f) => ({ ...f, owner: ownerOf(now, f.path)?.id ?? null }))
    .filter((f) => !SKIP(f.path));

  const observer = new Observer(
    root,
    now,
    store.loadRuleLevels(),
    [...builtinRules, ...capabilityRules(new CapabilityStore(root).list())],
    nodeId,
    grants,
  );
  const findings: AuditFinding[] = [];
  for (const f of files) {
    let before: string | undefined;
    try {
      before = git(root, ["show", `${base}:./${f.path}`]);
    } catch {
      before = undefined; // new file
    }
    const full = path.join(root, f.path);
    const event: AgentEvent = {
      kind: "tool.before",
      platform: "claude-code",
      sessionId: "audit",
      at: new Date().toISOString(),
      action: { type: "write", path: full, before, after: fs.existsSync(full) ? fs.readFileSync(full, "utf8") : "" },
    };
    const seenLive = seen.has(f.path.toLowerCase());
    for (const finding of observer.evaluate(event).findings) findings.push({ ...finding, path: f.path, seenLive });
  }
  return { base, files, findings };
}
