import { useEffect, useState } from "react";
import type { RaceReport } from "../../preload";

const AGENT_NAMES: Record<string, string> = { "claude-code": "Claude Code", codex: "Codex", cursor: "Cursor", "grok-build": "Grok Build" };

function seconds(ms: number) {
  return `${Math.round(ms / 1000)}s`;
}

/**
 * Race the node's task between Claude Code and Codex, then compare the score
 * breakdowns side by side and adopt one (or discard all). Reports survive restarts.
 */
export function RacePanel({
  nodeId,
  task,
  context,
  version,
  onChange,
}: {
  nodeId: string;
  task: string;
  /** The inspector's context text, when open; otherwise the generated one is used. */
  context?: string;
  version: number;
  onChange: (notice: string) => void;
}) {
  const [reports, setReports] = useState<RaceReport[]>([]);
  const [running, setRunning] = useState<string | null>(null);
  const [agents, setAgents] = useState<string[]>([]);
  const [progress, setProgress] = useState<string[]>([]);

  const refresh = () =>
    window.agentTogether.races().then((r) => {
      setReports(r.reports);
      setRunning(r.running);
      setAgents(r.agents);
    });

  useEffect(() => {
    refresh();
  }, [version]);

  useEffect(() => window.agentTogether.onRaceProgress((m) => setProgress((p) => [...p, m])), []);

  const start = async () => {
    setProgress([]);
    setRunning(nodeId);
    try {
      const report = await window.agentTogether.race(nodeId, task, context);
      const best = [...report.contestants].sort((a, b) => b.score.total - a.score.total)[0];
      onChange(`赛马结束，${AGENT_NAMES[best.id] ?? best.id} 得分最高（${best.score.total}），确认后点"采用"`);
    } catch (err) {
      onChange(`赛马失败：${err instanceof Error ? err.message : String(err)}`);
    }
    refresh();
  };

  const adopt = async (report: RaceReport, contestantId: string) => {
    if (await window.agentTogether.adoptRace(report.id, contestantId))
      onChange(`已采用 ${AGENT_NAMES[contestantId] ?? contestantId} 的改动，采用前的状态存成了检查点`);
  };

  const discard = async (report: RaceReport) => {
    await window.agentTogether.discardRace(report.id);
    onChange("已放弃这场赛马，worktree 已清理");
  };

  const mine = reports.filter((r) => r.nodeId === nodeId);
  const latest = mine[0];
  const open = latest && !latest.adopted && !latest.discarded;

  return (
    <section>
      <div className="row">
        <h4>赛马</h4>
        <button onClick={start} disabled={running !== null || !!open} title={open ? "先采用或放弃上一场" : undefined}>
          {running === nodeId ? "进行中…" : agents.map((a) => AGENT_NAMES[a] ?? a).join(" vs ")}
        </button>
      </div>
      {running === nodeId && (
        <ol className="feed">
          <li className="muted">每个 agent 在各自的 worktree 里跑同一个任务，可能要几分钟。</li>
          {progress.map((m, i) => (
            <li key={i}>{m}</li>
          ))}
        </ol>
      )}
      {running && running !== nodeId && <p className="muted">节点 {running} 正在赛马。</p>}
      {!latest && running !== nodeId && <p className="muted">用上面的任务描述，同一起点让每个参赛 agent 各做一遍，按测试和观察者打分。</p>}
      {latest && (
        <>
          <p className="muted">
            {latest.startedAt.slice(11, 19)} · {latest.task || "按任务清单推进"}
            {latest.adopted ? ` · 已采用 ${AGENT_NAMES[latest.adopted] ?? latest.adopted}` : latest.discarded ? " · 已放弃" : ""}
          </p>
          <div className="race">
            {[...latest.contestants]
              .sort((a, b) => b.score.total - a.score.total)
              .map((c, i) => (
                <div key={c.id} className={`contestant${latest.adopted === c.id ? " contestant-adopted" : ""}`}>
                  <div className="row">
                    <strong>{AGENT_NAMES[c.id] ?? c.id}</strong>
                    <span className={`score${i === 0 ? " score-best" : ""}`}>{c.score.total}</span>
                  </div>
                  <div className="muted">
                    {seconds(c.run.durationMs)}
                    {c.run.costUsd !== undefined ? ` · $${c.run.costUsd.toFixed(3)}` : ""}
                    {c.run.outputTokens !== undefined ? ` · ${c.run.outputTokens} 输出 token` : ""}
                  </div>
                  <ul className="parts">
                    {c.score.parts.map((p, j) => (
                      <li key={j} className={p.points > 0 ? "plus" : "minus"}>
                        {p.points > 0 ? "+" : ""}
                        {p.points} {p.label}
                      </li>
                    ))}
                  </ul>
                  {c.files.map((f) => (
                    <div key={f.path} className="file">
                      {f.path} <span className="plus">+{f.added}</span> <span className="minus">-{f.removed}</span>
                    </div>
                  ))}
                  {c.findings.map((f, j) => (
                    <div key={j} className={`finding finding-${f.level}`}>
                      [{f.level}] {f.message}
                    </div>
                  ))}
                  {c.run.summary && <p className="summary">{c.run.summary.slice(0, 300)}</p>}
                  {open && (
                    <button className={i === 0 ? "primary" : ""} onClick={() => adopt(latest, c.id)}>
                      采用
                    </button>
                  )}
                </div>
              ))}
          </div>
          {open && <button onClick={() => discard(latest)}>都不要，清理</button>}
        </>
      )}
    </section>
  );
}
