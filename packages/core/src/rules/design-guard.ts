import path from "node:path";
import { mayDepend, ownerOf } from "../owners.js";
import { relativeToRoot } from "../paths.js";
import type { Rule } from "./types.js";

const SOURCE = /\.[cm]?[jt]sx?$/;
// import x from "y" · import "y" · export * from "y" · require("y") · import("y")
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*|\brequire\s*\(\s*|\bimport\s*\(\s*)["']([^"']+)["']/g;
const EXTENSIONS = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", "/index.ts", "/index.tsx", "/index.js"];

const specifiers = (code: string | undefined) => new Set([...(code ?? "").matchAll(SPECIFIER)].map((m) => m[1]));

/**
 * 设计守护: an import may only cross node boundaries along a canvas edge.
 * v0.1 reads relative imports in JS/TS with a regex; tree-sitter and path aliases come later.
 */
export const designGuard: Rule = {
  id: "design-guard",
  defaultLevel: "ask",
  check(event, { root, canvas }) {
    if (event.kind !== "tool.before" || event.action.type !== "write") return null;
    const { path: file, before, after } = event.action;
    const rel = relativeToRoot(root, file);
    if (!rel || !SOURCE.test(rel)) return null;
    const from = ownerOf(canvas, rel);
    if (!from) return null;

    const old = specifiers(before);
    const violations: string[] = [];
    for (const spec of specifiers(after)) {
      if (old.has(spec) || !spec.startsWith(".")) continue;
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec));
      const to = EXTENSIONS.map((ext) => ownerOf(canvas, target + ext)).find(Boolean);
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
