import { useEffect, useRef } from "react";
import type { AgentRunOutcome, TestRun } from "../../preload";
import { clock } from "./time";

export type RunView = {
  nodeId: string;
  agent: string;
  state: "running" | "testing" | "done";
  lines: string[];
  outcome?: AgentRunOutcome;
  error?: string;
};

export function TestBadge({ run }: { run: TestRun | null | undefined }) {
  if (!run) return null;
  const counts = run.pass !== undefined ? ` ${run.pass}/${run.pass + (run.fail ?? 0)}` : "";
  return (
    <span className={`badge ${run.passed ? "badge-good" : "badge-bad"}`} title={`${run.command} · ${clock(run.at)}`}>
      {run.passed ? "测试通过" : "测试失败"}
      {counts}
    </span>
  );
}

/** One line for a notice: what the after-run check found, or "" when nothing. */
export function auditSummary(audit: AgentRunOutcome["audit"] | undefined): string {
  if (!audit?.findings.length) return "";
  const missed = audit.findings.filter((f) => !f.seenLive).length;
  return `事后检查发现 ${audit.findings.length} 个问题${missed ? `，其中 ${missed} 个是观察者当场没看到的（多半是用命令行改的）` : ""}`;
}

/**
 * Every change since dispatch, checked again after the run, however it was made.
 * A finding the observer never saw live means a write slipped past the hooks.
 */
export function AuditNotice({ audit }: { audit: AgentRunOutcome["audit"] | undefined }) {
  if (!audit?.findings.length) return null;
  const strong = audit.findings.some((f) => f.level === "ask" || f.level === "block");
  return (
    <div className={`finding ${strong ? "finding-block" : "finding-warn"}`}>
      <strong>{auditSummary(audit)}</strong>
      <ul>
        {audit.findings.map((f, i) => (
          <li key={i}>
            {f.path}：{f.message}
            {f.seenLive ? "" : "（当场没拦到）"}
          </li>
        ))}
      </ul>
      {strong && <p className="small">先看一下这些改动再标记完成；不想要可以在"检查点"里回到交给 AI 之前。</p>}
    </div>
  );
}

/**
 * An agent working in the app: what it says as it goes, then its summary and the
 * project's test result, with the next step (mark the node done, or hand the
 * failure back to the agent).
 */
export function AgentRun({
  view,
  titles,
  onStop,
  onDone,
  onRetry,
}: {
  view: RunView;
  /** Node id → title, to name the node a failing test belongs to. */
  titles: Record<string, string>;
  onStop: () => void;
  onDone: () => void;
  /** Hand a failure to a node: this one, or the one that owns the failing test. */
  onRetry: (nodeId: string, task: string) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.scrollTo({ top: box.current.scrollHeight });
  }, [view.lines.length]);

  const { run, tests, checkpoint, audit } = view.outcome ?? {};
  const failureTask = tests && !tests.passed ? `项目测试没有通过（${tests.command}），请修复。测试输出的最后部分：\n\n${tests.output.slice(-1500)}` : "";
  // A change here can break a test another node owns; that node is the one to fix it.
  const owners = (tests?.failingNodes ?? []).filter((id) => id !== view.nodeId && titles[id]);
  const ownTestsFail = !tests?.failingNodes?.length || tests.failingNodes.includes(view.nodeId);

  return (
    <section className="agent-run">
      <div className="row">
        <h4>
          {view.agent} ·{" "}
          {view.state === "running" ? "正在工作…" : view.state === "testing" ? "正在跑测试…" : run?.ok ? "完成" : "没有正常结束"}
        </h4>
        {view.state === "running" && <button onClick={onStop}>停止</button>}
      </div>
      <div className="agent-lines" ref={box}>
        {view.lines.length === 0 && view.state === "running" && <p className="muted">AI 助手已启动，它的每个动作会出现在下面的"观察者事件"里。</p>}
        {view.lines.map((line, i) => (
          <p key={i}>{line}</p>
        ))}
      </div>
      {view.error && <div className="finding finding-block">{view.error}</div>}
      {run && (
        <p className="muted small">
          {Math.round(run.durationMs / 1000)}s{run.costUsd !== undefined ? ` · $${run.costUsd.toFixed(3)}` : ""}
          {run.outputTokens !== undefined ? ` · ${run.outputTokens} 输出 token` : ""}
        </p>
      )}
      {view.state === "done" && view.outcome && (
        <>
          <AuditNotice audit={audit} />
          {tests ? (
            <div className="row">
              <TestBadge run={tests} />
              <span className="muted small grow">{checkpoint ? "已存检查点" : tests.passed ? "" : "失败的输出见下方"}</span>
            </div>
          ) : (
            <p className="muted small">项目没有测试命令，没跑测试。在"项目设置"里填一个。</p>
          )}
          {tests && !tests.passed && owners.length > 0 && (
            <p className="muted small">失败的测试在 {owners.map((id) => `"${titles[id]}"`).join("、")} 负责的文件里，本卡片改不了它们。</p>
          )}
          {tests && !tests.passed && <pre className="test-output">{tests.output.slice(-1200)}</pre>}
          <div className="actions">
            {tests?.passed && (
              <button className="primary" onClick={onDone}>
                标记为完成
              </button>
            )}
            {failureTask && ownTestsFail && (
              <button className="primary" onClick={() => onRetry(view.nodeId, failureTask)}>
                把失败交回给 AI 助手
              </button>
            )}
            {failureTask &&
              owners.map((id) => (
                <button
                  key={id}
                  className="primary"
                  onClick={() =>
                    onRetry(id, `${failureTask}\n\n（这些失败可能来自"${titles[view.nodeId] ?? view.nodeId}"卡片刚做的改动，请按它的新行为更新你负责的测试或代码。）`)
                  }
                >
                  交给"{titles[id]}"修复
                </button>
              ))}
          </div>
        </>
      )}
    </section>
  );
}
