import picomatch from "picomatch";
import { ownerOf } from "../owners.js";
import { relativeToRoot } from "../paths.js";
import type { Rule } from "./types.js";

/** 定向官: a write must stay inside the files owned by the active node. */
export const scopeFence: Rule = {
  id: "scope-fence",
  defaultLevel: "ask",
  check(event, { root, canvas, activeNode, grants }) {
    if (event.kind !== "tool.before" || event.action.type !== "write" || !activeNode) return null;
    const rel = relativeToRoot(root, event.action.path);
    if (rel?.startsWith(".agent-together/")) {
      return { nodeId: activeNode.id, message: `${rel} belongs to Agent Together itself; agents do not edit it.` };
    }
    // Same answer as everywhere else that asks "whose file is this": the most specific glob wins.
    // A file matching this card's globs but owned more specifically by another card is that card's.
    const owner = rel ? ownerOf(canvas, rel) : null;
    if (owner?.id === activeNode.id) return null;
    // Integration work authorised for this run (it ends with the run): wiring into the files it connects.
    if (rel && grants?.length && picomatch(grants)(rel)) return null;
    return {
      nodeId: activeNode.id,
      message:
        `${rel ?? event.action.path} is outside node "${activeNode.title}" ` +
        `(owns: ${activeNode.files.join(", ") || "nothing yet"}${owner ? `; this file belongs to "${owner.title}"` : ""}). ` +
        `Explain how this serves the node's goal, or stay within its files.`,
    };
  },
};
