import picomatch from "picomatch";
import { relativeToRoot } from "../paths.js";
import type { Rule } from "./types.js";

/** 定向官: a write must stay inside the files owned by the active node. */
export const scopeFence: Rule = {
  id: "scope-fence",
  defaultLevel: "ask",
  check(event, { root, activeNode }) {
    if (event.kind !== "tool.before" || event.action.type !== "write" || !activeNode) return null;
    const rel = relativeToRoot(root, event.action.path);
    if (rel?.startsWith(".loom/")) {
      return { nodeId: activeNode.id, message: `${rel} belongs to Loom itself; agents do not edit it.` };
    }
    if (rel && activeNode.files.length > 0 && picomatch(activeNode.files)(rel)) return null;
    return {
      nodeId: activeNode.id,
      message:
        `${rel ?? event.action.path} is outside node "${activeNode.title}" ` +
        `(owns: ${activeNode.files.join(", ") || "nothing yet"}). ` +
        `Explain how this serves the node's goal, or stay within its files.`,
    };
  },
};
