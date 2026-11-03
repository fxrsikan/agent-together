#!/usr/bin/env node
import { Daemon } from "./daemon.js";
import { createLlm, loadLlmConfig } from "./llm.js";
import { LoomStore } from "./store.js";

// Usage: loom-daemon [projectDir] [activeNodeId]
const store = LoomStore.find(process.argv[2] ?? process.cwd());
if (!store) {
  console.error("No .loom directory found. Run this inside a Loom project.");
  process.exit(1);
}
const config = loadLlmConfig(store.root);
const llm = createLlm(config);
const daemon = new Daemon(store.root, { llm, maxL2CallsPerSession: config.maxCallsPerSession });
if (process.argv[3]) daemon.setActiveNode(process.argv[3]);
daemon.on("event", ({ event, verdict }) => {
  const what = event.kind === "turn.end" ? "" : event.action.type;
  if (!verdict.findings.length) console.log(`[ok] ${event.kind} ${what}`);
  for (const f of verdict.findings) console.log(`[${f.level}] ${f.rule}: ${f.message}`);
});
daemon.on("memory", (ms) => ms.forEach((m) => console.log(`[memory ${m.status}] ${m.content}`)));
daemon.on("judgment", (j) => console.log(`[L2 ${j.onTrack ? "on track" : "OFF TRACK"}] ${j.nodeId}: ${j.reason}`));
daemon.on("l2error", (e) => console.log(`[L2 error] ${e}`));
const port = await daemon.start();
console.log(`Loom daemon for ${store.root} on 127.0.0.1:${port} · L2: ${llm?.name ?? "off"}`);
const shutdown = () => daemon.stop().then(() => process.exit(0));
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
