/** Which way to follow the canvas's links from a card. */
export type ReachDirection = "deps" | "dependents";

export interface Reach {
  /** The cards reached, without the starting card. */
  nodes: Set<string>;
  /** Edge ids ("from->to") on the way. */
  edges: Set<string>;
  /** The longest shortest path, in links; 0 when nothing is reached. */
  hops: number;
}

type Link = { from: string; to: string };

export const edgeId = (e: Link) => `${e.from}->${e.to}`;

/**
 * Cards reachable from `start` along the drawn links, breadth-first. A link "a → b"
 * means a may depend on b, so `deps` follows links forward (what this card builds
 * on) and `dependents` follows them backward (what builds on this card). This is
 * the drawn plan only: it says nothing about what a change would actually break.
 */
export function reachFrom(start: string, links: Link[], direction: ReachDirection): Reach {
  const nodes = new Set<string>();
  const edges = new Set<string>();
  let frontier = [start];
  let hops = 0;
  const seen = new Set([start]);
  while (frontier.length) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const link of links) {
        const [from, to] = direction === "deps" ? [link.from, link.to] : [link.to, link.from];
        if (from !== id) continue;
        edges.add(edgeId(link));
        if (seen.has(to)) continue;
        seen.add(to);
        nodes.add(to);
        next.push(to);
      }
    }
    if (next.length) hops++;
    frontier = next;
  }
  return { nodes, edges, hops };
}

/** Cards whose title, id or files contain the query (case-insensitive), best match first. */
export function findCards<T extends { id: string; title: string; files: string[] }>(cards: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const score = (c: T) =>
    c.title.toLowerCase().startsWith(q) ? 0 : c.title.toLowerCase().includes(q) ? 1 : c.id.includes(q) ? 2 : c.files.some((f) => f.toLowerCase().includes(q)) ? 3 : 9;
  return cards.filter((c) => score(c) < 9).sort((a, b) => score(a) - score(b));
}
