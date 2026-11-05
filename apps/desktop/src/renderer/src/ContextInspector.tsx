import { useEffect, useState } from "react";
import type { Memory } from "@agent-together/schema";
import type { ContextPreview } from "../../preload";

const KIND_LABEL: Record<Memory["kind"], string> = { decision: "决策", constraint: "约束", pitfall: "踩过的坑", preference: "偏好" };

/** Above this many tokens of memories per dispatch, suggest cleaning up old ones. */
const MEMORY_WARN_TOKENS = 1500;

type Measure = { tokens: number; sections: { title: string; tokens: number }[] };

/**
 * What the next dispatch or race will hand the agent: the generated context
 * file with a size per section, memories that can be left out this time
 * (those proven with another assistant or model start out unticked), what the
 * memories cost, and the full text to edit by hand. Reports the text in use
 * through `onContext`.
 */
export function ContextInspector({
  nodeId,
  task,
  agent,
  version,
  onContext,
}: {
  nodeId: string;
  task: string;
  agent: string;
  version: number;
  onContext: (markdown: string) => void;
}) {
  const [preview, setPreview] = useState<ContextPreview | null>(null);
  /** null: the default choice of memories for this assistant and model. */
  const [without, setWithout] = useState<string[] | null>(null);
  const [edited, setEdited] = useState<string | null>(null);
  const [measure, setMeasure] = useState<Measure | null>(null);

  useEffect(() => {
    setWithout(null);
    setEdited(null);
  }, [nodeId, agent]);

  useEffect(() => {
    window.agentTogether.previewContext(nodeId, task, without, agent).then(setPreview);
  }, [nodeId, task, without, agent, version]);

  const text = edited ?? preview?.markdown ?? "";

  useEffect(() => {
    onContext(text);
    window.agentTogether.measureContext(text).then(setMeasure);
  }, [text]);

  const left = preview?.without ?? [];
  const toggle = (id: string) => setWithout(left.includes(id) ? left.filter((x) => x !== id) : [...left, id]);
  const largest = Math.max(1, ...(measure?.sections.map((s) => s.tokens) ?? []));
  const memoryTotal = (preview?.memoryTokens ?? 0) + (preview?.mirroredTokens ?? 0);

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
            <span className="token-bar" style={{ width: `${(s.tokens / largest) * 100}%` }} />
            <span className="muted">{s.tokens}</span>
          </li>
        ))}
      </ul>
      {preview && (
        <p className={memoryTotal > MEMORY_WARN_TOKENS ? "finding finding-warn" : "muted"}>
          记忆约 {memoryTotal} token：这次带上的 {preview.memoryTokens}
          {preview.mirroredTokens > 0 && `，加上写在 CLAUDE.md / AGENTS.md 里、AI 每次启动都会读的全项目记忆 ${preview.mirroredTokens}`}。
          {memoryTotal > MEMORY_WARN_TOKENS && " 记忆有点多了，可以在「卡片记忆」和「全项目记忆」里把过时的停用。"}
        </p>
      )}
      {preview && preview.memories.length > 0 && (
        <>
          <div className="muted">这次带上的记忆（现在用 {preview.verifier}）</div>
          {preview.memories.map((m) => {
            const proven = preview.labels[m.id];
            const otherModel = proven && proven !== preview.verifier;
            return (
              <label key={m.id} className="check">
                <input type="checkbox" checked={!left.includes(m.id)} onChange={() => toggle(m.id)} disabled={edited !== null} />
                （{KIND_LABEL[m.kind]}）{m.content}
                {proven && (
                  <span className={otherModel ? "finding-warn" : "muted"}>
                    {" "}· 用 {proven} 验证{otherModel ? "，和现在的模型不同，默认不带" : ""}
                  </span>
                )}
              </label>
            );
          })}
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
