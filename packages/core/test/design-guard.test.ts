import { describe, expect, it } from "vitest";
import { Canvas, type LoomEvent } from "@loom/schema";
import { Observer } from "@loom/core";

const root = process.platform === "win32" ? "C:\\proj" : "/proj";

// login-form → user-service → database
const canvas = Canvas.parse({
  version: 1,
  nodes: [
    { id: "login-form", kind: "feature", title: "Login form", files: ["src/auth/**"] },
    { id: "user-service", kind: "module", title: "User service", files: ["src/services/**"] },
    { id: "database", kind: "module", title: "Database", files: ["src/db/**"] },
  ],
  edges: [
    { from: "login-form", to: "user-service" },
    { from: "user-service", to: "database" },
  ],
});

const write = (file: string, after: string, before?: string): LoomEvent => ({
  kind: "tool.before",
  platform: "claude-code",
  sessionId: "s1",
  at: "2026-11-04T00:00:00.000Z",
  action: { type: "write", path: `${root}/${file}`, before, after },
});

const rules = (event: LoomEvent) =>
  new Observer(root, canvas, { "scope-fence": "off" }).evaluate(event).findings.map((f) => f.rule);

describe("design-guard", () => {
  it("allows an import along a canvas edge", () => {
    expect(rules(write("src/auth/form.ts", `import { findUser } from "../services/users";`))).toEqual([]);
  });

  it("flags an import that skips a layer", () => {
    expect(rules(write("src/auth/form.ts", `import { db } from "../db/client";`))).toEqual(["design-guard"]);
  });

  it("flags an import against the edge direction", () => {
    expect(rules(write("src/services/users.ts", `const form = require("../auth/form");`))).toEqual(["design-guard"]);
  });

  it("ignores imports that were already there", () => {
    const line = `import { db } from "../db/client";`;
    expect(rules(write("src/auth/form.ts", `${line}\nexport {};`, line))).toEqual([]);
  });

  it("resolves a directory import past a root-level glob", () => {
    const withRoot = Canvas.parse({
      ...canvas,
      nodes: [...canvas.nodes, { id: "src", kind: "module", title: "src root", files: ["src/*"] }],
    });
    const o = new Observer(root, withRoot, { "scope-fence": "off" });
    const verdict = o.evaluate(write("src/auth/form.ts", `import { db } from "../db";`));
    expect(verdict.findings[0]?.message).toContain("Database");
  });

  it("ignores packages and imports inside the same node", () => {
    expect(rules(write("src/auth/form.ts", `import React from "react";\nimport { a } from "./a";`))).toEqual([]);
  });
});
