import { spawn } from "node:child_process";

/**
 * Environment for a fresh Claude Code session: drop the CLAUDE* variables a
 * host session (Claude desktop app, another Claude Code) exports, so the new
 * session does not think it is a child of that host. ANTHROPIC_* is the user's
 * own configuration (API key, proxy) and is kept.
 */
export function cleanEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !/^CLAUDE/i.test(k)));
}

/** The first message of a dispatched session: read the node's context file and do it. */
export const dispatchPrompt = (contextFile: string) =>
  `Read ${contextFile} and complete the task described there. Follow its rules.`;

/**
 * Opens a new terminal window running interactive Claude Code in `cwd`, so the
 * user can answer the "ask" prompts Loom raises. Windows only in v0.1.
 */
export function launchInTerminal(cwd: string, prompt: string, title = "Loom"): void {
  if (process.platform !== "win32") {
    throw new Error("v0.1 只支持在 Windows 上打开终端窗口；请在项目目录手动运行 claude。");
  }
  // `start` opens a new console window; the first quoted argument is its title.
  const child = spawn("cmd.exe", ["/c", `start "${title}" cmd /k claude "${prompt.replace(/"/g, "'")}"`], {
    cwd,
    env: cleanEnv(process.env),
    detached: true,
    stdio: "ignore",
    windowsVerbatimArguments: true,
  });
  child.unref();
}
