import type { Level } from "./events.js";

/**
 * One verdict on a piece of agent work, used everywhere the app says "passed" or
 * offers "mark done". A command exiting 0 is not enough: the agent must have
 * finished normally, tests must exist and pass, and the after-run check must
 * have run and found nothing. See the design doc, phase one, section 3.
 */
export type WorkStatus = "unverified" | "no-tests" | "tests-failed" | "audit-findings" | "audit-error" | "agent-failed" | "passed";

export const WORK_STATUS_LABEL: Record<WorkStatus, string> = {
  unverified: "未验证",
  "no-tests": "还没有测试",
  "tests-failed": "测试失败",
  "audit-findings": "事后检查发现问题",
  "audit-error": "事后检查没跑成",
  "agent-failed": "助手没有正常结束",
  passed: "通过",
};

/** What a test run says, as far as the verdict cares. */
export interface TestEvidence {
  passed: boolean;
  pass?: number;
  fail?: number;
  command?: string;
}

/** The after-run check: its findings, or why it could not run. */
export type AuditEvidence = { findings: { level: Level }[] } | { error: string };

export const auditFailed = (audit: AuditEvidence | null | undefined): audit is { error: string } => !!audit && "error" in audit;

/** A run whose summary shows that no test ran at all (node:test's "pass 0 / fail 0"): no evidence either way. */
export const ranNoTests = (tests: TestEvidence): boolean => tests.pass === 0 && (tests.fail ?? 0) === 0;

/** Findings at these levels need a person's look before the work counts as done. */
const MATTERS: Level[] = ["warn", "ask", "block"];

export interface WorkVerdict {
  status: WorkStatus;
  label: string;
  /** Every reason the work is not passed yet, in plain words; empty when passed. */
  reasons: string[];
}

/**
 * The verdict for agent work: `run` is the agent's own result (omit for a manual
 * test run), `auditRequired` says the after-run check should exist (it does for
 * any agent run in a git project). The first failing reason, in this order, sets
 * the status; all of them are listed.
 */
export function workVerdict(input: {
  run?: { ok: boolean; summary?: string } | null;
  tests: TestEvidence | null | undefined;
  audit?: AuditEvidence | null;
  auditRequired?: boolean;
}): WorkVerdict {
  const found: [WorkStatus, string][] = [];
  const { run, tests, audit } = input;
  if (run && !run.ok) found.push(["agent-failed", `助手没有正常结束${run.summary ? `：${run.summary.slice(0, 120)}` : ""}`]);
  if (auditFailed(audit)) found.push(["audit-error", `事后检查没跑成：${audit.error.slice(0, 160)}`]);
  if (tests && !tests.passed) found.push(["tests-failed", `测试没有通过${tests.command ? `（${tests.command}）` : ""}`]);
  if (audit && !auditFailed(audit)) {
    const n = audit.findings.filter((f) => MATTERS.includes(f.level)).length;
    if (n) found.push(["audit-findings", `事后检查发现 ${n} 个问题，要先看一下`]);
  }
  if (!tests) found.push(["no-tests", "没有跑测试：项目还没有测试命令，或这次没有跑"]);
  else if (tests.passed && ranNoTests(tests)) found.push(["no-tests", `测试命令跑了，但一个测试都没有${tests.command ? `（${tests.command}）` : ""}`]);
  if (input.auditRequired && !audit) found.push(["unverified", "没有做事后检查：项目没用 git，或交给 AI 之前没存下检查点"]);
  const status = found[0]?.[0] ?? "passed";
  return { status, label: WORK_STATUS_LABEL[status], reasons: found.map(([, r]) => r) };
}
