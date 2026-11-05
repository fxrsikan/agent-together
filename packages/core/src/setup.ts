import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

/** Result of one short probe command. */
export interface ProbeResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Runs a short command for setup checks. Injectable in tests so we never call
 * real AI assistants or spend money.
 */
export type ProbeRunner = (command: string, args: string[], env?: NodeJS.ProcessEnv) => Promise<ProbeResult>;

/** Whether a login check succeeded, failed, or could not be decided cheaply. */
export type LoginState = "ok" | "needed" | "unknown";

export type RequirementId = "node" | "git" | "claude-code" | "codex" | "cursor" | "grok-build";

/** One row in the setup wizard: a tool the user may need. */
export interface SetupRequirement {
  id: RequirementId;
  /** Short Chinese name shown in the UI. */
  name: string;
  installed: boolean;
  /** Parsed version string, or null when missing / unreadable. */
  version: string | null;
  login: LoginState;
  /**
   * When login is "unknown": plain Chinese note that the user should confirm
   * after opening the tool. Empty otherwise.
   */
  loginNote: string;
  /** One plain-Chinese sentence explaining what this is and why it matters. */
  explain: string;
  /**
   * Official install command for the user's OS, or a plain-Chinese sentence
   * that points at an official install page when no safe command is known
   * (empty when already fine).
   */
  installCommand: string;
  /** Command to start an interactive login, or null when not applicable. */
  loginCommand: string | null;
  /** True when this row does not block finishing the wizard. */
  ready: boolean;
}

/** Full setup scan used by the desktop wizard. */
export interface SetupReport {
  platform: NodeJS.Platform;
  requirements: SetupRequirement[];
  /** Node 22+, git, and at least one AI assistant ready. */
  ready: boolean;
}

export interface SetupOptions {
  run?: ProbeRunner;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** File existence check (for the Windows cursor-agent.cmd path). */
  fileExists?: (file: string) => boolean;
  /** Soft timeout for each probe; defaults to 8s. */
  timeoutMs?: number;
}

const UNKNOWN_LOGIN = "装好了，登录状态打开后确认";

/** Default runner: short-lived child process, no stdin prompt, never opens a TTY login flow that spends money. */
export function defaultProbeRunner(timeoutMs = 8_000): ProbeRunner {
  return (command, args, env = process.env) =>
    new Promise((resolve) => {
      const quote = (a: string) => (/^[\w./:\\=-]+$/.test(a) ? a : `"${a.replace(/"/g, '\\"')}"`);
      const child =
        process.platform === "win32"
          ? spawn([command, ...args].map(quote).join(" "), { env, shell: true, stdio: ["ignore", "pipe", "pipe"] })
          : spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        if (process.platform === "win32" && child.pid) spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
        else child.kill();
      }, timeoutMs);
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("error", (err) => {
        stderr += String(err);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
    });
}

/** Leading numeric x.y.z (or x.y) from a version command's output. */
export function parseVersion(text: string): string | null {
  const m = text.match(/\bv?(\d+\.\d+\.\d+)\b/) ?? text.match(/\bv?(\d+\.\d+)\b/);
  return m ? m[1] : null;
}

/** True when the version string is Node 22 or newer. */
export function nodeVersionOk(version: string | null): boolean {
  if (!version) return false;
  const major = Number(version.split(".")[0]);
  return Number.isFinite(major) && major >= 22;
}

/** Plain sentence used instead of a guessed shell install command. */
const GROK_INSTALL_HINT = "请到 Grok Build 官方安装页按说明安装：https://grok.com";

function installCommands(platform: NodeJS.Platform): Record<RequirementId, string> {
  if (platform === "win32") {
    return {
      node: "winget install OpenJS.NodeJS.LTS",
      git: "winget install Git.Git",
      "claude-code": "npm install -g @anthropic-ai/claude-code",
      codex: "npm install -g @openai/codex",
      cursor: "irm https://cursor.com/install?win=1 | iex",
      "grok-build": GROK_INSTALL_HINT,
    };
  }
  if (platform === "darwin") {
    return {
      node: "brew install node@22",
      git: "brew install git",
      "claude-code": "npm install -g @anthropic-ai/claude-code",
      codex: "npm install -g @openai/codex",
      cursor: "curl https://cursor.com/install -fsS | bash",
      "grok-build": GROK_INSTALL_HINT,
    };
  }
  return {
    node: "curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs",
    git: "sudo apt-get install -y git",
    "claude-code": "npm install -g @anthropic-ai/claude-code",
    codex: "npm install -g @openai/codex",
    cursor: "curl https://cursor.com/install -fsS | bash",
    "grok-build": GROK_INSTALL_HINT,
  };
}

