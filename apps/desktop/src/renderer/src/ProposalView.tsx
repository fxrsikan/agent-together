import { useState } from "react";
import type { CheckedSource, ImportProposal, ProposedItem } from "../../preload";

/** "src/a.py:12-20", for a citation. */
const where = (s: CheckedSource) => `${s.path}:${s.line}${s.end_line && s.end_line !== s.line ? `-${s.end_line}` : ""}`;

/** One citation: where it points, ✓ or why it failed; hovering shows the cited lines. */
function Source({ s }: { s: CheckedSource }) {
  return (
    <span className={`src-chip ${s.ok ? "src-ok" : "src-bad"}`} title={s.ok ? s.excerpt : s.problem}>
      {s.ok ? "✓" : "✗"} {where(s)}
      {!s.ok && <span className="src-problem">：{s.problem}</span>}
    </span>
  );
}

/** A statement with its citations; one without any is marked so. */
function Statement({ item }: { item: ProposedItem }) {
  return (
    <>
      {item.text}
      <span className="src-list">
        {item.sources.length ? item.sources.map((s, i) => <Source key={i} s={s} />) : <span className="src-chip src-bad">没有出处</span>}
      </span>
    </>
  );
}

/**
 * The helper model's proposal for review: per card its name, goal and acceptance
 * criteria, each with the code it cites (checked against the files), plus what the
 * model could not tell. Cards and criteria are ticked to adopt; a criterion whose
 * citations do not check out starts unticked. Nothing is saved until "采用".
 */
export function ProposalView({
  proposal,
  busy,
  onApply,
  onCancel,
}: {
  proposal: ImportProposal;
  busy: boolean;
  onApply: (kept: ImportProposal, chosen: string[]) => void;
  onCancel: () => void;
}) {
  const [chosen, setChosen] = useState<string[]>(proposal.nodes.map((n) => n.id));
  const [kept, setKept] = useState<Record<string, boolean[]>>(() =>
    Object.fromEntries(proposal.nodes.map((n) => [n.id, n.acceptance.map((a) => a.verified)])),
  );
  const toggleCard = (id: string) => setChosen((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]));
  const toggleItem = (id: string, i: number) => setKept((k) => ({ ...k, [id]: k[id].map((v, j) => (j === i ? !v : v)) }));
  const checked = proposal.nodes.flatMap((n) => [n.goal, ...n.acceptance]);
  const good = checked.filter((i) => i.verified).length;

  const apply = () =>
    onApply(
      { ...proposal, nodes: proposal.nodes.map((n) => ({ ...n, acceptance: n.acceptance.filter((_, i) => kept[n.id][i]) })) },
      chosen,
    );

  return (
    <div className="proposal">
      {proposal.description && <p>项目：{proposal.description}</p>}
      {proposal.stack && <p className="muted">技术栈：{proposal.stack}</p>}
      <p className="muted small">
        {good} / {checked.length} 条说明的出处核对通过。把鼠标停在出处上能看到那几行代码；出处不对的验收标准默认不勾选。
      </p>
      {proposal.nodes.map((n) => (
        <div key={n.id} className="proposal-card">
          <label className="check">
            <input type="checkbox" checked={chosen.includes(n.id)} onChange={() => toggleCard(n.id)} />
            <span>
              <strong>{n.title}</strong> <span className="muted">（{n.id}）</span>
            </span>
          </label>
          {chosen.includes(n.id) && (
            <div className="proposal-body">
              <div>
                <span className="muted">目标：</span>
                <Statement item={n.goal} />
              </div>
              {n.acceptance.map((a, i) => (
                <label key={i} className="check">
                  <input type="checkbox" checked={kept[n.id][i]} onChange={() => toggleItem(n.id, i)} />
                  <span>
                    <Statement item={a} />
                  </span>
                </label>
              ))}
              {n.unknowns.length > 0 && (
                <div className="unknowns">
                  <span className="muted">从代码看不出来（交给你判断，不会写进验收标准）：</span>
                  <ul>
                    {n.unknowns.map((u, i) => (
                      <li key={i}>{u}</li>
                    ))}
                  </ul>
                </div>
              )}
              {n.tasks.length > 0 && <span className="muted small">还可以做：{n.tasks.map((t) => t.replace(/[。.；;]+$/, "")).join("；")}</span>}
            </div>
          )}
        </div>
      ))}
      <div className="actions">
        <button className="primary" disabled={busy || !chosen.length} onClick={apply}>
          采用勾选的 {chosen.length} 张
        </button>
        <button disabled={busy} onClick={onCancel}>
          不要
        </button>
      </div>
    </div>
  );
}
