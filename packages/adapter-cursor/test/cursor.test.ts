import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { cursorCwd, installCursorHooks, parseHookInput, toCursorEvents, toCursorOutput } from "@agent-together/adapter-cursor";

/** A real preToolUse payload from Cursor 3.19 on Windows, as PowerShell delivered it (BOM, GBK-mangled). */
const mangled = fs.readFileSync(path.join(__dirname, "fixtures/pretooluse-write-powershell.txt"), "utf8");

describe("parseHookInput", () => {
  it("repairs a payload mangled by Windows PowerShell, including a swallowed closing quote", () => {
    expect(() => JSON.parse(mangled.slice(1))).toThrow();
    const payload = parseHookInput(mangled);
    expect(payload.tool_name).toBe("Write");
    expect(payload.tool_input.content).toContain('errors.push("邮箱格式不正确")');
    expect(payload.tool_input.content).toContain('errors.push("密码必须包含数字")');
  });

  it("parses clean input as is", () => {
    expect(parseHookInput('{"a":"密码"}')).toEqual({ a: "密码" });
    expect(parseHookInput('\uFEFF{"a":1}')).toEqual({ a: 1 });
  });
});

const base = { conversation_id: "c1", workspace_roots: ["/d:/proj"] };

describe("toCursorEvents", () => {
  it("turns Write into a write with the current file as before", () => {
    const [e] = toCursorEvents(
      { ...base, hook_event_name: "preToolUse", tool_name: "Write", tool_input: { file_path: "d:\\proj\\src\\a.ts", content: "new" } },
      () => "old",
    );
    expect(e).toMatchObject({ kind: "tool.before", platform: "cursor", sessionId: "c1", action: { type: "write", before: "old", after: "new" } });
  });

  it("reads a shell exit code from tool_output, and failures from postToolUseFailure", () => {
    const shell = { ...base, tool_name: "Shell", tool_input: { command: "npm test", cwd: "d:\\proj" } };
    expect(toCursorEvents({ ...shell, hook_event_name: "postToolUse", tool_output: '{"output":"","exitCode":1}' })[0]).toMatchObject({
      kind: "tool.after",
      ok: false,
      error: "exit 1",
    });
    expect(toCursorEvents({ ...shell, hook_event_name: "postToolUse", tool_output: '{"output":"","exitCode":0}' })[0]).toMatchObject({ ok: true });
    expect(
      toCursorEvents({ ...base, hook_event_name: "postToolUseFailure", tool_name: "Read", tool_input: { file_path: "x" }, error_message: "File not found" })[0],
    ).toMatchObject({ ok: false, error: "File not found", action: { type: "read" } });
  });

  it("ends the turn on stop and finds the project from the workspace root", () => {
    expect(toCursorEvents({ ...base, hook_event_name: "stop" })[0].kind).toBe("turn.end");
    expect(cursorCwd({ ...base, hook_event_name: "stop" })).toBe("d:/proj");
  });

  it("looks for the project from the touched file first: the CLI's workspace root is the git root", () => {
    const file = path.resolve("/repo/app/src/auth/a.ts");
    const cli = { conversation_id: "c", hook_event_name: "preToolUse", workspace_roots: [path.resolve("/repo")], tool_name: "Read", tool_input: { file_path: file } };
    expect(cursorCwd(cli)).toBe(path.dirname(file));
    const folder = os.tmpdir();
    expect(cursorCwd({ ...cli, tool_name: "Grep", tool_input: { file_path: folder } })).toBe(folder);
  });
});

describe("toCursorOutput", () => {
  const finding = (level: "ask" | "warn") => ({ level, findings: [{ rule: "scope-fence", level, message: "越界" }] });

  it("turns ask into an ASCII-only deny that tells the agent to ask the user", () => {
    const out = toCursorOutput("preToolUse", finding("ask"))!;
    expect(out).toMatch(/^[\x00-\x7f]*$/);
    const json = JSON.parse(out);
    expect(json.permission).toBe("deny");
    expect(json.agent_message).toContain("Ask the user");
    expect(json.user_message).toContain("越界");
  });

  it("always answers preToolUse, and adds context after a tool", () => {
    expect(JSON.parse(toCursorOutput("preToolUse", { level: "off", findings: [] })!)).toEqual({ permission: "allow" });
    expect(JSON.parse(toCursorOutput("postToolUse", finding("warn"))!).additional_context).toContain("越界");
    expect(toCursorOutput("stop", finding("warn"))).toBeNull();
  });
});

describe("installCursorHooks", () => {
  it("writes .cursor/hooks.json, replacing earlier Agent Together entries and keeping others", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-together-cursor-"));
    fs.mkdirSync(path.join(dir, ".cursor"));
    fs.writeFileSync(path.join(dir, ".cursor/hooks.json"), JSON.stringify({ version: 1, hooks: { stop: [{ command: "other" }] } }));
    installCursorHooks(dir, "node agent-together-hook.js --platform cursor");
    installCursorHooks(dir, "node agent-together-hook.js --platform cursor");
    const config = JSON.parse(fs.readFileSync(path.join(dir, ".cursor/hooks.json"), "utf8"));
    expect(config.version).toBe(1);
    expect(config.hooks.stop).toEqual([{ command: "other" }, { command: "node agent-together-hook.js --platform cursor" }]);
    expect(config.hooks.preToolUse).toHaveLength(1);
  });

  it("also writes to the git root, where cursor-agent looks", () => {
    const top = fs.mkdtempSync(path.join(os.tmpdir(), "agent-together-cursor-git-"));
    execFileSync("git", ["init", "-q"], { cwd: top });
    const app = path.join(top, "app");
    fs.mkdirSync(app);
    const files = installCursorHooks(app, "node agent-together-hook.js --platform cursor");
    expect(files).toHaveLength(2);
    expect(fs.existsSync(path.join(top, ".cursor/hooks.json"))).toBe(true);
    expect(fs.existsSync(path.join(app, ".cursor/hooks.json"))).toBe(true);
  });
});
