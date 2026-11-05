import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import {
  safeFile,
  jsonOrNull,
  bytesOrNull,
  writeJson,
  same,
  digest,
} from "./files.mjs";
import {
  isPortablePlugin,
  snapshotPlugin,
  pluginIdentity,
  validateSettings,
  validateProfile,
  loadProfile,
  validatePatch,
  patchText,
} from "./profile.mjs";

import { git } from "./git.mjs";
import { sourceState } from "./source-state.mjs";
export async function assertRepositoryReady(root) {
  await git(root, "rev-parse", "--show-toplevel");
  if (await git(root, "status", "--porcelain", "--untracked-files=no"))
    throw new Error(
      "Repository has uncommitted tracked changes; review and commit them before exporting.",
    );
  const remotes = (await git(root, "remote")).split("\n").filter(Boolean);
  if (!remotes.length) return;
  if (!remotes.includes("origin"))
    throw new Error("Expected origin remote; review repository configuration.");
  await git(root, "fetch", "--no-tags", "origin");
  let upstream;
  try {
    upstream = await git(
      root,
      "rev-parse",
      "--abbrev-ref",
      "--symbolic-full-name",
      "@{upstream}",
    );
  } catch {
    throw new Error("No tracked upstream; set it explicitly before exporting.");
  }
  if (!upstream.startsWith("origin/"))
    throw new Error("Upstream is not origin; review it before exporting.");
  const counts = (
    await git(root, "rev-list", "--left-right", "--count", `HEAD...${upstream}`)
  )
    .split(/\s+/)
    .map(Number);
  if (counts[1] > 0)
    throw new Error(
      "Repository is behind or diverged from its upstream; reconcile Git before exporting.",
    );
}
export async function exportProfile(ctx) {
  await assertRepositoryReady(ctx.root);
  const old = await jsonOrNull(await safeFile(ctx.root, "profile.json"));
  const loaded = old ? await loadProfile(ctx.root) : null;
  const rows = (await ctx.adapter.list()).filter(
    (row) =>
      row.id !== "paseo-sync" &&
      row.id !== ctx.selfId &&
      !ctx.selfIds?.includes(row.id),
  );
  // Preserve disabled intent accepted by synchronization on a host where the
  // plugin is absent. Exporting another host change must not delete this intent.
  const retained =
    loaded?.manifest.plugins.filter(
      (p) =>
        !p.enabled &&
        !rows.some((r) => r.id === p.id) &&
        p.id !== "paseo-sync" &&
        p.id !== ctx.selfId &&
        !ctx.selfIds?.includes(p.id),
    ) ?? [];
  const retainedIds = new Set(retained.map((p) => p.id));
  // An untracked or non-portable plugin (such as a local directory development
  // checkout) cannot be exported portably. A Git plugin whose local source is
  // not a clean, provenance-matching revision cannot be exported portably either.
  // Instead of blocking the whole profile, the plugin is skipped: a previously
  // published entry stays as the repository has it, and an unpublished one is
  // left out of this export.
  const skipped = [];
  for (const row of rows) {
    if (!isPortablePlugin(row)) {
      skipped.push({
        plugin: row.id,
        reason: "untracked",
      });
      continue;
    }
    if (row.installation?.identity.kind !== "git" || !row.path) continue;
    // sourceState shares the cleanliness notion of apply and baseline capture:
    // recorded patch applications stay clean, any other working-tree change or
    // a HEAD drift from provenance does not.
    const state = await sourceState(row, loaded ?? { patches: [] });
    if (state.clean) continue;
    skipped.push(
      state.head === row.installation.currentRevision
        ? {
            plugin: row.id,
            reason: "local-source-changes",
            files: state.changed,
          }
        : {
            plugin: row.id,
            reason: "head-differs",
            head: state.head,
            revision: row.installation.currentRevision,
          },
    );
  }
  const skippedIds = new Set(skipped.map((s) => s.plugin));
  const carried = [];
  for (const s of skipped) {
    const remote = loaded?.manifest.plugins.find((p) => p.id === s.plugin);
    if (remote) {
      s.published = true;
      carried.push(remote);
    }
  }
  const carriedIds = new Set(carried.map((p) => p.id));
  const plugins = [
    ...rows.filter((r) => !skippedIds.has(r.id)).map(snapshotPlugin),
    ...carried,
    ...retained,
  ].sort((a, b) => a.id.localeCompare(b.id));
  const previous = await jsonOrNull(await safeFile(ctx.state, "baseline.json"));
  if (loaded && previous) {
    const ids = new Set([
      ...loaded.manifest.plugins.map((p) => p.id),
      ...plugins.map((p) => p.id),
      ...Object.keys(previous.plugins ?? {}),
    ]);
    for (const id of ids) {
      const base = previous.plugins?.[id] ?? null,
        remote = loaded.manifest.plugins.find((p) => p.id === id) ?? null,
        local = plugins.find((p) => p.id === id) ?? null;
      if (
        !same(pluginIdentity(remote), pluginIdentity(base)) &&
        !same(pluginIdentity(local), pluginIdentity(remote))
      )
        throw new Error(
          `Repository has unapplied changes for ${id}; apply or reconcile before exporting.`,
        );
    }
  }
  const settings = [];
  if (
    rows.some((p) => p.id === "better-paseo") &&
    !skippedIds.has("better-paseo")
  ) {
    const file = "settings/better-paseo/presentation.json";
    const data = await jsonOrNull(await safeFile(ctx.home, "plugin-" + file));
    if (data !== null) {
      validateSettings("better-paseo", "presentation", data);
      settings.push({
        plugin: "better-paseo",
        document: "presentation",
        file,
        data,
      });
    }
  }
  settings.push(
    ...(loaded?.settings.filter(
      (s) => retainedIds.has(s.plugin) || carriedIds.has(s.plugin),
    ) ?? []),
  );
  if (loaded && previous) {
    const names = new Set([
      ...loaded.settings.map((s) => s.file),
      ...settings.map((s) => s.file),
      ...Object.keys(previous.settings ?? {}),
    ]);
    for (const name of names) {
      const raw = previous.settings?.[name] ?? null,
        base =
          raw === null
            ? null
            : JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
      const remote = loaded.settings.find((s) => s.file === name)?.data ?? null,
        local = settings.find((s) => s.file === name)?.data ?? null;
      if (!same(remote, base) && !same(local, remote))
        throw new Error(`Repository has unapplied settings changes: ${name}`);
    }
  }
  const patches = [];
  const candidates = loaded?.manifest.patches ?? [];
  // The bootstrap repair is deliberately the only discovery rule, not a directory sweep.
  if (
    !loaded &&
    (await bytesOrNull(
      await safeFile(ctx.root, "patches/github-board-0.10.2-icons.json"),
    ))
  )
    candidates.push({
      plugin: "github-board",
      file: "patches/github-board-0.10.2-icons.json",
    });
  for (const entry of candidates) {
    if (retainedIds.has(entry.plugin) || carriedIds.has(entry.plugin)) {
      patches.push(entry);
      continue;
    }
    const target = plugins.find((p) => p.id === entry.plugin);
    if (!target) continue;
    const data = validatePatch(
      JSON.parse(await readFile(await safeFile(ctx.root, entry.file), "utf8")),
      target,
    );
    const row = rows.find((r) => r.id === entry.plugin);
    for (const f of data.files) {
      const raw = await readFile(await safeFile(row.path, f.path));
      patchText(raw, f);
      if (digest(raw) !== f.afterSha256)
        throw new Error(
          `Known patch is not applied locally: ${entry.plugin}/${f.path}`,
        );
    }
    patches.push(entry);
  }
  const manifest = validateProfile({
    schemaVersion: 1,
    plugins,
    settings: settings.map(({ data, ...s }) => s),
    patches,
  });
  // Every input is validated before the first repository write.
  for (const s of settings)
    await writeJson(await safeFile(ctx.root, s.file), s.data);
  await writeJson(await safeFile(ctx.root, "profile.json"), manifest);
  return {
    exported: true,
    plugins: plugins.length,
    settings: settings.length,
    patches: patches.length,
    profileHash: (await loadProfile(ctx.root)).hash,
    skipped,
    warnings: [
      "Only allowlisted settings and explicitly recorded source patches are exported. Credentials, native client preferences and additional plugin data remain local.",
    ],
  };
}
