import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { workVerdict } from "@agent-together/schema";
import { listFiles, zNames, zNumstat } from "@agent-together/core";

describe("git -z output", () => {
  it("reads names with spaces, tabs and Chinese characters, and renames", () => {
    expect(zNames("a b.ts\0src/中文.ts\0")).toEqual(["a b.ts", "src/中文.ts"]);
    expect(zNumstat("3\t1\tsrc/中文.ts\0-\t-\timg.png\0" + "2\t0\t\0old.ts\0new 名.ts\0")).toEqual([
      { path: "src/中文.ts", added: 3, removed: 1 },
      { path: "img.png", added: 0, removed: 0 },
      { path: "new 名.ts", added: 2, removed: 0 },
    ]);
  });

  it("lists project files with Chinese names as they are", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "at-ls-"));
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "src", "分镜.ts"), "x");
    execFileSync("git", ["init", "-q"], { cwd: root });
    expect(listFiles(root)).toEqual(["src/分镜.ts"]);
  });
});

describe("work verdict", () => {
  const green = { passed: true, pass: 4, fail: 0, command: "npm test" };
  const clean = { findings: [] };

  it("passes only when the agent finished, tests exist and pass, and the check ran clean", () => {
    expect(workVerdict({ run: { ok: true }, tests: green, audit: clean, auditRequired: true })).toEqual({ status: "passed", label: "通过", reasons: [] });
  });

  it("does not count a run with no tests at all (0/0) as passing", () => {
    const v = workVerdict({ run: { ok: true }, tests: { passed: true, pass: 0, fail: 0, command: "node --test" }, audit: clean, auditRequired: true });
    expect(v.status).toBe("no-tests");
    expect(v.label).toBe("还没有测试");
  });

  it("tells an after-run check that failed apart from one that found nothing", () => {
    const v = workVerdict({ run: { ok: true }, tests: green, audit: { error: "git: bad object" }, auditRequired: true });
    expect(v.status).toBe("audit-error");
    expect(v.reasons[0]).toContain("git: bad object");
  });

  it("puts a failed agent first and lists every other reason too", () => {
    const v = workVerdict({ run: { ok: false, summary: "超时" }, tests: { passed: false, command: "npm test" }, audit: { findings: [{ level: "ask" }, { level: "log" }] }, auditRequired: true });
    expect(v.status).toBe("agent-failed");
    expect(v.reasons).toHaveLength(3);
    expect(v.reasons[2]).toContain("1 个问题"); // a log-level finding does not count
  });

  it("is unverified when the check should have run but did not", () => {
    expect(workVerdict({ run: { ok: true }, tests: green, audit: null, auditRequired: true }).status).toBe("unverified");
    expect(workVerdict({ run: { ok: true }, tests: green, audit: null }).status).toBe("passed");
  });
});
