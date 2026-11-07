import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  loadProfile,
  validateProfile,
  snapshotPlugin,
  validateSettings,
  normalizeSettings,
} from "../server/core/profile.mjs";
import { safeFile } from "../server/core/files.mjs";

export const profile = () => ({
  schemaVersion: 1,
  plugins: [
    {
      id: "skills",
      source: "npm:@gpambrozio/paseo-skills",
      revision: "0.4.0",
      enabled: true,
    },
  ],
  settings: [],
  patches: [],
});

test("rejects ambiguous or unrecognized manifest inputs", () => {
  const variants = [
    (p) => p.plugins.push(p.plugins[0]),
    (p) => (p.schemaVersion = 2),
    (p) => (p.plugins[0].revision = "latest"),
    (p) => (p.plugins[0].enabled = "yes"),
    (p) => (p.plugins[0].source = "/Users/person/plugin"),
    (p) => (p.plugins[0].unknown = true),
    (p) => (p.plugins[0].source = "git:https://x.invalid/repo?token=secret"),
    (p) => {
      p.plugins[0].source = "git:https://github.com/x/y";
      p.plugins[0].revision = "main";
    },
  ];
  for (const change of variants) {
    const p = profile();
    change(p);
    assert.throws(() => validateProfile(p));
  }
  assert.doesNotThrow(() => validateProfile(profile()));
});

test("source snapshot pins npm and git without machine paths", () => {
  const row = {
    id: "skills",
    enabled: false,
    installation: {
      identity: {
        kind: "npm",
        packageName: "@gpambrozio/paseo-skills",
        pluginPath: ".",
      },
      currentRevision: "0.4.0",
    },
  };
  assert.deepEqual(snapshotPlugin(row), {
    id: "skills",
    enabled: false,
    source: "npm:@gpambrozio/paseo-skills",
    revision: "0.4.0",
  });
  assert.throws(() =>
    snapshotPlugin({ id: "unmanaged", path: "/tmp/x", enabled: true }),
  );
});

test("setting allowlist rejects credential-shaped and newly introduced fields", () => {
  assert.doesNotThrow(() =>
    validateSettings("better-paseo", "presentation", {
      version: 1,
      values: { accent: "host", previewWrap: true },
    }),
  );
  for (const values of [
    { token: "secret" },
    { previewWrap: "yes" },
    { language: "invalid" },
    { customMonoFont: "/Users/person/font" },
  ]) {
    assert.throws(() =>
      validateSettings("better-paseo", "presentation", { version: 1, values }),
    );
  }
  assert.throws(() =>
    validateSettings("linear", "credentials", { version: 1, values: {} }),
  );
});

test("accepts the accent and inline code colors better-paseo publishes today", () => {
  for (const accent of ["zinc", "midnight", "claude", "ghostty", "pureBlack"])
    assert.doesNotThrow(() =>
      validateSettings("better-paseo", "presentation", {
        version: 1,
        values: { accent },
      }),
    );
  for (const inlineCodeColor of [
    "jade",
    "amber",
    "rose",
    "zinc",
    "midnight",
    "claude",
    "ghostty",
    "pureBlack",
  ])
    assert.doesNotThrow(() =>
      validateSettings("better-paseo", "presentation", {
        version: 1,
        values: { inlineCodeColor },
      }),
    );
});

