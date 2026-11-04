import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { cleanEnv } from "./terminal.js";

/** A small text-in, text-out model used for L2 judgments. */
export interface Llm {
  /** Shown to the user, e.g. "claude-cli (haiku)". */
  readonly name: string;
  complete(prompt: string): Promise<string>;
}

export interface LlmConfig {
  /** "auto" picks anthropic when an API key is set, else the claude CLI if installed. */
  provider?: "auto" | "off" | "anthropic" | "claude-cli" | "openai-compatible";
  model?: string;
  /** openai-compatible only, e.g. http://localhost:11434/v1 for Ollama. The key comes from AGENT_TOGETHER_LLM_API_KEY. */
  baseUrl?: string;
  /** L2 calls allowed per agent session; keeps judging from becoming a token sink. */
  maxCallsPerSession?: number;
}

const HAIKU = "claude-haiku-5-5";
const TIMEOUT_MS = 60_000;

/** Reads .agent-together/llm.json (no secrets in it); AGENT_TOGETHER_LLM_PROVIDER overrides the provider. */
export function loadLlmConfig(root: string): LlmConfig {
  const file = path.join(root, ".agent-together", "llm.json");
  const config: LlmConfig = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  const fromEnv = process.env.AGENT_TOGETHER_LLM_PROVIDER as LlmConfig["provider"] | undefined;
  return fromEnv ? { ...config, provider: fromEnv } : config;
}

/** Claude through the official SDK; credentials resolve from the environment (API key, auth token or `ant` profile). */
class AnthropicLlm implements Llm {
  readonly name: string;
  private client = new Anthropic();

  constructor(private model = HAIKU) {
    this.name = `anthropic (${model})`;
  }

  async complete(prompt: string): Promise<string> {
    const response = await this.client.messages.create(
      {
        model: this.model,
        max_tokens: 2048,
        output_config: { effort: "low" },
        messages: [{ role: "user", content: prompt }],
      },
      { timeout: TIMEOUT_MS },
    );
    if (response.stop_reason === "refusal") throw new Error("the model declined this judgment");
    return response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  }
}

/**
 * The user's logged-in Claude Code CLI in headless mode: no API key needed.
 * Runs in the temp folder so the call never lands inside a Agent Together project (and its hooks).
 */
class ClaudeCliLlm implements Llm {
  readonly name: string;

  constructor(private model = "haiku") {
    this.name = `claude-cli (${model})`;
  }

  complete(prompt: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn("claude", ["-p", "--model", this.model], {
        cwd: os.tmpdir(),
        env: cleanEnv(process.env),
        shell: process.platform === "win32",
        stdio: ["pipe", "pipe", "pipe"],
      });
      let out = "";
      let err = "";
      const timer = setTimeout(() => child.kill(), TIMEOUT_MS);
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("error", reject);
      child.on("close", (code) => {
        clearTimeout(timer);
        code === 0 ? resolve(out.trim()) : reject(new Error(`claude -p exited ${code}: ${err.trim().slice(0, 200)}`));
      });
      child.stdin.end(prompt);
    });
  }
}

/** Any OpenAI-compatible chat endpoint (Ollama, a local server, another provider). */
class OpenAiCompatibleLlm implements Llm {
  readonly name: string;

  constructor(
    private baseUrl: string,
    private model: string,
  ) {
    this.name = `openai-compatible (${model})`;
  }

  async complete(prompt: string): Promise<string> {
    const key = process.env.AGENT_TOGETHER_LLM_API_KEY;
    const res = await fetch(`${this.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({ model: this.model, messages: [{ role: "user", content: prompt }] }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`${this.baseUrl} answered ${res.status}`);
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return data.choices?.[0]?.message?.content ?? "";
  }
}

function onPath(command: string): boolean {
  const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD").split(";") : [""];
  return (process.env.PATH ?? "")
    .split(path.delimiter)
    .some((dir) => exts.some((ext) => fs.existsSync(path.join(dir, command + ext.toLowerCase())) || fs.existsSync(path.join(dir, command + ext))));
}

/** The configured L2 model, or null when L2 is off or nothing is available. */
export function createLlm(config: LlmConfig): Llm | null {
  const provider = config.provider ?? "auto";
  switch (provider) {
    case "off":
      return null;
    case "anthropic":
      return new AnthropicLlm(config.model);
    case "claude-cli":
      return new ClaudeCliLlm(config.model);
    case "openai-compatible":
      if (!config.baseUrl || !config.model) throw new Error("openai-compatible needs baseUrl and model in .agent-together/llm.json");
      return new OpenAiCompatibleLlm(config.baseUrl, config.model);
    case "auto":
      if (process.env.ANTHROPIC_API_KEY) return new AnthropicLlm(config.model);
      if (onPath("claude")) return new ClaudeCliLlm();
      return null;
  }
}
