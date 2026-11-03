#!/usr/bin/env node
import { Daemon } from "./daemon.js";
import { LoomStore } from "./store.js";

// Usage: loom-daemon [projectDir] [activeNodeId]
const store = LoomStore.find(process.argv[2] ?? process.cwd());
if (!store) {
  console.error("No .loom directory found. Run this inside a Loom project.");
  process.exit(1);
}
const daemon = new Daemon(store.root);
if (process.argv[3]) daemon.setActiveNode(process.argv[3]);
daemon.on("event", ({ event, verdict }) => {
  const what = event.kind === "turn.end" ? "" : event.action.type;
  if (!verdict.findings.length) console.log(`[ok] ${event.kind} ${what}`);
  for (const f of verdict.findings) console.log(`[${f.level}] ${f.rule}: ${f.message}`);
});
const port = await daemon.start();
console.log(`Loom daemon for ${store.root} on 127.0.0.1:${port}`);
const shutdown = () => daemon.stop().then(() => process.exit(0));
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
