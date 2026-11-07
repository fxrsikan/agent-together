import type { Canvas, CanvasNode, Capability, Memory, Scenario } from "@agent-together/schema";
import { RUN_CONVENTIONS } from "./product.js";

const list = (items: string[]) => (items.length ? items.map((i) => `- ${i}`).join("\n") : "- （无）");
const files = (n: CanvasNode) => n.files.map((f) => `\`${f}\``).join("、") || "（未绑定）";
const KIND_LABEL: Record<Memory["kind"], string> = { decision: "决策", constraint: "约束", pitfall: "踩过的坑", preference: "偏好" };

/**
 * Everything an agent should know to work on one node, without a specific task:
 * the node, the interface of its direct neighbours, its approved memories and the
 * rules Agent Together enforces. Never the whole repository. Used for dispatch and skill export.
 */
export function buildNodeGuide(canvas: Canvas, nodeId: string, memories: Memory[] = []): string {
  const node = canvas.nodes.find((n) => n.id === nodeId);
  if (!node) throw new Error(`unknown node: ${nodeId}`);
  const byId = (id: string) => canvas.nodes.find((n) => n.id === id)!;
  const dependsOn = canvas.edges.filter((e) => e.from === nodeId).map((e) => byId(e.to));
  const usedBy = canvas.edges.filter((e) => e.to === nodeId).map((e) => byId(e.from));

  return `## 节点：${node.title}

- 目标：${node.intent.goal || "（未填写）"}
- 可以修改的文件：${files(node)}

验收标准：
${list(node.intent.acceptance)}

任务清单：
${list(node.intent.tasks)}

## 可以依赖的节点

只读它们的对外接口，不要修改它们的文件。

${list(dependsOn.map((n) => `${n.title}：${n.intent.goal || "（无目标说明）"}，文件 ${files(n)}`))}

## 依赖本节点的节点

修改本节点的对外接口时，保持对它们兼容。

${list(usedBy.map((n) => `${n.title}：文件 ${files(n)}`))}

## 已审批的记忆

${list(memories.map((m) => `（${KIND_LABEL[m.kind]}）${m.content}`))}

## Agent Together 会检查的规则

- 只修改本节点的文件；越界写入会被拦截，需要向用户说明理由。
- 只能通过上面列出的依赖关系引用其他节点的代码。
- 不要靠跳过测试或删除断言让测试通过。
- 同一个命令反复失败时，停下来总结原因，换思路或询问用户。
- 需要改的文件属于别的节点时（例如 package.json），不要自己改，说明需要哪个节点先做什么。

## 怎么汇报

用户可能不会写代码。做完后用简体中文、大白话说清楚：做了什么、测试有没有通过、还剩什么要用户处理。
`;
}

/** The usage scenarios a card helps complete: what "done" means for the user, step by step. */
function scenarioSection(scenarios: Scenario[]): string {
  if (!scenarios.length) return "";
  const one = (sc: Scenario) =>
    [
      `### ${sc.id} ${sc.name}`,
      sc.preconditions.length ? `前置条件：${sc.preconditions.join("；")}` : "",
      sc.input ? `测试样例：\n${sc.input}` : "",
      sc.steps.length ? `步骤：\n${sc.steps.map((x, i) => `${i + 1}. ${x}`).join("\n")}` : "",
      sc.expected.length ? `预期结果：\n${sc.expected.map((x) => `- ${x}`).join("\n")}` : "",
      sc.dataChecks.length ? `数据检查：${sc.dataChecks.join("；")}` : "",
      sc.errorChecks.length ? `出错时：${sc.errorChecks.join("；")}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  return `## 相关使用场景（第一版做完的标准）\n\n${scenarios.map(one).join("\n\n")}\n\n`;
}

/** The context file handed to a dispatched agent: the task, then the node guide. */
export function buildNodeContext(
  canvas: Canvas,
  nodeId: string,
  task: string,
  memories: Memory[] = [],
  project?: { name: string; description?: string; stack?: string; webApp?: boolean; scenarios?: Scenario[] },
  roles: Capability[] = [],
): string {
  const roleId = canvas.nodes.find((n) => n.id === nodeId)?.role;
  const role = roles.find((r) => r.id === roleId && r.kind === "agent");
  if (roleId && !role) throw new Error(`角色“${roleId}”还没有保存，请先保存或取消分配`);
  const roleSection = role ? `## 角色：${role.description}\n\n${role.body}\n\n` : "";
  const guide = buildNodeGuide(canvas, nodeId, memories);
  const about = [
    project?.description?.trim(),
    project?.stack?.trim() && `技术栈：${project.stack.trim()}`,
    project?.webApp && `这是本地网页应用，Agent Together 按下面的约定启动它、在应用里预览：
${RUN_CONVENTIONS}`,
  ].filter(Boolean);
  const projectSection = project && about.length ? `## 项目：${project.name}\n\n${about.join("\n\n")}\n\n` : "";
  return `# 任务\n\n${task.trim() || "（未填写，请按节点的任务清单推进）"}\n\n${projectSection}${roleSection}${scenarioSection(project?.scenarios ?? [])}${guide}`;
}

/**
 * Rough token count without a tokenizer: CJK characters count about one token
 * each, other text about four characters per token. Good enough to compare.
 */
export function estimateTokens(text: string): number {
  const cjk = text.match(/[　-鿿＀-￯]/g)?.length ?? 0;
  return Math.ceil(cjk + (text.length - cjk) / 4);
}

/** Splits a context file at its headings, with a token estimate per section. */
export function contextSections(markdown: string): { title: string; tokens: number }[] {
  return markdown
    .split(/^(?=#{1,2} )/m)
    .filter((part) => part.trim())
    .map((part) => ({ title: part.split("\n")[0].replace(/^#+\s*/, ""), tokens: estimateTokens(part) }));
}
