import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadRaceConfig } from "./race.js";
import { defaultProbeRunner, resolveCursorCommand, resolveGrokCommand, type ProbeRunner } from "./setup.js";

/** A model an assistant can be told to use: the id its command line takes, and a name for people. */
export interface ModelChoice {
  id: string;
  label: string;
}

export type ModelAgent = "claude-code" | "codex" | "cursor" | "grok-build";

/** Claude Code's stable aliases; they always point at the latest model of each size. */
const CLAUDE_MODELS: ModelChoice[] = [
  { id: "haiku", label: "Haiku（最快、最便宜）" },
  { id: "sonnet", label: "Sonnet（速度和能力均衡）" },
  { id: "opus", label: "Opus（最强，也最贵）" },
];

/** "id - Name" lines from `cursor-agent models`. */
export function parseCursorModels(output: string): ModelChoice[] {
  const models: ModelChoice[] = [];
  for (const line of output.split(/\r?\n/)) {
    const m = /^\s*([\w.\-[\]=,]+)\s+-\s+(.+?)\s*$/.exec(line);
    if (m && m[1] !== "auto") models.push({ id: m[1], label: m[2].replace(/\s*\((current, )?default\)$/, "") });
  }
  return models;
}

/** Indented model ids from `grok models`, "* " marking the default. */
export function parseGrokModels(output: string): ModelChoice[] {
  const after = output.split(/available models:/i)[1] ?? "";
  const models: ModelChoice[] = [];
  for (const line of after.split(/\r?\n/)) {
    const m = /^\s*\*?\s*([\w.-]+)/.exec(line);
    if (m) models.push({ id: m[1], label: m[1] });
  }
  return models;
}

/** The models Codex last fetched for this account, from ~/.codex/models_cache.json. */
export function readCodexModels(home = os.homedir()): ModelChoice[] {
  try {
    const cache = JSON.parse(fs.readFileSync(path.join(home, ".codex", "models_cache.json"), "utf8"));
    return (cache.models ?? [])
      .filter((m: { slug?: unknown }) => typeof m.slug === "string")
      .map((m: { slug: string; display_name?: string }) => ({ id: m.slug, label: m.display_name || m.slug }));
  } catch {
    return [];
  }
}

/**
 * The models each assistant offers on this machine, without spending anything:
 * Claude Code's aliases, `cursor-agent models`, `grok models` and Codex's cache.
 * An assistant that is missing or cannot list them gets an empty list (the
 * user can still type a model name).
 */
export async function listModels(options: { run?: ProbeRunner; env?: NodeJS.ProcessEnv; home?: string } = {}): Promise<Record<ModelAgent, ModelChoice[]>> {
  const env = options.env ?? process.env;
  const run = options.run ?? defaultProbeRunner(20_000);
  const fileExists = (f: string) => fs.existsSync(f);
  const listed = async (command: string, parse: (out: string) => ModelChoice[]) => {
    try {
      const r = await run(command, ["models"], env);
      return r.code === 0 ? parse(r.stdout) : [];
    } catch {
      return [];
    }
  };
  const [cursor, grok] = await Promise.all([
    listed(resolveCursorCommand(env, process.platform, fileExists), parseCursorModels),
    listed(resolveGrokCommand(env, process.platform, fileExists), parseGrokModels),
  ]);
  return { "claude-code": CLAUDE_MODELS, codex: readCodexModels(options.home), cursor, "grok-build": grok };
}

/** The model chosen for each assistant in this project (.agent-together/race.json `models`). */
export function projectModels(root: string): Record<string, string> {
  return loadRaceConfig(root).models ?? {};
}

/**
 * Saves the model per assistant in .agent-together/race.json, keeping its other settings.
 * An empty model means "the assistant's own default" and is left out.
 */
export function saveProjectModels(root: string, models: Record<string, string>): void {
  const file = path.join(root, ".agent-together", "race.json");
  const config = loadRaceConfig(root);
  const chosen = Object.fromEntries(Object.entries(models).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v));
  if (Object.keys(chosen).length) config.models = chosen;
  else delete config.models;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
}
