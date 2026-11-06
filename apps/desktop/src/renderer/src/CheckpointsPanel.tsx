import { useEffect, useState } from "react";
import type { Checkpoint } from "@agent-together/core";
import { errorText } from "./errors";
import { clock } from "./time";

const SHOWN = 8;

/** Recent checkpoints with a rollback button each. Rollback asks for confirmation in the main process. */
export function CheckpointsPanel({ version, busy, onChange }: { version: number; busy?: string | null; onChange: (notice: string) => void }) {
  const [list, setList] = useState<Checkpoint[]>([]);

  useEffect(() => {
    window.agentTogether.checkpoints().then(setList);
  }, [version]);

  const save = async () => {
    const cp = await window.agentTogether.checkpoint("手动保存");
    onChange(`已保存检查点 ${cp.id}`);
  };

  const rollback = async (cp: Checkpoint) => {
    try {
      if (await window.agentTogether.rollback(cp.id)) onChange(`已回滚到"${cp.label}"（${clock(cp.at)}），回滚前的状态也存成了检查点`);
    } catch (err) {
      onChange(errorText(err));
    }
  };

  return (
    <section>
      <div className="row">
        <h4>检查点</h4>
        <button onClick={save}>存检查点</button>
      </div>
      {list.length === 0 && <p className="muted">还没有检查点。交给 AI 去做之前会自动保存一个。</p>}
      <ol className="feed">
        {list.slice(0, SHOWN).map((cp) => (
          <li key={cp.id} className="row">
            <span>
              <span className="muted">{clock(cp.at)}</span> {cp.label}
              {cp.nodeId ? <span className="muted"> · {cp.nodeId}</span> : null}
            </span>
            <button onClick={() => rollback(cp)} disabled={!!busy} title={busy ? `正在${busy}，等它结束再回滚` : undefined}>
              回滚到这里
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}
