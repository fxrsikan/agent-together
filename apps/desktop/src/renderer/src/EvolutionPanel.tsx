import { useEffect, useState } from "react";
import type { EvolutionReport, Experience } from "@agent-together/core";
import { when } from "./time";
import { verifierKey, verifierLabel } from "./verifier";

const AGENT_NAMES: Record<string, string> = { "claude-code": "Claude Code", codex: "Codex", cursor: "Cursor", "grok-build": "Grok Build" };

const OUTCOME: Record<string, string> = {
  clean: "守边界完成",
  escalated: "守边界上报（剩下的失败属于别的卡片）",
  failed: "自己的测试没过",
  crossed: "越界或被观察者拦下",
};

type Contestant = NonNullable<EvolutionReport["race"]>["contestants"][number];

function penalty(contestant: Contestant): number {
  return contestant.findings.reduce((sum, finding) => {
    if (finding.level === "ask" || finding.level === "block") return sum - 15;
    if (finding.level === "warn") return sum - 5;
    return sum;
  }, 0);
}

function lines(contestant: Contestant): number {
  return contestant.files.reduce((sum, file) => sum + file.added + file.removed, 0);
}

/** Compare strategies for a node and review or approve the resulting experience. */
export function EvolutionPanel({
  nodeId,
  task,
  version,
  onChange,
}: {
  nodeId: string;
  task: string;
  version: number;
  onChange: (message: string) => void;
}) {
  const [reportId, setReportId] = useState("");
  const [reports, setReports] = useState<EvolutionReport[]>([]);
  const [suggestions, setSuggestions] = useState<Experience[]>([]);
  const [agents, setAgents] = useState<string[]>([]);
  const [agent, setAgent] = useState("");
  const [busy, setBusy] = useState(false);
  const [candidate, setCandidate] = useState(false);
  /** This card's evolution memories and the project's model per assistant, to warn when they no longer match. */
  const [proven, setProven] = useState<string[]>([]);
  const [models, setModels] = useState<Record<string, string>>({});
  const refresh = async () => {
    const [data, memories, chosen] = await Promise.all([
      window.agentTogether.evolutions(agent || undefined),
      window.agentTogether.memories(),
      window.agentTogether.projectModels(),
    ]);
    setProven(memories.filter((m) => m.nodeId === nodeId && m.status === "active" && m.verifiedWith).map((m) => m.verifiedWith!));
    setModels(chosen);
    setReports(data.reports.filter((r) => r.nodeId === nodeId));
    setSuggestions(data.suggestions);
    setAgents(data.agents);
    setAgent((a) => a || data.agents[0] || "");
    setCandidate((data.candidate[nodeId] ?? 0) >= 2);
    setBusy(!!data.running);
  };
  useEffect(() => {
    refresh();
  }, [nodeId, version, agent]);
  const act = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
    } catch (e) {
      onChange(String(e));
    } finally {
      await refresh();
    }
  };
  const latest = reports.find((r) => r.id === reportId) ?? reports[0];
  const rank = (id: string) => {
    const i = latest?.ranking?.indexOf(id) ?? -1;
    return i < 0 ? 99 : i;
  };
  return (
    <section>
      <h4>进化</h4>
      {candidate && <p>这张卡片已经连续两次没通过测试，可以试试换个做法。</p>}
      {(() => {
        const now = agent ? verifierKey(agent, models[agent]) : "";
        const stale = proven.filter((k) => k !== now);
        if (!now || !stale.length) return null;
        return (
          <p className="finding finding-warn">
            这张卡片有 {stale.length} 条经验是用 {[...new Set(stale)].map(verifierLabel).join("、")} 验证的，现在用的是{" "}
            {verifierLabel(now)}，交给 AI 时默认不带上。可以用现在的模型再进化一次，确认它们还有效。
          </p>
        );
      })()}
      <p className="muted">
        同一个助手分别试两到三种做法，再和原来的方式比。会运行多次，可能产生费用。
      </p>
      <select value={agent} onChange={(e) => setAgent(e.target.value)}>
        {agents.map((a) => (
          <option key={a} value={a}>{AGENT_NAMES[a] ?? a}</option>
        ))}
      </select>
      <button
        disabled={busy || !agent}
        onClick={() =>
          act(async () => {
            const r = await window.agentTogether.evolve(nodeId, task, agent);
            setReportId(r.id);
            onChange(r.message ?? "比较完成");
          })
        }
      >
        {busy ? "比较中…" : "进化"}
      </button>
      {reports.length > 1 && (
        <select value={latest?.id ?? ""} onChange={(e) => setReportId(e.target.value)}>
          {reports.map((r) => (
            <option value={r.id} key={r.id}>
              {when(r.startedAt)} · {r.approved ? "已同意" : "未同意"}
            </option>
          ))}
        </select>
      )}
      {latest && (
        <>
          <p>{latest.message}</p>
          {latest.verifiedWith && <p className="muted">这次用的是 {verifierLabel(latest.verifiedWith)}</p>}
          {[...(latest.race?.contestants ?? [])]
            .sort((a, b) => rank(a.id) - rank(b.id))
            .map((c) => {
              const strategy = latest.strategies.find((s) => s.id === c.id);
              return (
                <div className="contestant" key={c.id}>
                  <strong>{strategy?.title ?? "原来的方式"}</strong>
                  {strategy && <p>{strategy.text}</p>}
                  <p>
                    {latest.outcomes?.[c.id] ? OUTCOME[latest.outcomes[c.id]] + " · " : ""}
                    {c.tests ? (c.tests.passed ? "测试通过" : "测试失败") : "没有配置测试"} ·{" "}
                    {c.score.total} 分 ·{" "}
                    {c.run.costUsd === undefined ? "费用未提供" : `$${c.run.costUsd.toFixed(3)}`} ·{" "}
                    {Math.round(c.run.durationMs / 1000)} 秒{" "}
                    {latest.winner === c.id ? "· 有效" : ""}
                  </p>
                  <p>
                    观察提醒扣分：{penalty(c)} · 改动 {lines(c)} 行
                  </p>
                  <ul>
                    {c.score.parts.map((p, i) => (
                      <li key={i}>
                        {p.label}：{p.points > 0 ? "+" : ""}
                        {p.points}
                      </li>
                    ))}
                  </ul>
                  <details>
                    <summary>测试输出</summary>
                    <pre>{c.tests?.output}</pre>
                  </details>
                </div>
              );
            })}
          {latest.approved && <p>已同意，以后交给 AI 时会带上这条经验。</p>}
          {latest.winner && !latest.approved && !latest.discarded && (
            <>
              <button
                disabled={busy}
                onClick={() =>
                  act(async () => {
                    await window.agentTogether.approveEvolution(latest.id, false);
                    onChange("已记住这个做法");
                  })
                }
              >
                同意
              </button>
              <button
                disabled={busy}
                onClick={() =>
                  act(async () => {
                    await window.agentTogether.approveEvolution(latest.id, true);
                    onChange("已记住做法并采用代码，采用前已存检查点");
                  })
                }
              >
                同意并采用代码
              </button>
            </>
          )}
          {latest.race && !latest.discarded && !latest.race.adopted && (
            <button
              disabled={busy}
              onClick={() => act(() => window.agentTogether.discardEvolution(latest.id))}
            >
              清理这次尝试
            </button>
          )}
          {reports.length > 1 && (
            <details>
              <summary>以前的进化记录</summary>
              {reports.slice(1).map((r) => (
                <p key={r.id}>
                  {when(r.startedAt)} · {r.message} · {r.approved ? "已同意" : "未同意"}
                </p>
              ))}
            </details>
          )}
        </>
      )}
      {suggestions.map((s) => (
        <div key={s.id}>
          <p>
            别的项目用过的做法：{s.title}（在 {s.projects.length} 个项目有效
            {s.verifiedWith?.length ? `，用 ${s.verifiedWith.map(verifierLabel).join("、")} 验证` : ""}）
          </p>
          <p>{s.text}</p>
          <button
            disabled={busy}
            onClick={() =>
              act(async () => {
                await window.agentTogether.approveExperience(s.id, nodeId);
                onChange("已把这条经验加入当前卡片");
              })
            }
          >
            同意用于这张卡片
          </button>
        </div>
      ))}
    </section>
  );
}