/** Path helpers matching the *target* platform, not the host running the tests. */
function pathFor(platform: NodeJS.Platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

/**
 * Resolves the cursor-agent binary the same way the Cursor adapter does:
 * env override, then Windows installer path, else `cursor-agent` on PATH.
 */
export function resolveCursorCommand(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, fileExists: (f: string) => boolean): string {
  if (env.AGENT_TOGETHER_CURSOR_AGENT) return env.AGENT_TOGETHER_CURSOR_AGENT;
  if (platform === "win32" && env.LOCALAPPDATA) {
    const installed = pathFor(platform).join(env.LOCALAPPDATA, "cursor-agent", "cursor-agent.cmd");
    if (fileExists(installed)) return installed;
  }
  return "cursor-agent";
}

/**
 * Resolves the grok binary: env override, then `~/.grok/bin/grok`, else `grok`.
 */
export function resolveGrokCommand(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, fileExists: (f: string) => boolean): string {
  if (env.AGENT_TOGETHER_GROK) return env.AGENT_TOGETHER_GROK;
  const home = env.USERPROFILE ?? env.HOME;
  if (home) {
    const installed = pathFor(platform).join(home, ".grok", "bin", platform === "win32" ? "grok.exe" : "grok");
    if (fileExists(installed)) return installed;
  }
  return "grok";
}

function looksMissing(r: ProbeResult): boolean {
  if (r.code === 0) return false;
  const text = `${r.stdout}\n${r.stderr}`.toLowerCase();
  return (
    r.code === 127 ||
    /not recognized|not found|no such file|enoent|command not found|不是内部或外部命令/.test(text) ||
    (r.code !== 0 && !parseVersion(`${r.stdout}\n${r.stderr}`))
  );
}

/**
 * Cheap login heuristics that never send a model prompt.
 * - Claude: `claude auth status` (or stdout mentioning logged in / missing auth).
 * - Codex: `codex login status` when available.
 * - Cursor: `cursor-agent status` ("Logged in as …" / "Not logged in").
 * - Grok: cannot tell without a paid call → unknown.
 */
function interpretLogin(id: RequirementId, r: ProbeResult | null): { login: LoginState; note: string } {
  if (!r) return { login: "unknown", note: UNKNOWN_LOGIN };
  const text = `${r.stdout}\n${r.stderr}`;
  const lower = text.toLowerCase();
  if (id === "claude-code") {
    if (r.code === 0 && /logged[\s-]?in|authenticated|email|account/i.test(text) && !/not logged|unauthor/i.test(lower)) {
      return { login: "ok", note: "" };
    }
    if (/not logged|unauthor|please\s+(log|sign)\s*in|login required|no.*credential/i.test(lower)) {
      return { login: "needed", note: "" };
    }
    return { login: "unknown", note: UNKNOWN_LOGIN };
  }
  if (id === "codex" || id === "cursor") {
    if (r.code === 0 && /logged[\s-]?in|authenticated|email|api key/i.test(text) && !/not logged|unauthor/i.test(lower)) {
      return { login: "ok", note: "" };
    }
    if (/not logged|unauthor|please\s+(log|sign)\s*in|login required|no.*credential/i.test(lower)) {
      return { login: "needed", note: "" };
    }
    return { login: "unknown", note: UNKNOWN_LOGIN };
  }
  return { login: "unknown", note: UNKNOWN_LOGIN };
}

async function probeVersion(run: ProbeRunner, command: string, env: NodeJS.ProcessEnv): Promise<{ installed: boolean; version: string | null; raw: ProbeResult }> {
  const raw = await run(command, ["--version"], env);
  if (looksMissing(raw)) return { installed: false, version: null, raw };
  return { installed: true, version: parseVersion(`${raw.stdout}\n${raw.stderr}`), raw };
}

/**
 * Scans the machine for Node 22+, git, and each AI assistant CLI.
 * All process calls go through `run` so unit tests can use fakes.
 */
export async function checkSetup(options: SetupOptions = {}): Promise<SetupReport> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const run = options.run ?? defaultProbeRunner(options.timeoutMs);
  const fileExists = options.fileExists ?? ((f: string) => fs.existsSync(f));
  const installs = installCommands(platform);
  const cursorCmd = resolveCursorCommand(env, platform, fileExists);
  const grokCmd = resolveGrokCommand(env, platform, fileExists);

  const nodeProbe = await probeVersion(run, "node", env);
  const nodeOk = nodeVersionOk(nodeProbe.version);
  const nodeReq: SetupRequirement = {
    id: "node",
    name: "Node.js",
    installed: nodeProbe.installed,
    version: nodeProbe.version,
    login: "ok",
    loginNote: "",
    explain: "应用和各家 AI 助手的命令行都需要 Node.js 22 或更新。",
    installCommand: nodeOk ? "" : installs.node,
    loginCommand: null,
    ready: nodeOk,
  };

  const gitProbe = await probeVersion(run, "git", env);
  const gitReq: SetupRequirement = {
    id: "git",
    name: "git",
    installed: gitProbe.installed,
    version: gitProbe.version,
    login: "ok",
    loginNote: "",
    explain: "用来保存检查点、回滚，以及让多个 AI 助手在独立工作区里比赛。",
    installCommand: gitProbe.installed ? "" : installs.git,
    loginCommand: null,
    ready: gitProbe.installed,
  };

  type AssistantSpec = {
    id: Extract<RequirementId, "claude-code" | "codex" | "cursor" | "grok-build">;
    name: string;
    command: string;
    explain: string;
    loginArgs: string[] | null;
    loginCommand: string;
  };

  const assistants: AssistantSpec[] = [
    {
      id: "claude-code",
      name: "Claude Code",
      command: "claude",
      explain: "Anthropic 的 AI 编程助手命令行。装好并登录后，就可以把画布上的卡片交给它做。",
      loginArgs: ["auth", "status"],
      loginCommand: "claude",
    },
    {
      id: "codex",
      name: "Codex",
      command: "codex",
      explain: "OpenAI 的 AI 编程助手命令行。装好并登录后，就可以把画布上的卡片交给它做。",
      loginArgs: ["login", "status"],
      loginCommand: "codex",
    },
    {
      id: "cursor",
      name: "Cursor",
      command: cursorCmd,
      explain: "Cursor 的命令行助手（cursor-agent）。装好后，就可以把画布上的卡片交给它做。",
      loginArgs: ["status"],
      loginCommand: `"${cursorCmd}" login`,
    },
    {
      id: "grok-build",
      name: "Grok Build",
      command: grokCmd,
      explain: "xAI 的 Grok Build 命令行。装好后，就可以把画布上的卡片交给它做。",
      loginArgs: null,
      loginCommand: `"${grokCmd}"`,
    },
  ];

  const assistantReqs: SetupRequirement[] = [];
  for (const a of assistants) {
    const ver = await probeVersion(run, a.command, env);
    let login: LoginState = "unknown";
    let loginNote = ver.installed ? UNKNOWN_LOGIN : "";
    if (ver.installed && a.loginArgs) {
      const auth = await run(a.command, a.loginArgs, env);
      ({ login, note: loginNote } = interpretLogin(a.id, auth));
    } else if (ver.installed) {
      ({ login, note: loginNote } = interpretLogin(a.id, null));
    }
    const ready = ver.installed && login !== "needed";
    assistantReqs.push({
      id: a.id,
      name: a.name,
      installed: ver.installed,
      version: ver.version,
      login,
      loginNote,
      explain: a.explain,
      installCommand: ver.installed ? "" : installs[a.id],
      loginCommand: ver.installed && login !== "ok" ? a.loginCommand : null,
      ready,
    });
  }

  const requirements = [nodeReq, gitReq, ...assistantReqs];
  const ready = nodeReq.ready && gitReq.ready && assistantReqs.some((a) => a.ready);
  return { platform, requirements, ready };
}

/** Plain Chinese names for observer rule ids shown in the UI. */
export const RULE_LABEL: Record<string, string> = {
  "scope-fence": "越界写入",
  "design-guard": "违反依赖关系",
  "test-tampering": "篡改测试",
  "repeated-failure": "命令反复失败",
  "repeated-read": "反复读取同一文件",
};

/** Replace a raw rule id with its plain name when showing score parts or findings. */
export function ruleLabel(id: string): string {
  return RULE_LABEL[id] ?? id;
}
