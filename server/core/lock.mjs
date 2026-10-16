import { mkdir, rm } from "node:fs/promises";
import { privateRoot, safeFile, writeJson } from "./files.mjs";
export async function acquireOperation(ctx) {
  const root = ctx.lockRoot ?? ctx.state;
  await privateRoot(root);
  const lock = await safeFile(root, "operation.lock");
  try {
    await mkdir(lock);
  } catch (e) {
    if (e.code === "EEXIST")
      throw new Error(
        "Another operation is active, or an interrupted operation needs review.",
      );
    throw e;
  }
  try {
    await writeJson(await safeFile(root, "operation.lock/owner.json"), {
      pid: process.pid,
    });
  } catch (e) {
    await rm(lock, { recursive: true, force: true });
    throw e;
  }
  return () => rm(lock, { recursive: true, force: true });
}
export async function withOperation(ctx, fn) {
  const release = await acquireOperation(ctx);
  try {
    return await fn();
  } finally {
    await release();
  }
}
