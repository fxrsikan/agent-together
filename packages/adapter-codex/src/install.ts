import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const EVENTS = ["PreToolUse", "PostToolUse", "Stop"] as const;
const MARKER = "agent-together-hook";

interface HookGroup {
  matcher?: string;
  hooks: { type: string; command: string; timeout?: number }[];
}

/**
 * Codex loads project hooks from the repository root's .codex/ only, so a Agent Together
 * project in a subfolder still installs there; agent-together-hook finds the right .agent-together
 * from each event's cwd. Outside git, the project folder itself is used.
 */
export function codexHooksRoot(projectRoot: string): string {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return projectRoot;
  }
}

/**
 * Registers agent-together-hook in <repo root>/.codex/hooks.json. Codex runs project
 * hooks only after the user trusts them (/hooks in the Codex CLI), and again
 * after they change. Re-running replaces earlier Agent Together entries and keeps the rest.
 */
export function installCodexHooks(projectRoot: string, hookCommand: string): string {
  if (!hookCommand.includes(MARKER)) throw new Error(`hook command must contain "${MARKER}"`);
  const file = path.join(codexHooksRoot(projectRoot), ".codex", "hooks.json");
  const config = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  config.hooks ??= {};
  for (const event of EVENTS) {
    const groups: HookGroup[] = (config.hooks[event] ?? []).filter(
      (g: HookGroup) => !g.hooks?.some((h) => h.command.includes(MARKER)),
    );
    groups.push({ hooks: [{ type: "command", command: hookCommand, timeout: 10 }] });
    config.hooks[event] = groups;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
  return file;
}
