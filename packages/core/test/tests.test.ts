import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runProjectTests, streamJsonResult, streamJsonText, testCommandFor, testCounts, testHistory, writeProjectInfo } from "@agent-together/core";

const project = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-together-tests-"));
  fs.mkdirSync(path.join(root, ".agent-together"));
  return root;
};

describe("testCommandFor", () => {
  it("prefers project.json, then race.json, then a real npm test script", () => {
    const root = project();
    expect(testCommandFor(root)).toBeNull();
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }));
    expect(testCommandFor(root)).toBeNull();
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));
    expect(testCommandFor(root)).toBe("npm test");
    fs.writeFileSync(path.join(root, ".agent-together/race.json"), JSON.stringify({ testCommand: "node --test" }));
    expect(testCommandFor(root)).toBe("node --test");
    writeProjectInfo(root, { name: "p", testCommand: "npm run check" });
    expect(testCommandFor(root)).toBe("npm run check");
  });
});

describe("testCounts", () => {
  it("reads node:test, Vitest and Jest summaries", () => {
    expect(testCounts("ℹ tests 77\nℹ pass 75\nℹ fail 2\n")).toEqual({ pass: 75, fail: 2 });
    expect(testCounts(" Test Files  11 passed (11)\n      Tests  91 passed (91)\n")).toEqual({ pass: 91, fail: 0 });
    expect(testCounts("Tests:       1 failed, 3 passed, 4 total")).toEqual({ pass: 3, fail: 1 });
    expect(testCounts("all good")).toEqual({});
  });
});

describe("runProjectTests", () => {
  it("runs the command in the project, records the result per node, and fails on a non-zero exit", async () => {
    const root = project();
    writeProjectInfo(root, { name: "p", testCommand: `node -e "console.log('ℹ pass 2'); console.log('ℹ fail 0')"` });
    const ok = await runProjectTests(root, "store");
    expect(ok).toMatchObject({ passed: true, pass: 2, fail: 0, nodeId: "store" });
    writeProjectInfo(root, { testCommand: `node -e "process.exit(1)"` });
    expect((await runProjectTests(root, "cli"))?.passed).toBe(false);
    const history = testHistory(root);
    expect(history.last?.nodeId).toBe("cli");
    expect(history.byNode.store.passed).toBe(true);
  });

  it("does nothing without a test command", async () => {
    expect(await runProjectTests(project(), null)).toBeNull();
  });
});

describe("stream-json (Claude Code, cursor-agent)", () => {
  // Line shapes from real `--output-format stream-json` runs of both CLIs.
  const lines = [
    `{"type":"system","subtype":"init","session_id":"s"}`,
    `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"你好"},{"type":"tool_use","name":"Read"}]}}`,
    `{"type":"result","subtype":"success","is_error":false,"result":"你好","total_cost_usd":0.002}`,
  ];

  it("picks the agent's words out of assistant lines", () => {
    expect(lines.map(streamJsonText)).toEqual([null, "你好", null]);
  });

  it("finds the final result", () => {
    expect(streamJsonResult(lines.join("\n"))).toMatchObject({ result: "你好", total_cost_usd: 0.002 });
    expect(streamJsonResult("not json")).toBeNull();
  });
});
