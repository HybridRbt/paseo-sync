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
const rowFor = async (ctx) =>
  (await ctx.adapter.list()).find((p) => p.id === "paseo-cafe");
const encode = (raw) => raw?.toString("base64") ?? null;
async function snapshot(ctx, ids) {
  const row = await rowFor(ctx);
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
      ? { version: 5, values: {} }
      : JSON.parse(raw.toString("utf8"));
  if (
    !Number.isInteger(data.version) ||
    data.version < 1 ||
    data.version > 5 ||
    !data.values ||
    typeof data.values !== "object" ||
    Array.isArray(data.values)
  )
    throw new Error("Unsupported Cafe settings document");
  const opt = data.values.autoUpdateOptOuts ?? [];
  const exclusions = [...new Set([...opt, ...ids])].sort();
  if (
    !Array.isArray(opt) ||
    exclusions.length > 500 ||
    !exclusions.every(
      (x) =>
        typeof x === "string" && /^[a-z][a-z0-9-]*$/.test(x) && x.length <= 100,
    )
  )
    throw new Error("Invalid or unsupported Cafe exclusion list");
  return {
    installed: true,
    missing: [...new Set(ids)].filter((id) => !opt.includes(id)).sort(),
    raw: encode(raw),
    enabled: row.enabled,
    next: {
      ...data,
      values: { ...data.values, autoUpdateOptOuts: exclusions },
    },
  };
}
const approvalFor = (ids, s) =>
  objectHash({ ids: [...ids].sort(), snapshot: s });
export async function cafePlan(ctx, ids) {
  const s = await snapshot(ctx, ids);
  return {
    installed: s.installed,
    missing: s.missing,
    approval: approvalFor(ids, s),
    exclusions: s.next?.values.autoUpdateOptOuts ?? [],
  };
}
async function assertBytes(ctx, expected) {
  if (encode(await bytesOrNull(await location(ctx))) !== expected)
    throw new Error("Cafe settings changed concurrently");
}
async function verifyEnabled(ctx, enabled) {
  const row = await rowFor(ctx);
  if (
    !row ||
    row.enabled !== enabled ||
    (enabled && row.status && row.status !== "running")
  )
    throw new Error(
      "Cafe enabled/runtime state does not match the operation target",
    );
  return row.enabled;
}
export async function applyCafe(ctx, ids, approval) {
  return withOperation(ctx, async () => {
    const s = await snapshot(ctx, ids);
    if (approvalFor(ids, s) !== approval)
      throw new Error("Cafe preview is stale");
    if (!s.missing.length) return { changed: false };
    const id = randomUUID(),
      file = await safeFile(ctx.state, `cafe-backups/${id}.json`),
      b = {
        id,
        before: s.raw,
        after: null,
        enabled: s.enabled,
        afterEnabled: s.enabled,
        status: "pending",
      };
    await writeJson(file, b);
    try {
      if (s.enabled) await ctx.adapter.act("disable", "paseo-cafe");
      await assertBytes(ctx, s.raw);
      await writeJson(await location(ctx), s.next);
      b.after = encode(await bytesOrNull(await location(ctx)));
      b.afterEnabled = false;
      b.status = "written";
      await writeJson(file, b);
      if (s.enabled) await ctx.adapter.act("enable", "paseo-cafe");
      b.afterEnabled = await verifyEnabled(ctx, s.enabled);
      b.status = "complete";
      await writeJson(file, b);
      return { changed: true, backupId: id };
    } catch (e) {
      b.status = "failed";
      b.afterEnabled = (await rowFor(ctx))?.enabled ?? null;
      b.error = e.message;
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
    current = encode(await bytesOrNull(await location(ctx))),
    row = await rowFor(ctx);
  const expected =
      b.status === "restore-failed" || b.status === "restored"
        ? b.restoreAfter
        : b.after,
    enabled =
      b.status === "restore-failed" || b.status === "restored"
        ? b.restoreEnabled
        : b.afterEnabled;
  const conflicts = [];
  if (!row || current !== expected || row.enabled !== enabled)
    conflicts.push(
      "Cafe settings or enabled state changed since this operation",
    );
  if (["pending", "restoring"].includes(b.status))
    conflicts.push("Interrupted Cafe backup requires inspection");
  return {
    backupId: id,
    approval: objectHash({ b, current, enabled: row?.enabled ?? null }),
    conflicts,
    restoreEnabled: b.enabled,
  };
}
export async function restoreCafe(ctx, id, approval) {
  return withOperation(ctx, async () => {
    const p = await cafeRestorePlan(ctx, id);
    if (p.approval !== approval || p.conflicts.length)
      throw new Error("Cafe restore is stale or conflicts with local settings");
    const b = await backup(ctx, id),
      row = await rowFor(ctx),
      file = await safeFile(ctx.state, `cafe-backups/${id}.json`);
    const expected =
      b.status === "restore-failed" || b.status === "restored"
        ? b.restoreAfter
        : b.after;
    if (!row) throw new Error("Cafe no longer installed");
    b.status = "restoring";
    await writeJson(file, b);
    try {
      if (row.enabled) await ctx.adapter.act("disable", "paseo-cafe");
      await assertBytes(ctx, expected);
      if (b.before === null) {
        const { rm } = await import("node:fs/promises");
        await rm(await location(ctx), { force: true });
      } else
        await atomicWrite(await location(ctx), Buffer.from(b.before, "base64"));
      if (b.enabled) await ctx.adapter.act("enable", "paseo-cafe");
      await verifyEnabled(ctx, b.enabled);
      b.restoreAfter = encode(await bytesOrNull(await location(ctx)));
      b.restoreEnabled = b.enabled;
      b.status = "restored";
      await writeJson(file, b);
      return { restored: true, backupId: id };
    } catch (e) {
      b.status = "restore-failed";
      b.error = e.message;
      b.restoreAfter = encode(await bytesOrNull(await location(ctx)));
      b.restoreEnabled = (await rowFor(ctx))?.enabled ?? null;
      await writeJson(file, b);
      e.backupId = id;
      throw e;
    }
  });
}
