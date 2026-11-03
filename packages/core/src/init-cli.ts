#!/usr/bin/env node
import path from "node:path";
import { initProject } from "./init.js";

// Usage: loom-init [projectDir] [--force]
const args = process.argv.slice(2);
const root = path.resolve(args.find((a) => !a.startsWith("--")) ?? ".");
try {
  const canvas = initProject(root, { force: args.includes("--force") });
  console.log(`Loom canvas created in ${path.join(root, ".loom")}: ${canvas.nodes.length} nodes, ${canvas.edges.length} edges`);
  for (const n of canvas.nodes) console.log(`  ${n.id}  ${n.files.join(", ")}`);
  for (const e of canvas.edges) console.log(`  ${e.from} -> ${e.to}  (${e.label})`);
  console.log("Rename nodes, write their goals and adjust edges, then open the project in Loom.");
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
