import { sourceState } from "./source-state.mjs";
import { acquireOperation } from "./lock.mjs";
import { randomUUID } from "node:crypto";
import { readFile, mkdir, rm, lstat } from "node:fs/promises";
import path from "node:path";
import {
  safeFile,
  bytesOrNull,
  jsonOrNull,
  digest,
  objectHash,
  same,
  atomicWrite,
  writeJson,
  privateRoot,
} from "./files.mjs";
import {
  loadProfile,
  snapshotPlugin,
  pluginIdentity,
  patchText,
  validateSettings,
} from "./profile.mjs";

function skipMissingDisabled(ctx, current, target) {
  return (
    !!target &&
    !target.enabled &&
    !current.plugins[target.id] &&
    target.id !== "paseo-sync" &&
    target.id !== ctx.selfId &&
    !ctx.selfIds?.includes(target.id)
  );
}
function baseState(s) {
  return {
    plugins: Object.fromEntries(
      Object.entries(s.plugins).map(([id, p]) => [id, p?.descriptor ?? null]),
    ),
    settings: s.settings,
    patches: s.patches,
  };
}
async function settingsFile(ctx, s) {
  return safeFile(ctx.home, `plugin-settings/${s.plugin}/${s.document}.json`);
}
async function installedFile(ctx, row, name) {
  if (!path.isAbsolute(row.path))
    throw new Error("Installed plugin path must be absolute");
  const relative = path.relative(ctx.home, row.path);
  if (
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    !relative.split(path.sep).includes("plugins")
  )
    throw new Error(
      `Plugin path is outside local managed installations: ${row.id}`,
    );
  return safeFile(ctx.home, `${relative.split(path.sep).join("/")}/${name}`);
}
async function capture(ctx, profile) {
  const rows = await ctx.adapter.list();
  const byId = new Map(rows.map((r) => [r.id, r]));
  const config = await jsonOrNull(await safeFile(ctx.home, "config.json"));
  const plugins = {},
    settings = {},
    patches = {};
  for (const p of profile.manifest.plugins) {
    const row = byId.get(p.id);
    plugins[p.id] = row
      ? {
          descriptor: snapshotPlugin(row),
          path: row.path,
          status: row.status,
          sourceState: await sourceState(row, profile),
        }
      : null;
  }
  for (const s of profile.settings) {
    const raw = await bytesOrNull(await settingsFile(ctx, s));
    if (raw !== null)
      validateSettings(s.plugin, s.document, JSON.parse(raw.toString("utf8")));
    settings[s.file] = raw === null ? null : raw.toString("base64");
  }
  for (const bundle of profile.patches) {
    const row = byId.get(bundle.plugin);
    for (const file of bundle.data.files) {
      const raw = row
        ? await bytesOrNull(await installedFile(ctx, row, file.path))
        : null;
      patches[`${bundle.plugin}/${file.path}`] =
        raw === null ? null : raw.toString("base64");
    }
  }
  return {
    pluginsEnabled: config?.pluginsEnabled === true,
    plugins,
    settings,
    patches,
  };
}
const parsed = (raw) =>
  raw === null ? null : JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
