import path from "node:path";
import os from "node:os";
import { realpath, readdir } from "node:fs/promises";
import {
  privateRoot,
  safeFile,
  jsonOrNull,
  objectHash,
} from "./core/files.mjs";
import { makeAdapter, assertDaemonVersion } from "./core/paseo.mjs";
import {
  buildPlan,
  applyPlan,
  verify,
  restorePlan,
  restore,
} from "./core/sync.mjs";
import { loadProfile } from "./core/profile.mjs";
import {
  cafePlan,
  applyCafe,
  cafeRestorePlan,
  restoreCafe,
} from "./core/cafe.mjs";
import {
  cleanRepository,
  prepareRepository,
  publishPlan,
  publish,
} from "./core/repository.mjs";
import { JobManager } from "./jobs.mjs";
import { belongsToDaemon } from "./core/daemon-identity.mjs";
const mutations = new Set(["apply", "publish", "cafe", "restore"]);
export function createService({
  readSettings,
  expectedPid = process.ppid,
  stateRoot,
  adapterFactory = makeAdapter,
  getParent = undefined,
}) {
  let cached = null;
  async function connection(fresh = true) {
    const s = await readSettings();
    const key = objectHash(s);
    if (!fresh && cached?.key === key) return cached.value;
    const selected =
      s.daemonHome ||
      process.env.PASEO_HOME ||
      path.join(os.homedir(), ".paseo");
    if (!path.isAbsolute(selected))
      throw new Error("Daemon home must be absolute");
    const home = await realpath(selected),
      adapter = await adapterFactory(home, s.cliPath || undefined),
      status = await adapter.status();
    assertDaemonVersion(status.daemonVersion);
    if (!(await belongsToDaemon(status.pid, expectedPid, getParent)))
      throw new Error(
        `Daemon PID mismatch (expected parent ${expectedPid}, CLI reported ${status.pid ?? "missing"}): this plugin may only operate its parent daemon. Check daemon home.`,
      );
    const shared = await privateRoot(
      path.join(
        stateRoot ??
          process.env.PASEO_SYNC_STATE ??
          (process.platform === "win32"
            ? path.join(process.env.LOCALAPPDATA ?? os.homedir(), "PaseoSync")
            : path.join(os.homedir(), ".local", "state", "paseo-sync")),
        objectHash(home).slice(0, 24),
      ),
    );
    const value = {
      s,
      home,
      adapter,
      status,
      shared,
      manager: new JobManager(shared),
    };
    cached = { key, value };
    return value;
  }
  async function context(c) {
    if (!path.isAbsolute(c.s.checkout))
      throw new Error("Set an absolute profile checkout path first");
    const root = await realpath(c.s.checkout),
      rel = path.relative(c.home, root);
    if (
      !rel.startsWith(".." + path.sep) &&
      rel !== ".." &&
      !path.isAbsolute(rel)
    )
      throw new Error("Profile checkout must be outside the Paseo home");
    const marker = await jsonOrNull(await safeFile(root, "paseo-plugin.json"));
    if (marker?.id === "paseo-sync")
      throw new Error(
        "Use your separate configuration repository, not the public plugin source",
      );
    const state = await privateRoot(
      path.join(c.shared, "profiles", objectHash(root).slice(0, 24)),
    );
    const rows = await c.adapter.list(),
      selfIds = ["paseo-sync"];
    for (const row of rows) {
      if (!row.path) continue;
      try {
        const manifest = await jsonOrNull(
          await safeFile(row.path, "paseo-plugin.json"),
        );
        if (manifest?.id === "paseo-sync") selfIds.push(row.id);
      } catch {
        /* Unrelated plugin paths cannot authorize self management. */
      }
    }
    return {
      root,
      home: c.home,
      state,
      lockRoot: c.shared,
      adapter: c.adapter,
      selfIds,
    };
  }
  const seal = (ctx, kind, inner, backupId = "") =>
    objectHash({ root: ctx.root, home: ctx.home, kind, inner, backupId });
  async function preview(ctx, kind, backupId) {
    if (kind === "publish") {
      const p = await publishPlan(ctx);
      return {
        ...p,
        approval: seal(ctx, kind, p.approval),
        confirmKind: kind,
        _innerApproval: p.approval,
      };
    }
    if (kind === "restore") {
      if (!backupId) throw new Error("Choose a backup ID");
      const isCafe = backupId.startsWith("cafe:"),
        id = isCafe ? backupId.slice(5) : backupId;
      const p = isCafe
        ? await cafeRestorePlan(ctx, id)
        : await restorePlan(ctx, id);
      const { _backup, _current, ...safe } = p;
      return {
        ...safe,
        backupId,
        approval: seal(ctx, kind, p.approval, backupId),
        confirmKind: kind,
        _innerApproval: p.approval,
      };
    }
    const profile = await loadProfile(ctx.root),
      ids = [
        ...new Set([
          ...profile.manifest.plugins.map((p) => p.id),
          ...ctx.selfIds,
        ]),
      ];
    if (kind === "cafe") {
      const p = await cafePlan(ctx, ids);
      return {
        ...p,
        approval: seal(ctx, kind, p.approval),
        confirmKind: kind,
        _innerApproval: p.approval,
      };
    }
    const p = await buildPlan(ctx),
      cafe = await cafePlan(ctx, ids);
    return {
      ...p,
      conflicts: [
        ...p.conflicts,
        ...(cafe.missing.length
          ? [
              "Cafe auto-update conflicts: preview and confirm exclusions first.",
            ]
          : []),
      ],
      cafeMissing: cafe.missing,
      approval: seal(
        ctx,
        "apply",
        objectHash({ plan: p.approval, cafe: cafe.approval }),
      ),
      confirmKind: "apply",
      _innerApproval: p.approval,
    };
  }
  async function execute(c, input, phase) {
    await phase("checking");
    if (input.kind === "prepare") {
      const homeRel = path.relative(c.home, c.s.checkout);
      if (
        !path.isAbsolute(c.s.checkout) ||
        (!homeRel.startsWith(".." + path.sep) &&
          homeRel !== ".." &&
          !path.isAbsolute(homeRel))
      )
        throw new Error(
          "Checkout must be an absolute path outside the Paseo home",
        );
      await phase("git-fetch-and-fast-forward");
      return prepareRepository(c.s.checkout, c.s.repositoryUrl);
    }
    const ctx = await context(c);
    if (input.kind === "inspect")
      return {
        host: os.hostname(),
        home: c.home,
        checkout: ctx.root,
        daemonVersion: c.status.daemonVersion,
        cli: ctx.adapter.executable ?? null,
        plugins: (await ctx.adapter.list()).map((r) => ({
          id: r.id,
          enabled: r.enabled,
          status: r.status,
          revision: r.installation?.currentRevision ?? null,
        })),
        selfIds: ctx.selfIds,
      };
    if (input.kind === "verify") return verify(ctx);
    if (input.kind === "backups") {
      const list = [];
      for (const [dir, prefix] of [
        ["backups", ""],
        ["cafe-backups", "cafe:"],
      ]) {
        const folder = await safeFile(ctx.state, dir);
        let names = [];
        try {
          names = await readdir(folder);
        } catch (e) {
          if (e.code !== "ENOENT") throw e;
        }
        for (const name of names.filter((n) =>
          /^[a-f0-9-]{36}\.json$/.test(n),
        )) {
          const b = await jsonOrNull(
            await safeFile(ctx.state, `${dir}/${name}`),
          );
          list.push({ id: prefix + name.slice(0, -5), status: b.status });
        }
      }
      return { backups: list };
    }
    const mapped = {
      plan: "apply",
      publishPlan: "publish",
      cafePlan: "cafe",
      restorePlan: "restore",
    }[input.kind];
    if (mapped) {
      await phase("preview");
      const { _innerApproval, ...safe } = await preview(
        ctx,
        mapped,
        input.backupId,
      );
      return safe;
    }
    if (!mutations.has(input.kind)) throw new Error("Unknown operation");
    await cleanRepository(ctx.root);
    const p = await preview(ctx, input.kind, input.backupId);
    if (input.approval !== p.approval)
      throw new Error("Operation preview is stale. Review a new preview.");
    if (p.conflicts?.length) throw new Error(p.conflicts.join("\n"));
    await phase("backup-and-execute");
    if (input.kind === "publish") return publish(ctx, p._innerApproval);
    if (input.kind === "cafe") {
      const profile = await loadProfile(ctx.root),
        ids = [
          ...new Set([
            ...profile.manifest.plugins.map((p) => p.id),
            ...ctx.selfIds,
          ]),
        ];
      const r = await applyCafe(ctx, ids, p._innerApproval);
      return r.backupId ? { ...r, backupId: `cafe:${r.backupId}` } : r;
    }
    if (input.kind === "restore") {
      const cafe = input.backupId.startsWith("cafe:"),
        id = cafe ? input.backupId.slice(5) : input.backupId;
      if (cafe) {
        const r = await restoreCafe(ctx, id, p._innerApproval);
        return { ...r, backupId: `cafe:${r.backupId}` };
      }
      return restore(ctx, id, p._innerApproval);
    }
    return applyPlan(ctx, p._innerApproval);
  }
  return {
    async start(input) {
      if (mutations.has(input.kind) && !input.approval)
        throw new Error("Approval digest is required");
      const c = await connection();
      return c.manager.start(input.kind, async (phase) => {
        try {
          return await execute(c, input, phase);
        } catch (e) {
          if (
            e.backupId &&
            (input.kind === "cafe" || input.backupId?.startsWith("cafe:"))
          )
            e.backupId = `cafe:${e.backupId}`;
          throw e;
        }
      });
    },
    async getJob(id) {
      const c = await connection(false);
      return c.manager.get(id);
    },
    async unlock() {
      const c = await connection();
      return c.manager.unlock();
    },
  };
}
