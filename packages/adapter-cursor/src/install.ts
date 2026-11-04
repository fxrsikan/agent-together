import fs from "node:fs";
import path from "node:path";

const EVENTS = ["preToolUse", "postToolUse", "postToolUseFailure", "stop"] as const;
const MARKER = "loom-hook";

/**
 * Registers loom-hook in <project>/.cursor/hooks.json (Cursor reads project
 * hooks from the opened workspace, and only once the workspace is trusted).
 * Re-running replaces earlier Loom entries and keeps the rest.
 */
export function installCursorHooks(projectRoot: string, hookCommand: string): string {
  if (!hookCommand.includes(MARKER)) throw new Error(`hook command must contain "${MARKER}"`);
  const file = path.join(projectRoot, ".cursor", "hooks.json");
  const config = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  config.version ??= 1;
  config.hooks ??= {};
  for (const event of EVENTS) {
    const entries: { command: string }[] = (config.hooks[event] ?? []).filter((h: { command?: string }) => !h.command?.includes(MARKER));
    entries.push({ command: hookCommand });
    config.hooks[event] = entries;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
  return file;
}
