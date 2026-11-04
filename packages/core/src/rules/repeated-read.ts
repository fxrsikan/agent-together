import type { AgentEvent } from "@agent-together/schema";
import type { Rule } from "./types.js";

const LIMIT = 4;

const readPath = (e: AgentEvent) => (e.kind === "tool.before" && e.action.type === "read" ? e.action.path : null);

/** Token waste: the same file read again and again in one session. */
export const repeatedRead: Rule = {
  id: "repeated-read",
  defaultLevel: "warn",
  check(event, { history, activeNode }) {
    const file = readPath(event);
    if (!file) return null;
    const times = history.filter((e) => readPath(e) === file).length + 1;
    if (times !== LIMIT) return null;
    return {
      nodeId: activeNode?.id,
      message: `${file} has been read ${times} times this session. Keep the parts you need instead of re-reading it.`,
    };
  },
};
