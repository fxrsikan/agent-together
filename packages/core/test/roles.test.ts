import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Canvas } from "@agent-together/schema";
import { buildNodeContext, draftRole, planCanvas, ProjectStore, roleFromDraft, rolesFromDraft, type Llm } from "@agent-together/core";

const role = { id: "tester", description: "用于补充测试", body: "只写测试，不改业务代码。" };
const node = { id: "tests", title: "测试", kind: "module" };
const fake = (reply: unknown): Llm => ({ name: "fake", complete: async () => typeof reply === "string" ? reply : JSON.stringify(reply) });
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })));

describe("role drafts", () => {
  it("accepts fenced JSON and preserves optional tools and model", async () => {
    const result = await draftRole(fake(`回答：\n\`\`\`json\n${JSON.stringify({ ...role, tools: ["Read"], model: "sonnet" })}\n\`\`\``), "写测试");
    expect(result).toMatchObject({ ...role, kind: "agent", tools: ["Read"], model: "sonnet" });
  });

  it("rejects unusable replies and explains a missing model", async () => {
    for (const reply of ["不是 JSON", "{bad}", "null", "{}", JSON.stringify({ ...role, id: "../bad" }), JSON.stringify({ ...role, body: " " })]) {
      await expect(draftRole(fake(reply), "写测试")).rejects.toThrow("请重试");
    }
    await expect(draftRole(null, "写测试")).rejects.toThrow("没有可用的 AI");
    expect(roleFromDraft(null)).toBeNull();
    expect(rolesFromDraft({})).toEqual([]);
  });

  it("filters invalid and duplicate drafts and caps proposals at four", () => {
    expect(rolesFromDraft([null, role, role, ...Array.from({ length: 6 }, (_, i) => ({ ...role, id: `role-${i}` }))])).toHaveLength(4);
  });

  it("keeps planner roles optional and only assigns valid proposed roles", async () => {
    expect((await planCanvas(fake({ nodes: [node] }), "小项目")).roles).toEqual([]);
    const plan = await planCanvas(fake({ nodes: [{ ...node, role: "tester" }], roles: [role] }), "测试项目");
    expect(plan.roles[0].kind).toBe("agent");
    expect(plan.canvas.nodes[0].role).toBe("tester");
    const invalid = await planCanvas(fake({ nodes: [{ ...node, role: "unknown" }], roles: "bad" }), "小项目");
    expect(invalid.canvas.nodes[0].role).toBeUndefined();
  });

  it("loads old canvases, round-trips roles on disk and includes their instructions", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-together-roles-"));
    roots.push(root);
    const store = new ProjectStore(root);
    const old = Canvas.parse({ version: 1, nodes: [node] });
    expect(old.nodes[0].role).toBeUndefined();
    const canvas = Canvas.parse({ ...old, nodes: [{ ...node, role: "tester" }] });
    store.writeCanvas(canvas);
    expect(store.loadCanvas()).toEqual(canvas);
    expect(buildNodeContext(canvas, "tests", "补测试", [], undefined, [roleFromDraft(role)!])).toContain(role.body);
    expect(() => buildNodeContext(canvas, "tests", "")).toThrow("还没有保存");
    expect(buildNodeContext(old, "tests", "")).not.toContain(role.body);
  });
});
