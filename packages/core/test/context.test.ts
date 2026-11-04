import { describe, expect, it } from "vitest";
import { Canvas } from "@agent-together/schema";
import { buildNodeContext, contextSections, estimateTokens } from "@agent-together/core";

const canvas = Canvas.parse({
  version: 1,
  nodes: [
    {
      id: "login-form",
      kind: "feature",
      title: "Login form",
      intent: { goal: "Sign in with email", acceptance: ["Rejects bad email"], tasks: [] },
      files: ["src/auth/**"],
    },
    { id: "user-service", kind: "module", title: "User service", files: ["src/services/**"] },
    { id: "database", kind: "module", title: "Database", files: ["src/db/**"] },
    { id: "app", kind: "feature", title: "App shell", files: ["src/app/**"] },
  ],
  edges: [
    { from: "app", to: "login-form" },
    { from: "login-form", to: "user-service" },
    { from: "user-service", to: "database" },
  ],
});

describe("buildNodeContext", () => {
  const md = buildNodeContext(canvas, "login-form", "Add a digit rule");

  it("states the task, goal, owned files and acceptance criteria", () => {
    expect(md).toContain("Add a digit rule");
    expect(md).toContain("Sign in with email");
    expect(md).toContain("`src/auth/**`");
    expect(md).toContain("- Rejects bad email");
  });

  it("includes direct neighbours only", () => {
    expect(md).toContain("User service");
    expect(md).toContain("App shell");
    expect(md).not.toContain("Database");
  });

  it("rejects an unknown node", () => {
    expect(() => buildNodeContext(canvas, "nope", "")).toThrow("unknown node");
  });
});

describe("estimateTokens / contextSections", () => {
  it("counts CJK characters as one token and other text at four characters per token", () => {
    expect(estimateTokens("登录表单")).toBe(4);
    expect(estimateTokens("abcdefgh")).toBe(2);
  });

  it("lists every heading of a context file with its size", () => {
    const sections = contextSections(buildNodeContext(canvas, "login-form", "Add a digit rule"));
    expect(sections.map((s) => s.title)).toEqual([
      "任务",
      "节点：Login form",
      "可以依赖的节点",
      "依赖本节点的节点",
      "已审批的记忆",
      "Agent Together 会检查的规则",
    ]);
    expect(sections.every((s) => s.tokens > 0)).toBe(true);
  });
});