test("normalizes the legacy rowLabels and hoverDelay spellings the daemon keeps on disk", () => {
  assert.deepEqual(
    normalizeSettings({
      version: 1,
      values: { rowLabels: true, hoverDelay: "500ms", previewWrap: false },
    }),
    {
      version: 1,
      values: {
        previewWrap: false,
        rowLabelStyle: "both",
        hoverDelaySeconds: 0.5,
      },
    },
  );
  // A modern key wins and its legacy spelling drops, exactly like the plugin's
  // own read-time migration.
  assert.deepEqual(
    normalizeSettings({
      version: 1,
      values: {
        rowLabels: true,
        rowLabelStyle: "icon",
        hoverDelay: "1s",
        hoverDelaySeconds: 2,
      },
    }).values,
    { rowLabelStyle: "icon", hoverDelaySeconds: 2 },
  );
  // Unmapped legacy delay spellings drop instead of being guessed.
  assert.deepEqual(
    normalizeSettings({ version: 1, values: { hoverDelay: "300ms" } }).values,
    {},
  );
  const once = normalizeSettings({
    version: 1,
    values: { rowLabels: true, hoverDelay: "2s" },
  });
  assert.deepEqual(normalizeSettings(once), once);
  // Fields that are still unknown after normalization reject by name.
  assert.throws(
    () =>
      validateSettings("better-paseo", "presentation", {
        version: 1,
        values: { token: "secret", rowClick: true },
      }),
    /Unsupported presentation fields: token, rowClick/,
  );
});

test("rejects traversal, Windows drive paths, and symlink escape before reading", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-path-"));
  await mkdir(path.join(root, "settings"));
  for (const value of [
    "../secret",
    "C:\\secret",
    "/tmp/secret",
    "settings/../secret",
    "settings\\secret",
  ]) {
    await assert.rejects(safeFile(root, value));
  }
  await symlink(
    tmpdir(),
    path.join(root, "settings", "link"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(safeFile(root, "settings/link/secret"));
});

test("loads only approved documents, rejects malformed setting files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-manifest-"));
  const p = profile();
  p.plugins.push({
    id: "better-paseo",
    source: "git:https://github.com/RoundRedDot/better-paseo",
    revision: "a".repeat(40),
    enabled: true,
  });
  p.settings.push({
    plugin: "better-paseo",
    document: "presentation",
    file: "settings/better-paseo/presentation.json",
  });
  await mkdir(path.join(root, "settings/better-paseo"), { recursive: true });
  await writeFile(path.join(root, "profile.json"), JSON.stringify(p));
  const f = path.join(root, p.settings[0].file);
  await writeFile(
    f,
    JSON.stringify({ version: 1, values: { previewWrap: true } }),
  );
  assert.equal(
    (await loadProfile(root)).settings[0].data.values.previewWrap,
    true,
  );
  await writeFile(
    f,
    JSON.stringify({ version: 1, values: { password: "never-share" } }),
  );
  await assert.rejects(loadProfile(root));
});

test("validates bundle plugins and integrity on loadProfile", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-bundle-"));
  try {
    const bundleContent = Buffer.from("fake-gzip-bundle");
    const crypto = await import("node:crypto");
    const sha = crypto.createHash("sha256").update(bundleContent).digest("hex");

    const p = {
      schemaVersion: 1,
      plugins: [
        {
          id: "flowly",
          source: "bundle:bundles/flowly.tar.gz",
          revision: sha,
          enabled: true,
        },
      ],
      settings: [],
      patches: [],
    };
    assert.doesNotThrow(() => validateProfile(p));

    // Rejects invalid bundle formats
    assert.throws(() => validateProfile({
      ...p,
      plugins: [{ id: "flowly", source: "bundle:other/flowly.tar.gz", revision: sha, enabled: true }]
    }));
    assert.throws(() => validateProfile({
      ...p,
      plugins: [{ id: "flowly", source: "bundle:bundles/flowly.tar.gz", revision: "short", enabled: true }]
    }));

    // Test loadProfile
    await mkdir(path.join(root, "bundles"), { recursive: true });
    await writeFile(path.join(root, "bundles/flowly.tar.gz"), bundleContent);
    await writeFile(path.join(root, "profile.json"), JSON.stringify(p));

    const loaded = await loadProfile(root);
    assert.equal(loaded.manifest.plugins[0].id, "flowly");
    assert.equal(loaded.bundles.length, 1);
    assert.equal(loaded.bundles[0].hash, sha);

    // Mismatched bundle hash throws
    await writeFile(path.join(root, "bundles/flowly.tar.gz"), Buffer.from("corrupted-content"));
    await assert.rejects(() => loadProfile(root), /Bundle hash mismatch/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

