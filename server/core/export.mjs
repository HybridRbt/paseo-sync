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
  snapshotPlugin,
  pluginIdentity,
  validateSettings,
  validateProfile,
  loadProfile,
  validatePatch,
  patchText,
} from "./profile.mjs";

import { git } from "./git.mjs";
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
  const plugins = rows
    .map(snapshotPlugin)
    .sort((a, b) => a.id.localeCompare(b.id));
  for (const row of rows) {
    if (
      row.installation?.identity.kind === "git" &&
      row.path &&
      (await git(row.path, "rev-parse", "HEAD")) !==
        row.installation.currentRevision
    )
      throw new Error(
        `Git plugin HEAD differs from installation revision: ${row.id}. Update provenance before exporting.`,
      );
    if (
      row.installation?.identity.kind === "git" &&
      row.path &&
      (await git(row.path, "status", "--porcelain", "--untracked-files=all"))
    )
      throw new Error(
        `Git plugin has local source changes: ${row.id}. Commit a portable source revision first.`,
      );
  }
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
  if (plugins.some((p) => p.id === "better-paseo")) {
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
    warnings: [
      "Only allowlisted settings and explicitly recorded source patches are exported. Credentials, native client preferences and additional plugin data remain local.",
    ],
  };
}
