import { useEffect, useState } from "react";
import { WORK_STATUS_LABEL } from "@agent-together/schema";
import type { DecisionOption, RunInfo, RunRecord } from "../../preload";
import { errorText } from "./errors";

/**
 * 制作状态 (phase one, M3): start the version with one click and watch it go card
 * by card: what is done, what runs now (with the assistant's words), what is next,
 * and the decision cards when it needs you. Code, logs and observer events stay
 * in the technical details below.
 */

const AGENT_NAMES: Record<string, string> = { "claude-code": "Claude Code", codex: "Codex", cursor: "Cursor", "grok-build": "Grok Build" };
const STATUS: Record<string, { label: string; tone: string }> = {
  running: { label: "正在制作", tone: "badge-warn" },
  paused: { label: "已暂停", tone: "" },
  waiting: { label: "等你决定", tone: "badge-bad" },
  interrupted: { label: "被中断了", tone: "badge-bad" },
  done: { label: "这一版的卡片做完了", tone: "badge-good" },
  stopped: { label: "已结束", tone: "" },
};
const TASK: Record<string, string> = { todo: "○", doing: "…", done: "✓", skipped: "↷" };
const stepStatus = (s: string | undefined) => (!s ? "" : s === "product-failed" ? "产品启动不了" : (WORK_STATUS_LABEL as Record<string, string>)[s] ?? s);
const money = (n: number) => `$${n.toFixed(n < 1 ? 3 : 2)}`;

