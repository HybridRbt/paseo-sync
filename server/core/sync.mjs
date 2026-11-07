import { sourceState } from "./source-state.mjs";
import { acquireOperation } from "./lock.mjs";
import { randomUUID } from "node:crypto";
import {
  readFile,
  readdir,
  mkdir,
  rm,
  lstat,
  writeFile,
  rename,
  realpath,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
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
import {
  unpackBundle,
  packPluginDirectory,
  attachPatchOriginalBytes,
  BUNDLE_MARKER,
  resolveBundleArchive,
} from "./bundle.mjs";

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
// A skipped target is outside this operation's recovery scope, even if another
// process changes or installs it while the other targets are being synchronized.
function recoveryScope(profile, current, skipped) {
  const ignored = new Set(skipped.map((s) => s.plugin));
  const manifest = {
    ...profile.manifest,
    plugins: profile.manifest.plugins.filter((p) => !ignored.has(p.id)),
    settings: profile.manifest.settings.filter((s) => !ignored.has(s.plugin)),
    patches: profile.manifest.patches.filter((p) => !ignored.has(p.plugin)),
  };
  const settings = profile.settings.filter((s) => !ignored.has(s.plugin));
  const patches = profile.patches.filter((p) => !ignored.has(p.plugin));
  const activeProfile = {
    manifest,
    settings,
    patches,
    hash: objectHash({ manifest, settings, patches }),
  };
  const files = new Set(settings.map((s) => s.file));
  return {
    profile: activeProfile,
    before: {
      ...current,
      plugins: Object.fromEntries(
        Object.entries(current.plugins).filter(([id]) => !ignored.has(id)),
      ),
      settings: Object.fromEntries(
        Object.entries(current.settings).filter(([file]) => files.has(file)),
      ),
      patches: Object.fromEntries(
        Object.entries(current.patches).filter(
          ([key]) => !ignored.has(key.split("/")[0]),
        ),
      ),
    },
  };
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
// A plugin skipped by an operation was not synchronized by it. Recording its
// current, unsynchronized state as the baseline would erase local-change
// protection: once the source is clean again, a later apply would silently
// overwrite local settings instead of reporting localConflict. The skipped
// plugin keeps its previous baseline entries instead.
function preserveSkippedBaseline(state, previous, profile, ids) {
  for (const id of ids) {
    if (previous?.plugins && Object.hasOwn(previous.plugins, id))
      state.plugins[id] = previous.plugins[id];
    else delete state.plugins[id];
    for (const file of Object.keys(state.settings))
      if (
        file.startsWith(`settings/${id}/`) ||
        profile.settings.some((s) => s.plugin === id && s.file === file)
      )
        delete state.settings[file];
    if (previous?.settings)
      for (const [file, val] of Object.entries(previous.settings))
        if (
          file.startsWith(`settings/${id}/`) ||
          profile.settings.some((s) => s.plugin === id && s.file === file)
        )
          state.settings[file] = val;
    for (const key of Object.keys(state.patches))
      if (key.startsWith(`${id}/`)) delete state.patches[key];
    if (previous?.patches)
      for (const [key, val] of Object.entries(previous.patches))
        if (key.startsWith(`${id}/`)) state.patches[key] = val;
  }
  return state;
}
async function settingsFile(ctx, s) {
  return safeFile(ctx.home, `plugin-settings/${s.plugin}/${s.document}.json`);
}
// Removing an installation deletes its settings directory, and the profile
// only manages its allowlisted documents: every other settings file under
// the plugin's directory is host-only data that a reinstall must capture
// before removal and rewrite after installation.
async function readHostOnlySettings(ctx, profile, plugin) {
  const managed = new Set(
    profile.settings
      .filter((s) => s.plugin === plugin)
      .map((s) => `${s.document}.json`),
  );
  const captured = {};
  let names = [];
  try {
    names = await readdir(await safeFile(ctx.home, `plugin-settings/${plugin}`));
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  for (const name of names) {
    if (managed.has(name) || !name.endsWith(".json")) continue;
    const raw = await bytesOrNull(
      await safeFile(ctx.home, `plugin-settings/${plugin}/${name}`),
    );
    if (raw !== null) captured[name] = raw.toString("base64");
  }
  return captured;
}
async function writeHostOnlySettings(ctx, plugin, captured) {
  for (const [name, b64] of Object.entries(captured ?? {}))
    await atomicWrite(
      await safeFile(ctx.home, `plugin-settings/${plugin}/${name}`),
      Buffer.from(b64, "base64"),
    );
}
// An operation that died between its removal and the host-only rewrite
// leaves the captured documents deleted on disk; recover exactly those,
// never touching documents that exist now (later local edits, or defaults
// recreated by a reinstall).
async function recoverHostOnlySettings(ctx, plugin, captured, recreated = {}) {
  for (const [name, b64] of Object.entries(captured ?? {})) {
    const file = await safeFile(ctx.home, `plugin-settings/${plugin}/${name}`);
    const raw = await bytesOrNull(file);
    // Missing documents are recovered outright. Documents the incomplete
    // installation recreated with defaults are recovered while their bytes
    // still match what that installation wrote; anything else is a later
    // local edit and stays untouched.
    const installDefaults =
      Object.hasOwn(recreated, name) &&
      raw !== null &&
      raw.toString("base64") === recreated[name];
    if (raw === null || installDefaults)
      await atomicWrite(file, Buffer.from(b64, "base64"));
  }
}
async function installedFile(ctx, row, name) {
  if (!path.isAbsolute(row.path))
    throw new Error("Installed plugin path must be absolute");
  const relative = path.relative(ctx.home, row.path);
  const segments = relative.split(path.sep);
  if (
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    (!segments.includes("plugins") && !segments.includes("local-plugins"))
  )
    throw new Error(
      `Plugin path is outside local managed installations: ${row.id}`,
    );
  return safeFile(ctx.home, `${segments.join("/")}/${name}`);
}
// A plugin root that is itself a symlink is refused before destinations are
// derived from its spelling: rename() moves the link itself, so consuming
// such a spelling would split the installation out of the managed area.
async function symlinkedRoot(p) {
  try {
    return (await lstat(p)).isSymbolicLink();
  } catch {
    return false; // missing or unreachable roots stay with the other checks
  }
}

export async function isManagedLocalPath(home, pluginPath) {
  if (!pluginPath || !path.isAbsolute(pluginPath)) return false;
  // Managing is a real-location decision, like the other prefix-relative
  // comparisons: row.path from the daemon and the home spelling may both
  // carry symlink components (a linked home or macOS /var checkouts), so
  // both sides resolve to their real locations before comparing. A link
  // inside local-plugins escaping the boundary groups as unmanaged, a
  // missing local-plugins root or missing plugin path is not managed, and
  // neither is a plugin root that is itself a symlink: bundle updates
  // rename the destination, so renaming a link spelling would consume the
  // alias and republish the bundle as a separate copy outside the managed
  // area (Codex P2 on PR #23). That joins the safeFile/prepareRepository
  // invariants — links in ancestor components still resolve.
  const local = path.join(home, "local-plugins");
  let actualLocal, actualPlugin, rootStat;
  try {
    [actualLocal, actualPlugin, rootStat] = await Promise.all([
      realpath(local),
      realpath(pluginPath),
      lstat(pluginPath),
    ]);
  } catch {
    return false;
  }
  if (rootStat?.isSymbolicLink()) return false;
  const rel = path.relative(actualLocal, actualPlugin);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

export async function hasBundleMarker(pluginPath) {
  if (!pluginPath) return false;
  try {
    const raw = await bytesOrNull(path.join(pluginPath, BUNDLE_MARKER));
    if (!raw) return false;
    const meta = JSON.parse(raw.toString("utf8"));
    return Boolean(meta?.source?.startsWith("bundle:") && meta?.revision);
  } catch {
    return false;
  }
}

async function resolvePluginDescriptor(
  row,
  target,
  profile = null,
  ctx = null,
) {
  if (!row) return null;
  try {
    return snapshotPlugin(row);
  } catch {}
  if (
    target?.source?.startsWith("bundle:") &&
    row.installation?.identity?.kind === "directory" &&
    row.path
  ) {
    try {
      const patchSpecs = (
        profile?.patches
          ?.filter((b) => b.plugin === row.id)
          .flatMap((b) => b.data?.files ?? []) ?? []
      ).map((f) => ({ ...f }));
      await attachPatchOriginalBytes(ctx, target, patchSpecs);
      const packed = await packPluginDirectory(row.path, {
        patches: patchSpecs,
      });
      return {
        id: row.id,
        source: target.source,
        revision: packed.sha256,
        enabled: row.enabled,
      };
    } catch {}
  }
  return null;
}

function bundleCacheFile(ctx, pluginId, revision) {
  return path.join(ctx.state, "bundles", `${pluginId}-${revision}.tar.gz`);
}

async function getBundleArchive(ctx, target) {
  return resolveBundleArchive(ctx, target);
}

async function cacheBundleArchive(ctx, pluginId, revision, buffer) {
  if (!ctx.state) return;
  const cachedFile = bundleCacheFile(ctx, pluginId, revision);
  if (!(await bytesOrNull(cachedFile))) {
    await mkdir(path.dirname(cachedFile), { recursive: true });
    await atomicWrite(cachedFile, buffer);
  }
}

export async function installOrUpdateBundlePlugin(
  ctx,
  target,
  isUpdate = false,
  existingPath = null,
) {
  const destDir =
    isUpdate && existingPath && (await isManagedLocalPath(ctx.home, existingPath))
      ? existingPath
      : path.join(ctx.home, "local-plugins", target.id);

  if (isUpdate) {
    // Refuse a plugin root that is itself a symlink before authorizing the
    // update (Codex P2 on PR #23): rename() would move the link and replace
    // it with a staged copy, consuming the alias while the real managed
    // installation stays stale. Refusing the spelling at the plugin root is
    // explicit and distinct from an external checkout, which the check below
    // keeps reporting for other unmanaged locations.
    if (existingPath && (await symlinkedRoot(existingPath))) {
      throw new Error(
        `Cannot update a plugin directory whose root is a symlink: ${target.id} (${existingPath})`,
      );
    }
    if (!existingPath || !(await isManagedLocalPath(ctx.home, existingPath))) {
      throw new Error(
        `Cannot update external plugin checkout with bundle: ${target.id} (${existingPath})`,
      );
    }
    if (!(await hasBundleMarker(existingPath))) {
      throw new Error(
        `Cannot overwrite unmarked plugin directory with bundle: ${target.id} (${existingPath})`,
      );
    }
  } else if (existsSync(destDir) && !(await hasBundleMarker(destDir))) {
    throw new Error(
      `Cannot overwrite unmarked plugin directory with bundle: ${target.id} (${destDir})`,
    );
  }

  // Preserve previous bundle archive before replacing it so restore can roll back (Review #1)
  if (isUpdate && existingPath && (await isManagedLocalPath(ctx.home, existingPath))) {
    try {
      const metaFile = path.join(existingPath, BUNDLE_MARKER);
      const rawMeta = await bytesOrNull(metaFile);
      if (rawMeta) {
        const meta = JSON.parse(rawMeta.toString("utf8"));
        if (meta.revision) {
          const prevCacheFile = bundleCacheFile(ctx, target.id, meta.revision);
          if (!(await bytesOrNull(prevCacheFile))) {
            const packed = await packPluginDirectory(existingPath);
            if (packed.sha256 === meta.revision) {
              await cacheBundleArchive(ctx, target.id, meta.revision, packed.buffer);
            }
          }
        }
      }
    } catch {}
  }

  const raw = await getBundleArchive(ctx, target);
  if (!raw) {
    throw new Error(
      `Bundle archive not found or hash mismatch for ${target.id}: expected ${target.revision}`,
    );
  }

  await mkdir(path.dirname(destDir), { recursive: true });
  const stageDir = path.join(
    path.dirname(destDir),
    `.${path.basename(destDir)}.stage-${randomUUID()}`,
  );
  try {
    const unpacked = await unpackBundle(raw, stageDir);
    await writeFile(
      path.join(stageDir, BUNDLE_MARKER),
      JSON.stringify(
        {
          source: target.source,
          revision: target.revision,
          files: unpacked.files,
        },
        null,
        2,
      ),
      "utf8",
    );
  } catch (err) {
    await rm(stageDir, { recursive: true, force: true });
    throw err;
  }

  const backupDir = existsSync(destDir)
    ? path.join(
        path.dirname(destDir),
        `.${path.basename(destDir)}.bak-${randomUUID()}`,
      )
    : null;
  if (backupDir) {
    await rename(destDir, backupDir);
  }
  try {
    await rename(stageDir, destDir);
  } catch (err) {
    await rm(stageDir, { recursive: true, force: true });
    if (backupDir && existsSync(backupDir) && !existsSync(destDir)) {
      try {
        await rename(backupDir, destDir);
      } catch {}
    }
    throw err;
  }
  if (backupDir) {
    await rm(backupDir, { recursive: true, force: true });
  }
  await cacheBundleArchive(ctx, target.id, target.revision, raw);

  if (!isUpdate) {
    await ctx.adapter.install({ ...target, source: destDir });
  } else {
    if (typeof ctx.adapter.reload === "function") {
      await ctx.adapter.reload(target.id);
    } else if (typeof ctx.adapter.act === "function") {
      try {
        await ctx.adapter.act("reload", target.id);
      } catch {}
    }
  }
  return destDir;
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
    const descriptor = await resolvePluginDescriptor(row, p, profile, ctx);
    plugins[p.id] = row
      ? {
          descriptor,
          path: row.path,
          status: row.status,
          sourceState: await sourceState(row, profile),
        }
      : null;
  }
  for (const s of profile.settings) {
    const file = await settingsFile(ctx, s);
    if (
      skipMissingDisabled(
        ctx,
        { plugins },
        profile.manifest.plugins.find((p) => p.id === s.plugin),
      )
    ) {
      settings[s.file] = null;
      continue;
    }
    const raw = await bytesOrNull(file);
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
function backupDrift(a, c, currentState = null) {
  if (!a || !c) return null;
  if (same(a, c)) return null;

  const plugins = [];
  const source = [];
  const settings = [];

  const allPluginIds = new Set([
    ...Object.keys(a.plugins),
    ...Object.keys(c.plugins),
  ]);
  for (const id of allPluginIds) {
    const ap = a.plugins[id];
    const cp = c.plugins[id];
    if (same(ap, cp)) continue;

    const apDesc = ap ? { descriptor: ap.descriptor, status: ap.status } : null;
    const cpDesc = cp ? { descriptor: cp.descriptor, status: cp.status } : null;

    if (!same(ap?.sourceState, cp?.sourceState)) {
      const curPlugin = currentState?.plugins?.[id];
      const curSource = cp?.sourceState;
      const prevSource = ap?.sourceState;
      const isDirty = curSource?.clean === false;
      const headMismatch =
        Boolean(curSource?.head && curPlugin?.descriptor?.revision) &&
        curSource.head !== curPlugin.descriptor.revision;
      if (isDirty || headMismatch) {
        const reason = isDirty
          ? (headMismatch ? "head-differs" : "local-source-changes")
          : "head-differs";
        source.push({
          plugin: id,
          reason,
          files: curSource?.changed ?? [],
          head: curSource?.head ?? null,
          checkout: curPlugin?.path ?? null,
        });
      } else if (prevSource?.clean === false) {
        source.push({
          plugin: id,
          reason: "recorded-source-dirty",
          files: prevSource?.changed ?? [],
          head: curSource?.head ?? prevSource?.head ?? null,
          checkout: curPlugin?.path ?? null,
        });
      } else if (same(apDesc, cpDesc) && prevSource?.head !== curSource?.head) {
        source.push({
          plugin: id,
          reason: "head-differs",
          files: [],
          head: curSource?.head ?? null,
          checkout: curPlugin?.path ?? null,
        });
      }
    }

    if (!same(apDesc, cpDesc)) {
      plugins.push({
        plugin: id,
        from: apDesc,
        to: cpDesc,
      });
    }
  }

  const allSettingsFiles = new Set([
    ...Object.keys(a.settings || {}),
    ...Object.keys(c.settings || {}),
  ]);
  for (const file of allSettingsFiles) {
    if (!same(a.settings[file], c.settings[file])) {
      settings.push(file);
    }
  }

  const allPatchKeys = new Set([
    ...Object.keys(a.patches || {}),
    ...Object.keys(c.patches || {}),
  ]);
  const patches = [];
  for (const key of allPatchKeys) {
    if (!same(a.patches[key], c.patches[key])) {
      patches.push(key);
    }
  }

  return {
    plugins,
    source,
    settings,
    patches,
    ...(a.pluginsEnabled !== c.pluginsEnabled
      ? { pluginsEnabled: { from: a.pluginsEnabled, to: c.pluginsEnabled } }
      : {}),
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
    // A profile target can collide with an untracked or local-development
    // installation whose descriptor cannot be snapshotted. Presenting it as
    // an absent plugin offered a conflict-free install whose confirmation
    // crashed on the null descriptor, and whose failed capture stored unusable
    // backups; disclose the installation (exactly like publishing does) and
    // leave it untouched instead.
    if (currentPlugin && !currentPlugin.descriptor) {
      skipped.push({
        plugin: target.id,
        reason: "untracked",
        checkout: currentPlugin.path,
      });
      continue;
    }
    // Reconciling a dirty local Git source with the profile would destroy the
    // local edits (update replaces the whole checkout), so the plugin is
    // skipped with its dirtiness disclosed, exactly like publish, and
    // everything else synchronizes.
    if (currentPlugin?.sourceState?.clean === false) {
      skipped.push(
        currentPlugin.sourceState.head === now?.revision
          ? {
              plugin: target.id,
              reason: "local-source-changes",
              files: currentPlugin.sourceState.changed,
              checkout: currentPlugin.path,
            }
          : {
              plugin: target.id,
              reason: "head-differs",
              head: currentPlugin.sourceState.head,
              revision: now?.revision,
              checkout: currentPlugin.path,
            },
      );
      continue;
    }
    // An external or unmarked directory checkout must not be overwritten or
    // converted into a bundle in local-plugins: skip it with its checkout
    // disclosed, preserving the developer's working directory.
    if (
      currentPlugin?.path &&
      target.source.startsWith("bundle:") &&
      (!(await isManagedLocalPath(ctx.home, currentPlugin.path)) ||
        !(await hasBundleMarker(currentPlugin.path)))
    ) {
      if (now?.revision !== target.revision) {
        skipped.push({
          plugin: target.id,
          reason: "local-source-changes",
          checkout: currentPlugin.path,
          files: [],
        });
        continue;
      }
    }
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
    const selfId = ctx.selfIds?.includes(target.id) ? target.id : ctx.selfId;
    const blocked = transitionConflict(
      now,
      target,
      selfId,
    );
    // An exact registry version transition cannot be expressed as an in-place
    // update (the daemon only offers approved registry upgrades). Under
    // preferProfile it stays a disclosed skip; the explicit reinstall mode
    // aligns it by removing and reinstalling the profile's pinned
    // revision instead.
    const registryTransition =
      blocked &&
      ctx.preferProfile &&
      now &&
      now.revision !== target.revision &&
      now.registry &&
      now.source === target.source &&
      (now.pluginPath ?? ".") === (target.pluginPath ?? ".") &&
      target.id !== selfId &&
      target.id !== "paseo-sync";
    // Installing immediately enables code, so a target the profile wants
    // disabled is never reinstalled (the missing-disabled guard blocks the
    // same transition for absent plugins); it keeps the disclosed skip.
    if (registryTransition && !(ctx.reinstallRegistry && target.enabled)) {
      skipped.push({
        plugin: target.id,
        reason: "registry-version-transition",
        head: now.revision,
        revision: target.revision,
      });
      continue;
    }
    // A registry transition handled as a reinstall is disclosed by its
    // change entry, not as a blocking conflict.
    if (blocked && !registryTransition) conflicts.push(blocked);
    if (!sameVersion)
      actions.push(
        registryTransition ? "reinstall" : now ? "update" : "install",
      );
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
    reinstallRegistry: !!ctx.reinstallRegistry,
  });
  const plan = {
    schemaVersion: 1,
    profileHash: profile.hash,
    approval,
    preferProfile: !!ctx.preferProfile,
    reinstallRegistry: !!ctx.reinstallRegistry,
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
async function saveBaseline(ctx, profile, state) {
  await writeJson(await safeFile(ctx.state, "baseline.json"), {
    schemaVersion: 1,
    profileHash: profile.hash,
    ...state,
  });
}
export async function captureBaseline(ctx, profile, skipIds = new Set()) {
  const current = await capture(ctx, profile);
  if (
    Object.entries(current.plugins).some(
      ([id, p]) => !skipIds.has(id) && p?.sourceState?.clean === false,
    )
  )
    throw new Error("Local source changed while preparing publish");
  for (const p of profile.manifest.plugins)
    if (
      !skipIds.has(p.id) &&
      !skipMissingDisabled(ctx, current, p) &&
      !same(
        pluginIdentity(current.plugins[p.id]?.descriptor),
        pluginIdentity(p),
      )
    )
      throw new Error("Local plugin state changed while preparing publish");
  for (const setting of profile.settings)
    if (
      !skipIds.has(setting.plugin) &&
      !skipMissingDisabled(
        ctx,
        current,
        profile.manifest.plugins.find((p) => p.id === setting.plugin),
      ) &&
      !same(parsed(current.settings[setting.file]), setting.data)
    )
      throw new Error("Local settings changed while preparing publish");
  for (const bundle of profile.patches)
    if (skipIds.has(bundle.plugin)) continue;
    else
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
  return {
    schemaVersion: 1,
    profileHash: profile.hash,
    ...preserveSkippedBaseline(
      baseState(current),
      await baseline(ctx),
      profile,
      skipIds,
    ),
  };
}
// A plugin skipped by an operation (dirty source, missing-disabled) is outside
// that operation's verified scope: its acknowledged divergence must not fail
// the verification of everything that was applied.
export async function verify(ctx, skip = new Set()) {
  const profile = await loadProfile(ctx.root),
    current = await capture(ctx, profile);
  const differences = [],
    runtime = [];
  for (const p of profile.manifest.plugins) {
    const c = current.plugins[p.id];
    if (skipMissingDisabled(ctx, current, p) || skip.has(p.id)) continue;
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
      !skip.has(s.plugin) &&
      !same(parsed(current.settings[s.file]), s.data)
    )
      differences.push(s.file);
  for (const b of profile.patches) {
    const owner = profile.manifest.plugins.find((p) => p.id === b.plugin);
    const files =
      skipMissingDisabled(ctx, current, owner) || skip.has(b.plugin)
        ? []
        : b.data.files;
    for (const f of files) {
      const raw = current.patches[`${b.plugin}/${f.path}`];
      if (raw === null || digest(Buffer.from(raw, "base64")) !== f.afterSha256)
        differences.push(`patch:${b.plugin}/${f.path}`);
    }
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
    const skippedIds = new Set(plan.skipped.map((s) => s.plugin));
    // Dirty-skipped plugins were not synchronized by this operation, in either
    // the skip-only or the mixed-operation path, so their baseline entries keep
    // recording the last synchronized state. missing-disabled skips keep their
    // existing baseline behavior.
    const dirtySkipped = new Set(
      plan.skipped
        .filter((s) => s.reason !== "missing-disabled")
        .map((s) => s.plugin),
    );
    if (plan.changes.length === 0) {
      await saveBaseline(
        ctx,
        profile,
        preserveSkippedBaseline(
          baseState(current),
          previous,
          profile,
          dirtySkipped,
        ),
      );
      return {
        changed: false,
        backupId: null,
        verification: await verify(ctx, skippedIds),
      };
    }
    const id = randomUUID();
    filename = await backupFile(ctx, id);
    backup = {
      schemaVersion: 1,
      id,
      home: path.resolve(ctx.home),
      ...recoveryScope(profile, current, plan.skipped),
      skipped: plan.skipped,
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
      if (before?.descriptor?.enabled) await ctx.adapter.act("disable", id);
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
        if (target.source.startsWith("bundle:")) {
          await installOrUpdateBundlePlugin(ctx, target, false);
        } else {
          await ctx.adapter.install(target);
        }
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
        if (target.source.startsWith("bundle:")) {
          await installOrUpdateBundlePlugin(ctx, target, true, latest.path);
        } else {
          await ctx.adapter.update(target);
        }
      }
      if (change.actions.includes("reinstall")) {
        // The daemon cannot express an exact registry version transition as
        // an update; align by removing and installing the pinned revision.
        // Like the update path, edits that landed while the plugin was being
        // disabled must abort before the destructive removal, and removing an
        // installation deletes its settings directory, so host-only settings
        // documents are captured into the backup first and rewritten after.
        const latest = (await ctx.adapter.list()).find((p) => p.id === id);
        if (
          !latest ||
          !same(await sourceState(latest, profile), before.sourceState ?? null)
        )
          throw new Error(`Local source changed while stopping ${id}`);
        backup.hostOnlySettings = {
          ...backup.hostOnlySettings,
          [id]: await readHostOnlySettings(ctx, profile, id),
        };
        await writeJson(filename, backup);
        await ctx.adapter.act("remove", id);
        await ctx.adapter.install(target);
        // The installation may recreate host-only documents with fresh
        // defaults. Record their post-install bytes so a restore of this
        // operation — if it fails before the rewrite below — can tell the
        // daemon's defaults (bytes still matching) apart from local edits
        // made after the failure, and recover the captured contents.
        const capturedHostOnly = backup.hostOnlySettings?.[id];
        if (capturedHostOnly) {
          const recreated = {};
          for (const name of Object.keys(capturedHostOnly)) {
            const raw = await bytesOrNull(
              await safeFile(ctx.home, `plugin-settings/${id}/${name}`),
            );
            if (
              raw !== null &&
              raw.toString("base64") !== capturedHostOnly[name]
            )
              recreated[name] = raw.toString("base64");
          }
          if (Object.keys(recreated).length) {
            backup.hostOnlyRecreated = {
              ...backup.hostOnlyRecreated,
              [id]: recreated,
            };
            await writeJson(filename, backup);
          }
        }
        const row = (await ctx.adapter.list()).find((x) => x.id === id);
        if (!row) throw new Error(`Install returned no plugin: ${id}`);
        if (row.enabled) await ctx.adapter.act("disable", id);
      }
      const row = (await ctx.adapter.list()).find((x) => x.id === id);
      if (!row) throw new Error(`Missing plugin after install: ${id}`);
      const installed =
        (await resolvePluginDescriptor(row, target, profile, ctx)) ??
        snapshotPlugin(row);
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
        // Removal deletes and reinstalling may recreate settings files, so
        // the byte-for-byte guard only covers in-place version changes.
        if (
          !change.actions.includes("reinstall") &&
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
      // Only a reinstall removed the settings directory; its host-only
      // documents were freshly captured right before that removal. Once
      // they are back on disk, drop the captured entry: later restores must
      // not resurrect documents the user deleted afterwards.
      if (change.actions.includes("reinstall")) {
        await writeHostOnlySettings(ctx, id, backup.hostOnlySettings?.[id]);
        if (backup.hostOnlySettings) {
          delete backup.hostOnlySettings[id];
          if (!Object.keys(backup.hostOnlySettings).length)
            delete backup.hostOnlySettings;
          if (backup.hostOnlyRecreated) {
            delete backup.hostOnlyRecreated[id];
            if (!Object.keys(backup.hostOnlyRecreated).length)
              delete backup.hostOnlyRecreated;
          }
          await writeJson(filename, backup);
        }
      }
      if (target.enabled) await ctx.adapter.act("enable", id);
    }
    const verification = await verify(ctx, skippedIds);
    backup.after = await capture(ctx, backup.profile);
    if (!verification.configurationMatches || !verification.runtimeHealthy)
      throw new Error(`Verification failed: ${JSON.stringify(verification)}`);
    backup.status = "complete";
    await writeJson(filename, backup);
    // backup.after excludes the skipped plugins (recovery scope), so their
    // previous entries are merged back in.
    await saveBaseline(
      ctx,
      profile,
      preserveSkippedBaseline(
        baseState(backup.after),
        previous,
        profile,
        dirtySkipped,
      ),
    );
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
  const conflicts = [],
    skipped = [];
  const registryRollbacks = new Set();
  if (b.after === null || b.status === "pending" || b.status === "restoring")
    conflicts.push(
      "Interrupted backup has no verified final state; inspect daemon state before restoring.",
    );
  for (const [plugin, before] of Object.entries(b.before.plugins)) {
    const now = current.plugins[plugin];
    // A failed or interrupted capture can leave the descriptor snapshot
    // missing, on this host (an untracked or local-development installation
    // shares the id) or in the backup itself. Restoring such an entry would
    // disable or reinstall from an unidentifiable source; disclose it as
    // untracked and leave it untouched instead of dereferencing null.
    if ((now && !now.descriptor) || (before && !before.descriptor)) {
      skipped.push({ plugin, reason: "untracked", restore: true });
      continue;
    }
    // Restoring reinstalls the pinned revision and rewrites patched files,
    // which would destroy uncommitted local edits. The dirty plugin keeps
    // its local state instead, disclosed with its files, checkout and
    // repair guidance, exactly like publish and apply; everything else
    // restores.
    if (now?.sourceState?.clean === false) {
      skipped.push(
        now.sourceState.head === now.descriptor.revision
          ? {
              plugin,
              reason: "local-source-changes",
              files: now.sourceState.changed,
              checkout: now.path,
              restore: true,
            }
          : {
              plugin,
              reason: "head-differs",
              head: now.sourceState.head,
              revision: now.descriptor.revision,
              checkout: now.path,
              restore: true,
            },
      );
      continue;
    }
    if (before) {
      // An exact registry version transition cannot be expressed as an
      // in-place update, so restoring the backed-up pinned revision
      // removes and reinstalls it (mirroring the apply-side reinstall)
      // instead of refusing the whole restore.
      const nowDescriptor = now?.descriptor ?? null;
      // Installing immediately enables code, so a backup whose pinned
      // revision was disabled is never rolled back through a reinstall.
      const registryRollback =
        before.descriptor.enabled &&
        nowDescriptor?.registry &&
        nowDescriptor.revision !== before.descriptor.revision &&
        nowDescriptor.source === before.descriptor.source &&
        (nowDescriptor.pluginPath ?? ".") ===
          (before.descriptor.pluginPath ?? ".");
      if (registryRollback) registryRollbacks.add(plugin);
      else {
        const conflict = transitionConflict(
          nowDescriptor,
          before.descriptor,
          ctx.selfIds?.includes(plugin) ? plugin : ctx.selfId,
        );
        if (conflict) conflicts.push(conflict);
      }
      if (before.descriptor?.source?.startsWith("bundle:")) {
        const archive = await getBundleArchive(ctx, before.descriptor);
        if (!archive) {
          conflicts.push(
            `Previous bundle archive for ${plugin} (${before.descriptor.revision.slice(0, 7)}) is not available in local cache or repository; cannot restore.`,
          );
        }
      }
    }
  }
  const skippedIds = new Set(skipped.map((s) => s.plugin));
  // A dirty local source is outside the snapshot guard whether this preview
  // discloses it as a skip or the operation's own final snapshot recorded it
  // dirty (a failed apply, or a restore that skipped the plugin and captured
  // the divergence): the repair guidance tells the user to resolve the
  // checkout and preview again, so neither the dirtiness nor its resolution
  // may invalidate the backup. Its patch entries are the same checkout bytes,
  // so they leave with it. Settings and every other plugin stay guarded.
  const outsideGuard = new Set(
    [current, b.after]
      .filter(Boolean)
      .flatMap((s) =>
        Object.entries(s.plugins)
          .filter(([, p]) => p?.sourceState?.clean === false)
          .map(([plugin]) => plugin),
      ),
  );
  const guarded = (s) => {
    const c = comparable(s, includesSourceMetadata);
    if (!outsideGuard.size) return c;
    return {
      ...c,
      plugins: Object.fromEntries(
        Object.entries(c.plugins).filter(([p]) => !outsideGuard.has(p)),
      ),
      patches: Object.fromEntries(
        Object.entries(c.patches).filter(
          ([key]) => !outsideGuard.has(key.split("/")[0]),
        ),
      ),
    };
  };
  const drift =
    b.after !== null
      ? backupDrift(guarded(b.after), guarded(current), current)
      : null;
  return {
    backupId: id,
    changes: b.profile.manifest.plugins
      .filter((p) => !skippedIds.has(p.id))
      .map((p) => ({
        plugin: p.id,
        actions: [registryRollbacks.has(p.id) ? "reinstall" : "restore"],
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
    skipped,
    currentChangedSinceBackup: drift ? drift : false,
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
    if (preview.currentChangedSinceBackup) {
      const d = preview.currentChangedSinceBackup;
      const details = [];
      if (typeof d === "object" && d !== null) {
        if (d.source?.length)
          details.push(`source: ${d.source.map((s) => s.plugin).join(", ")}`);
        if (d.plugins?.length)
          details.push(`plugins: ${d.plugins.map((p) => p.plugin).join(", ")}`);
        if (d.settings?.length)
          details.push(`settings: ${d.settings.join(", ")}`);
        if (d.patches?.length)
          details.push(`patches: ${d.patches.join(", ")}`);
        if (d.pluginsEnabled)
          details.push(
            `pluginsEnabled: ${d.pluginsEnabled.from} -> ${d.pluginsEnabled.to}`,
          );
      }
      throw new Error(
        `Current managed data changed after the operation; resolve those changes before restoring.${details.length ? ` (${details.join(", ")})` : ""}`,
      );
    }
    const b = preview._backup;
    // Dirty local sources disclosed by the preview keep their local state:
    // the restore loop and its verification leave them entirely alone.
    const skippedIds = new Set(preview.skipped.map((s) => s.plugin));
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
      if (skippedIds.has(target.id)) continue;
      b.phase = `restore:${target.id}`;
      await writeJson(await backupFile(ctx, id), b);
      const before = b.before.plugins[target.id];
      let row = (await ctx.adapter.list()).find((x) => x.id === target.id);
      // An absent installation means whatever removed it also deleted its
      // settings directory; captured host-only documents are the only copy.
      const reinstallFromAbsent = !row;
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
      const currentDescriptor = row
        ? ((await resolvePluginDescriptor(
            row,
            before.descriptor,
            b.profile,
            ctx,
          )) ?? snapshotPlugin(row))
        : null;
      // Registry rollback uses remove + install of the backed-up pinned
      // revision, exactly like the apply-side reinstall mode.
      const registryRollback =
        before.descriptor.enabled &&
        currentDescriptor?.registry &&
        row &&
        currentDescriptor.revision !== before.descriptor.revision &&
        currentDescriptor.source === before.descriptor.source &&
        (currentDescriptor.pluginPath ?? ".") ===
          (before.descriptor.pluginPath ?? ".");
      if (
        !row ||
        !same(
          {
            ...pluginIdentity(currentDescriptor),
            enabled: before.descriptor.enabled,
          },
          pluginIdentity(before.descriptor),
        )
      ) {
        if (before.descriptor.source.startsWith("bundle:")) {
          await installOrUpdateBundlePlugin(
            ctx,
            before.descriptor,
            !!row,
            row?.path,
          );
        } else if (registryRollback) {
          // Removing the installation deletes its settings directory;
          // capture host-only documents first and rewrite them afterwards.
          b.hostOnlySettings = {
            ...b.hostOnlySettings,
            [target.id]: await readHostOnlySettings(ctx, b.profile, target.id),
          };
          await writeJson(await backupFile(ctx, id), b);
          await ctx.adapter.act("remove", target.id);
          await ctx.adapter.install(before.descriptor);
        } else {
          if (row) await ctx.adapter.update(before.descriptor);
          else await ctx.adapter.install(before.descriptor);
        }
        row = (await ctx.adapter.list()).find((x) => x.id === target.id);
        if (row?.enabled) await ctx.adapter.act("disable", target.id);
        // A reinstall (registry rollback, or recovery from a failed one that
        // removed the installation) legitimately recreates settings files
        // with fresh defaults, so the byte-for-byte guard only covers
        // in-place moves. The pre-install check above still guards the
        // absent state.
        if (!registryRollback && !reinstallFromAbsent)
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
        // After a registry rollback or a reinstall from absent the settings
        // baseline was reset by a removal; the backup bytes are written
        // unconditionally over any recreated defaults.
        if (!registryRollback && !reinstallFromAbsent)
          await assertCurrentSettings(target.id);
        const file = await settingsFile(ctx, s),
          raw = b.before.settings[s.file];
        if (raw === null) await rm(file, { force: true });
        else await atomicWrite(file, Buffer.from(raw, "base64"));
      }
      // Host-only documents are rewritten only where the installation was
      // actually removed: the registry rollback (freshly captured right
      // before its removal) and a reinstall from absent, whose predecessor
      // already deleted them, leaving the captured backup bytes as the only
      // copy. An in-place restore never removed them; its pre-apply capture
      // is stale and invisible to the drift guard, so only documents that
      // an interrupted operation left missing are recovered.
      if (registryRollback || reinstallFromAbsent)
        await writeHostOnlySettings(
          ctx,
          target.id,
          b.hostOnlySettings?.[target.id],
        );
      else
        await recoverHostOnlySettings(
          ctx,
          target.id,
          b.hostOnlySettings?.[target.id],
          b.hostOnlyRecreated?.[target.id],
        );
      if (before.descriptor.enabled) await ctx.adapter.act("enable", target.id);
    }
    const restored = await capture(ctx, b.profile);
    for (const p of b.profile.manifest.plugins)
      if (b.before.plugins[p.id]) {
        if (skippedIds.has(p.id)) continue;
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
