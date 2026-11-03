import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { installHooks, toHookOutput, toLoomEvent } from "@loom/adapter-claude-code";

const base = { session_id: "s1", cwd: "/proj" };

describe("toLoomEvent", () => {
  it("maps an Edit before it runs to a write with before/after", () => {
    const event = toLoomEvent({
      ...base,
      hook_event_name: "PreToolUse",
      tool_name: "Edit",
      tool_input: { file_path: "/proj/a.ts", old_string: "a", new_string: "b" },
    });
    expect(event).toMatchObject({
      kind: "tool.before",
      action: { type: "write", path: "/proj/a.ts", before: "a", after: "b" },
    });
  });

  it("reads the current file for a Write so rules can compare", () => {
    const event = toLoomEvent(
      { ...base, hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: "/proj/a.ts", content: "new" } },
      () => "old",
    );
    expect(event).toMatchObject({ action: { before: "old", after: "new" } });
  });

  it("maps a failed Bash call to a failed shell event", () => {
    const event = toLoomEvent({
      ...base,
      hook_event_name: "PostToolUseFailure",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      error: "exit 1",
    });
    expect(event).toMatchObject({ kind: "tool.after", ok: false, action: { type: "shell", command: "npm test" } });
  });

  it("ignores events Loom does not use", () => {
    expect(toLoomEvent({ ...base, hook_event_name: "Notification" })).toBeNull();
  });
});

describe("toHookOutput", () => {
  const finding = { rule: "scope-fence", message: "outside node" };

  it("denies a blocked tool call", () => {
    const out = JSON.parse(toHookOutput("PreToolUse", { level: "block", findings: [{ ...finding, level: "block" }] })!);
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("asks the user on ask", () => {
    const out = JSON.parse(toHookOutput("PreToolUse", { level: "ask", findings: [{ ...finding, level: "ask" }] })!);
    expect(out.hookSpecificOutput.permissionDecision).toBe("ask");
  });

  it("adds context after a tool ran", () => {
    const out = JSON.parse(toHookOutput("PostToolUse", { level: "warn", findings: [{ ...finding, level: "warn" }] })!);
    expect(out.hookSpecificOutput.additionalContext).toContain("outside node");
  });

  it("prints nothing when only logging", () => {
    expect(toHookOutput("PreToolUse", { level: "log", findings: [{ ...finding, level: "log" }] })).toBeNull();
  });
});

describe("installHooks", () => {
  it("adds Loom hooks once and keeps other settings", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-"));
    const file = path.join(dir, ".claude", "settings.local.json");
    fs.mkdirSync(path.dirname(file));
    fs.writeFileSync(file, JSON.stringify({ model: "x", hooks: { Stop: [{ hooks: [{ type: "command", command: "say done" }] }] } }));
    installHooks(dir, "node /x/loom-hook.js");
    installHooks(dir, "node /x/loom-hook.js");
    const settings = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(settings.model).toBe("x");
    expect(settings.hooks.PreToolUse).toHaveLength(1);
    expect(settings.hooks.Stop).toHaveLength(2);
  });
});
