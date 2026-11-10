import { useEffect, useMemo, useRef, useState } from "react";
import {
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  BackgroundVariant,
  MarkerType,
  ReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type NodeChange,
  type ReactFlowInstance,
} from "@xyflow/react";
import { ranNoTests, strongest, type AgentEvent, type Canvas, type Capability, type Level } from "@agent-together/schema";
import type { CompileReport } from "@agent-together/core";
import type { Agent, EventRecord, Judgment, SessionInfo, TestHistory } from "../../preload";
import { AgentRun, TestBadge, type RunView, auditSummary } from "./AgentRun";
import { CheckpointsPanel } from "./CheckpointsPanel";
import { ContextInspector } from "./ContextInspector";
import { MemoryPanel } from "./MemoryPanel";
import { NodeCard, type NodeCardType } from "./NodeCard";
import { CanvasToolbar, FocusPanel } from "./CanvasChrome";
import { edgeId, reachFrom, type ReachDirection } from "./reach";
import { ThemeToggle } from "./theme";
import { NodeEditor } from "./NodeEditor";
import { CardEvidence } from "./CardEvidence";
import { ProjectSettings } from "./ProjectSettings";
import { ModelSettings } from "./ModelSettings";
import { ImportChecklist } from "./ImportChecklist";
import { HelperModelSettings } from "./HelperModelSettings";
import { EvolutionPanel } from "./EvolutionPanel";
import { RoleDraft } from "./RoleDraft";
import { RacePanel } from "./RacePanel";
import { clock } from "./time";
import { errorText } from "./errors";
import { RequirementsPanel } from "./RequirementsPanel";
import { ProductPanel } from "./ProductPanel";
import { EnginePanel } from "./EnginePanel";
import { AcceptancePanel } from "./AcceptancePanel";

const nodeTypes = { card: NodeCard };
const FEED_LIMIT = 100;
const AGENT_NAMES: Record<Agent, string> = { "claude-code": "Claude Code", codex: "Codex", cursor: "Cursor", "grok-build": "Grok Build" };

/** A path as the user knows it: relative to the project when it is inside it. */
function shortPath(file: string, root: string): string {
  const f = file.replace(/\\/g, "/");
  const r = root.replace(/\\/g, "/").replace(/\/$/, "");
  return f.toLowerCase().startsWith(r.toLowerCase() + "/") ? f.slice(r.length + 1) : file;
}

/** A shell command with the project folder written as "." (agents often cd into it first). */
function shortCommand(command: string, root: string): string {
  const variants = [root, root.replace(/\\/g, "/")];
  let out = command;
  for (const v of variants) out = out.split(`"${v}"`).join(".").split(v).join(".");
  return out.replace(/^cd \. && /, "");
}

function describe(event: AgentEvent, root: string): string {
  if (event.kind === "turn.end") return "一轮结束";
  const a = event.action;
  const what = a.type === "write" ? `写 ${shortPath(a.path, root)}` : a.type === "read" ? `读 ${shortPath(a.path, root)}` : a.type === "shell" ? `$ ${shortCommand(a.command, root)}` : a.tool;
  if (event.kind === "tool.after") return `${event.ok ? "完成" : "失败"} ${what}`;
  return what;
}

const message = errorText;

/** An empty canvas: plan it from the product description with AI, or start drawing by hand. */
function EmptyCanvas({ onAdd, onChange, onRoles }: { onRoles: (roles: Capability[], canvas: Canvas) => void; onAdd: () => void; onChange: (notice: string) => void }) {
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    window.agentTogether.projectInfo().then((p) => setDescription(p.description ?? ""));
  }, []);

  const plan = async () => {
    setBusy(true);
    setError("");
    try {
      const { canvas, stack, roles } = await window.agentTogether.planCanvas(description);
      onRoles(roles, canvas);
      const { suggestions } = await window.agentTogether.evolutions();
      onChange(`AI 规划了 ${canvas.nodes.length} 张卡片（${stack}）。逐个检查目标、验收标准和文件范围，改好再交给 AI。${suggestions.length ? ` 有 ${suggestions.length} 条在别的项目用过的经验，选中卡片后可在“进化”里查看，同意后才会加入记忆。` : ""}`);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="empty-canvas">
      <h3>画布是空的</h3>
      <p>建议先在左边的「需求与反馈」里说说你想做什么。AI 会追问几个问题，整理成需求说明和使用场景，你确认后再按需求生成画布，每张卡片都知道自己负责哪些场景。</p>
      <p className="muted">也可以跳过需求，直接用一段描述让 AI 拆成卡片：</p>
      <textarea
        className="task"
        rows={6}
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="例如：一个命令行待办清单，可以添加、完成、删除、列出待办，数据存在本地 JSON 文件里。"
      />
      {error && <div className="finding finding-block">{error}</div>}
      <div className="actions">
        <button disabled={busy || !description.trim()} onClick={plan}>
          {busy ? "生成中…（约半分钟）" : "跳过需求，直接生成画布"}
        </button>
        <button onClick={onAdd} disabled={busy}>
          手动添加卡片
        </button>
      </div>
    </div>
  );
}

