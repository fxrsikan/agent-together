import { execFile, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { parseJsonObject } from "./judge.js";
import type { Llm } from "./llm.js";
import { readProjectInfo, writeProjectInfo } from "./project.js";

/**
 * Running the product being built (phase one, M2): a local web app started with
 * its own command, on a port Agent Together picks and passes in PORT, with
 * AT_SERVICE_MODE saying whether external services are sample ("mock") or real.
 * The run configuration is kept in project.json once a start actually worked.
 */
export interface RunConfig {
  /** Installs dependencies, run once when they are missing (e.g. "npm install"). */
  install?: string;
  /** Starts the server, e.g. "node server.js" or "npm start". */
  start: string;
  /** Path to open once it responds, "/" by default. */
  path?: string;
  /** Builds a deliverable, if the product needs one. */
  build?: string;
  /** When a start with this configuration last worked. */
  verifiedAt?: string;
  /**
   * Where the product keeps its business data (project-relative files, folders or
   * globs, e.g. "data/" or "manuscript/**"). Code and data are looked at apart: a
   * stable version backs the data up, acceptance starts without it, a delivery
   * package leaves it out.
   */
  data?: string[];
}

/** The conventions every agent working on a web product is told (and the product is started with). */
export const RUN_CONVENTIONS = `- 服务器监听环境变量 PORT 指定的端口（没有时用 3000），只监听本机（127.0.0.1 或 localhost）。
- 外部服务按环境变量 AT_SERVICE_MODE 切换："mock" 用示例服务（默认），"real" 用真实服务。示例服务和真实服务实现同一个接口，页面不知道用的是哪个。
- 业务数据放在环境变量 AT_DATA_DIR 指定的文件夹里（没有时用项目里的 data/ 文件夹），不和代码混在一起。
- 启动命令要能在 Windows 和 macOS 上直接运行（例如 node server.js），不依赖全局安装的工具。`;

export function readRunConfig(root: string): RunConfig | null {
  const run = readProjectInfo(root).run;
  return run?.start?.trim() ? run : null;
}

export function saveRunConfig(root: string, config: RunConfig): RunConfig {
  const clean: RunConfig = {
    start: config.start.trim(),
    ...(config.install?.trim() ? { install: config.install.trim() } : {}),
    ...(config.path?.trim() ? { path: config.path.trim().startsWith("/") ? config.path.trim() : `/${config.path.trim()}` } : {}),
    ...(config.build?.trim() ? { build: config.build.trim() } : {}),
    ...(config.verifiedAt ? { verifiedAt: config.verifiedAt } : {}),
    ...(config.data?.some((d) => d.trim()) ? { data: [...new Set(config.data.map((d) => d.trim().replace(/\\/g, "/")).filter(Boolean))] } : {}),
  };
  writeProjectInfo(root, { run: clean });
  return clean;
}

const readJson = (file: string): Record<string, unknown> | null => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};

/** A start command read off the files: package.json's start script, else a server file. Null when nothing fits. */
export function guessRunConfig(root: string, files: string[]): RunConfig | null {
  const pkg = readJson(path.join(root, "package.json"));
  const deps = pkg && Object.keys({ ...(pkg.dependencies as object), ...(pkg.devDependencies as object) }).length > 0;
  const install = deps ? "npm install" : undefined;
  const scripts = (pkg?.scripts ?? {}) as Record<string, string>;
  if (scripts.start) return { start: "npm start", ...(install ? { install } : {}) };
  const server = ["server.js", "server.mjs", "src/server.js", "src/server.mjs", "app.js", "src/app.js", "index.js", "src/index.js"].find((f) => files.includes(f));
  if (server) return { start: `node ${server}`, ...(install ? { install } : {}) };
  if (scripts.dev) return { start: "npm run dev", ...(install ? { install } : {}) };
  return null;
}

