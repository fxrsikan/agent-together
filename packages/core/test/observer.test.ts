import { describe, expect, it } from "vitest";
import { Canvas, type AgentEvent } from "@agent-together/schema";
import { Observer } from "@agent-together/core";

const root = process.platform === "win32" ? "C:\\proj" : "/proj";
const at = "2026-11-04T00:00:00.000Z";

const canvas = Canvas.parse({
  version: 1,
  nodes: [
    { id: "login-form", kind: "feature", title: "Login form", files: ["src/auth/**"] },
    { id: "db", kind: "module", title: "Database", files: ["src/db/**"] },
  ],
  edges: [{ from: "login-form", to: "db" }],
});

const write = (path: string, after: string, before?: string): AgentEvent => ({
  kind: "tool.before",
  platform: "claude-code",
  sessionId: "s1",
  at,
  action: { type: "write", path, before, after },
});

const failed = (command: string): AgentEvent => ({
  kind: "tool.after",
  platform: "claude-code",
  sessionId: "s1",
  at,
  action: { type: "shell", command },
  ok: false,
});

const observer = (active: string | null = "login-form") => new Observer(root, canvas, {}, undefined, active);

describe("scope-fence", () => {
  it("allows writes inside the active node", () => {
    expect(observer().evaluate(write(`${root}/src/auth/form.ts`, "x")).level).toBe("off");
  });

  it("asks before writing outside the active node", () => {
    const verdict = observer().evaluate(write(`${root}/src/db/schema.ts`, "x"));
    expect(verdict.level).toBe("ask");
    expect(verdict.findings[0]).toMatchObject({ rule: "scope-fence", nodeId: "login-form" });
  });

  it("stays quiet when no node is active", () => {
    expect(observer(null).evaluate(write(`${root}/src/db/schema.ts`, "x")).level).toBe("off");
  });

  it("lets a write through only when the file's owner is the active node, as ownership says everywhere else", () => {
    // tests/** belongs to "tests", but the more specific tests/test_store.py belongs to "store".
    const overlap = Canvas.parse({
      version: 1,
      nodes: [
        { id: "tests", kind: "module", title: "Tests", files: ["tests/**"] },
        { id: "store", kind: "module", title: "Store", files: ["src/store/**", "tests/test_store.py"] },
      ],
      edges: [],
    });
    const asTests = new Observer(root, overlap, {}, undefined, "tests");
    expect(asTests.evaluate(write(`${root}/tests/test_cli.py`, "x")).level).toBe("off");
    const v = asTests.evaluate(write(`${root}/tests/test_store.py`, "x"));
    expect(v.level).toBe("ask");
    expect(v.findings[0].message).toContain('belongs to "Store"');
    expect(new Observer(root, overlap, {}, undefined, "store").evaluate(write(`${root}/tests/test_store.py`, "x")).level).toBe("off");
  });

  it("honours a level override from rules.json", () => {
    const o = new Observer(root, canvas, { "scope-fence": "block" }, undefined, "login-form");
    expect(o.evaluate(write(`${root}/src/db/schema.ts`, "x")).level).toBe("block");
  });
});

describe("test-tampering", () => {
  it("flags skipping a test", () => {
    const verdict = observer().evaluate(
      write(`${root}/src/auth/form.test.ts`, "it.skip('works', () => {})", "it('works', () => {})"),
    );
    expect(verdict.findings.map((f) => f.rule)).toContain("test-tampering");
  });

  it("flags deleting assertions", () => {
    const verdict = observer().evaluate(
      write(`${root}/src/auth/form.test.ts`, "expect(a).toBe(1);", "expect(a).toBe(1); expect(b).toBe(2);"),
    );
    expect(verdict.findings.map((f) => f.rule)).toContain("test-tampering");
  });

  it("allows replacing loose assertions with one exact assertion", () => {
    const before = "assert.match(message, /1/);\nassert.match(message, /买 牛奶/);";
    const after = "assert.equal(message, '已添加：买 牛奶（编号 1）');";
    const verdict = observer().evaluate(write(`${root}/src/auth/form.test.ts`, after, before));
    expect(verdict.findings.map((f) => f.rule)).not.toContain("test-tampering");
  });

  it("still flags dropping an exact assertion for a loose one", () => {
    const before = "assert.equal(a, 1);\nassert.equal(b, 2);";
    const after = "assert.ok(a);";
    const verdict = observer().evaluate(write(`${root}/src/auth/form.test.ts`, after, before));
    expect(verdict.findings.map((f) => f.rule)).toContain("test-tampering");
  });

  it("still flags deleting loose assertions without adding an exact one", () => {
    const before = "assert.match(m, /1/);\nassert.match(m, /x/);";
    const after = "assert.match(m, /1/);";
    const verdict = observer().evaluate(write(`${root}/src/auth/form.test.ts`, after, before));
    expect(verdict.findings.map((f) => f.rule)).toContain("test-tampering");
  });
});

describe("repeated-failure", () => {
  it("warns on the third failure of the same command", () => {
    const o = observer();
    expect(o.evaluate(failed("npm test")).level).toBe("off");
    expect(o.evaluate(failed("npm test")).level).toBe("off");
    expect(o.evaluate(failed("npm test")).level).toBe("warn");
  });
});
