import { describe, expect, it } from "vitest";
import {
  checkSetup,
  nodeVersionOk,
  parseVersion,
  resolveCursorCommand,
  resolveGrokCommand,
  ruleLabel,
  type ProbeResult,
  type ProbeRunner,
} from "../src/setup.js";

const ok = (stdout: string, code = 0): ProbeResult => ({ code, stdout, stderr: "" });
const missing = (): ProbeResult => ({
  code: 1,
  stdout: "",
  stderr: "'claude' is not recognized as an internal or external command",
});

function fakeRunner(map: Record<string, ProbeResult | ProbeResult[]>): ProbeRunner {
  const seen = new Map<string, number>();
  return async (command, args) => {
    const key = `${command} ${args.join(" ")}`;
    const entry = map[key] ?? map[command];
    if (!entry) return missing();
    if (Array.isArray(entry)) {
      const i = seen.get(key) ?? 0;
      seen.set(key, i + 1);
      return entry[Math.min(i, entry.length - 1)]!;
    }
    return entry;
  };
}

describe("parseVersion / nodeVersionOk", () => {
  it("reads common version banners", () => {
    expect(parseVersion("v22.11.0")).toBe("22.11.0");
    expect(parseVersion("git version 2.45.1.windows.1")).toBe("2.45.1");
    expect(parseVersion("claude 1.0.50 (Claude Code)")).toBe("1.0.50");
    expect(nodeVersionOk("22.0.0")).toBe(true);
    expect(nodeVersionOk("21.9.0")).toBe(false);
    expect(nodeVersionOk(null)).toBe(false);
  });
});

describe("resolveCursorCommand / resolveGrokCommand", () => {
  it("prefers env, then the Windows installer path", () => {
    expect(resolveCursorCommand({ AGENT_TOGETHER_CURSOR_AGENT: "C:\\tools\\ca.cmd" }, "win32", () => false)).toBe("C:\\tools\\ca.cmd");
    expect(
      resolveCursorCommand({ LOCALAPPDATA: "C:\\Users\\x\\AppData\\Local" }, "win32", (f) => f.endsWith("cursor-agent.cmd")),
    ).toBe("C:\\Users\\x\\AppData\\Local\\cursor-agent\\cursor-agent.cmd");
    expect(resolveCursorCommand({}, "linux", () => false)).toBe("cursor-agent");
  });

  it("finds grok under ~/.grok/bin", () => {
    expect(resolveGrokCommand({ HOME: "/home/me" }, "linux", (f) => f === "/home/me/.grok/bin/grok")).toBe("/home/me/.grok/bin/grok");
    expect(resolveGrokCommand({}, "linux", () => false)).toBe("grok");
  });
});