export function runConfigPrompt(root: string, files: string[]): string {
  const read = (rel: string) => {
    try {
      return fs.readFileSync(path.join(root, rel), "utf8").slice(0, 3000);
    } catch {
      return "";
    }
  };
  return `这是一个本地网页应用的项目。请找出怎么启动它。

约定：
${RUN_CONVENTIONS}

文件（部分）：
${files.slice(0, 200).join("\n")}

package.json：
${read("package.json") || "（没有）"}

README：
${read("README.md") || "（没有）"}

只输出 JSON：{"install":"安装依赖的命令，不需要就写空字符串","start":"启动服务器的命令","path":"启动后打开的路径，一般是 /"}。看不出怎么启动时 start 写空字符串。`;
}

/** Asks the helper model how to start the product; null when it cannot tell. */
export async function proposeRunConfig(llm: Llm, root: string, files: string[]): Promise<RunConfig | null> {
  const raw = parseJsonObject<{ install?: string; start?: string; path?: string }>(await llm.complete(runConfigPrompt(root, files), { timeoutMs: 90_000, maxTokens: 800 }));
  if (!raw?.start?.trim()) return null;
  return { start: raw.start.trim(), ...(raw.install?.trim() ? { install: raw.install.trim() } : {}), ...(raw.path?.trim() ? { path: raw.path.trim() } : {}) };
}

/** A free local port. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

/** Resolves true once the URL answers at all (any status below 500), false on timeout or abort. */
export function waitForHttp(url: string, timeoutMs: number, stop?: () => boolean): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const attempt = () => {
      if (stop?.()) return resolve(false);
      const req = http.get(url, { timeout: 2000 }, (res) => {
        res.resume();
        if ((res.statusCode ?? 500) < 500) resolve(true);
        else retry();
      });
      req.on("error", retry);
      req.on("timeout", () => req.destroy());
    };
    const retry = () => (Date.now() > deadline ? resolve(false) : setTimeout(attempt, 400));
    attempt();
  });
}

/** A URL the server printed itself ("listening on http://localhost:3000"), for products that ignore PORT. */
export function urlFromLogs(lines: string[]): string | null {
  for (const line of [...lines].reverse()) {
    const m = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d{2,5})/.exec(line);
    if (m) return `http://127.0.0.1:${m[1]}`;
  }
  return null;
}

/** Ends a process and everything it started (npm → node), on Windows and elsewhere. */
export function killTree(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null || !child.pid) return resolve();
    child.once("exit", () => resolve());
    if (process.platform === "win32") execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], () => undefined);
    else {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    }
    setTimeout(resolve, 5000);
  });
}

export type ProductState = "stopped" | "installing" | "starting" | "running" | "failed";

export interface ProductStatus {
  state: ProductState;
  url: string | null;
  /** Why it failed, in plain words; the logs hold the details. */
  error: string | null;
  config: RunConfig | null;
  serviceMode: "mock" | "real";
}

const MAX_LOG_LINES = 500;

/** The product's server process: at most one per project. */
export class ProductProcess {
  private child: ChildProcess | null = null;
  private status: ProductStatus;
  private lines: string[] = [];
  private generation = 0;

  constructor(
    readonly root: string,
    private readonly onChange: (status: ProductStatus) => void = () => undefined,
  ) {
    this.status = { state: "stopped", url: null, error: null, config: readRunConfig(root), serviceMode: "mock" };
  }

  get current(): ProductStatus {
    return { ...this.status };
  }

  logs(last = 200): string[] {
    return this.lines.slice(-last);
  }

  private set(patch: Partial<ProductStatus>) {
    this.status = { ...this.status, ...patch };
    this.onChange(this.current);
  }

  private log(text: string) {
    for (const line of text.replace(/\r/g, "").split("\n")) if (line.trim()) this.lines.push(line);
    if (this.lines.length > MAX_LOG_LINES) this.lines.splice(0, this.lines.length - MAX_LOG_LINES);
  }

