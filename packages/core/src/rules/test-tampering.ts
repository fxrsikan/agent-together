import type { Rule } from "./types.js";

const TEST_FILE = /(^|[\\/])(__tests__|tests?)[\\/]|\.(test|spec)\.[cm]?[jt]sx?$|(^|[\\/])test_[^\\/]*\.py$/;
const SKIP = /\b(it|test|describe)\.(skip|only|todo)\(|\bx(it|describe)\(|@pytest\.mark\.skip/;
const ASSERT = /\bexpect\(|\bassert\b/g;
/** Assertions that only check part of a value (a pattern, truthiness, containment). */
const LOOSE = /\bassert\.(match|ok|notEqual|notStrictEqual)\(|\bassert\(|\.(toMatch|toContain|toBeTruthy|toBeDefined|toHaveLength)\(|\.includes\(/;
/** Assertions that pin a value exactly. */
const EXACT = /\bassert\.(equal|strictEqual|deepEqual|deepStrictEqual|throws|rejects)\(|\.(toBe|toEqual|toStrictEqual|toThrow)\(|\bassert\s+\S.*==/;

const count = (text: string | undefined) => (text?.match(ASSERT) ?? []).length;
const assertionLines = (text: string) =>
  text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => new RegExp(ASSERT.source).test(l));

/** Lines in `a` that are not in `b`, counting duplicates. */
function minus(a: string[], b: string[]) {
  const left = [...b];
  return a.filter((line) => {
    const i = left.indexOf(line);
    if (i < 0) return true;
    left.splice(i, 1);
    return false;
  });
}

/**
 * Fewer assertions is fine when only loose ones went away and an exact one came
 * in: `match(m, /1/); match(m, /买/)` becoming `equal(m, '已添加：买（编号 1）')`
 * makes the test stricter, not weaker.
 */
export function strengthened(before: string, after: string) {
  const b = assertionLines(before);
  const a = assertionLines(after);
  const removed = minus(b, a);
  const added = minus(a, b);
  return removed.length > 0 && removed.every((l) => LOOSE.test(l) && !EXACT.test(l)) && added.some((l) => EXACT.test(l));
}

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
    if (before !== undefined && count(after) < count(before) && !strengthened(before, after)) {
      return {
        nodeId: activeNode?.id,
        message: `${path}: this edit removes ${count(before) - count(after)} assertion(s). Fix the code, not the test.`,
      };
    }
    return null;
  },
};
