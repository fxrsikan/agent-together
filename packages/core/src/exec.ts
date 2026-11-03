import { spawn } from "node:child_process";

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

/**
 * Runs a CLI with the prompt on stdin (no shell quoting of user text), killing
 * it after `timeoutMs`. Shared by the agent runners.
 */
export function execCli(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; input: string; timeoutMs: number }): Promise<ExecResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    // On Windows the CLIs are .cmd shims that need a shell; pass one command line (args are flags
    // and model names, never user text — the prompt goes through stdin).
    const quote = (a: string) => (/^[\w./:=-]+$/.test(a) ? a : `"${a.replace(/"/g, '\\"')}"`);
    const child =
      process.platform === "win32"
        ? spawn([command, ...args].map(quote).join(" "), { cwd: options.cwd, env: options.env, shell: true, stdio: ["pipe", "pipe", "pipe"] })
        : spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, options.timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => {
      stderr += String(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut, durationMs: Date.now() - started });
    });
    child.stdin.end(options.input);
  });
}
