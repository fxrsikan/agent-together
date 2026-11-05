import picomatch from "picomatch";
import type { Canvas, CanvasNode } from "@agent-together/schema";

/** How specific a glob is: an exact path beats any pattern; otherwise the longer fixed start wins. */
function specificity(glob: string): number {
  const wild = glob.search(/[*?[{]/);
  return wild === -1 ? Number.MAX_SAFE_INTEGER : wild;
}

/**
 * The node that owns a project-relative path: of the nodes whose globs match it, the
 * one with the most specific matching glob (so a card can own tests/test_store.py
 * while another owns tests/**); the first such node on a tie.
 */
export function ownerOf(canvas: Canvas, rel: string): CanvasNode | null {
  let best: CanvasNode | null = null;
  let bestScore = -1;
  for (const n of canvas.nodes) {
    for (const glob of n.files) {
      const score = specificity(glob);
      if (score > bestScore && picomatch(glob)(rel)) {
        best = n;
        bestScore = score;
      }
    }
  }
  return best;
}

/** True when the canvas has an edge saying `from` may depend on `to`. */
export function mayDepend(canvas: Canvas, from: string, to: string): boolean {
  return from === to || canvas.edges.some((e) => e.from === from && e.to === to);
}
