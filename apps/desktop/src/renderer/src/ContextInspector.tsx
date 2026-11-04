import { useEffect, useState } from "react";
import type { Memory } from "@agent-together/schema";

const KIND_LABEL: Record<Memory["kind"], string> = { decision: "决策", constraint: "约束", pitfall: "踩过的坑", preference: "偏好" };

type Measure = { tokens: number; sections: { title: string; tokens: number }[] };

/**
 * What the next dispatch or race will hand the agent: the generated context
 * file with a size per section, memories that can be left out this time, and
 * the full text to edit by hand. Reports the text in use through `onContext`.
 */
export function ContextInspector({
  nodeId,
  task,
  version,
  onContext,
}: {
  nodeId: string;
  task: string;
  version: number;
  onContext: (markdown: string) => void;
}) {
  const [generated, setGenerated] = useState("");
  const [memories, setMemories] = useState<Memory[]>([]);
  const [without, setWithout] = useState<string[]>([]);
  const [edited, setEdited] = useState<string | null>(null);
  const [measure, setMeasure] = useState<Measure | null>(null);

  useEffect(() => {
    setWithout([]);
    setEdited(null);
  }, [nodeId]);

  useEffect(() => {
    window.agentTogether.previewContext(nodeId, task, without).then((p) => {
      setGenerated(p.markdown);
      setMemories(p.memories);
    });
  }, [nodeId, task, without, version]);

  const text = edited ?? generated;

  useEffect(() => {
    onContext(text);
    window.agentTogether.measureContext(text).then(setMeasure);
  }, [text]);

  const toggle = (id: string) => setWithout((w) => (w.includes(id) ? w.filter((x) => x !== id) : [...w, id]));
  const largest = Math.max(1, ...(measure?.sections.map((s) => s.tokens) ?? []));

  return (
    <div className="inspector">
      <div className="row">
        <strong>约 {measure?.tokens ?? "…"} token</strong>
        <span className="muted">{edited !== null ? "已手动修改" : "自动生成"}</span>
      </div>
      <ul className="sections">
        {measure?.sections.map((s) => (
          <li key={s.title}>
            <span className="section-title">{s.title}</span>
            <span className="bar" style={{ width: `${(s.tokens / largest) * 100}%` }} />
            <span className="muted">{s.tokens}</span>
          </li>
        ))}
      </ul>
      {memories.length > 0 && (
        <>
          <div className="muted">这次带上的记忆</div>
          {memories.map((m) => (
            <label key={m.id} className="check">
              <input type="checkbox" checked={!without.includes(m.id)} onChange={() => toggle(m.id)} disabled={edited !== null} />
              （{KIND_LABEL[m.kind]}）{m.content}
            </label>
          ))}
        </>
      )}
      <textarea className="task context-text" rows={12} value={text} onChange={(e) => setEdited(e.target.value)} />
      {edited !== null && (
        <button onClick={() => setEdited(null)} title="丢掉手动修改，按任务和勾选的记忆重新生成">
          恢复自动生成
        </button>
      )}
    </div>
  );
}