  private run(command: string, env: NodeJS.ProcessEnv): ChildProcess {
    this.log(`$ ${command}`);
    const child = spawn(command, { cwd: this.root, env: { ...process.env, ...env }, shell: true, detached: process.platform !== "win32", windowsHide: true });
    child.stdout?.on("data", (d) => this.log(String(d)));
    child.stderr?.on("data", (d) => this.log(String(d)));
    return child;
  }

  /**
   * Starts the product with this configuration (installing dependencies first when
   * they are missing) and waits until it answers. Resolves with the status: running,
   * or failed with the reason.
   */
  async start(config: RunConfig, serviceMode: "mock" | "real" = "mock", readyTimeoutMs = 60_000, env: NodeJS.ProcessEnv = {}): Promise<ProductStatus> {
    await this.stop();
    const gen = ++this.generation;
    this.lines = [];
    this.set({ state: "starting", url: null, error: null, config, serviceMode });
    if (config.install && !fs.existsSync(path.join(this.root, "node_modules")) && fs.existsSync(path.join(this.root, "package.json"))) {
      this.set({ state: "installing" });
      const code = await new Promise<number | null>((resolve) => this.run(config.install!, {}).on("exit", resolve));
      if (gen !== this.generation) return this.current;
      if (code !== 0) return (this.set({ state: "failed", error: `安装依赖失败（${config.install}，退出代码 ${code}）` }), this.current);
      this.set({ state: "starting" });
    }
    const port = await freePort();
    const child = this.run(config.start, { ...env, PORT: String(port), AT_SERVICE_MODE: serviceMode });
    this.child = child;
    let exited: string | null = null;
    child.on("exit", (code, signal) => {
      exited = `程序退出了（${signal ? `信号 ${signal}` : `退出代码 ${code}`}）`;
      if (gen === this.generation && this.child === child) {
        this.child = null;
        if (this.status.state !== "stopped") this.set({ state: "failed", error: this.status.state === "running" ? `${exited}，看一下日志` : `启动时${exited}，看一下日志` });
      }
    });
    const base = `http://127.0.0.1:${port}`;
    const until = Date.now() + readyTimeoutMs;
    let url: string | null = null;
    while (!url && Date.now() < until && !exited && gen === this.generation) {
      // Our port first; a product that ignores PORT usually prints the address it chose.
      if (await waitForHttp(base, 1500, () => !!exited || gen !== this.generation)) url = base;
      else {
        const printed = urlFromLogs(this.lines);
        if (printed && (await waitForHttp(printed, 1000))) url = printed;
      }
    }
    if (gen !== this.generation) return this.current;
    if (!url) {
      if (!exited) {
        await killTree(child);
        this.set({ state: "failed", error: `${Math.round(readyTimeoutMs / 1000)} 秒内没有在端口 ${port} 上响应。服务器要监听环境变量 PORT 指定的端口` });
      }
      return this.current;
    }
    this.set({ state: "running", url: `${url}${config.path && config.path !== "/" ? config.path : "/"}` });
    return this.current;
  }

  async stop(): Promise<void> {
    this.generation++;
    const child = this.child;
    this.child = null;
    if (child) {
      this.log("（已停止）");
      await killTree(child);
    }
    if (this.status.state !== "stopped") this.set({ state: "stopped", url: null, error: null });
  }
}

/**
 * Tries a run configuration for real: starts the product, waits until it answers,
 * stops it. Saved to project.json only when it worked.
 */
export async function verifyRunConfig(root: string, config: RunConfig, serviceMode: "mock" | "real" = "mock"): Promise<{ ok: boolean; error: string | null; logs: string[]; config: RunConfig }> {
  const probe = new ProductProcess(root);
  const status = await probe.start(config, serviceMode);
  const logs = probe.logs();
  await probe.stop();
  if (status.state !== "running") return { ok: false, error: status.error, logs, config };
  return { ok: true, error: null, logs, config: saveRunConfig(root, { ...config, verifiedAt: new Date().toISOString() }) };
}
