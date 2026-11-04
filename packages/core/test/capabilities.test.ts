import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { claudeCodeCompiler } from "@agent-together/adapter-claude-code";
import { agentSkillsCompiler } from "@agent-together/adapter-codex";
import { cursorRulesCompiler } from "@agent-together/adapter-cursor";
import { Canvas, Capability, type AgentEvent } from "@agent-together/schema";
import { CapabilityStore, capabilityFromNode, checkCapability, compileCapabilities, Daemon } from "@agent-together/core";

const compilers = [claudeCodeCompiler, agentSkillsCompiler, cursorRulesCompiler];
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "agent-together-cap-"));

const canvas = Canvas.parse({
  version: 1,
  nodes: [
    { id: "login-form", kind: "feature", title: "登录表单", intent: { goal: "邮箱密码登录" }, files: ["src/auth/**"] },
    { id: "user-service", kind: "module", title: "用户服务", files: ["src/services/**"] },
  ],
  edges: [{ from: "login-form", to: "user-service" }],
});

describe("CapabilityStore", () => {
  it("round-trips a capability through its Markdown file", () => {
    const store = new CapabilityStore(tmp());
    const saved = store.save(
      Capability.parse({ id: "reviewer", kind: "agent", description: "Use when reviewing code", tools: ["Read"], body: "Review carefully.\n\nLine two." }),
    );
    expect(store.list()).toEqual([saved]);
  });
});

describe("checkCapability", () => {
  it("rejects an observer with a broken regex and warns about a vague description", () => {
    const c = Capability.parse({ id: "x", kind: "observer", description: "something", forbid: "(", body: "msg" });
    const { errors, warnings } = checkCapability(c);
    expect(errors.join()).toContain("forbid");
    expect(warnings.join()).toContain("什么时候使用");
  });
});

describe("compileCapabilities", () => {
  it("writes a node skill for Claude Code, the Agent Skills layout and Cursor", () => {
    const root = tmp();
    const skill = capabilityFromNode(canvas, "login-form", []);
    const [report] = compileCapabilities(root, [skill], compilers);
    expect(report.errors).toEqual([]);
    expect(report.written).toEqual({
      "claude-code": [".claude/skills/agent-together-login-form/SKILL.md"],
      "agent-skills": [".agents/skills/agent-together-login-form/SKILL.md"],
      cursor: [".cursor/rules/agent-together-login-form.mdc"],
    });
    expect(fs.readFileSync(path.join(root, ".cursor/rules/agent-together-login-form.mdc"), "utf8")).toContain("globs: src/auth/**");
    expect(fs.readFileSync(path.join(root, ".agents/skills/agent-together-login-form/SKILL.md"), "utf8")).toContain("用户服务");
  });

  it("skips targets that have no equivalent, and compiles nothing with errors", () => {
    const root = tmp();
    const agent = Capability.parse({ id: "reviewer", kind: "agent", description: "Use when reviewing", body: "b" });
    const broken = Capability.parse({ id: "bad", kind: "observer", description: "Use when x", forbid: "(", body: "b" });
    const observer = Capability.parse({ id: "ok", kind: "observer", description: "Use when x", forbid: "y", body: "b" });
    const [a, b, c] = compileCapabilities(root, [agent, broken, observer], compilers);
    expect(a.skipped).toEqual(["agent-skills", "cursor"]);
    expect(b.written).toEqual({});
    expect(c).toMatchObject({ kind: "observer", written: {}, skipped: [] });
  });
});

describe("capabilityFromNode", () => {
  it("bumps the version only when the node's content changed", () => {
    const v1 = capabilityFromNode(canvas, "login-form", []);
    expect(capabilityFromNode(canvas, "login-form", [], v1).version).toBe("1");
    const memory = { id: "m", nodeId: "login-form", kind: "decision" as const, status: "active" as const, content: "用 zod", source: "user", createdAt: "" };
    expect(capabilityFromNode(canvas, "login-form", [memory], v1).version).toBe("2");
  });
});

describe("observer capabilities", () => {
  it("become rules the daemon enforces on every platform", () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, ".agent-together", "canvas"), { recursive: true });
    fs.writeFileSync(path.join(root, ".agent-together", "canvas", "login-form.json"), JSON.stringify(canvas.nodes[0]));
    new CapabilityStore(root).save(
      Capability.parse({
        id: "no-console-log",
        kind: "observer",
        description: "Use when writing auth code",
        scope: ["src/auth/**"],
        forbid: "console\\.log",
        level: "ask",
        body: "认证代码不许留 console.log，用 logger。",
      }),
    );
    const daemon = new Daemon(root);
    const write = (platform: "claude-code" | "codex", file: string, after: string, before?: string): AgentEvent => ({
      kind: "tool.before",
      platform,
      sessionId: platform,
      at: "2026-11-04T00:00:00.000Z",
      action: { type: "write", path: path.join(root, file), after, before },
    });
    const rules = (e: AgentEvent) => daemon.handle(e).findings.map((f) => `${f.rule}:${f.level}`);
    expect(rules(write("claude-code", "src/auth/a.ts", "console.log(email)"))).toEqual(["capability:no-console-log:ask"]);
    expect(rules(write("codex", "src/auth/a.ts", "console.log(email)"))).toEqual(["capability:no-console-log:ask"]);
    expect(rules(write("codex", "src/other/a.ts", "console.log(email)"))).toEqual([]);
    expect(rules(write("codex", "src/auth/a.ts", "console.log(x)\nreturn 1", "console.log(x)"))).toEqual([]);
  });
});
