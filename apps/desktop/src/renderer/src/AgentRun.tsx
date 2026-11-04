import { useEffect, useRef } from "react";
import type { AgentRunOutcome, TestRun } from "../../preload";

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
    <span className={`badge ${run.passed ? "badge-good" : "badge-bad"}`} title={`${run.command} · ${new Date(run.at).toLocaleTimeString()}`}>
      {run.passed ? "测试通过" : "测试失败"}
      {counts}
    </span>
  );
}

/**
 * An agent working in the app: what it says as it goes, then its summary and the
 * project's test result, with the next step (mark the node done, or hand the
 * failure back to the agent).
 */
export function AgentRun({
  view,
  onStop,
  onDone,
  onRetry,
}: {
  view: RunView;
  onStop: () => void;
  onDone: () => void;
  onRetry: (task: string) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.scrollTo({ top: box.current.scrollHeight });
  }, [view.lines.length]);

  const { run, tests, checkpoint } = view.outcome ?? {};
  const failureTask = tests && !tests.passed ? `项目测试没有通过（${tests.command}），请修复。测试输出的最后部分：\n\n${tests.output.slice(-1500)}` : "";

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
        {view.lines.length === 0 && view.state === "running" && <p className="muted">agent 已启动，它的每个动作会出现在下面的"观察者事件"里。</p>}
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
          {tests ? (
            <div className="row">
              <TestBadge run={tests} />
              <span className="muted small grow">{checkpoint ? "已存检查点" : tests.passed ? "" : "失败的输出见下方"}</span>
            </div>
          ) : (
            <p className="muted small">项目没有测试命令，没跑测试。在"项目设置"里填一个。</p>
          )}
          {tests && !tests.passed && <pre className="test-output">{tests.output.slice(-1200)}</pre>}
          <div className="actions">
            {tests?.passed && (
              <button className="primary" onClick={onDone}>
                标记为完成
              </button>
            )}
            {failureTask && (
              <button className="primary" onClick={() => onRetry(failureTask)}>
                把失败交回给 agent
              </button>
            )}
          </div>
        </>
      )}
    </section>
  );
}
