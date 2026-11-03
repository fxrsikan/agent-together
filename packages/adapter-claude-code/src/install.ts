import fs from "node:fs";
import path from "node:path";

const EVENTS = ["PreToolUse", "PostToolUse", "PostToolUseFailure", "Stop"] as const;
const MARKER = "loom-hook";

interface HookGroup {
  matcher?: string;
  hooks: { type: string; command: string; timeout?: number }[];
}

/**
 * Registers loom-hook for every event in <project>/.claude/settings.local.json.
 * The command holds an absolute path, so it goes in the personal (git-ignored)
 * settings file, not the shared one. Re-running replaces earlier Loom entries
 * and leaves everything else untouched.
 */
export function installHooks(projectRoot: string, hookCommand: string): string {
  if (!hookCommand.includes(MARKER)) throw new Error(`hook command must contain "${MARKER}"`);
  const file = path.join(projectRoot, ".claude", "settings.local.json");
  const settings = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  settings.hooks ??= {};
  for (const event of EVENTS) {
    const groups: HookGroup[] = (settings.hooks[event] ?? []).filter(
      (g: HookGroup) => !g.hooks?.some((h) => h.command.includes(MARKER)),
    );
    const handler = { type: "command", command: hookCommand, timeout: 10 };
    groups.push(event === "Stop" ? { hooks: [handler] } : { matcher: "*", hooks: [handler] });
    settings.hooks[event] = groups;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
  return file;
}
