import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { guessRunConfig, ProductProcess, readRunConfig, urlFromLogs, verifyRunConfig, waitForHttp } from "@agent-together/core";

function project(files: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "at-product-"));
  fs.mkdirSync(path.join(root, ".agent-together"));
  fs.writeFileSync(path.join(root, ".agent-together", "project.json"), JSON.stringify({ name: "p", createdAt: "" }));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return root;
}

const get = (url: string) =>
  new Promise<string>((resolve, reject) => http.get(url, (res) => { let body = ""; res.on("data", (d) => (body += d)); res.on("end", () => resolve(body)); }).on("error", reject));

// Listens on PORT and says which service mode it was started in.
const SERVER = `require("http").createServer((q, r) => r.end("mode=" + process.env.AT_SERVICE_MODE)).listen(Number(process.env.PORT || 3000), "127.0.0.1", () => console.log("ready"));`;

describe("running the product", { timeout: 60_000 }, () => {
  it("guesses the start command from the files", () => {
    const root = project({ "package.json": JSON.stringify({ scripts: { start: "node server.js" }, dependencies: { express: "1" } }) });
    expect(guessRunConfig(root, ["package.json", "server.js"])).toEqual({ start: "npm start", install: "npm install" });
    expect(guessRunConfig(project({}), ["src/server.js"])).toEqual({ start: "node src/server.js" });
    expect(guessRunConfig(project({}), ["README.md"])).toBeNull();
  });

  it("starts on the port it picks, passes the service mode, and stops", async () => {
    const root = project({ "server.js": SERVER });
    const states: string[] = [];
    const product = new ProductProcess(root, (s) => states.push(s.state));
    const status = await product.start({ start: "node server.js" }, "mock");
    expect(status.state).toBe("running");
    expect(await get(status.url!)).toBe("mode=mock");
    expect(product.logs()).toContain("ready");
    await product.stop();
    expect(product.current.state).toBe("stopped");
    expect(await waitForHttp(status.url!, 800)).toBe(false);
    expect(states).toEqual(["starting", "running", "stopped"]);
  });

  it("finds a product that ignores PORT by the address it prints", async () => {
    const fixed = `const s = require("http").createServer((q, r) => r.end("ok")).listen(0, "127.0.0.1", () => console.log("listening on http://localhost:" + s.address().port));`;
    const product = new ProductProcess(project({ "server.js": fixed }));
    const status = await product.start({ start: "node server.js" });
    expect(status.state).toBe("running");
    expect(await get(status.url!)).toBe("ok");
    await product.stop();
  });

  it("says why it failed: the program exited, or never answered", async () => {
    const crash = new ProductProcess(project({ "server.js": `console.error("缺少配置文件"); process.exit(2);` }));
    const s1 = await crash.start({ start: "node server.js" });
    expect(s1.state).toBe("failed");
    expect(s1.error).toContain("退出代码 2");
    expect(crash.logs()).toContain("缺少配置文件");

    const silent = new ProductProcess(project({ "server.js": "setInterval(() => {}, 1000);" }));
    const s2 = await silent.start({ start: "node server.js" }, "mock", 2500);
    expect(s2.state).toBe("failed");
    expect(s2.error).toContain("没有在端口");
    await silent.stop();
  });

  it("saves a run configuration only once a start with it worked", async () => {
    const root = project({ "server.js": SERVER });
    expect((await verifyRunConfig(root, { start: "node missing.js" })).ok).toBe(false);
    expect(readRunConfig(root)).toBeNull();
    const ok = await verifyRunConfig(root, { start: "node server.js", path: "home" });
    expect(ok.ok).toBe(true);
    expect(readRunConfig(root)).toMatchObject({ start: "node server.js", path: "/home" });
    expect(readRunConfig(root)?.verifiedAt).toBeTruthy();
  });

  it("reads an address a server printed", () => {
    expect(urlFromLogs(["starting", "Server running at http://0.0.0.0:5173/"])).toBe("http://127.0.0.1:5173");
    expect(urlFromLogs(["no address here"])).toBeNull();
  });
});
