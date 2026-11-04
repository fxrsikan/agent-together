import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { generateCanvas, initProject, ProjectStore } from "@agent-together/core";

function project(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-together-init-"));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}

const files = {
  "src/index.ts": `import { form } from "./auth/form";`,
  "src/auth/form.ts": `import { findUser } from "../services/users";\nimport { x } from "./x";`,
  "src/auth/x.ts": "export const x = 1;",
  "src/services/users.ts": `import { db } from "../db";`,
  "src/db/index.ts": "export const db = {};",
  "README.md": "# demo",
};

describe("generateCanvas", () => {
  const root = project(files);
  const canvas = generateCanvas(root, Object.keys(files));

  it("makes one module node per directory under src, plus root-level files", () => {
    expect(canvas.nodes.map((n) => [n.id, n.files[0]])).toEqual([
      ["src", "src/*"],
      ["auth", "src/auth/**"],
      ["db", "src/db/**"],
      ["services", "src/services/**"],
    ]);
  });

  it("derives edges from relative imports, resolving index files", () => {
    expect(canvas.edges.map((e) => `${e.from}->${e.to}`).sort()).toEqual([
      "auth->services",
      "services->db",
      "src->auth",
    ]);
  });

  it("lays callers out left of their dependencies", () => {
    const x = (id: string) => canvas.nodes.find((n) => n.id === id)!.position!.x;
    expect(x("src")).toBeLessThan(x("auth"));
    expect(x("services")).toBeLessThan(x("db"));
  });
});

describe("generateCanvas in a monorepo", () => {
  const mono = {
    "package.json": `{"name":"root"}`,
    "packages/schema/package.json": `{"name":"@acme/schema"}`,
    "packages/schema/src/index.ts": "export type A = 1;",
    "packages/core/package.json": `{"name":"@acme/core"}`,
    "packages/core/src/index.ts": `import type { A } from "@acme/schema";`,
    "apps/web/package.json": `{"name":"web"}`,
    "apps/web/src/main.ts": `import { x } from "@acme/core/sub";\nimport React from "react";`,
  };
  const canvas = generateCanvas(project(mono), Object.keys(mono));

  it("makes one node per workspace package, titled by package name", () => {
    expect(canvas.nodes.map((n) => [n.id, n.title, n.files[0]])).toEqual([
      ["web", "web", "apps/web/**"],
      ["core", "@acme/core", "packages/core/**"],
      ["schema", "@acme/schema", "packages/schema/**"],
    ]);
  });

  it("links packages imported by name, including subpaths", () => {
    expect(canvas.edges.map((e) => `${e.from}->${e.to}`).sort()).toEqual(["core->schema", "web->core"]);
  });
});

describe("initProject", () => {
  it("writes a canvas the store can load, and refuses to overwrite it", () => {
    const root = project(files);
    initProject(root);
    expect(new ProjectStore(root).loadCanvas().nodes).toHaveLength(4);
    expect(() => initProject(root)).toThrow("--force");
    expect(() => initProject(root, { force: true })).not.toThrow();
  });
});
