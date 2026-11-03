import type { LoomEvent } from "@loom/schema";
import type { Rule } from "./types.js";

const LIMIT = 3;

const failedCommand = (e: LoomEvent) =>
  e.kind === "tool.after" && !e.ok && e.action.type === "shell" ? e.action.command.trim() : null;

/** 纠偏官: the same command keeps failing — stop and rethink instead of retrying. */
export const repeatedFailure: Rule = {
  id: "repeated-failure",
  defaultLevel: "warn",
  check(event, { history, activeNode }) {
    const command = failedCommand(event);
    if (!command) return null;
    const times = history.filter((e) => failedCommand(e) === command).length + 1;
    if (times < LIMIT) return null;
    return {
      nodeId: activeNode?.id,
      message:
        `"${command}" has failed ${times} times in this session. ` +
        `Stop retrying: summarise what you tried and why it fails, then change approach or ask the user.`,
    };
  },
};
