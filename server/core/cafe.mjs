import { randomUUID } from "node:crypto";
import {
  safeFile,
  bytesOrNull,
  jsonOrNull,
  objectHash,
  writeJson,
  atomicWrite,
} from "./files.mjs";
import { withOperation } from "./lock.mjs";
const location = (ctx) =>
  safeFile(ctx.home, "plugin-settings/paseo-cafe/directory-settings.json");
async function snapshot(ctx, ids) {
  const row = (await ctx.adapter.list()).find((p) => p.id === "paseo-cafe");
  if (!row)
    return {
      installed: false,
      missing: [],
      raw: null,
      enabled: false,
      next: null,
    };
  const raw = await bytesOrNull(await location(ctx));
  const data =
    raw === null
      ? { version: 1, values: {} }
      : JSON.parse(raw.toString("utf8"));
  if (
    data.version !== 1 ||
    !data.values ||
    typeof data.values !== "object" ||
    Array.isArray(data.values)
  )
    throw new Error("Unsupported Cafe settings document");
  const opt = data.values.autoUpdateOptOuts ?? [];
  if (!Array.isArray(opt) || !opt.every((x) => typeof x === "string"))
    throw new Error("Invalid Cafe exclusion list");
  const missing = [...new Set(ids)].filter((id) => !opt.includes(id)).sort();
  const next = {
    ...data,
    values: {
      ...data.values,
      autoUpdateOptOuts: [...new Set([...opt, ...ids])].sort(),
    },
  };
  return {
    installed: true,
    missing,
    raw: raw?.toString("base64") ?? null,
    enabled: row.enabled,
    next,
  };
}
export async function cafePlan(ctx, ids) {
  const s = await snapshot(ctx, ids);
  return {
    installed: s.installed,
    missing: s.missing,
    approval: objectHash({ ids: [...ids].sort(), snapshot: s }),
    exclusions: s.next?.values.autoUpdateOptOuts ?? [],
  };
}
async function assertBytes(ctx, expected) {
  const raw = await bytesOrNull(await location(ctx));
  if ((raw?.toString("base64") ?? null) !== expected)
    throw new Error("Cafe settings changed concurrently");
}
export async function applyCafe(ctx, ids, approval) {
  return withOperation(ctx, async () => {
    const p = await cafePlan(ctx, ids);
    if (p.approval !== approval) throw new Error("Cafe preview is stale");
    if (!p.missing.length) return { changed: false };
    const s = await snapshot(ctx, ids),
      id = randomUUID(),
      file = await safeFile(ctx.state, `cafe-backups/${id}.json`);
    const b = {
      id,
      before: s.raw,
      after: null,
      enabled: s.enabled,
      status: "pending",
    };
    await writeJson(file, b);
    try {
      if (s.enabled) await ctx.adapter.act("disable", "paseo-cafe");
      await assertBytes(ctx, s.raw);
      await writeJson(await location(ctx), s.next);
      b.after = (await bytesOrNull(await location(ctx))).toString("base64");
      b.status = "written";
      await writeJson(file, b);
      if (s.enabled) await ctx.adapter.act("enable", "paseo-cafe");
      b.status = "complete";
      await writeJson(file, b);
      return { changed: true, backupId: id };
    } catch (e) {
      b.status = "failed";
      await writeJson(file, b);
      e.backupId = id;
      throw e;
    }
  });
}
async function backup(ctx, id) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid backup ID");
  const b = await jsonOrNull(
    await safeFile(ctx.state, `cafe-backups/${id}.json`),
  );
  if (!b) throw new Error("Cafe backup missing");
  return b;
}
export async function cafeRestorePlan(ctx, id) {
  const b = await backup(ctx, id),
    raw = await bytesOrNull(await location(ctx));
  const current = raw?.toString("base64") ?? null;
  return {
    backupId: id,
    approval: objectHash({ b, current }),
    conflicts:
      current !== b.after ? ["Cafe settings changed since this operation"] : [],
  };
}
export async function restoreCafe(ctx, id, approval) {
  return withOperation(ctx, async () => {
    const p = await cafeRestorePlan(ctx, id);
    if (p.approval !== approval || p.conflicts.length)
      throw new Error("Cafe restore is stale or conflicts with local settings");
    const b = await backup(ctx, id),
      row = (await ctx.adapter.list()).find((x) => x.id === "paseo-cafe");
    if (!row) throw new Error("Cafe no longer installed");
    if (row.enabled) await ctx.adapter.act("disable", "paseo-cafe");
    await assertBytes(ctx, b.after);
    if (b.before === null) {
      const { rm } = await import("node:fs/promises");
      await rm(await location(ctx), { force: true });
    } else
      await atomicWrite(await location(ctx), Buffer.from(b.before, "base64"));
    if (row.enabled) await ctx.adapter.act("enable", "paseo-cafe");
    b.status = "restored";
    await writeJson(await safeFile(ctx.state, `cafe-backups/${id}.json`), b);
    return { restored: true, backupId: id };
  });
}
