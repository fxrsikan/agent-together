import { useEffect, useState } from "react";
import type { Checkpoint } from "@agent-together/core";

const SHOWN = 8;

/** Recent checkpoints with a rollback button each. Rollback asks for confirmation in the main process. */
export function CheckpointsPanel({ version, onChange }: { version: number; onChange: (notice: string) => void }) {
  const [list, setList] = useState<Checkpoint[]>([]);

  useEffect(() => {
    window.agentTogether.checkpoints().then(setList);
  }, [version]);

  const save = async () => {
    const cp = await window.agentTogether.checkpoint("手动保存");
    onChange(`已保存检查点 ${cp.id}`);
  };

  const rollback = async (cp: Checkpoint) => {
    if (await window.agentTogether.rollback(cp.id)) onChange(`已回滚到"${cp.label}"（${cp.at.slice(11, 19)}），回滚前的状态也存成了检查点`);
  };

  return (
    <section>
      <div className="row">
        <h4>检查点</h4>
        <button onClick={save}>存检查点</button>
      </div>
      {list.length === 0 && <p className="muted">还没有检查点。派发任务前会自动保存一个。</p>}
      <ol className="feed">
        {list.slice(0, SHOWN).map((cp) => (
          <li key={cp.id} className="row">
            <span>
              <span className="muted">{new Date(cp.at).toLocaleTimeString()}</span> {cp.label}
              {cp.nodeId ? <span className="muted"> · {cp.nodeId}</span> : null}
            </span>
            <button onClick={() => rollback(cp)}>回滚到这里</button>
          </li>
        ))}
      </ol>
    </section>
  );
}
