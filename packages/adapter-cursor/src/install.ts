import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const EVENTS = ["preToolUse", "postToolUse", "postToolUseFailure", "stop"] as const;
const MARKER = "agent-together-hook";

function gitRoot(dir: string): string | null {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

function writeHooks(file: string, hookCommand: string) {
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
}

/**
 * Registers agent-together-hook in .cursor/hooks.json. The Cursor editor reads it from
 * the opened folder, cursor-agent (the CLI) from the git repository root, so a
 * project in a subfolder gets both. Cursor runs project hooks only in a
 * trusted workspace. Re-running replaces earlier Agent Together entries and keeps the rest.
 */
export function installCursorHooks(projectRoot: string, hookCommand: string): string[] {
  if (!hookCommand.includes(MARKER)) throw new Error(`hook command must contain "${MARKER}"`);
  const roots = [projectRoot, gitRoot(projectRoot)].filter((r): r is string => !!r);
  const files = [...new Set(roots.map((r) => path.resolve(r, ".cursor", "hooks.json")))];
  for (const file of files) writeHooks(file, hookCommand);
  return files;
}
