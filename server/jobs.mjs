import { randomUUID } from "node:crypto";
import { mkdir, rm, readdir } from "node:fs/promises";
import { safeFile, jsonOrNull, writeJson, privateRoot } from "./core/files.mjs";
export const publicError = (e) =>
  String(e?.message ?? e)
    .replace(/https:\/\/[^\s/]*@/g, "https://[redacted]@")
    .replace(
      /((?:token|secret|password|authorization)\s*[:=]\s*)[^\s,;]+/gi,
      "$1[redacted]",
    )
    .slice(0, 1800);
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code !== "ESRCH";
  }
}
export class JobManager {
  constructor(state) {
    this.state = state;
    this.running = null;
  }
  async file(id) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid operation ID");
    return safeFile(this.state, `jobs/${id}.json`);
  }
  async initialize() {
    await privateRoot(this.state);
    await mkdir(await safeFile(this.state, "jobs"), { recursive: true });
    const owner = await jsonOrNull(
      await safeFile(this.state, "job.lock/owner.json"),
    );
    if (owner && !alive(owner.pid)) {
      const file = await this.file(owner.id),
        j = await jsonOrNull(file);
      if (j && ["running", "queued"].includes(j.status)) {
        j.status = "interrupted";
        j.error =
          "Plugin process stopped. Inspect backups and daemon state before unlocking or retrying.";
        await writeJson(file, j);
      }
    }
  }
  async start(kind, task) {
    await this.initialize();
    const lock = await safeFile(this.state, "job.lock");
    try {
      await mkdir(lock);
    } catch (e) {
      if (e.code === "EEXIST")
        throw new Error(
          "Another operation is active, or an interrupted operation requires review.",
        );
      throw e;
    }
    const id = randomUUID(),
      j = {
        id,
        kind,
        status: "queued",
        phase: "queued",
        startedAt: new Date().toISOString(),
      };
    try {
      await writeJson(await safeFile(this.state, "job.lock/owner.json"), {
        id,
        pid: process.pid,
      });
      await writeJson(await this.file(id), j);
      await writeJson(await safeFile(this.state, "latest.json"), { id });
    } catch (e) {
      await rm(lock, { recursive: true, force: true });
      throw e;
    }
    // The work is deliberately detached from the RPC and remains owned by this process.
    this.running = (async () => {
      try {
        j.status = "running";
        await writeJson(await this.file(id), j);
        const phase = async (value) => {
          j.phase = value;
          await writeJson(await this.file(id), j);
        };
        j.result = await task(phase);
        j.status = "succeeded";
        j.phase = "complete";
      } catch (e) {
        j.status = "failed";
        j.error = publicError(e);
        if (e.backupId) j.backupId = e.backupId;
      } finally {
        j.finishedAt = new Date().toISOString();
        try {
          await writeJson(await this.file(id), j);
        } finally {
          await rm(lock, { recursive: true, force: true });
        }
      }
    })();
    this.running.catch(() => {});
    return { id, kind, status: "queued" };
  }
  async get(id) {
    await this.initialize();
    if (!id) {
      const latest = await jsonOrNull(
        await safeFile(this.state, "latest.json"),
      );
      if (!latest) return null;
      id = latest.id;
    }
    return jsonOrNull(await this.file(id));
  }
  async unlock() {
    const lock = await safeFile(this.state, "job.lock"),
      owner = await jsonOrNull(
        await safeFile(this.state, "job.lock/owner.json"),
      );
    if (owner && alive(owner.pid))
      throw new Error("Owner process is still alive; cannot unlock");
    if (!owner)
      throw new Error(
        "No verifiable interrupted operation lock; inspect manually",
      );
    await this.initialize();
    await rm(lock, { recursive: true, force: true });
    return { unlocked: true };
  }
}