/** One open project: the editable canvas on the left, the selected node and the observers on the right. */
export function Workspace({ info, onClose }: { info: SessionInfo; onClose: () => void }) {
  const [roles, setRoles] = useState<Capability[]>([]);
  const [drafts, setDrafts] = useState<Capability[]>([]);
  /** Per draft, the id the plan assigned to nodes ("" for one-sentence drafts); the user may rename the draft before saving. */
  const plannedIds = useRef<string[]>([]);
  const [proposedCanvas, setProposedCanvas] = useState<Canvas | null>(null);
  const [sentence, setSentence] = useState("");
  const [roleBusy, setRoleBusy] = useState(false);
  const [judgments, setJudgments] = useState<Judgment[]>([]);
  const [version, setVersion] = useState(0); // bumped when files may have changed under us
  const [canvas, setCanvas] = useState<Canvas | null>(null);
  const [flowNodes, setFlowNodes] = useState<NodeCardType[]>([]);
  const [activeId, setActiveId] = useState<string | null>(info.activeNodeId);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** Following the selected card's links one way; null shows the whole canvas as usual. */
  const [reachDir, setReachDir] = useState<ReachDirection | null>(null);
  useEffect(() => setReachDir(null), [selectedId]);
  const reach = useMemo(() => {
    const links = canvas?.edges ?? [];
    if (!selectedId) return null;
    return { deps: reachFrom(selectedId, links, "deps"), dependents: reachFrom(selectedId, links, "dependents") };
  }, [canvas, selectedId]);
  const shownReach = reach && reachDir ? reach[reachDir] : null;
  const [feed, setFeed] = useState<EventRecord[]>([]);
  const [notice, setNotice] = useState("");
  const [task, setTask] = useState("");
  const [agent, setAgent] = useState<Agent>("claude-code");
  const [models, setModels] = useState<Record<string, string>>({});
  /** Cards whose description was written from code that changed since: id -> changed files. */
  const [stale, setStale] = useState<Record<string, string[]>>({});
  const [mode, setMode] = useState<"app" | "terminal">("app");
  const [runView, setRunView] = useState<RunView | null>(null);
  const [testRuns, setTestRuns] = useState<TestHistory>({ byNode: {} });
  const [testing, setTesting] = useState(false);
  /** The requirements panel on the left; open until the first version is confirmed and planned. */
  const [showReq, setShowReq] = useState(false);
  /** Roles, settings, checkpoints, observer events: shown on request once the project has confirmed requirements. */
  const [tech, setTech] = useState(true);
  /** The middle of the window: the product being built, or the canvas. The product once it knows how to start. */
  const [centerTab, setCenterTab] = useState<"product" | "canvas">("canvas");
  useEffect(() => {
    window.agentTogether.productState().then((p) => p.config && setCenterTab("product"));
  }, []);
  /** Scenario id → name, to show which scenarios a card serves. */
  const [scenarioNames, setScenarioNames] = useState<Record<string, string>>({});
  useEffect(() => {
    window.agentTogether.specState().then((st) => {
      setShowReq(!st.confirmed || st.cards === 0 || st.spec?.status !== "confirmed");
      // Projects made the requirements-first way see the run, not the machinery; others keep everything in view.
      if (st.confirmed) setTech(false);
    });
  }, []);
  /** What the project is busy with; the other actions wait until it is done. */
  const [busy, setBusy] = useState<string | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [contextText, setContextText] = useState("");
  const flow = useRef<ReactFlowInstance<NodeCardType, Edge> | null>(null);
  // With the inspector open, its text (possibly edited) is what gets handed out.
  const context = inspecting ? contextText : undefined;

  useEffect(() => {
    // History from the log first; live events arrive on top of it.
    window.agentTogether.recentLog().then(({ events, judgments: past }) => {
      setFeed((live) => [...live, ...events].slice(0, FEED_LIMIT));
      setJudgments((live) => [...live, ...past].slice(0, FEED_LIMIT));
    });
    const offs = [
      window.agentTogether.onEvent((r) => {
        setFeed((f) => [r, ...f].slice(0, FEED_LIMIT));
        // An agent turn may have changed files or checkpoints: refresh what depends on them.
        if (r.event.kind === "turn.end") setVersion((v) => v + 1);
      }),
      window.agentTogether.onActive(setActiveId),
      window.agentTogether.onBusy(setBusy),
      window.agentTogether.onMemoryDrafts((drafts) => {
        setNotice(`有 ${drafts.length} 条记忆草稿待审批，点开对应卡片查看`);
        setVersion((v) => v + 1);
      }),
      window.agentTogether.onJudgment((j) => setJudgments((js) => [j, ...js].slice(0, FEED_LIMIT))),
      window.agentTogether.onL2Error((e) => setNotice(`事后智能判断没能运行：${e}`)),
      window.agentTogether.onCanvasChanged(() => setVersion((v) => v + 1)),
      window.agentTogether.onAgentText(({ text }) => setRunView((r) => (r ? { ...r, lines: [...r.lines, text].slice(-200) } : r))),
      window.agentTogether.onAgentStatus(({ state }) => setRunView((r) => (r && state !== "idle" ? { ...r, state } : r))),
      window.agentTogether.onTests(() => setVersion((v) => v + 1)),
    ];
    return () => offs.forEach((off) => off());
  }, []);

  useEffect(() => {
    window.agentTogether.canvas().then(setCanvas);
    window.agentTogether.specState().then((st) => setScenarioNames(Object.fromEntries((st.spec?.scenarios ?? []).map((x) => [x.id, x.name]))));
    window.agentTogether.busy().then(setBusy);
    window.agentTogether.roles().then(setRoles);
    window.agentTogether.testHistory().then(setTestRuns);
    window.agentTogether.staleCards().then(setStale);
    window.agentTogether.projectModels().then(setModels);
  }, [version]);

  const changed = (text: string) => {
    setNotice(text);
    setVersion((v) => v + 1);
  };
  const attempt = async (work: () => Promise<unknown>) => {
    try {
      await work();
    } catch (err) {
      setNotice(message(err));
    }
  };

  // A node's light shows the strongest finding about it in the recent feed; an L2 "off track" counts as warn.
  const signals = useMemo(() => {
    const byNode = new Map<string, Level>();
    const raise = (nodeId: string, level: Level) =>
      byNode.set(nodeId, strongest([{ rule: "", message: "", level }, { rule: "", message: "", level: byNode.get(nodeId) ?? "off" }]));
    for (const { verdict } of feed) for (const f of verdict.findings) if (f.nodeId) raise(f.nodeId, f.level);
    for (const j of judgments) if (!j.onTrack) raise(j.nodeId, "warn");
    return byNode;
  }, [feed, judgments]);

  // React Flow owns positions while dragging; the canvas on disk is the source of everything else.
  useEffect(() => {
    setFlowNodes(
      (canvas?.nodes ?? []).map((node, i) => ({
        id: node.id,
        type: "card",
        position: node.position ?? { x: (i % 4) * 300, y: Math.floor(i / 4) * 180 },
        selected: node.id === selectedId,
        data: {
          node,
          active: node.id === activeId,
          signal: signals.get(node.id) ?? "off",
          tests: testRuns.byNode[node.id],
          evolutionCandidate: (testRuns.consecutiveFailures?.[node.id] ?? 0) >= 2,
          stale: !!stale[node.id],
          reach: shownReach?.nodes.has(node.id) ? reachDir! : undefined,
          dim: !!shownReach && node.id !== selectedId && !shownReach.nodes.has(node.id),
        },
      })),
    );
  }, [canvas, activeId, signals, selectedId, testRuns, shownReach, reachDir, stale]);

  // Edges too: React Flow keeps selection here, so a clicked edge can be deleted with the Delete key.
  const [edges, setEdges] = useState<Edge[]>([]);
  useEffect(() => {
    setEdges(
      (canvas?.edges ?? []).map((e) => {
        // On the followed chain: the direction's colour; off it, faded; otherwise quiet neutral.
        const on = shownReach?.edges.has(edgeId(e));
        // Counted imports ("3 处引用", from opening existing code) only matter next to the card you look at;
        // shown everywhere they pile up. Labels someone wrote always show.
        const counted = !!e.label && /^\d+ 处引用$/.test(e.label);
        const near = e.from === selectedId || e.to === selectedId;
        const stroke = on ? (reachDir === "deps" ? "var(--deps)" : "var(--dependents)") : "var(--edge)";
        return {
          id: edgeId(e),
          source: e.from,
          target: e.to,
          label: counted && !near ? undefined : e.label,
          style: { stroke, strokeWidth: on ? 2 : 1.4, opacity: shownReach && !on ? 0.15 : 1 },
          labelStyle: { fill: on ? stroke : "var(--muted)" },
          labelBgStyle: { fill: "var(--panel)", stroke: "var(--line)" },
          labelBgPadding: [6, 3] as [number, number],
          labelBgBorderRadius: 999,
          markerEnd: { type: MarkerType.ArrowClosed, color: stroke, width: 16, height: 16 },
        };
      }),
    );
  }, [canvas, shownReach, reachDir, selectedId]);

  const selected = canvas?.nodes.find((n) => n.id === selectedId) ?? null;

  const addNode = () =>
    attempt(async () => {
      const box = document.querySelector(".canvas")?.getBoundingClientRect();
      const center = box && flow.current ? flow.current.screenToFlowPosition({ x: box.left + box.width / 2, y: box.top + box.height / 2 }) : { x: 0, y: 0 };
      const node = await window.agentTogether.addNode("新卡片", "module", { x: Math.round(center.x - 110), y: Math.round(center.y - 50) });
      setSelectedId(node.id);
      changed("已添加卡片：在右边填写名字、目标、验收标准和它拥有的文件；从卡片右侧的圆点拖到另一张卡片，表示它依赖那张卡片。");
    });

  const connect = (c: Connection) =>
    attempt(async () => {
      if (!canvas || !c.source || !c.target) return;
      await window.agentTogether.saveEdges([...canvas.edges, { from: c.source, to: c.target }]);
    });

  const deleteEdges = (gone: Edge[]) =>
    attempt(async () => {
      if (!canvas) return;
      const ids = new Set(gone.map((e) => e.id));
      await window.agentTogether.saveEdges(canvas.edges.filter((e) => !ids.has(`${e.from}->${e.to}`)));
      setNotice(`已删除 ${gone.length} 条连线`);
    });

  const saveRole = (draft: Capability, index: number) => attempt(async () => {
    const saved = await window.agentTogether.saveRole(draft);
    for (const proposed of proposedCanvas?.nodes ?? []) {
      const node = canvas?.nodes.find((n) => n.id === proposed.id);
      if (node && proposed.role && proposed.role === plannedIds.current[index]) {
        await window.agentTogether.saveNode({ ...node, role: saved.id });
      }
    }
    plannedIds.current.splice(index, 1);
    setDrafts((items) => items.filter((_, i) => i !== index));
    changed(`已保存角色「${saved.id}」，把它拖到画布上就能用`);
  });

  const install = async () =>
    setNotice(`已写入 ${(await window.agentTogether.installHooks()).join("、")}。Codex 需要在项目里运行 codex，并在它的 /hooks 菜单里信任后才生效；Cursor 需要信任该工作区。`);

  const describeReport = (r: CompileReport) =>
    r.errors.length
      ? `${r.id} 未编译：${r.errors.join("；")}`
      : r.kind === "observer"
        ? `${r.id} → 由 Agent Together 观察者对所有 AI 助手执行`
        : `${r.id} → ${Object.values(r.written).flat().join("、")}` + (r.warnings.length ? `（提醒：${r.warnings.join("；")}）` : "");

  const exportCapability = async (nodeId: string) =>
    setNotice(`已保存为可复用技能说明并编译：${describeReport(await window.agentTogether.exportCapability(nodeId))}`);

  const compileAll = async () => {
    const reports = await window.agentTogether.compileCapabilities();
    setNotice(reports.length ? reports.map(describeReport).join(" · ") : "还没有可复用技能说明（.agent-together/capabilities/ 为空）");
  };

  const dispatch = (nodeId: string, taskText = task) =>
    attempt(async () => {
      setNotice(""); // an earlier notice ("已分配角色…") no longer describes what is happening
      if (mode === "terminal") {
        const file = await window.agentTogether.dispatch(nodeId, taskText, agent, context);
        changed(`已存检查点并在新窗口启动 ${AGENT_NAMES[agent]}，上下文：${file}`);
        setTask("");
        return;
      }
      setRunView({ nodeId, agent: AGENT_NAMES[agent], state: "running", lines: [] });
      setTask("");
      try {
        const outcome = await window.agentTogether.runAgent(nodeId, taskText, agent, context);
        // CLIs that do not stream (Grok Build) still show their summary.
        setRunView((r) => {
          const lines = r?.lines.length ? r.lines : [outcome.run.summary];
          return { nodeId, agent: AGENT_NAMES[agent], state: "done", outcome, lines };
        });
        setVersion((v) => v + 1);
      } catch (err) {
        setRunView((r) => (r ? { ...r, state: "done", error: message(err) } : r));
      }
    });

  const markDone = (nodeId: string) =>
    attempt(async () => {
      const node = canvas?.nodes.find((n) => n.id === nodeId);
      if (!node) return;
      await window.agentTogether.saveNode({ ...node, status: "done" });
      if (activeId === nodeId) await window.agentTogether.setActive(null);
      setRunView(null);
      changed(`"${node.title}"已完成`);
    });

  /** The card an agent is working on right now, if any. */
  const runningNode = runView && (runView.state === "running" || runView.state === "testing") ? runView.nodeId : null;

  const runTests = () =>
    attempt(async () => {
      setTesting(true);
      try {
        const { tests, checkpoint, audit } = await window.agentTogether.runTests(selectedId);
        const found = auditSummary(audit);
        const said = !tests
          ? "项目没有测试命令：在项目设置里填写"
          : tests.passed && ranNoTests(tests)
            ? `测试命令跑了，但一个测试都没有（${tests.command}），不能证明代码是对的`
            : `${tests.passed ? "测试通过" : "测试失败"}（${tests.command}）${checkpoint ? "，已存检查点" : ""}`;
        changed(said + (found ? `。${found}` : ""));
      } finally {
        setTesting(false);
      }
    });

  return (
    <div className="app">
      <header className="bar">
        <button onClick={onClose} title="关闭项目，回到项目列表">
          ← 项目
        </button>
        <strong title={info.root}>{info.name}</strong>
        <span className="muted path one-line" title={info.root}>{info.root}</span>
        <span className="spacer" />
        <TestBadge run={testRuns.last} />
        {busy && <span className="badge badge-warn" title="这件事做完之前，其他会改动项目的操作要等一等">正在{busy}</span>}
        <button onClick={runTests} disabled={testing || !!busy || runView?.state === "running"}>
          {testing ? "测试中…" : "运行测试"}
        </button>
        <span className="muted" title={`AI 做完后，另用一个模型复查改动有没有偏离卡片${info.l2 ? `（${info.l2}）` : ""}`}>复查：{info.l2 ? "开" : "关"}</span>
        <span className="muted">当前卡片：{canvas?.nodes.find((n) => n.id === activeId)?.title ?? "无"}</span>
        <button className={showReq ? "on" : ""} onClick={() => setShowReq((v) => !v)} title="需求说明、使用场景和决定记录">
          需求
        </button>
        <button onClick={addNode}>＋ 卡片</button>
        <button onClick={compileAll} title="把角色和技能说明写成各家 AI 助手认识的格式">更新 AI 说明</button>
        <button onClick={install} title="重新给各家 AI 助手装上观察者，让它们的动作被看到">重新接上观察者</button>
        <ThemeToggle />
      </header>
      {notice && (
        <div className="notice row">
          <span className="grow">{notice}</span>
          <button className="link" onClick={() => setNotice("")}>
            ×
          </button>
        </div>
      )}
      <main className="body">
        {showReq && (
          <RequirementsPanel
            version={version}
            canvas={canvas}
            onChange={changed}
            onRoles={(items, plan) => {
              plannedIds.current = items.map((r) => r.id);
              setDrafts(items);
              setProposedCanvas(plan);
            }}
            onClose={() => setShowReq(false)}
          />
        )}
        <div className="center">
        <div className="center-tabs">
          <button className={centerTab === "product" ? "on" : ""} onClick={() => setCenterTab("product")} title="正在做的产品，可以直接操作">
            产品预览
          </button>
          <button className={centerTab === "canvas" ? "on" : ""} onClick={() => setCenterTab("canvas")} title="开发卡片、依赖和归属">
            画布
          </button>
        </div>
        <ProductPanel visible={centerTab === "product"} version={version} onChange={changed} />
        <div className="canvas" style={centerTab === "canvas" ? undefined : { display: "none" }} onDragOver={(e) => e.preventDefault()} onDrop={(e) => {
          e.preventDefault();
          const role = roles.find((r) => r.id === e.dataTransfer.getData("application/agent-together-role"));
          if (!role) return;
          const target = (e.target as HTMLElement).closest(".react-flow__node")?.getAttribute("data-id");
          attempt(async () => {
            const existing = canvas?.nodes.find((n) => n.id === target);
            const position = flow.current?.screenToFlowPosition({ x: e.clientX, y: e.clientY }) ?? { x: 0, y: 0 };
            // A new step is named after the role (a short id); its goal starts as the role's description.
            const node = existing ?? await window.agentTogether.addNode(role.id, "flow", position);
            await window.agentTogether.saveNode({ ...node, role: role.id, ...(existing ? {} : { intent: { ...node.intent, goal: role.description } }) });
            changed(existing
              ? `「${existing.title}」交给角色「${role.id}」来做`
              : `已添加一步「${role.id}」，请填好它的目标和文件范围`);
          });
        }}>
          {canvas && canvas.nodes.length === 0 ? (
            <EmptyCanvas onAdd={addNode} onChange={changed} onRoles={(items, plan) => { plannedIds.current = items.map((r) => r.id); setDrafts(items); setProposedCanvas(plan); }} />
          ) : (
            <ReactFlow
              nodes={flowNodes}
              edges={edges}
              nodeTypes={nodeTypes}
              onInit={(instance) => (flow.current = instance)}
              onNodesChange={(changes: NodeChange<NodeCardType>[]) => setFlowNodes((ns) => applyNodeChanges(changes, ns))}
              onEdgesChange={(changes: EdgeChange<Edge>[]) => setEdges((es) => applyEdgeChanges(changes, es))}
              onNodeDragStop={(_e, _node, dragged) =>
                attempt(() => window.agentTogether.moveNodes(dragged.map((n) => ({ id: n.id, x: n.position.x, y: n.position.y }))))
              }
              onConnect={connect}
              // Delete or Backspace removes edges only; nodes go through the editor's button (with a confirmation).
              deleteKeyCode={["Delete", "Backspace"]}
              onBeforeDelete={async ({ edges: gone }) => ({ nodes: [], edges: gone })}
              onEdgesDelete={deleteEdges}
              onNodeClick={(_e, n) => setSelectedId(n.id)}
              onPaneClick={() => setSelectedId(null)}
              fitView
            >
              <Background variant={BackgroundVariant.Dots} gap={18} size={1.3} color="var(--dot)" />
              <CanvasToolbar nodes={canvas?.nodes ?? []} onPick={setSelectedId} />
            </ReactFlow>
          )}
          {selected && reach && (
            <FocusPanel
              node={selected}
              deps={reach.deps}
              dependents={reach.dependents}
              direction={reachDir}
              onDirection={setReachDir}
              onClose={() => setSelectedId(null)}
            />
          )}
        </div>
        </div>
        <aside className="side">
          <EnginePanel version={version} onChange={changed} />
          <AcceptancePanel
            version={version}
            onChange={changed}
            onOpenPreview={() => {
              setCenterTab("product");
              void window.agentTogether.productState().then((p) => (p.status.state === "running" ? null : window.agentTogether.productStart().catch(() => null)));
            }}
          />
          <button className="link small tech-toggle" onClick={() => setTech((v) => !v)}>
            {tech ? "收起技术详情" : "显示技术详情（角色、设置、检查点、观察者事件）"}
          </button>
          <ImportChecklist version={version} onChange={changed} />
          {tech && (
          <section>
            <h4>专职角色</h4>
            <p className="muted">把角色拖到空白处添加一步，拖到卡片上交给它来做。草稿同意后才会保存。</p>
            {roles.map((role) => (
              <div
                key={role.id}
                draggable
                onDragStart={(e) => e.dataTransfer.setData("application/agent-together-role", role.id)}
                className="role-chip"
                title="拖到画布空白处添加一步，拖到卡片上交给它来做"
              >
                <strong>{role.id}</strong>
                <span>{role.description}</span>
              </div>
            ))}
            <textarea className="task" value={sentence} onChange={(e) => setSentence(e.target.value)} placeholder="例如：做一个只写测试、不改业务代码的测试员" />
            <button disabled={roleBusy || !sentence.trim()} onClick={() => attempt(async () => {
              setRoleBusy(true);
              try {
                const draft = await window.agentTogether.draftRole(sentence);
                plannedIds.current.push("");
                setDrafts((items) => [...items, draft]);
                setSentence("");
              } finally {
                setRoleBusy(false);
              }
            })}>{roleBusy ? "正在写角色说明…" : "AI 帮我写角色"}</button>
            {drafts.map((draft, index) => (
              <RoleDraft
                key={index}
                draft={draft}
                onEdit={(updated) => {
                  setDrafts((items) => items.map((r, i) => i === index ? updated : r));
                  if (updated.id !== draft.id) {
                    setProposedCanvas((plan) => plan && ({
                      ...plan,
                      nodes: plan.nodes.map((n) => n.role === draft.id ? { ...n, role: updated.id } : n),
                    }));
                  }
                }}
                onSave={() => saveRole(draft, index)}
                onDiscard={() => {
                  plannedIds.current.splice(index, 1);
                  setDrafts((items) => items.filter((_, i) => i !== index));
                }}
              />
            ))}
          </section>
          )}
          {selected ? (
            <>
              <NodeEditor node={selected} onChange={changed} />
              {selected.scenarios?.length ? (
                <p className="muted small">
                  负责的使用场景：{selected.scenarios.map((id) => `${id}${scenarioNames[id] ? ` ${scenarioNames[id]}` : ""}`).join("；")}
                </p>
              ) : null}
              <CardEvidence node={selected} stale={stale[selected.id] ?? []} onChange={changed} />
              <section>
                <h4>交给 AI 去做</h4>
                <textarea
                  className="task"
                  rows={3}
                  placeholder="这次要做什么（留空则按任务清单推进）"
                  value={task}
                  onChange={(e) => setTask(e.target.value)}
                />
                <div className="actions">
                  <select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)} title="在应用里运行：AI 助手在后台工作，输出显示在这里，做完自动跑测试">
                    <option value="app">在应用里运行</option>
                    <option value="terminal">在终端窗口打开</option>
                  </select>
                  <select value={agent} onChange={(e) => setAgent(e.target.value as Agent)}>
                    {(Object.keys(AGENT_NAMES) as Agent[]).map((a) => (
                      <option key={a} value={a}>
                        {AGENT_NAMES[a]}
                      </option>
                    ))}
                  </select>
                  <span className="muted" title="在下方「用哪个模型」里修改">模型：{models[agent] || "默认"}</span>
                  <button className="primary" onClick={() => dispatch(selected.id)} disabled={!!busy || runView?.state === "running" || runView?.state === "testing"} title={busy ? `正在${busy}，等它结束` : undefined}>
                    交给 AI 去做
                  </button>
                  {/* While an agent runs, its card stays the current one: the observer judges against it. */}
                  {selected.id === activeId ? (
                    <button onClick={() => attempt(() => window.agentTogether.setActive(null))} disabled={!!runningNode} title={runningNode ? "AI 做完之前不能换当前卡片" : undefined}>
                      取消当前卡片
                    </button>
                  ) : (
                    <button onClick={() => attempt(() => window.agentTogether.setActive(selected.id))} disabled={!!runningNode} title={runningNode ? "AI 做完之前不能换当前卡片" : undefined}>
                      设为当前卡片
                    </button>
                  )}
                  <button onClick={() => setInspecting((v) => !v)}>{inspecting ? "收起上下文" : "检查上下文"}</button>
                  <button onClick={() => exportCapability(selected.id)}>导出为可复用技能说明</button>
                </div>
                {inspecting && <ContextInspector nodeId={selected.id} task={task} agent={agent} version={version} onContext={setContextText} />}
              </section>
              {runView && runView.nodeId === selected.id && (
                <AgentRun
                  view={runView}
                  titles={Object.fromEntries((canvas?.nodes ?? []).map((n) => [n.id, n.title]))}
                  hasGit={info.hasGit}
                  onStop={() => window.agentTogether.stopAgent()}
                  onDone={() => markDone(selected.id)}
                  onRetry={(nodeId, retryTask) => {
                    setSelectedId(nodeId);
                    dispatch(nodeId, retryTask);
                  }}
                />
              )}
              {info.hasGit && <EvolutionPanel nodeId={selected.id} task={task} version={version} projectBusy={busy} onChange={changed} />}
              {info.hasGit && <RacePanel nodeId={selected.id} task={task} context={context} version={version} projectBusy={busy} onChange={changed} />}
              <MemoryPanel nodeId={selected.id} version={version} onChange={changed} />
            </>
          ) : (
            <>
              <p className="muted">
                点卡片查看和编辑；拖动卡片调整位置；从卡片右侧圆点拖到另一张卡片表示依赖，选中连线按 Delete 删除。设为当前卡片后，观察者按它的范围检查 AI 助手。
              </p>
              {runView && (runView.state === "running" || runView.state === "testing") && (
                <p className="finding finding-warn">
                  {runView.agent} 正在处理"{canvas?.nodes.find((n) => n.id === runView.nodeId)?.title}"，点那张卡片查看进度。
                </p>
              )}
              {tech && (
                <>
                  <ProjectSettings version={version} onChange={changed} />
                  <ModelSettings version={version} onChange={changed} />
                  <HelperModelSettings onChange={changed} />
                  <MemoryPanel nodeId={null} version={version} onChange={changed} />
                </>
              )}
            </>
          )}
          {tech && (
          <>
          {info.hasGit ? <CheckpointsPanel version={version} busy={busy} onChange={changed} /> : <p className="muted">项目不在 git 仓库中，检查点和赛马不可用。</p>}
          {judgments.length > 0 && (
            <>
              <h4>事后智能判断</h4>
              <ol className="feed">
                {judgments.slice(0, 5).map((j) => (
                  <li key={j.at + j.nodeId}>
                    <span className="muted">{clock(j.at)}</span>{" "}
                    <span className={j.onTrack ? "" : "finding-warn"}>{j.onTrack ? "没有偏离" : "可能偏离"}</span>：{j.reason}
                  </li>
                ))}
              </ol>
            </>
          )}
          <h4>观察者事件</h4>
          {feed.length === 0 && <p className="muted">暂无事件。交给 AI 去做之后，它的每个动作都会出现在这里。</p>}
          <ol className="feed">
            {feed.map(({ event, verdict }, i) => (
              <li key={feed.length - i}>
                <div className="feed-line">
                  <span className="muted">{clock(event.at)}</span> {describe(event, info.root)}
                </div>
                {verdict.findings.map((f) => (
                  <div key={f.rule} className={`finding finding-${f.level}`}>
                    [{f.level}] {f.message}
                  </div>
                ))}
              </li>
            ))}
          </ol>
          </>
          )}
        </aside>
      </main>
    </div>
  );
}
