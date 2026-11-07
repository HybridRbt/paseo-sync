import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { atomicWrite, bytesOrNull } from "../server/core/files.mjs";
test("Windows transient file sharing errors do not lose the final journal write", async (t) => {
  const base = await fs.mkdtemp(path.join(tmpdir(), "paseo-atomic-")),
    file = path.join(base, "job.json");
  await fs.writeFile(file, "old");
  const rename = fs.rename,
    platform = process.platform;
  let count = 0;
  t.mock.method(fs, "rename", async (...args) => {
    if (count++ < 2) {
      const e = new Error("temporarily occupied");
      e.code = "EPERM";
      throw e;
    }
    return rename(...args);
  });
  Object.defineProperty(process, "platform", { value: "win32" });
  try {
    await atomicWrite(file, "new");
  } finally {
    Object.defineProperty(process, "platform", { value: platform });
  }
  assert.equal(await fs.readFile(file, "utf8"), "new");
  assert.deepEqual(await fs.readdir(base), ["job.json"]);
});
test("Windows transient file sharing errors do not fail the owner.json read", async (t) => {
  const base = await fs.mkdtemp(path.join(tmpdir(), "paseo-read-")),
    file = path.join(base, "owner.json");
  await fs.writeFile(file, '{"pid":1234}');
  const readFile = fs.readFile,
    platform = process.platform;
  let count = 0;
  const mock = t.mock.method(fs, "readFile", async (...args) => {
    if (count++ < 2) {
      const e = new Error("temporarily occupied");
      e.code = "EPERM";
      throw e;
    }
    return readFile(...args);
  });
  Object.defineProperty(process, "platform", { value: "win32" });
  try {
    const data = await bytesOrNull(file);
    assert.equal(data.toString("utf8"), '{"pid":1234}');
    assert.equal(mock.mock.callCount(), 3);
  } finally {
    Object.defineProperty(process, "platform", { value: platform });
  }
});
