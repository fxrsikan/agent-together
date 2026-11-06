import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentEvent } from "@agent-together/schema";
import { auditChanges, Checkpoints, writtenPaths } from "@agent-together/core";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "at-audit-"));
  dirs.push(root);
  const write = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  write(".agent-together/canvas/auth.json", JSON.stringify({ id: "auth", kind: "feature", title: "Auth", files: ["src/auth/**"] }));
  write(".agent-together/canvas/db.json", JSON.stringify({ id: "db", kind: "module", title: "DB", files: ["src/db/**"] }));
  write(".agent-together/canvas/_edges.json", "[]");
  write("src/auth/login.ts", "export const login = 1;\n");
  write("src/db/schema.ts", "export const schema = 1;\n");
  write("src/auth/login.test.ts", "expect(a).toBe(1);\nexpect(b).toBe(2);\n");
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "-A"], { cwd: root });
  execFileSync("git", ["commit", "-qm", "base"], { cwd: root, env });
  return { root, write };
}

describe("auditChanges", { timeout: 30_000 }, () => {
  it("finds a write to another node that the hooks never saw", () => {
    const { root, write } = project();
    const base = new Checkpoints(root).create("before", "auth").commit;
    write("src/auth/login.ts", "export const login = 2;\n"); // seen live
    write("src/db/schema.ts", "export const schema = 2;\n"); // e.g. `echo > src/db/schema.ts`
    const seen = writtenPaths(root, [
      {
        kind: "tool.before",
        platform: "claude-code",
        sessionId: "s",
        at: "",
        action: { type: "write", path: path.join(root, "src/auth/login.ts"), after: "" },
      } as AgentEvent,
    ]);
    const audit = auditChanges(root, base, "auth", seen);
    expect(audit.files.map((f) => f.path).sort()).toEqual(["src/auth/login.ts", "src/db/schema.ts"]);
    expect(audit.findings).toHaveLength(1);
    expect(audit.findings[0]).toMatchObject({ rule: "scope-fence", path: "src/db/schema.ts", seenLive: false });
  });

  it("reads Chinese file names as they are, judging and reading the right files", () => {
    const { root, write } = project();
    write("src/auth/登录页.ts", "export const a = 1;\n");
    execFileSync("git", ["add", "-A"], { cwd: root });
    execFileSync("git", ["commit", "-qm", "中文"], { cwd: root, env });
    const base = new Checkpoints(root).create("before", "auth").commit;
    write("src/auth/登录页.ts", "export const a = 2;\n"); // edited, inside the card
    write("src/db/数据表.ts", "export const t = 1;\n"); // new, outside the card
    const audit = auditChanges(root, base, "auth");
    expect(audit.files.map((f) => [f.path, f.owner]).sort()).toEqual([
      ["src/auth/登录页.ts", "auth"],
      ["src/db/数据表.ts", "db"],
    ]);
    expect(audit.findings).toHaveLength(1);
    expect(audit.findings[0]).toMatchObject({ rule: "scope-fence", path: "src/db/数据表.ts" });
  });

  it("catches a deleted test file and ignores bookkeeping folders", () => {
    const { root, write } = project();
    const base = new Checkpoints(root).create("before", "auth").commit;
    fs.rmSync(path.join(root, "src/auth/login.test.ts"));
    write(".claude/settings.local.json", "{}");
    write(".agent-together/context/auth.md", "x");
    const audit = auditChanges(root, base, "auth");
    expect(audit.files.map((f) => f.path)).toEqual(["src/auth/login.test.ts"]);
    expect(audit.findings.map((f) => f.rule)).toContain("test-tampering");
  });

  it("is quiet when nothing changed", () => {
    const { root } = project();
    const base = new Checkpoints(root).create("before", "auth").commit;
    expect(auditChanges(root, base, "auth")).toMatchObject({ files: [], findings: [] });
  });
});
