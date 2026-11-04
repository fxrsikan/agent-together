import picomatch from "picomatch";
import type { Canvas, CanvasNode } from "@agent-together/schema";

/** The first node whose file globs match a project-relative path. */
export function ownerOf(canvas: Canvas, rel: string): CanvasNode | null {
  return canvas.nodes.find((n) => n.files.length > 0 && picomatch(n.files)(rel)) ?? null;
}

/** True when the canvas has an edge saying `from` may depend on `to`. */
export function mayDepend(canvas: Canvas, from: string, to: string): boolean {
  return from === to || canvas.edges.some((e) => e.from === from && e.to === to);
}
