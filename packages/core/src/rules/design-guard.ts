import fs from "node:fs";
import path from "node:path";
import { importCandidates, importSpecifiers, SOURCE_FILE } from "../imports.js";
import { mayDepend, ownerOf } from "../owners.js";
import { relativeToRoot } from "../paths.js";
import type { Rule } from "./types.js";

/**
 * 设计守护: an import may only cross node boundaries along a canvas edge.
 * Reads relative JS/TS imports and Python imports with regexes; tree-sitter and path aliases come later.
 */
export const designGuard: Rule = {
  id: "design-guard",
  defaultLevel: "ask",
  check(event, { root, canvas }) {
    if (event.kind !== "tool.before" || event.action.type !== "write") return null;
    const { path: file, before, after } = event.action;
    const rel = relativeToRoot(root, file);
    if (!rel || !SOURCE_FILE.test(rel)) return null;
    const from = ownerOf(canvas, rel);
    if (!from) return null;

    const old = importSpecifiers(before, rel);
    const exists = (p: string) => fs.existsSync(path.join(root, p));
    const violations: string[] = [];
    for (const spec of importSpecifiers(after, rel)) {
      if (old.has(spec)) continue;
      const to = importCandidates(rel, spec, exists).map((c) => ownerOf(canvas, c)).find(Boolean);
      if (to && !mayDepend(canvas, from.id, to.id)) violations.push(`"${spec}" (${to.title})`);
    }
    if (!violations.length) return null;
    return {
      nodeId: from.id,
      message:
        `${rel} would import ${violations.join(", ")}, but the canvas has no edge ` +
        `from "${from.title}" to that node. Go through an allowed dependency, or ask the user to add the edge.`,
    };
  },
};
