import { spawn } from "node:child_process";

/**
 * Environment for a fresh agent session: drop the CLAUDE* variables a host
 * session (Claude desktop app, another Claude Code) exports, so the new session
 * does not think it is a child of that host. Provider settings (ANTHROPIC_*,
 * OPENAI_*) are the user's own and are kept.
 */
export function cleanEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !/^CLAUDE/i.test(k)));
}

/**
 * Opens a new terminal window running `commandLine` in `cwd`, so the user can
 * watch and answer the agent. Windows only in v0.1.
 */
export function openTerminal(cwd: string, commandLine: string, title = "Agent Together"): void {
  if (process.platform !== "win32") {
    throw new Error(`暂只支持在 Windows 上打开终端窗口；请在项目目录手动运行：${commandLine}`);
  }
  // `start` opens a new console window; its first quoted argument is the title.
  const child = spawn("cmd.exe", ["/c", `start "${title}" cmd /k ${commandLine}`], {
    cwd,
    env: cleanEnv(process.env),
    detached: true,
    stdio: "ignore",
    windowsVerbatimArguments: true,
  });
  child.unref();
}

/** The first message of a dispatched session: read the node's context file and do it. */
export const dispatchPrompt = (contextFile: string) =>
  `Read ${contextFile} and complete the task described there. Follow its rules.`;
