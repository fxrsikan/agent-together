import { Capability } from "@agent-together/schema";
import { parseJsonObject } from "./judge.js";
import type { Llm } from "./llm.js";

/** Validates an editable role draft without trusting the model's kind. */
export function roleFromDraft(input: unknown): Capability | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const draft = input as Record<string, unknown>;
  const result = Capability.safeParse({
    id: typeof draft.id === "string" ? draft.id.trim() : draft.id,
    kind: "agent",
    description: typeof draft.description === "string" ? draft.description.trim() : draft.description,
    body: typeof draft.body === "string" ? draft.body.trim() : draft.body,
    tools: draft.tools,
    model: draft.model,
  });
  return result.success ? result.data : null;
}

/** Keeps at most four distinct, valid specialist proposals. */
export function rolesFromDraft(input: unknown): Capability[] {
  const roles: Capability[] = [];
  if (!Array.isArray(input)) return roles;
  for (const item of input) {
    const role = roleFromDraft(item);
    if (role && !roles.some((r) => r.id === role.id)) roles.push(role);
    if (roles.length === 4) break;
  }
  return roles;
}

/** Generates a draft only; the user saves it separately. */
export async function draftRole(llm: Llm | null, sentence: string): Promise<Capability> {
  if (!llm) throw new Error("还没有可用的 AI，请先配置模型或登录 Claude 命令行。");
  if (!sentence.trim()) throw new Error("请先说说这个角色要做什么");
  const reply = await llm.complete(`按用户的话写一个专职角色。说明和正文用大白话中文，写清工作范围、不能做什么、如何检查结果。只输出 JSON：{"id":"小写英文短横线名字","description":"用于什么情况","body":"完整工作说明"}。可选 tools（工具名数组）和 model，不要随意限制工具。用户的话：\n${sentence.trim()}`, { maxTokens: 4000 });
  const role = roleFromDraft(parseJsonObject(reply));
  if (!role) throw new Error("AI 没有给出完整的角色说明，请重试");
  return role;
}
