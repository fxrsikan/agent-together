import { exec } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ownerOf } from "./owners.js";
import { readProjectInfo } from "./project.js";
import { ProjectStore } from "./store.js";

/** One run of the project's tests, kept per node in .agent-together/tests.json (git-ignored). */
export interface TestRun {
  command: string;
  passed: boolean;
  /** Counts when the runner's summary could be read (node:test, Vitest, Jest). */
  pass?: number;
  fail?: number;
  /** The tail of the output, enough to see what failed. */
  output: string;
  /** The node whose work the run checked, if any. */
  nodeId: string | null;
  /** Project-relative test files that failed, as far as the output names them. */
  failingFiles?: string[];
  /** The nodes that own those files: the right place to hand a failure back to. */
  failingNodes?: string[];
  at: string;
  durationMs: number;
}

export interface TestHistory {
  last?: TestRun;
  recent?: Record<string, TestRun[]>;
  consecutiveFailures?: Record<string, number>;
  byNode: Record<string, TestRun>;
}

const historyFile = (root: string) => path.join(root, ".agent-together", "tests.json");

/**
 * The command that tests the project: project.json `testCommand`, else
 * race.json `testCommand`, else `npm test` when package.json defines a real test script.
 */
export function testCommandFor(root: string): string | null {
  const fromProject = readProjectInfo(root).testCommand?.trim();
  if (fromProject) return fromProject;
  try {
    const race = JSON.parse(fs.readFileSync(path.join(root, ".agent-together", "race.json"), "utf8"));
    if (typeof race.testCommand === "string" && race.testCommand.trim()) return race.testCommand.trim();
  } catch {}
  try {
    const script = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).scripts?.test;
    if (typeof script === "string" && !script.includes("no test specified")) return "npm test";
  } catch {}
  return null;
}

/** Pass/fail counts from the summaries of node:test, Vitest and Jest; undefined when none matches. */
export function testCounts(output: string): { pass?: number; fail?: number } {
  const num = (re: RegExp) => {
    const m = re.exec(output);
    return m ? Number(m[1]) : undefined;
  };
  const nodePass = num(/^(?:ℹ|#) pass (\d+)/m);
  if (nodePass !== undefined) return { pass: nodePass, fail: num(/^(?:ℹ|#) fail (\d+)/m) ?? 0 };
  const summary = /^\s*Tests:?\s+(.*)$/m.exec(output)?.[1]; // "Tests  3 passed (3)" / "Tests: 1 failed, 3 passed, 4 total"
  if (!summary) return {};
  return { pass: Number(/(\d+) passed/.exec(summary)?.[1] ?? 0), fail: Number(/(\d+) failed/.exec(summary)?.[1] ?? 0) };
}

/**
 * Failing test files named in a runner's output: node:test's "test at <file>:line:col",
 * Vitest's and Jest's "FAIL <file>". Returned project-relative with forward slashes.
 */
export function failingTestFiles(output: string, root: string): string[] {
  const found = new Set<string>();
  const add = (raw: string) => {
    let file = raw.trim().replace(/^file:\/\/\/?/, "").replace(/\\/g, "/");
    const base = root.replace(/\\/g, "/").replace(/\/$/, "");
    if (file.toLowerCase().startsWith(base.toLowerCase() + "/")) file = file.slice(base.length + 1);
    if (!/^[a-zA-Z]:\//.test(file) && !file.startsWith("/") && !file.startsWith("node:")) found.add(file);
  };
  for (const m of output.matchAll(/^\s*test at (.+?):\d+:\d+\s*$/gm)) add(m[1]);
  for (const m of output.matchAll(/^\s*FAIL\s+(\S+\.\w+)/gm)) add(m[1]);
  return [...found];
}

export function testHistory(root: string): TestHistory {
  try {
    return JSON.parse(fs.readFileSync(historyFile(root), "utf8"));
  } catch {
    return { byNode: {} };
  }
}

/** Runs the project's tests (null when it has no test command) and records the result. */
export function runProjectTests(root: string, nodeId: string | null, timeoutMs = 5 * 60_000): Promise<TestRun | null> {
  const command = testCommandFor(root);
  if (!command) return Promise.resolve(null);
  const started = Date.now();
  return new Promise((resolve) =>
    exec(command, { cwd: root, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const output = `${stdout}${stderr}`.trim();
      const failingFiles = err ? failingTestFiles(output, root) : [];
      let failingNodes: string[] = [];
      try {
        const canvas = new ProjectStore(root).loadCanvas();
        failingNodes = [...new Set(failingFiles.map((f) => ownerOf(canvas, f)?.id).filter((id): id is string => !!id))];
      } catch {} // a canvas being edited mid-run: leave the owners out
      const run: TestRun = {
        command,
        passed: !err,
        ...testCounts(output),
        output: output.slice(-3000),
        nodeId,
        ...(failingFiles.length ? { failingFiles, failingNodes } : {}),
        at: new Date().toISOString(),
        durationMs: Date.now() - started,
      };
      const history = testHistory(root);
      history.last = run;
      if (nodeId) {
        history.consecutiveFailures ??= {};
        history.consecutiveFailures[nodeId] = run.passed ? 0 : (history.consecutiveFailures[nodeId] ?? (history.byNode[nodeId]?.passed === false ? 1 : 0)) + 1;
        history.recent ??= {};
        history.recent[nodeId] = [...(history.recent[nodeId] ?? []), run].slice(-5);
        history.byNode[nodeId] = run;
      }
      fs.mkdirSync(path.dirname(historyFile(root)), { recursive: true });
      fs.writeFileSync(historyFile(root), JSON.stringify(history, null, 2));
      resolve(run);
    }),
  );
}
