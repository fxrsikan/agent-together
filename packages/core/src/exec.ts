import { spawn } from "node:child_process";

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Stopped through `signal`. */
  aborted: boolean;
  durationMs: number;
}

/**
 * Runs a CLI with the prompt on stdin (no shell quoting of user text), killing
 * it after `timeoutMs` or when `signal` aborts. `onLine` sees each stdout line as
 * it arrives, for runners that stream. Shared by the agent runners.
 */
export function execCli(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; input: string; timeoutMs: number; signal?: AbortSignal; onLine?: (line: string) => void },
): Promise<ExecResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    // On Windows the CLIs are .cmd shims that need a shell; pass one command line (args are flags,
    // model names and temp-file paths, never user text — the prompt goes through stdin).
    const quote = (a: string) => (/^[\w./:=-]+$/.test(a) ? a : `"${a.replace(/"/g, '\\"')}"`);
    const child =
      process.platform === "win32"
        ? spawn([command, ...args].map(quote).join(" "), { cwd: options.cwd, env: options.env, shell: true, stdio: ["pipe", "pipe", "pipe"] })
        : spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let pending = "";
    let timedOut = false;
    let aborted = false;
    const kill = () => {
      // On Windows the shell wraps the agent; kill the whole tree.
      if (process.platform === "win32" && child.pid) spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
      else child.kill();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, options.timeoutMs);
    const onAbort = () => {
      aborted = true;
      kill();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (d) => {
      stdout += d;
      if (!options.onLine) return;
      pending += d;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) options.onLine(line);
    });
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => {
      stderr += String(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (options.onLine && pending.trim()) options.onLine(pending);
      resolve({ code, stdout, stderr, timedOut, aborted, durationMs: Date.now() - started });
    });
    child.stdin.end(options.input);
  });
}
