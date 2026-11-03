import type { Rule } from "./types.js";

const TEST_FILE = /(^|[\\/])(__tests__|tests?)[\\/]|\.(test|spec)\.[cm]?[jt]sx?$|(^|[\\/])test_[^\\/]*\.py$/;
const SKIP = /\b(it|test|describe)\.(skip|only|todo)\(|\bx(it|describe)\(|@pytest\.mark\.skip/;
const ASSERT = /\bexpect\(|\bassert\b/g;

const count = (text: string | undefined) => (text?.match(ASSERT) ?? []).length;

/** 纠偏官: making tests pass by skipping them or deleting assertions. */
export const testTampering: Rule = {
  id: "test-tampering",
  defaultLevel: "ask",
  check(event, { activeNode }) {
    if (event.kind !== "tool.before" || event.action.type !== "write") return null;
    const { path, before, after } = event.action;
    if (!TEST_FILE.test(path)) return null;
    if (SKIP.test(after) && !SKIP.test(before ?? "")) {
      return { nodeId: activeNode?.id, message: `${path}: this edit skips tests. Fix the code, not the test.` };
    }
    if (before !== undefined && count(after) < count(before)) {
      return {
        nodeId: activeNode?.id,
        message: `${path}: this edit removes ${count(before) - count(after)} assertion(s). Fix the code, not the test.`,
      };
    }
    return null;
  },
};
