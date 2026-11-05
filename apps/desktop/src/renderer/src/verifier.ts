// Mirrors verifierKey / verifierLabel in packages/core/src/memory.ts (the renderer cannot import core's Node code).

const AGENT_NAMES: Record<string, string> = { "claude-code": "Claude Code", codex: "Codex", cursor: "Cursor", "grok-build": "Grok Build" };

/** "claude-code/haiku", or "claude-code" for the assistant's default model. */
export function verifierKey(agent: string, model?: string): string {
  return model?.trim() ? `${agent}/${model.trim()}` : agent;
}

/** "claude-code/haiku" → "Claude Code · haiku"; "codex" → "Codex · 默认模型". */
export function verifierLabel(key: string): string {
  const [agent, ...model] = key.split("/");
  return `${AGENT_NAMES[agent] ?? agent} · ${model.length ? model.join("/") : "默认模型"}`;
}
