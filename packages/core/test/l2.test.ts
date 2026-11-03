import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { LoomEvent } from "@loom/schema";
import { Daemon, parseJsonObject, type Judgment, type Llm } from "@loom/core";

/** A canned model: answers memory prompts and turn prompts with fixed JSON, and records what it was asked. */
function fakeLlm(turn: { onTrack: boolean; reason: string }): Llm & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    name: "fake",
    prompts,
    async complete(prompt: string) {
      prompts.push(prompt);
      return prompt.includes("经验记忆")
        ? '好的：```json\n{"memory": "登录表单不能直接依赖数据库，要经过用户服务"}\n```'
        : JSON.stringify(turn);
    },
  };
}

function project(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "loom-l2-"));
  const canvas = path.join(root, ".loom", "canvas");
  fs.mkdirSync(canvas, { recursive: true });
  fs.writeFileSync(
    path.join(canvas, "login-form.json"),
    JSON.stringify({ id: "login-form", kind: "feature", title: "登录表单", intent: { goal: "邮箱密码登录" }, files: ["src/auth/**"] }),
  );
  fs.writeFileSync(path.join(canvas, "_edges.json"), "[]");
  return root;
}

const at = "2026-11-04T00:00:00.000Z";
const base = { platform: "claude-code" as const, sessionId: "s1", at };

function runTurn(daemon: Daemon, root: string, writePath: string) {
  const events: LoomEvent[] = [
    { kind: "tool.before", ...base, action: { type: "write", path: path.join(root, writePath), after: "x" } },
    { kind: "turn.end", ...base },
  ];
  for (const e of events) daemon.handle(e);
}

describe("parseJsonObject", () => {
  it("finds the JSON object inside prose or code fences", () => {
    expect(parseJsonObject('sure:\n```json\n{"a": 1}\n```')).toEqual({ a: 1 });
    expect(parseJsonObject("no json here")).toBeNull();
  });
});

describe("L2 in the daemon", () => {
  it("refines memory drafts and keeps the raw observation as evidence", async () => {
    const root = project();
    const daemon = new Daemon(root, { llm: fakeLlm({ onTrack: true, reason: "ok" }) });
    daemon.setActiveNode("login-form");
    runTurn(daemon, root, "src/db/users.ts");
    await daemon.settled();
    const [memory] = daemon.memory.list();
    expect(memory.content).toBe("登录表单不能直接依赖数据库，要经过用户服务");
    expect(memory.evidence).toContain("src/db/users.ts");
    expect(memory.status).toBe("draft");
  });

  it("judges a turn against the node goal and the dispatched task", async () => {
    const root = project();
    const llm = fakeLlm({ onTrack: false, reason: "在改数据库，与登录表单无关" });
    const daemon = new Daemon(root, { llm });
    daemon.store.writeContext("login-form", "# 任务\n\n加一条密码校验\n\n## 节点：登录表单\n");
    daemon.setActiveNode("login-form");
    const judgments: Judgment[] = [];
    daemon.on("judgment", (j) => judgments.push(j));
    runTurn(daemon, root, "src/auth/form.ts");
    await daemon.settled();
    expect(judgments).toMatchObject([{ nodeId: "login-form", onTrack: false, reason: "在改数据库，与登录表单无关", by: "fake" }]);
    expect(llm.prompts.at(-1)).toContain("加一条密码校验");
  });

  it("stops calling the model once the session budget is used up", async () => {
    const root = project();
    const llm = fakeLlm({ onTrack: true, reason: "ok" });
    const daemon = new Daemon(root, { llm, maxL2CallsPerSession: 1 });
    daemon.setActiveNode("login-form");
    runTurn(daemon, root, "src/auth/a.ts");
    runTurn(daemon, root, "src/auth/b.ts");
    await daemon.settled();
    expect(llm.prompts).toHaveLength(1);
  });

  it("reports a failing model without breaking the daemon", async () => {
    const root = project();
    const broken: Llm = { name: "broken", complete: () => Promise.reject(new Error("no network")) };
    const daemon = new Daemon(root, { llm: broken });
    daemon.setActiveNode("login-form");
    const errors: string[] = [];
    daemon.on("l2error", (e) => errors.push(e));
    runTurn(daemon, root, "src/auth/a.ts");
    await daemon.settled();
    expect(errors).toEqual(["no network"]);
  });
});
