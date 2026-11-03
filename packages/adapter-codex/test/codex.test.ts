import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { exitCodeFromTranscript, installCodexHooks, parsePatch, toCodexOutput, toLoomEvents } from "@loom/adapter-codex";

const patch = [
  "*** Begin Patch",
  "*** Update File: src/a.ts",
  "@@",
  " const keep = 0;",
  "-export const a = 1;",
  "+export const a = 2;",
  "*** Add File: src/b.ts",
  "+export const b = 3;",
  "*** Delete File: src/old.ts",
  "*** Update File: src/c.ts",
  "*** Move to: src/d.ts",
  "@@",
  "-x",
  "+y",
  "*** End Patch",
].join("\n");

describe("parsePatch", () => {
  it("splits a multi-file patch into per-file before/after", () => {
    expect(parsePatch(patch)).toEqual([
      { op: "update", path: "src/a.ts", moveTo: undefined, before: "const keep = 0;\nexport const a = 1;", after: "const keep = 0;\nexport const a = 2;" },
      { op: "add", path: "src/b.ts", moveTo: undefined, before: "", after: "export const b = 3;" },
      { op: "delete", path: "src/old.ts", moveTo: undefined, before: "", after: "" },
      { op: "update", path: "src/c.ts", moveTo: "src/d.ts", before: "x", after: "y" },
    ]);
  });
});

const base = { session_id: "s1", cwd: path.resolve("/proj") };

describe("toLoomEvents", () => {
  it("turns one apply_patch into one write per file (and the rename target), with absolute paths", () => {
    const events = toLoomEvents({ ...base, hook_event_name: "PreToolUse", tool_name: "apply_patch", tool_input: { command: patch } });
    expect(events.map((e) => (e.kind === "tool.before" && e.action.type === "write" ? e.action.path : null))).toEqual(
      ["src/a.ts", "src/b.ts", "src/old.ts", "src/c.ts", "src/d.ts"].map((p) => path.resolve("/proj", p)),
    );
    expect(events[1]).toMatchObject({ platform: "codex", action: { before: undefined, after: "export const b = 3;" } });
  });

  it("reads a shell failure from the tool response", () => {
    const [event] = toLoomEvents({
      ...base,
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      tool_response: { exit_code: 1, stdout: "" },
    });
    expect(event).toMatchObject({ kind: "tool.after", ok: false, action: { type: "shell", command: "npm test" } });
  });

  it("takes a shell exit code from the transcript when the response is only output", () => {
    const transcript = [
      JSON.stringify({ type: "event_msg", payload: { item: { type: "CommandExecution", id: "exec-1", status: "failed", exit_code: 1 } } }),
      JSON.stringify({ type: "event_msg", payload: { item: { type: "CommandExecution", id: "exec-2", status: "completed", exit_code: 0 } } }),
    ].join("\n");
    const lookup = (p: { tool_use_id?: string }) => exitCodeFromTranscript(transcript, p.tool_use_id!);
    const post = (id: string) =>
      toLoomEvents({ ...base, hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: id, tool_input: { command: "x" }, tool_response: "" }, new Date(), lookup)[0];
    expect(post("exec-1")).toMatchObject({ ok: false, error: "exit 1" });
    expect(post("exec-2")).toMatchObject({ ok: true });
    expect(post("exec-9")).toMatchObject({ ok: true });
  });

  it("maps Stop to the end of a turn and ignores other events", () => {
    expect(toLoomEvents({ ...base, hook_event_name: "Stop" })).toMatchObject([{ kind: "turn.end" }]);
    expect(toLoomEvents({ ...base, hook_event_name: "SessionStart" })).toEqual([]);
  });
});

describe("toCodexOutput", () => {
  const f = { rule: "scope-fence", message: "outside node" };

  it("turns ask into a deny that tells the agent to get the user's decision", () => {
    const out = JSON.parse(toCodexOutput("PreToolUse", { level: "ask", findings: [{ ...f, level: "ask" }] })!);
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(/Ask the user[\s\S]*outside node/);
  });

  it("adds context after a tool ran, and stays silent on Stop", () => {
    const warn = { level: "warn" as const, findings: [{ ...f, level: "warn" as const }] };
    expect(JSON.parse(toCodexOutput("PostToolUse", warn)!).hookSpecificOutput.additionalContext).toContain("outside node");
    expect(toCodexOutput("Stop", warn)).toBeNull();
  });
});

describe("installCodexHooks", () => {
  it("writes .codex/hooks.json once and keeps other hooks", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-codex-"));
    fs.mkdirSync(path.join(dir, ".codex"));
    fs.writeFileSync(path.join(dir, ".codex", "hooks.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "say" }] }] } }));
    installCodexHooks(dir, "node /x/loom-hook.js --platform codex");
    installCodexHooks(dir, "node /x/loom-hook.js --platform codex");
    const config = JSON.parse(fs.readFileSync(path.join(dir, ".codex", "hooks.json"), "utf8"));
    expect(config.hooks.PreToolUse).toHaveLength(1);
    expect(config.hooks.Stop).toHaveLength(2);
  });

  it("installs at the git repository root when the project is a subfolder", () => {
    const top = fs.mkdtempSync(path.join(os.tmpdir(), "loom-codex-repo-"));
    execFileSync("git", ["init", "-q"], { cwd: top });
    const project = path.join(top, "apps", "web");
    fs.mkdirSync(project, { recursive: true });
    const file = installCodexHooks(project, "node /x/loom-hook.js --platform codex");
    expect(fs.realpathSync(path.dirname(path.dirname(file)))).toBe(fs.realpathSync(top));
  });
});