export function EnginePanel({ version, onChange }: { version: number; onChange: (notice: string) => void }) {
  const [info, setInfo] = useState<RunInfo | null>(null);
  const [agent, setAgent] = useState("claude-code");
  const [limits, setLimits] = useState<{ maxRepairs: number; maxCalls: number; budgetUsd: number } | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const [busy, setBusy] = useState("");

  const refresh = () =>
    window.agentTogether.runInfo().then((next) => {
      setInfo(next);
      setLimits((l) => l ?? { maxRepairs: next.limits.maxRepairs, maxCalls: next.limits.maxCalls, budgetUsd: next.limits.budgetUsd });
    });
  useEffect(() => {
    void refresh();
  }, [version]);
  useEffect(() => {
    const offs = [
      window.agentTogether.onRunState((run: RunRecord) => {
        setInfo((i) => (i ? { ...i, run, open: ["running", "paused", "waiting", "interrupted"].includes(run.status) } : i));
        if (run.status !== "running") void refresh();
      }),
      window.agentTogether.onEngineText(({ text }) => setLines((l) => [...l, text].slice(-8))),
    ];
    return () => offs.forEach((off) => off());
  }, []);

  if (!info) return null;
  const act = (label: string, work: () => Promise<unknown>, notice?: string) => async () => {
    setBusy(label);
    try {
      await work();
      if (notice) onChange(notice);
    } catch (err) {
      onChange(errorText(err));
    } finally {
      setBusy("");
      void refresh();
    }
  };
  const run = info.run;
  const open = info.open && run;
  const status = run ? STATUS[run.status] : null;
  const done = run ? run.tasks.filter((t) => t.state === "done").length : 0;
  const current = run?.tasks.find((t) => t.state === "doing");

  return (
    <section className="engine">
      <div className="row">
        <h4>制作状态</h4>
        {status && open && <span className={`badge ${status.tone}`}>{status.label}</span>}
      </div>

      {!info.confirmed && <p className="muted">先在左边「需求与反馈」里确认第一版的需求，再开始制作。</p>}

      {open && run && (
        <>
          <p className="small">
            第 {run.version} 版 · {done} / {run.tasks.length} 张卡片完成 · 调用 {run.usage.calls} / {run.limits.maxCalls} 次 · 已知花费 {money(run.usage.costUsd)}
            {run.usage.callsWithoutCost ? `（另有 ${run.usage.callsWithoutCost} 次没报费用）` : ""} / 预算 ${run.limits.budgetUsd}
          </p>
          {/* A decision or an interruption shows its own message below. */}
          {run.status !== "waiting" && run.status !== "interrupted" && <p className="muted small">{run.note}</p>}
        </>
      )}

      {run?.status === "waiting" && run.decision && (
        <div className="decision">
          <strong>{run.decision.question}</strong>
          <p className="small">
            <span className="muted">原因：</span>
            {run.decision.why}
          </p>
          <p className="small">
            <span className="muted">影响：</span>
            {run.decision.impact}
          </p>
          <div className="actions">
            {run.decision.options.map((o) => (
              <button
                key={o.id}
                className={o.id === run.decision!.recommended ? "primary" : ""}
                title={o.id === run.decision!.recommended ? "推荐" : undefined}
                disabled={!!busy}
                onClick={act("decide", () => window.agentTogether.runDecide(o.id as DecisionOption))}
              >
                {o.label}
                {o.id === run.decision!.recommended ? "（推荐）" : ""}
              </button>
            ))}
          </div>
        </div>
      )}

      {run?.status === "interrupted" && (
        <div className="decision">
          <strong>{run.note}</strong>
          <div className="actions">
            <button className="primary" disabled={!!busy} onClick={act("resume", () => window.agentTogether.runResumeInterrupted(), "从中断的那一步重新开始")}>
              继续
            </button>
            <button disabled={!!busy} onClick={act("stop", () => window.agentTogether.runStop(), "已放弃上次的制作，做好的卡片都保留")}>
              放弃
            </button>
          </div>
        </div>
      )}

      {open && run && (
        <ol className="tasks">
          {run.tasks.map((t) => (
            <li key={t.nodeId} className={`task task-${t.state}`}>
              <span className="task-mark">{TASK[t.state]}</span> {t.title}
              {t.attempts > 0 && t.state !== "done" && <span className="muted small"> · 改了 {t.attempts} 次</span>}
              {t.state === "skipped" && <span className="muted small"> · 跳过</span>}
              {t.nodeId === current?.nodeId && run.status === "running" && lines.length > 0 && <pre className="engine-lines">{lines.join("\n").slice(-600)}</pre>}
            </li>
          ))}
        </ol>
      )}

      {open && run && (
        <div className="actions">
          {run.status === "running" && (
            <button disabled={!!busy} onClick={act("pause", () => window.agentTogether.runPause(), "做完当前这一步就暂停")}>
              暂停
            </button>
          )}
          {run.status === "paused" && (
            <button className="primary" disabled={!!busy} onClick={act("resume", () => window.agentTogether.runResume())}>
              继续
            </button>
          )}
          {(run.status === "running" || run.status === "paused" || run.status === "waiting") && (
            <button disabled={!!busy} onClick={act("stop", () => window.agentTogether.runStop(), "已结束这次制作，做好的卡片都保留")}>
              结束
            </button>
          )}
        </div>
      )}

      {!open && info.confirmed && (
        <>
          {run && <p className="muted small">上一次：{run.note}</p>}
          {info.upcoming.length ? (
            <>
              <p className="small">
                第 {info.version} 版还有 {info.upcoming.length} 张卡片，会按这个顺序做：{info.upcoming.map((c) => c.title).join(" → ")}
              </p>
              <div className="row">
                <select value={agent} onChange={(e) => setAgent(e.target.value)} aria-label="用哪个助手">
                  {info.agents.map((a) => (
                    <option key={a} value={a}>
                      {AGENT_NAMES[a] ?? a}
                      {info.models[a] ? `（${info.models[a]}）` : ""}
                    </option>
                  ))}
                </select>
                <button
                  className="primary"
                  disabled={!!busy}
                  onClick={act("start", () => window.agentTogether.runStart(agent, limits ?? undefined), "开始制作：一张一张做，需要你决定时会停下来问")}
                >
                  {busy === "start" ? "开始中…" : "开始制作"}
                </button>
              </div>
              {limits && (
                <details className="small">
                  <summary className="muted">限制（防止停不下来）</summary>
                  <label className="field">
                    <span>每张卡片最多交回去修几次</span>
                    <input type="number" min={0} max={10} value={limits.maxRepairs} onChange={(e) => setLimits({ ...limits, maxRepairs: Number(e.target.value) })} />
                  </label>
                  <label className="field">
                    <span>这次最多调用助手几次</span>
                    <input type="number" min={1} max={500} value={limits.maxCalls} onChange={(e) => setLimits({ ...limits, maxCalls: Number(e.target.value) })} />
                  </label>
                  <label className="field">
                    <span>预算（美元，按助手报告的费用算，到了就停下来问你）</span>
                    <input type="number" min={0.1} step={0.5} value={limits.budgetUsd} onChange={(e) => setLimits({ ...limits, budgetUsd: Number(e.target.value) })} />
                  </label>
                </details>
              )}
            </>
          ) : (
            <p className="muted small">第 {info.version} 版的卡片都做完了。下一步：按使用场景验收（M4）。</p>
          )}
        </>
      )}

      {run && run.steps.length > 0 && (
        <details className="steps small">
          <summary className="muted">每一步的记录（{run.steps.length}）</summary>
          <ol>
            {run.steps.map((s) => (
              <li key={s.id}>
                <span className={`badge ${s.state === "passed" ? "badge-good" : s.state === "running" ? "badge-warn" : "badge-bad"}`}>
                  {s.state === "running" ? "进行中" : s.state === "interrupted" ? "中断" : stepStatus(s.status)}
                </span>{" "}
                {s.title}
                {s.attempt ? `（第 ${s.attempt + 1} 次）` : ""}
                <span className="muted">
                  {s.durationMs ? ` · ${Math.round(s.durationMs / 1000)}s` : ""}
                  {s.costUsd !== undefined ? ` · ${money(s.costUsd)}` : ""}
                  {s.grants.length ? " · 预先授权接线" : ""}
                </span>
                {s.reasons && s.reasons.length > 0 && s.state !== "passed" && (
                  <ul>
                    {s.reasons.map((r, i) => (
                      <li key={i} className="pre">
                        {r}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ol>
        </details>
      )}
    </section>
  );
}
