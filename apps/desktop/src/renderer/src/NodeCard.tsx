import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import type { CanvasNode, Level } from "@agent-together/schema";
import type { TestRun } from "../../preload";
import { TestBadge } from "./AgentRun";
import type { ReachDirection } from "./reach";

export type NodeCardData = {
  node: CanvasNode;
  active: boolean;
  signal: Level;
  tests?: TestRun;
  evolutionCandidate?: boolean;
  /** While following links from a selected card: on the chain (which way), or faded out. */
  reach?: ReachDirection;
  dim?: boolean;
};
export type NodeCardType = Node<NodeCardData, "card">;

export const KIND: Record<CanvasNode["kind"], string> = { feature: "功能", module: "模块", decision: "决策", flow: "流程" };
const STATUS: Record<CanvasNode["status"], string> = { todo: "待办", in_progress: "进行中", done: "✓ 完成", blocked: "! 阻塞" };
const SIGNAL: Record<Level, string> = { off: "顺利", log: "顺利", warn: "有提醒", ask: "被拦了，需要你看一下", block: "被拦了，需要你看一下" };

/**
 * One canvas card. Its kind sets the colour (border, label, focus ring); status and
 * "current card" are labelled chips, so nothing depends on colour alone.
 */
export function NodeCard({ data }: NodeProps<NodeCardType>) {
  const { node, active, signal, tests, reach, dim } = data;
  const classes = ["card", dim ? "card-dim" : "", reach ? `card-reach-${reach}` : ""].filter(Boolean).join(" ");
  return (
    <div className={classes} data-kind={node.kind}>
      <Handle type="target" position={Position.Left} />
      <div className="card-head">
        <span className="card-kind">{KIND[node.kind]}</span>
        <span className={`signal signal-${signal}`} title={`观察者：${SIGNAL[signal]}`} aria-label={`观察者：${SIGNAL[signal]}`} />
      </div>
      {node.role && <div className="tag">角色 · {node.role}</div>}
      <div className="card-title">{node.title}</div>
      <div className="card-meta">
        <span className={`chip chip-${node.status}`}>{STATUS[node.status]}</span>
        {active && <span className="chip chip-active" title="观察者正按这张卡片的范围检查 AI 助手">当前</span>}
        {node.executor && <span className="chip">{node.executor}</span>}
        <TestBadge run={tests} />
      </div>
      {data.evolutionCandidate && <div className="card-hint" title="点开卡片，在“进化”里换个做法">连续两次测试失败，可以试试进化</div>}
      <div className="card-files">{node.files.join("  ") || "未绑定文件"}</div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