describe("checkSetup", () => {
  it("is ready when Node 22+, git and one logged-in assistant are present", async () => {
    const report = await checkSetup({
      platform: "win32",
      env: {},
      fileExists: () => false,
      run: fakeRunner({
        "node --version": ok("v22.14.0"),
        "git --version": ok("git version 2.45.1"),
        "claude --version": ok("1.0.50 (Claude Code)"),
        "claude auth status": ok("Logged in as user@example.com"),
        "codex --version": missing(),
        "cursor-agent --version": missing(),
        "grok --version": missing(),
      }),
    });
    expect(report.ready).toBe(true);
    expect(report.requirements.find((r) => r.id === "node")?.ready).toBe(true);
    expect(report.requirements.find((r) => r.id === "claude-code")).toMatchObject({
      installed: true,
      login: "ok",
      ready: true,
      installCommand: "",
    });
    expect(report.requirements.find((r) => r.id === "codex")?.ready).toBe(false);
  });

  it("is not ready when Node is too old, even if assistants exist", async () => {
    const report = await checkSetup({
      platform: "darwin",
      env: {},
      fileExists: () => false,
      run: fakeRunner({
        "node --version": ok("v20.11.0"),
        "git --version": ok("git version 2.39.0"),
        "claude --version": ok("1.0.0"),
        "claude auth status": ok("Logged in as a@b.c"),
        "codex --version": missing(),
        "cursor-agent --version": missing(),
        "grok --version": missing(),
      }),
    });
    expect(report.ready).toBe(false);
    expect(report.requirements.find((r) => r.id === "node")?.installCommand).toContain("brew install node@22");
  });

  it("treats an installed assistant with unknown login as ready, and marks logged-out as not ready", async () => {
    const report = await checkSetup({
      platform: "linux",
      env: {},
      fileExists: () => false,
      run: fakeRunner({
        "node --version": ok("v22.1.0"),
        "git --version": ok("git version 2.40.0"),
        "claude --version": ok("1.0.0"),
        "claude auth status": { code: 1, stdout: "", stderr: "Not logged in" },
        "codex --version": ok("0.1.0"),
        "codex login status": { code: 1, stdout: "", stderr: "unknown subcommand" },
        "cursor-agent --version": ok("2026.10.0"),
        "grok --version": missing(),
      }),
    });
    const claude = report.requirements.find((r) => r.id === "claude-code")!;
    const codex = report.requirements.find((r) => r.id === "codex")!;
    const cursor = report.requirements.find((r) => r.id === "cursor")!;
    expect(claude).toMatchObject({ login: "needed", ready: false, loginCommand: "claude" });
    expect(codex.login).toBe("unknown");
    expect(codex.loginNote).toContain("登录状态打开后确认");
    expect(codex.ready).toBe(true);
    expect(cursor).toMatchObject({ login: "unknown", ready: true });
    expect(report.ready).toBe(true);
  });

  it("reads Cursor's login from cursor-agent status", async () => {
    const check = (status: { code: number; stdout: string; stderr: string }) =>
      checkSetup({
        platform: "linux",
        env: {},
        fileExists: () => false,
        run: fakeRunner({
          "node --version": ok("v22.1.0"),
          "git --version": ok("git version 2.40.0"),
          "claude --version": missing(),
          "codex --version": missing(),
          "cursor-agent --version": ok("2026.10.0"),
          "cursor-agent status": status,
          "grok --version": missing(),
        }),
      }).then((r) => r.requirements.find((x) => x.id === "cursor")!);
    expect(await check(ok("✓ Logged in as a@b.c"))).toMatchObject({ login: "ok", ready: true, loginCommand: null });
    expect(await check({ code: 1, stdout: "Not logged in", stderr: "" })).toMatchObject({
      login: "needed",
      ready: false,
      loginCommand: '"cursor-agent" login',
    });
  });

  it("gives a Windows install command when git is missing", async () => {
    const report = await checkSetup({
      platform: "win32",
      env: {},
      fileExists: () => false,
      run: fakeRunner({
        "node --version": ok("v22.0.0"),
        "git --version": missing(),
        "claude --version": missing(),
        "codex --version": missing(),
        "cursor-agent --version": missing(),
        "grok --version": missing(),
      }),
    });
    expect(report.ready).toBe(false);
    expect(report.requirements.find((r) => r.id === "git")?.installCommand).toBe("winget install Git.Git");
  });

  it("uses the Windows cursor-agent.cmd path when present", async () => {
    const cmd = "C:\\Users\\x\\AppData\\Local\\cursor-agent\\cursor-agent.cmd";
    const report = await checkSetup({
      platform: "win32",
      env: { LOCALAPPDATA: "C:\\Users\\x\\AppData\\Local" },
      fileExists: (f) => f === cmd,
      run: fakeRunner({
        "node --version": ok("v22.0.0"),
        "git --version": ok("git version 2.45.0"),
        "claude --version": missing(),
        "codex --version": missing(),
        [cmd + " --version"]: ok("2026.10.0"),
        "grok --version": missing(),
      }),
    });
    expect(report.requirements.find((r) => r.id === "cursor")).toMatchObject({ installed: true, version: "2026.10.0", ready: true });
  });
});

describe("ruleLabel", () => {
  it("maps known observer rule ids to plain Chinese", () => {
    expect(ruleLabel("scope-fence")).toBe("越界写入");
    expect(ruleLabel("mystery")).toBe("mystery");
  });
});
