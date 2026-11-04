import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import type { CanvasNode, Level } from "@agent-together/schema";
import type { TestRun } from "../../preload";
import { TestBadge } from "./AgentRun";

export type NodeCardData = { node: CanvasNode; active: boolean; signal: Level; tests?: TestRun; evolutionCandidate?: boolean };
export type NodeCardType = Node<NodeCardData, "card">;

const KIND: Record<CanvasNode["kind"], string> = { feature: "功能", module: "模块", decision: "决策", flow: "流程" };
const STATUS: Record<CanvasNode["status"], string> = { todo: "待办", in_progress: "进行中", done: "完成", blocked: "阻塞" };

/** One canvas node: kind, title, status, its last test result, owned files and the observer signal light. */
export function NodeCard({ data }: NodeProps<NodeCardType>) {
  const { node, active, signal, tests } = data;
  return (
    <div className={`card card-${node.status}${active ? " card-active" : ""}`}>
      <Handle type="target" position={Position.Left} />
      <div className="card-head">
        <span className="tag">{KIND[node.kind]}</span>
        <span className={`signal signal-${signal}`} title={`观察者信号：${signal}`} />
      </div>
      {node.role && <div className="tag">角色：{node.role}</div>}
      <div className="card-title">{node.title}</div>
      <div className="card-meta row">
        <span>
          {STATUS[node.status]}
          {node.executor ? ` · ${node.executor}` : ""}
        </span>
        <TestBadge run={tests} />
      </div>
      {data.evolutionCandidate && <div className="card-hint" title="点开卡片，在“进化”里换个做法">连续两次测试失败，可以试试进化</div>}
      <div className="card-files">{node.files.join("  ") || "未绑定文件"}</div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
