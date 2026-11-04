import { z } from "zod";
import { CapabilityId } from "./capability.js";

/** Node kinds on the canvas. See design doc: "核心概念：画布与节点". */
export const NodeKind = z.enum(["feature", "module", "decision", "flow"]);

export const NodeStatus = z.enum(["todo", "in_progress", "done", "blocked"]);

/** One node carries five faces: intent, implementation, status, memory, executor. */
export const CanvasNode = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "node id must be a lowercase slug"),
  kind: NodeKind,
  title: z.string().min(1),
  intent: z
    .object({
      goal: z.string(),
      acceptance: z.array(z.string()).default([]),
      tasks: z.array(z.string()).default([]),
    })
    .default({ goal: "", acceptance: [], tasks: [] }),
  /** Globs (relative to project root) of files this node owns. */
  files: z.array(z.string()).default([]),
  status: NodeStatus.default("todo"),
  executor: z.string().optional(),
  /** Saved agent capability used for this step. */
  role: CapabilityId.optional(),
  position: z.object({ x: z.number(), y: z.number() }).optional(),
});
export type CanvasNode = z.infer<typeof CanvasNode>;

/** An edge means "from may depend on to". Imports outside the edges are design drift. */
export const CanvasEdge = z.object({
  from: z.string(),
  to: z.string(),
  label: z.string().optional(),
});
export type CanvasEdge = z.infer<typeof CanvasEdge>;

export const Canvas = z
  .object({
    version: z.literal(1),
    nodes: z.array(CanvasNode),
    edges: z.array(CanvasEdge).default([]),
  })
  .superRefine((canvas, ctx) => {
    const ids = new Set<string>();
    for (const node of canvas.nodes) {
      if (ids.has(node.id)) {
        ctx.addIssue({ code: "custom", message: `duplicate node id: ${node.id}`, path: ["nodes"] });
      }
      ids.add(node.id);
    }
    canvas.edges.forEach((edge, i) => {
      for (const end of [edge.from, edge.to]) {
        if (!ids.has(end)) {
          ctx.addIssue({ code: "custom", message: `edge points at unknown node: ${end}`, path: ["edges", i] });
        }
      }
    });
  });
export type Canvas = z.infer<typeof Canvas>;