function comparable(s, includeSource = true) {
  return {
    pluginsEnabled: s.pluginsEnabled,
    plugins: Object.fromEntries(
      Object.entries(s.plugins).map(([k, v]) => [
        k,
        v
          ? {
              descriptor: pluginIdentity(v.descriptor),
              status: v.status,
              ...(includeSource ? { sourceState: v.sourceState ?? null } : {}),
            }
          : null,
      ]),
    ),
    settings: s.settings,
    patches: s.patches,
  };
}
async function baseline(ctx) {
  return jsonOrNull(await safeFile(ctx.state, "baseline.json"));
}
function transitionConflict(now, target, selfId = "paseo-sync") {
  if (target.id === selfId || target.id === "paseo-sync")
    return `Self management is excluded: ${target.id}. Update this controller separately.`;
  if (!now)
    return !target.enabled
      ? `Cannot install disabled target ${target.id}: Paseo install immediately enables code.`
      : null;
  if (
    now.source !== target.source ||
    (now.pluginPath ?? ".") !== (target.pluginPath ?? ".")
  )
    return `Source change requires a separate migration: ${target.id}`;
  if (now.revision !== target.revision && now.registry)
    return `Exact registry version transition is not supported: ${target.id}. Review registry provenance separately; no reinstall will be attempted.`;
  return null;
}
async function planData(ctx) {
  await privateRoot(ctx.state);
  const profile = await loadProfile(ctx.root),
    current = await capture(ctx, profile),
    previous = await baseline(ctx);
  const conflicts = [],
    changes = [],
    skipped = [];
  if (!current.pluginsEnabled)
    conflicts.push(
      "pluginsEnabled is off; enable it explicitly in Paseo before applying.",
    );
  const localConflict = (label, now, old, wanted) => {
    if (
      previous &&
      old !== undefined &&
      !same(now, old) &&
      !same(now, wanted) &&
      !ctx.preferProfile
    )
      conflicts.push(
        `Local changes conflict with profile: ${label}. Export local changes or review --prefer-profile.`,
      );
  };
  for (const target of profile.manifest.plugins) {
    const currentPlugin = current.plugins[target.id],
      now = currentPlugin?.descriptor ?? null;
    const actions = [];
    if (skipMissingDisabled(ctx, current, target)) {
      skipped.push({ plugin: target.id, reason: "missing-disabled" });
      continue;
    }
    if (currentPlugin?.sourceState?.clean === false)
      conflicts.push(
        `Local source edits or dirty Git HEAD prevent synchronization: ${target.id}`,
      );
    const sameVersion =
      now &&
      same(
        { ...pluginIdentity(now), enabled: target.enabled },
        pluginIdentity(target),
      );
    localConflict(
      target.id,
      pluginIdentity(now),
      previous?.plugins?.[target.id] === undefined
        ? undefined
        : pluginIdentity(previous.plugins[target.id]),
      pluginIdentity(target),
    );
    const blocked = transitionConflict(
      now,
      target,
      ctx.selfIds?.includes(target.id) ? target.id : ctx.selfId,
    );
    if (blocked) conflicts.push(blocked);
    if (!sameVersion) actions.push(now ? "update" : "install");
    const bundle = profile.patches.find((x) => x.plugin === target.id);
    if (bundle) {
      let needsPatch = !sameVersion;
      for (const f of bundle.data.files) {
        const raw = current.patches[`${target.id}/${f.path}`];
        if (sameVersion) {
          if (raw === null)
            throw new Error(
              `Patch target changed or missing: ${target.id}/${f.path}`,
            );
          const bytes = Buffer.from(raw, "base64");
          patchText(bytes, f);
          if (digest(bytes) !== f.afterSha256) needsPatch = true;
        }
      }
      if (needsPatch) actions.push("patch");
    }
    for (const s of profile.settings.filter((x) => x.plugin === target.id)) {
      const nowValue = parsed(current.settings[s.file]);
      localConflict(
        s.file,
        nowValue,
        previous?.settings?.[s.file] === undefined
          ? undefined
          : parsed(previous.settings[s.file]),
        s.data,
      );
      if (!same(nowValue, s.data)) actions.push(`settings:${s.document}`);
    }
    if (now && now.enabled !== target.enabled)
      actions.push(target.enabled ? "enable" : "disable");
    if (
      now &&
      target.enabled &&
      currentPlugin.status !== "running" &&
      actions.length === 0
    )
      actions.push("reload");
    if (actions.length)
      changes.push({
        plugin: target.id,
        actions,
        from: now,
        to: target,
        settings: profile.settings
          .filter(
            (s) =>
              s.plugin === target.id &&
              !same(parsed(current.settings[s.file]), s.data),
          )
          .map((s) => ({
            document: s.document,
            before: parsed(current.settings[s.file]),
            after: s.data,
          })),
      });
  }
  const approval = objectHash({
    profile: profile.hash,
    current: comparable(current),
    previous,
    preferProfile: !!ctx.preferProfile,
  });
  const plan = {
    schemaVersion: 1,
    profileHash: profile.hash,
    approval,
    preferProfile: !!ctx.preferProfile,
    changes,
    skipped,
    conflicts,
    warnings: [
      "Plugin state here is daemon state; verify client UI after first install.",
      "Linear and GitHub credentials are local; functional sign-in is not certified by configuration verification.",
    ],
  };
  return { plan, profile, current, previous };
}
export async function buildPlan(ctx) {
  return (await planData(ctx)).plan;
}
async function saveBaseline(ctx, current, profile) {
  await writeJson(await safeFile(ctx.state, "baseline.json"), {
    schemaVersion: 1,
    profileHash: profile.hash,
    ...baseState(current),
  });
}
export async function captureBaseline(ctx, profile) {
  const current = await capture(ctx, profile);
  if (
    Object.values(current.plugins).some((p) => p?.sourceState?.clean === false)
  )
    throw new Error("Local source changed while preparing publish");
  for (const p of profile.manifest.plugins)
    if (
      !skipMissingDisabled(ctx, current, p) &&
      !same(
        pluginIdentity(current.plugins[p.id]?.descriptor),
        pluginIdentity(p),
      )
    )
      throw new Error("Local plugin state changed while preparing publish");
  for (const setting of profile.settings)
    if (
      !skipMissingDisabled(
        ctx,
        current,
        profile.manifest.plugins.find((p) => p.id === setting.plugin),
      ) &&
      !same(parsed(current.settings[setting.file]), setting.data)
    )
      throw new Error("Local settings changed while preparing publish");
  for (const bundle of profile.patches)
    for (const f of skipMissingDisabled(
      ctx,
      current,
      profile.manifest.plugins.find((p) => p.id === bundle.plugin),
    )
      ? []
      : bundle.data.files) {
      const raw = current.patches[`${bundle.plugin}/${f.path}`];
      if (raw === null || digest(Buffer.from(raw, "base64")) !== f.afterSha256)
        throw new Error("Local source patch changed while preparing publish");
    }
  return { schemaVersion: 1, profileHash: profile.hash, ...baseState(current) };
}
export async function verify(ctx) {
  const profile = await loadProfile(ctx.root),
    current = await capture(ctx, profile);
  const differences = [],
    runtime = [];
  for (const p of profile.manifest.plugins) {
    const c = current.plugins[p.id];
    if (skipMissingDisabled(ctx, current, p)) continue;
    if (!same(pluginIdentity(c?.descriptor), pluginIdentity(p)))
      differences.push(`plugin:${p.id}`);
    if (c?.sourceState?.clean === false) differences.push(`source:${p.id}`);
    if (p.enabled && c?.status !== "running")
      runtime.push({ plugin: p.id, status: c?.status ?? "missing" });
  }
  for (const s of profile.settings)
    if (
      !skipMissingDisabled(
        ctx,
        current,
        profile.manifest.plugins.find((p) => p.id === s.plugin),
      ) &&
      !same(parsed(current.settings[s.file]), s.data)
    )
      differences.push(s.file);
  for (const b of profile.patches)
    for (const f of skipMissingDisabled(
      ctx,
      current,
      profile.manifest.plugins.find((p) => p.id === b.plugin),
    )
      ? []
      : b.data.files) {
      const raw = current.patches[`${b.plugin}/${f.path}`];
      if (raw === null || digest(Buffer.from(raw, "base64")) !== f.afterSha256)
        differences.push(`patch:${b.plugin}/${f.path}`);
    }
  if (!current.pluginsEnabled)
    runtime.push({ plugin: "*", status: "pluginsEnabled=false" });
  return {
    configurationMatches: differences.length === 0,
    runtimeHealthy: runtime.length === 0,
    differences,
    runtime,
    credentialsVerified: false,
    clientUiVerified: false,
  };
}
async function backupFile(ctx, id) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid backup ID");
  return safeFile(ctx.state, `backups/${id}.json`);
}
export async function applyPlan(ctx, approval) {
  await privateRoot(ctx.state);
  const release = await acquireOperation(ctx);
  let backup = null,
    filename = null;
  try {
    const data = await planData(ctx);
    const { plan, profile, current, previous } = data;
    if (approval !== plan.approval)
      throw new Error(
        "Plan is stale. Run plan again and review its differences.",
      );
    if (plan.conflicts.length) throw new Error(plan.conflicts.join("\n"));
    if (plan.changes.length === 0) {
      await saveBaseline(ctx, current, profile);
      return {
        changed: false,
        backupId: null,
        verification: await verify(ctx),
      };
    }
    const id = randomUUID();
    filename = await backupFile(ctx, id);
    backup = {
      schemaVersion: 1,
      id,
      home: path.resolve(ctx.home),
      profile,
      before: current,
      previous,
      status: "pending",
      after: null,
    };
    await writeJson(filename, backup);
    for (const change of plan.changes) {
      backup.phase = `plugin:${change.plugin}`;
      await writeJson(filename, backup);
      const id = change.plugin,
        target = profile.manifest.plugins.find((x) => x.id === id),
        before = current.plugins[id];
      const affectedSettings = profile.settings.filter((s) => s.plugin === id),
        bundle = profile.patches.find((x) => x.plugin === id);
      if (before?.descriptor.enabled) await ctx.adapter.act("disable", id);
      // A client may have saved while disable was in flight. Compare exact bytes.
      for (const s of affectedSettings) {
        const raw = await bytesOrNull(await settingsFile(ctx, s));
        if (
          (raw === null ? null : raw.toString("base64")) !==
          current.settings[s.file]
        )
          throw new Error(`Settings changed concurrently while stopping ${id}`);
      }
      if (change.actions.includes("install")) {
        await ctx.adapter.install(target);
        const row = (await ctx.adapter.list()).find((x) => x.id === id);
        if (!row) throw new Error(`Install returned no plugin: ${id}`);
        if (row.enabled) await ctx.adapter.act("disable", id);
      }
      if (change.actions.includes("update")) {
        const latest = (await ctx.adapter.list()).find((p) => p.id === id);
        if (
          !latest ||
          !same(await sourceState(latest, profile), before.sourceState ?? null)
        )
          throw new Error(`Local source changed while stopping ${id}`);
        await ctx.adapter.update(target);
      }
      const row = (await ctx.adapter.list()).find((x) => x.id === id);
      if (!row) throw new Error(`Missing plugin after install: ${id}`);
      const installed = snapshotPlugin(row);
      if (
        !same(
          { ...pluginIdentity(installed), enabled: target.enabled },
          pluginIdentity(target),
        )
      )
        throw new Error(`Installed revision/source mismatch: ${id}`);
      if (bundle) {
        const writes = [];
        for (const f of bundle.data.files) {
          const file = await installedFile(ctx, row, f.path),
            raw = await readFile(file);
          writes.push({ file, raw, next: patchText(raw, f) });
        }
        for (const w of writes)
          if (!w.raw.equals(w.next)) await atomicWrite(w.file, w.next);
      }
      for (const s of affectedSettings) {
        const file = await settingsFile(ctx, s),
          raw = await bytesOrNull(file);
        // Installation may recreate defaults. Preserve the original check for same-version changes.
        if (
          (raw === null ? null : raw.toString("base64")) !==
          current.settings[s.file]
        )
          throw new Error(
            `Settings changed concurrently before write: ${s.file}`,
          );
        if (
          !same(raw === null ? null : JSON.parse(raw.toString("utf8")), s.data)
        )
          await writeJson(file, s.data);
      }
      if (target.enabled) await ctx.adapter.act("enable", id);
    }
    const verification = await verify(ctx);
    backup.after = await capture(ctx, profile);
    if (!verification.configurationMatches || !verification.runtimeHealthy)
      throw new Error(`Verification failed: ${JSON.stringify(verification)}`);
    backup.status = "complete";
    await writeJson(filename, backup);
    await saveBaseline(ctx, backup.after, profile);
    return {
      changed: true,
      backupId: backup.id,
      backupFile: filename,
      verification,
    };
  } catch (error) {
    if (backup) {
      backup.status = "failed";
      backup.error = error.message;
      try {
        backup.after = await capture(ctx, backup.profile);
      } catch {
        backup.after = null;
      }
      await writeJson(filename, backup);
      error.backupId = backup.id;
      error.backupFile = filename;
    }
    throw error;
  } finally {
    await release();
  }
}
export async function restorePlan(ctx, id) {
  const b = await jsonOrNull(await backupFile(ctx, id));
  if (!b || b.schemaVersion !== 1 || b.home !== path.resolve(ctx.home))
    throw new Error("Backup is missing or belongs to another Paseo home");
  const current = await capture(ctx, b.profile);
  const includesSourceMetadata =
    b.after !== null &&
    Object.values(b.after.plugins)
      .filter(Boolean)
      .every((p) => Object.hasOwn(p, "sourceState"));
  const conflicts = [];
  if (b.after === null || b.status === "pending" || b.status === "restoring")
    conflicts.push(
      "Interrupted backup has no verified final state; inspect daemon state before restoring.",
    );
  for (const [plugin, before] of Object.entries(b.before.plugins)) {
    const now = current.plugins[plugin];
    if (now?.sourceState?.clean === false)
      conflicts.push(`Local source edits prevent restoring ${plugin}`);
    if (before) {
      const conflict = transitionConflict(
        now?.descriptor ?? null,
        before.descriptor,
        ctx.selfIds?.includes(plugin) ? plugin : ctx.selfId,
      );
      if (conflict) conflicts.push(conflict);
    }
  }
  return {
    backupId: id,
    changes: b.profile.manifest.plugins.map((p) => ({
      plugin: p.id,
      actions: ["restore"],
      from: current.plugins[p.id]?.descriptor ?? null,
      to: b.before.plugins[p.id]?.descriptor ?? { ...p, enabled: false },
      settings: b.profile.settings
        .filter((s) => s.plugin === p.id)
        .map((s) => ({
          document: s.document,
          before: parsed(current.settings[s.file]),
          after: parsed(b.before.settings[s.file]),
        })),
    })),
    approval: objectHash({ backup: b, current: comparable(current) }),
    conflicts,
    currentChangedSinceBackup:
      b.after !== null &&
      !same(
        comparable(current, includesSourceMetadata),
        comparable(b.after, includesSourceMetadata),
      ),
    warnings: [
      "Restore may reinstall previous pinned versions using the network. New plugins are disabled and retained to preserve their data.",
    ],
    _backup: b,
    _current: current,
  };
}
export async function restore(ctx, id, approval) {
  await privateRoot(ctx.state);
  const release = await acquireOperation(ctx);
  let backup = null;
  try {
    const preview = await restorePlan(ctx, id);
    if (preview.approval !== approval) throw new Error("Restore plan is stale");
    if (preview.conflicts.length) throw new Error(preview.conflicts.join("\n"));
    if (preview.currentChangedSinceBackup)
      throw new Error(
        "Current managed data changed after the operation; resolve those changes before restoring.",
      );
    const b = preview._backup;
    backup = b;
    b.operationAfter ??= b.after;
    b.status = "restoring";
    b.phase = "restore:start";
    await writeJson(await backupFile(ctx, id), b);
    const assertCurrentSettings = async (plugin) => {
      for (const s of b.profile.settings.filter((x) => x.plugin === plugin)) {
        const raw = await bytesOrNull(await settingsFile(ctx, s));
        if (
          (raw === null ? null : raw.toString("base64")) !==
          preview._current.settings[s.file]
        )
          throw new Error(
            `Settings changed concurrently while restoring: ${s.file}`,
          );
      }
    };
    for (const target of b.profile.manifest.plugins) {
      b.phase = `restore:${target.id}`;
      await writeJson(await backupFile(ctx, id), b);
      const before = b.before.plugins[target.id];
      let row = (await ctx.adapter.list()).find((x) => x.id === target.id);
      if (row?.enabled) await ctx.adapter.act("disable", target.id);
      if (
        row &&
        !same(
          await sourceState(row, b.profile),
          preview._current.plugins[target.id]?.sourceState ?? null,
        )
      )
        throw new Error(
          `Local source changed while stopping ${target.id} for restore`,
        );
      await assertCurrentSettings(target.id);
      if (!before) {
        for (const s of b.profile.settings.filter(
          (x) => x.plugin === target.id,
        )) {
          await assertCurrentSettings(target.id);
          const file = await settingsFile(ctx, s),
            raw = b.before.settings[s.file];
          if (raw === null) await rm(file, { force: true });
          else await atomicWrite(file, Buffer.from(raw, "base64"));
        }
        continue;
      }
      if (
        !row ||
        !same(
          {
            ...pluginIdentity(snapshotPlugin(row)),
            enabled: before.descriptor.enabled,
          },
          pluginIdentity(before.descriptor),
        )
      ) {
        if (row) await ctx.adapter.update(before.descriptor);
        else await ctx.adapter.install(before.descriptor);
        row = (await ctx.adapter.list()).find((x) => x.id === target.id);
        if (row?.enabled) await ctx.adapter.act("disable", target.id);
        await assertCurrentSettings(target.id);
      }
      for (const bundle of b.profile.patches.filter(
        (x) => x.plugin === target.id,
      ))
        for (const f of bundle.data.files) {
          const raw = b.before.patches[`${target.id}/${f.path}`];
          if (raw !== null)
            await atomicWrite(
              await installedFile(ctx, row, f.path),
              Buffer.from(raw, "base64"),
            );
        }
      for (const s of b.profile.settings.filter(
        (x) => x.plugin === target.id,
      )) {
        await assertCurrentSettings(target.id);
        const file = await settingsFile(ctx, s),
          raw = b.before.settings[s.file];
        if (raw === null) await rm(file, { force: true });
        else await atomicWrite(file, Buffer.from(raw, "base64"));
      }
      if (before.descriptor.enabled) await ctx.adapter.act("enable", target.id);
    }
    const restored = await capture(ctx, b.profile);
    for (const p of b.profile.manifest.plugins)
      if (b.before.plugins[p.id]) {
        if (
          !same(
            pluginIdentity(restored.plugins[p.id]?.descriptor),
            pluginIdentity(b.before.plugins[p.id].descriptor),
          )
        )
          throw new Error(`Restore verification failed: ${p.id}`);
        for (const s of b.profile.settings.filter((x) => x.plugin === p.id))
          if (restored.settings[s.file] !== b.before.settings[s.file])
            throw new Error(`Restore settings mismatch: ${s.file}`);
        for (const bundle of b.profile.patches.filter((x) => x.plugin === p.id))
          for (const f of bundle.data.files) {
            const key = `${p.id}/${f.path}`;
            if (
              b.before.patches[key] !== null &&
              restored.patches[key] !== b.before.patches[key]
            )
              throw new Error(`Restore patch mismatch: ${key}`);
          }
      }
    if (b.previous)
      await writeJson(await safeFile(ctx.state, "baseline.json"), b.previous);
    else await rm(await safeFile(ctx.state, "baseline.json"), { force: true });
    b.status = "restored";
    b.after = restored;
    await writeJson(await backupFile(ctx, id), b);
    return {
      restored: true,
      backupId: id,
      retainedDisabledPlugins: b.profile.manifest.plugins
        .filter((p) => !b.before.plugins[p.id])
        .map((p) => p.id),
    };
  } catch (error) {
    if (backup) {
      backup.status = "restore-failed";
      backup.error = error.message;
      try {
        backup.after = await capture(ctx, backup.profile);
      } catch {
        backup.after = null;
      }
      await writeJson(await backupFile(ctx, id), backup);
      error.backupId = id;
    }
    throw error;
  } finally {
    await release();
  }
}
