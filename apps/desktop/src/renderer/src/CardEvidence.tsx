import { useState } from "react";
import type { CanvasNode } from "@agent-together/schema";
import type { ImportProposal } from "../../preload";
import { errorText } from "./errors";
import { ProposalView } from "./ProposalView";

/**
 * Where a card's description came from, when the helper model wrote it from code:
 * the cited lines, what it could not tell, and whether the cited files changed
 * since. A changed card can be re-read on its own; the new proposal is reviewed
 * like the import one before anything is saved.
 */
export function CardEvidence({ node, stale, onChange }: { node: CanvasNode; stale: string[]; onChange: (notice: string) => void }) {
  const [proposal, setProposal] = useState<ImportProposal | null>(null);
  const [busy, setBusy] = useState(false);
  const evidence = node.evidence;
  if (!evidence) return null;

  const act = async (work: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await work();
    } catch (err) {
      onChange(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <h4>说明的出处</h4>
      {stale.length > 0 && (
        <p className="finding finding-warn">
          写这些说明之后，{stale.join("、")} 改过了，说明可能已经过时。
        </p>
      )}
      <p className="muted small">
        {new Date(evidence.at).toLocaleDateString("zh-CN")} 由帮手模型读代码写成
        {evidence.commit ? `，对应提交 ${evidence.commit.slice(0, 8)}` : ""}。
      </p>
      {evidence.sources.length > 0 && (
        <div className="src-list">
          {evidence.sources.map((s, i) => (
            <span key={i} className={`src-chip ${stale.includes(s.path) ? "src-bad" : "src-ok"}`}>
              {s.path}:{s.line}
              {s.end_line && s.end_line !== s.line ? `-${s.end_line}` : ""}
            </span>
          ))}
        </div>
      )}
      {evidence.unknowns.length > 0 && (
        <div className="unknowns">
          <span className="muted">当时从代码看不出来：</span>
          <ul>
            {evidence.unknowns.map((u, i) => (
              <li key={i}>{u}</li>
            ))}
          </ul>
        </div>
      )}
      {!proposal && (
        <div className="actions">
          <button
            className={stale.length ? "primary" : ""}
            disabled={busy}
            onClick={() => act(async () => setProposal(await window.agentTogether.understandProject(node.id)))}
          >
            {busy ? "正在读代码…" : "重新让 AI 读这张卡片"}
          </button>
        </div>
      )}
      {proposal && (
        <ProposalView
          proposal={proposal}
          busy={busy}
          onCancel={() => setProposal(null)}
          onApply={(kept, chosen) =>
            act(async () => {
              await window.agentTogether.applyImportProposal(kept, chosen);
              setProposal(null);
              onChange("已按现在的代码更新这张卡片的说明和出处");
            })
          }
        />
      )}
    </section>
  );
}
