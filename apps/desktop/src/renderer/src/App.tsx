import { useEffect, useMemo, useState } from "react";
import { Background, Controls, MarkerType, ReactFlow, type Edge } from "@xyflow/react";
import { strongest, type Canvas, type Level, type LoomEvent } from "@loom/schema";
import type { EventRecord } from "../../preload";
import { CheckpointsPanel } from "./CheckpointsPanel";
import { NodeCard, type NodeCardType } from "./NodeCard";

const nodeTypes = { card: NodeCard };
const FEED_LIMIT = 100;

function describe(event: LoomEvent): string {
  if (event.kind === "turn.end") return "一轮结束";
  const a = event.action;
  const what = a.type === "write" ? `写 ${a.path}` : a.type === "read" ? `读 ${a.path}` : a.type === "shell" ? `$ ${a.command}` : a.tool;
  if (event.kind === "tool.after") return `${event.ok ? "完成" : "失败"} ${what}`;
  return what;
}

export function App() {
  const [info, setInfo] = useState<{ root: string; port: number; hasGit: boolean } | null>(null);
  const [version, setVersion] = useState(0); // bumped when files may have changed under us
  const [canvas, setCanvas] = useState<Canvas | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [feed, setFeed] = useState<EventRecord[]>([]);
  const [notice, setNotice] = useState("");
  const [task, setTask] = useState("");

  useEffect(() => {
    window.loom.info().then((i) => {
      setInfo(i);
      setActiveId(i.activeNodeId);
    });
    const offEvent = window.loom.onEvent((r) => {
      setFeed((f) => [r, ...f].slice(0, FEED_LIMIT));
      // An agent turn may have changed files or checkpoints: refresh what depends on them.
      if (r.event.kind === "turn.end") setVersion((v) => v + 1);
    });
    const offActive = window.loom.onActive(setActiveId);
    return () => {
      offEvent();
      offActive();
    };
  }, []);

  useEffect(() => {
    window.loom.canvas().then(setCanvas);
  }, [version]);

  const changed = (message: string) => {
    setNotice(message);
    setVersion((v) => v + 1);
  };

  // A node's light shows the strongest finding about it in the recent feed.
  const signals = useMemo(() => {
    const byNode = new Map<string, Level>();
    for (const { verdict } of feed) {
      for (const f of verdict.findings) {
        if (f.nodeId) byNode.set(f.nodeId, strongest([f, { ...f, level: byNode.get(f.nodeId) ?? "off" }]));
      }
    }
    return byNode;
  }, [feed]);

  const nodes: NodeCardType[] = useMemo(
    () =>
      (canvas?.nodes ?? []).map((node, i) => ({
        id: node.id,
        type: "card",
        position: node.position ?? { x: i * 300, y: 0 },
        data: { node, active: node.id === activeId, signal: signals.get(node.id) ?? "off" },
      })),
    [canvas, activeId, signals],
  );

  const edges: Edge[] = useMemo(
    () =>
      (canvas?.edges ?? []).map((e) => ({
        id: `${e.from}->${e.to}`,
        source: e.from,
        target: e.to,
        label: e.label,
        markerEnd: { type: MarkerType.ArrowClosed },
      })),
    [canvas],
  );

  const selected = canvas?.nodes.find((n) => n.id === selectedId) ?? null;

  const install = async () => setNotice(`已写入 ${await window.loom.installHooks()}`);

  const dispatch = async (nodeId: string) => {
    try {
      const file = await window.loom.dispatch(nodeId, task);
      changed(`已存检查点并在新窗口启动 Claude Code，上下文：${file}`);
      setTask("");
    } catch (err) {
      setNotice(`派发失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <div className="app">
      <header className="bar">
        <strong>Loom</strong>
        <span className="muted">{info ? `${info.root} · 守护进程 127.0.0.1:${info.port}` : "启动中…"}</span>
        <span className="spacer" />
        <span className="muted">当前节点：{canvas?.nodes.find((n) => n.id === activeId)?.title ?? "无"}</span>
        <button onClick={install}>安装 Claude Code hooks</button>
      </header>
      {notice && <div className="notice">{notice}</div>}
      <main className="body">
        <div className="canvas">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodeClick={(_e, n) => setSelectedId(n.id)}
            onPaneClick={() => setSelectedId(null)}
            fitView
          >
            <Background />
            <Controls />
          </ReactFlow>
        </div>
        <aside className="side">
          {selected ? (
            <section>
              <h3>{selected.title}</h3>
              <p>{selected.intent.goal || "未写目标"}</p>
              {selected.intent.acceptance.length > 0 && (
                <>
                  <h4>验收标准</h4>
                  <ul>{selected.intent.acceptance.map((a) => <li key={a}>{a}</li>)}</ul>
                </>
              )}
              {selected.intent.tasks.length > 0 && (
                <>
                  <h4>任务</h4>
                  <ul>{selected.intent.tasks.map((t) => <li key={t}>{t}</li>)}</ul>
                </>
              )}
              <h4>派发任务</h4>
              <textarea
                className="task"
                rows={3}
                placeholder="这次要做什么（留空则按任务清单推进）"
                value={task}
                onChange={(e) => setTask(e.target.value)}
              />
              <div className="actions">
                <button className="primary" onClick={() => dispatch(selected.id)}>
                  派发给 Claude Code
                </button>
                {selected.id === activeId ? (
                  <button onClick={() => window.loom.setActive(null)}>取消当前节点</button>
                ) : (
                  <button onClick={() => window.loom.setActive(selected.id)}>设为当前节点</button>
                )}
              </div>
            </section>
          ) : (
            <p className="muted">点击节点查看意图；设为当前节点后，观察者按它的范围检查 agent。</p>
          )}
          {info?.hasGit ? (
            <CheckpointsPanel version={version} onChange={changed} />
          ) : (
            <p className="muted">项目不在 git 仓库中，检查点不可用。</p>
          )}
          <h4>观察者事件</h4>
          {feed.length === 0 && <p className="muted">暂无事件。安装 hooks 后在本项目里运行 Claude Code。</p>}
          <ol className="feed">
            {feed.map(({ event, verdict }, i) => (
              <li key={feed.length - i}>
                <div className="feed-line">
                  <span className="muted">{event.at.slice(11, 19)}</span> {describe(event)}
                </div>
                {verdict.findings.map((f) => (
                  <div key={f.rule} className={`finding finding-${f.level}`}>
                    [{f.level}] {f.message}
                  </div>
                ))}
              </li>
            ))}
          </ol>
        </aside>
      </main>
    </div>
  );
}
