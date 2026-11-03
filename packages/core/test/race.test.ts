import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentRunner } from "@loom/schema";
import { Race, scoreContestant } from "@loom/core";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

/** A repo whose Loom project lives in app/: login-form owns src/auth, database owns src/db. */
function repo() {
  const top = fs.mkdtempSync(path.join(os.tmpdir(), "loom-race-repo-"));
  git(top, "init", "-q");
  const app = path.join(top, "app");
  const write = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(app, rel)), { recursive: true });
    fs.writeFileSync(path.join(app, rel), text);
  };
  write(".loom/canvas/login-form.json", JSON.stringify({ id: "login-form", kind: "feature", title: "Login", files: ["src/auth/**"] }));
  write(".loom/canvas/database.json", JSON.stringify({ id: "database", kind: "module", title: "DB", files: ["src/db/**"] }));
  write(".loom/canvas/_edges.json", "[]");
  // The "tests": pass when src/auth/rule.txt says digit.
  write(".loom/race.json", JSON.stringify({ testCommand: `node -e "process.exit(require('fs').readFileSync('src/auth/rule.txt','utf8').includes('digit')?0:1)"` }));
  write("src/auth/rule.txt", "length\n");
  return { top, app };
}

/** A fake agent that writes files in its working folder. */
const agent = (id: string, files: Record<string, string>): AgentRunner => ({
  id,
  async run(cwd, prompt) {
    expect(prompt).toContain(".loom/context/login-form.md");
    expect(fs.readFileSync(path.join(cwd, ".loom/context/login-form.md"), "utf8")).toContain("add a digit rule");
    for (const [rel, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true });
      fs.writeFileSync(path.join(cwd, rel), text);
    }
    return { ok: true, summary: `${id} done`, durationMs: 1 };
  },
});

describe("Race", () => {
  it("runs contestants in isolated worktrees, scores them, and adopts the winner", async () => {
    const { top, app } = repo();
    const race = new Race(app);
    const report = await race.run("login-form", "add a digit rule", [
      agent("careful", { "src/auth/rule.txt": "length\ndigit\n" }),
      agent("sloppy", { "src/auth/rule.txt": "length\n", "src/db/users.ts": "export const users = [];" }),
    ]);

    const [careful, sloppy] = report.contestants;
    expect(careful.files).toEqual([{ path: "src/auth/rule.txt", added: 1, removed: 0 }]);
    expect(careful.tests?.passed).toBe(true);
    expect(careful.findings).toEqual([]);
    expect(sloppy.tests?.passed).toBe(false);
    expect(sloppy.findings.map((f) => f.rule)).toContain("scope-fence");
    expect(careful.score.total).toBeGreaterThan(sloppy.score.total);
    // The real project is untouched until a winner is adopted.
    expect(fs.readFileSync(path.join(app, "src/auth/rule.txt"), "utf8")).toBe("length\n");

    race.adopt(report.id, "careful");
    // git writes line endings per the user's core.autocrlf (CRLF on a default Windows install).
    expect(fs.readFileSync(path.join(app, "src/auth/rule.txt"), "utf8").replace(/\r\n/g, "\n")).toBe("length\ndigit\n");
    expect(fs.existsSync(path.join(app, "src/db/users.ts"))).toBe(false);
    expect(fs.existsSync(careful.worktree)).toBe(false);
    expect(git(top, "for-each-ref", "refs/loom/races")).toBe("");
    expect(race.load(report.id).adopted).toBe("careful");
  }, 60_000); // several git worktrees: slow on Windows
});

describe("scoreContestant", () => {
  it("explains every point it gives or takes", () => {
    const score = scoreContestant({
      run: { ok: false, summary: "", durationMs: 1 },
      files: [{ path: "a", added: 50, removed: 10 }],
      findings: [{ rule: "design-guard", level: "ask", message: "" }],
      tests: { command: "t", passed: true, output: "" },
    });
    expect(score.parts.map((p) => `${p.label}:${p.points}`)).toEqual([
      "agent 没有正常结束:-30",
      "测试通过:40",
      "违反 design-guard:-15",
      "改动 60 行:-3",
    ]);
    expect(score.total).toBe(92);
  });
});
