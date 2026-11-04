import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Checkpoints } from "@agent-together/core";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

/** A repo whose Agent Together project lives in app/, next to an unrelated sibling folder. */
function repo() {
  const top = fs.mkdtempSync(path.join(os.tmpdir(), "agent-together-cp-"));
  git(top, "init", "-q");
  const app = path.join(top, "app");
  fs.mkdirSync(path.join(app, "src"), { recursive: true });
  fs.mkdirSync(path.join(top, "other"));
  fs.writeFileSync(path.join(app, "src", "a.ts"), "v1");
  fs.writeFileSync(path.join(app, ".gitignore"), "ignored.txt\n");
  fs.writeFileSync(path.join(top, "other", "keep.txt"), "v1");
  return { top, app, read: (p: string) => fs.readFileSync(path.join(top, p), "utf8") };
}

// Each test runs many git commands: slow on a busy Windows machine.
describe("Checkpoints", { timeout: 30_000 }, () => {
  it("rolls back edits and new files inside the project only", () => {
    const { top, app, read } = repo();
    const cp = new Checkpoints(app);
    const first = cp.create("派发前", "login-form");

    fs.writeFileSync(path.join(app, "src", "a.ts"), "v2");
    fs.writeFileSync(path.join(app, "src", "new.ts"), "new");
    fs.writeFileSync(path.join(app, "ignored.txt"), "keep me");
    fs.writeFileSync(path.join(top, "other", "keep.txt"), "v2");

    cp.rollback(first.id);

    expect(read("app/src/a.ts")).toBe("v1");
    expect(fs.existsSync(path.join(app, "src", "new.ts"))).toBe(false);
    expect(read("app/ignored.txt")).toBe("keep me");
    expect(read("other/keep.txt")).toBe("v2");
  });

  it("keeps the user's index and branch untouched, and can undo a rollback", () => {
    const { app, read } = repo();
    const cp = new Checkpoints(app);
    const first = cp.create("start");
    fs.writeFileSync(path.join(app, "src", "a.ts"), "v2");

    const safety = cp.rollback(first.id);
    expect(read("app/src/a.ts")).toBe("v1");
    expect(git(app, "status", "--porcelain")).toContain("?? ");
    expect(() => git(app, "rev-parse", "HEAD")).toThrow();

    cp.rollback(safety.id);
    expect(read("app/src/a.ts")).toBe("v2");
  });

  it("lists checkpoints newest first with their labels", () => {
    const { app } = repo();
    const cp = new Checkpoints(app);
    cp.create("one");
    cp.create("two", "n1");
    const list = cp.list();
    expect(list).toHaveLength(2);
    expect(list.map((c) => c.label).sort()).toEqual(["one", "two"]);
  });
});
