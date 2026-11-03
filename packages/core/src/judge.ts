import type { CanvasNode, LoomEvent } from "@loom/schema";
import type { Llm } from "./llm.js";

/** The first JSON object in a model reply (models sometimes wrap it in prose or fences). */
export function parseJsonObject<T>(text: string): T | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}

/**
 * 记忆官 (L2): rewrites a rule-generated draft into one plain Chinese sentence a
 * teammate would write down. Returns null when the model gives nothing usable.
 */
export async function refineMemory(llm: Llm, raw: string, node: CanvasNode | null): Promise<string | null> {
  const prompt = `你在为一个软件项目整理"经验记忆"。下面是自动观察器记录的原始信息${node ? `，属于功能节点「${node.title}」（目标：${node.intent.goal || "未写"}）` : ""}。

原始信息：
${raw}

把它改写成一条给以后的开发者（人或 AI）看的经验，要求：
- 只用一句中文，不超过 60 个字；
- 写清楚"不要做什么 / 应该怎么做"，保留关键的文件、模块名；
- 不要提"观察器""Loom""规则"这些词。

只输出 JSON：{"memory": "..."}`;
  const answer = parseJsonObject<{ memory?: string }>(await llm.complete(prompt));
  const memory = answer?.memory?.trim();
  return memory ? memory : null;
}

export interface TurnJudgment {
  onTrack: boolean;
  reason: string;
}

function describe(event: LoomEvent): string | null {
  if (event.kind === "turn.end") return null;
  const a = event.action;
  if (a.type === "write") return `写入 ${a.path}`;
  if (a.type === "shell" && event.kind === "tool.after") return `执行 ${a.command}${event.ok ? "" : "（失败）"}`;
  return null;
}

/** True when a turn did something worth judging (wrote files or ran commands). */
export function turnWorthJudging(events: LoomEvent[]): boolean {
  return events.some((e) => describe(e) !== null);
}

/**
 * 定向官 (L2): did this agent turn serve the node's goal and the dispatched task?
 * Sees only the node's intent, the task text and a list of actions, never the code.
 */
export async function judgeTurn(llm: Llm, node: CanvasNode, task: string | null, events: LoomEvent[]): Promise<TurnJudgment | null> {
  const actions = events.map(describe).filter(Boolean).slice(-40);
  const prompt = `你在检查一个 AI 编程助手的这一轮工作有没有偏离目标。

功能节点：${node.title}
节点目标：${node.intent.goal || "（未写）"}
验收标准：${node.intent.acceptance.join("；") || "（未写）"}
节点负责的文件：${node.files.join("、") || "（未绑定）"}
这次派发的任务：${task?.trim() || "（未单独派发，按节点目标判断）"}

这一轮的动作：
${actions.map((a) => `- ${a}`).join("\n")}

判断这些动作是否都在为上面的目标和任务服务。只要有动作明显在做无关的事（例如重构不相干的模块、改了与任务无关的文件、在做别的功能），就算偏离。拿不准时算没有偏离。

只输出 JSON：{"onTrack": true 或 false, "reason": "一句中文理由，不超过 50 字"}`;
  const answer = parseJsonObject<Partial<TurnJudgment>>(await llm.complete(prompt));
  if (typeof answer?.onTrack !== "boolean") return null;
  return { onTrack: answer.onTrack, reason: String(answer.reason ?? "").trim() };
}
