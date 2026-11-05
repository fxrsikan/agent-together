import { useState } from "react";
import { MiniMap, useReactFlow, useViewport } from "@xyflow/react";
import type { CanvasNode } from "@agent-together/schema";
import { KIND } from "./NodeCard";
import { findCards, type Reach, type ReachDirection } from "./reach";

const KIND_COLOR: Record<CanvasNode["kind"], string> = {
  feature: "var(--kind-feature)",
  module: "var(--kind-module)",
  decision: "var(--kind-decision)",
  flow: "var(--kind-flow)",
};

/**
 * The small floating toolbar at the bottom of the canvas: find a card by name or
 * file, show the overview map, fit everything in view, zoom. Lives inside
 * <ReactFlow> so it can move the camera.
 */
export function CanvasToolbar({ nodes, onPick }: { nodes: CanvasNode[]; onPick: (id: string) => void }) {
  const flow = useReactFlow();
  const { zoom } = useViewport();
  const [query, setQuery] = useState("");
  const [hot, setHot] = useState(0);
  const [map, setMap] = useState(false);
  const found = findCards(nodes, query).slice(0, 8);

  const pick = (id: string) => {
    onPick(id);
    setQuery("");
    flow.fitView({ nodes: [{ id }], duration: 200, maxZoom: 1.2 });
  };

  return (
    <>
      {map && (
        <MiniMap
          pannable
          zoomable
          position="bottom-right"
          nodeColor={(n) => KIND_COLOR[(n.data as { node?: CanvasNode }).node?.kind ?? "module"]}
          nodeStrokeWidth={0}
          maskColor="color-mix(in srgb, var(--canvas) 70%, transparent)"
        />
      )}
      <div className="canvas-toolbar" role="toolbar" aria-label="画布工具">
        <div className="finder">
          <input
            value={query}
            placeholder="找卡片：名字或文件"
            aria-label="找卡片"
            onChange={(e) => {
              setQuery(e.target.value);
              setHot(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") setHot((h) => Math.min(h + 1, found.length - 1));
              else if (e.key === "ArrowUp") setHot((h) => Math.max(h - 1, 0));
              else if (e.key === "Enter" && found[hot]) pick(found[hot].id);
              else if (e.key === "Escape") setQuery("");
            }}
          />
          {found.length > 0 && (
            <ul role="listbox">
              {found.map((n, i) => (
                <li key={n.id} role="option" aria-selected={i === hot} className={i === hot ? "hot" : ""} onMouseDown={() => pick(n.id)}>
                  {n.title} <span className="mono">{n.files[0] ?? n.id}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <span className="sep" />
        <button className={map ? "on" : ""} onClick={() => setMap((m) => !m)} title="显示整张画布的缩略图">
          总览
        </button>
        <button onClick={() => flow.fitView({ duration: 200 })} title="让所有卡片都在窗口里">
          适合窗口
        </button>
        <span className="sep" />
        <button onClick={() => flow.zoomOut({ duration: 150 })} aria-label="缩小">
          −
        </button>
        <span className="zoom">{Math.round(zoom * 100)}%</span>
        <button onClick={() => flow.zoomIn({ duration: 150 })} aria-label="放大">
          +
        </button>
      </div>
    </>
  );
}

/**
 * The selected card, floating on the canvas: what it is, and how far its links
 * reach. "它依赖的" follows its links forward, "依赖它的" backward; the chain stays
 * strong on the canvas while the rest fades. Counts come from the drawn links only.
 */
export function FocusPanel({
  node,
  deps,
  dependents,
  direction,
  onDirection,
  onClose,
}: {
  node: CanvasNode;
  deps: Reach;
  dependents: Reach;
  direction: ReachDirection | null;
  onDirection: (d: ReachDirection | null) => void;
  onClose: () => void;
}) {
  const shown = direction === "deps" ? deps : direction === "dependents" ? dependents : null;
  return (
    <div className="focus-panel" data-kind={node.kind} role="region" aria-label={`卡片：${node.title}`}>
      <div className="row">
        <span className="focus-label">{KIND[node.kind]}</span>
        <button className="link" onClick={onClose} aria-label="取消选中">
          ×
        </button>
      </div>
      <h5>{node.title}</h5>
      {node.intent.goal && <span className="muted small">{node.intent.goal}</span>}
      <div className="reach-buttons">
        <button
          className={direction === "deps" ? "on-deps" : ""}
          disabled={!deps.nodes.size}
          onClick={() => onDirection(direction === "deps" ? null : "deps")}
          title="顺着连线，看这张卡片用到了哪些卡片"
        >
          它依赖的 <b>{deps.nodes.size}</b>
        </button>
        <button
          className={direction === "dependents" ? "on-dependents" : ""}
          disabled={!dependents.nodes.size}
          onClick={() => onDirection(direction === "dependents" ? null : "dependents")}
          title="逆着连线，看哪些卡片用到了这张卡片"
        >
          依赖它的 <b>{dependents.nodes.size}</b>
        </button>
      </div>
      <span className="receipt">
        {shown
          ? `${shown.nodes.size} 张卡片 · ${shown.edges.size} 条连线 · 最远 ${shown.hops} 步（按画布上的连线算）`
          : "点上面的按钮，看这张卡片和别的卡片怎么连着。"}
      </span>
    </div>
  );
}
