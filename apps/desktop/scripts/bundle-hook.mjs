// Bundles the observer hook program (and the workspace code it uses) into one file
// that any Node.js 22+ can run, so the installed app does not need the source tree.
// Output: out/hook/agent-together-hook.mjs (unpacked from app.asar when packaged).
import { build } from "rolldown";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

await build({
  input: path.resolve(desktop, "../../packages/hook/src/agent-together-hook.ts"),
  platform: "node",
  output: { file: path.join(desktop, "out/hook/agent-together-hook.mjs"), format: "esm" },
  logLevel: "warn",
});
console.log("bundled out/hook/agent-together-hook.mjs");
