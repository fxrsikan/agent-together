import { useEffect, useState } from "react";
import type { Memory } from "@agent-together/schema";
import { verifierLabel } from "./verifier";

const KIND_LABEL: Record<Memory["kind"], string> = { decision: "决策", constraint: "约束", pitfall: "踩过的坑", preference: "偏好" };

/**
 * Memories of one node (or the whole project when nodeId is null): drafts to
 * approve or reject, active ones to retire, and a box to add one by hand.
 */
export function MemoryPanel({
  nodeId,
  version,
  onChange,
}: {
  nodeId: string | null;
  version: number;
  onChange: (notice: string) => void;
}) {
  const [all, setAll] = useState<Memory[]>([]);
  const [text, setText] = useState("");
  const [kind, setKind] = useState<Memory["kind"]>("decision");

  useEffect(() => {
    window.agentTogether.memories().then(setAll);
  }, [version, nodeId]);

  const mine = all.filter((m) => m.nodeId === nodeId);
  const drafts = mine.filter((m) => m.status === "draft");
  const active = mine.filter((m) => m.status === "active");

  const setStatus = async (m: Memory, status: Memory["status"], verb: string) => {
    await window.agentTogether.setMemoryStatus(m.id, status);
    onChange(`${verb}记忆，CLAUDE.md 已同步`);
  };

  const add = async () => {
    if (!text.trim()) return;
    await window.agentTogether.addMemory(nodeId, kind, text);
    setText("");
    onChange(nodeId ? "已添加记忆，下次把这张卡片交给 AI 时会带上" : "已添加全项目记忆，CLAUDE.md 和 AGENTS.md 已同步");
  };

  return (
    <section>
      <h4>{nodeId ? "卡片记忆" : "全项目记忆"}</h4>
      {drafts.length > 0 && <p className="muted">待审批草稿 {drafts.length} 条（来自观察者）</p>}
      <ol className="feed">
        {drafts.map((m) => (
          <li key={m.id}>
            <div className="draft">{m.content}</div>
            <div className="actions">
              <button className="primary" onClick={() => setStatus(m, "active", "已批准")}>批准</button>
              <button onClick={() => setStatus(m, "rejected", "已拒绝")}>拒绝</button>
            </div>
          </li>
        ))}
        {active.map((m) => (
          <li key={m.id} className="row">
            <span>
              <span className="muted">（{KIND_LABEL[m.kind]}）</span>
              {m.content}
              {m.verifiedWith && <span className="muted"> · 用 {verifierLabel(m.verifiedWith)} 验证</span>}
            </span>
            <button onClick={() => setStatus(m, "expired", "已停用")}>停用</button>
          </li>
        ))}
      </ol>
      {drafts.length === 0 && active.length === 0 && <p className="muted">暂无记忆。</p>}
      <div className="actions">
        <select value={kind} onChange={(e) => setKind(e.target.value as Memory["kind"])}>
          {Object.entries(KIND_LABEL).map(([k, label]) => (
            <option key={k} value={k}>{label}</option>
          ))}
        </select>
        <input className="grow" placeholder="添加一条记忆" value={text} onChange={(e) => setText(e.target.value)} />
        <button onClick={add}>添加</button>
      </div>
    </section>
  );
}
