import type { Canvas, CanvasNode, Memory } from "@loom/schema";

const list = (items: string[]) => (items.length ? items.map((i) => `- ${i}`).join("\n") : "- （无）");
const files = (n: CanvasNode) => n.files.map((f) => `\`${f}\``).join("、") || "（未绑定）";
const KIND_LABEL: Record<Memory["kind"], string> = { decision: "决策", constraint: "约束", pitfall: "踩过的坑", preference: "偏好" };

/**
 * Everything an agent should know to work on one node, without a specific task:
 * the node, the interface of its direct neighbours, its approved memories and the
 * rules Loom enforces. Never the whole repository. Used for dispatch and skill export.
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

## Loom 会检查的规则

- 只修改本节点的文件；越界写入会被拦截，需要向用户说明理由。
- 只能通过上面列出的依赖关系引用其他节点的代码。
- 不要靠跳过测试或删除断言让测试通过。
- 同一个命令反复失败时，停下来总结原因，换思路或询问用户。
`;
}

/** The context file handed to a dispatched agent: the task, then the node guide. */
export function buildNodeContext(canvas: Canvas, nodeId: string, task: string, memories: Memory[] = []): string {
  const guide = buildNodeGuide(canvas, nodeId, memories);
  return `# 任务\n\n${task.trim() || "（未填写，请按节点的任务清单推进）"}\n\n${guide}`;
}
