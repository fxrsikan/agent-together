import assert from "node:assert/strict";
import { test } from "node:test";
import { validateLogin } from "./validate.ts";

test("accepts a valid email and password", () => {
  assert.deepEqual(validateLogin("a@b.co", "password1"), []);
});

test("rejects a malformed email", () => {
  assert.ok(validateLogin("not-an-email", "password1").includes("邮箱格式不正确"));
});

test("rejects a short password", () => {
  assert.ok(validateLogin("a@b.co", "short1").includes("密码至少 8 位"));
});
