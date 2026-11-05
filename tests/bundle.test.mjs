import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import {
  packPluginDirectory,
  unpackBundle,
  buildTarBuffer,
  parseTarEntries,
} from "../server/core/bundle.mjs";

test("packPluginDirectory packages files, ignores .git/node_modules/.DS_Store, and is deterministic", async () => {
  const src = await mkdtemp(path.join(tmpdir(), "bundle-src-"));
  const dst = await mkdtemp(path.join(tmpdir(), "bundle-dst-"));
  try {
    // Regular plugin files
    await writeFile(path.join(src, "paseo-plugin.json"), JSON.stringify({ id: "my-plugin", name: "My Plugin" }));
    await writeFile(path.join(src, "index.js"), "console.log('hello');");
    await mkdir(path.join(src, "assets"), { recursive: true });
    await writeFile(path.join(src, "assets/icon.png"), "fake-png-content");

    // Ignored items
    await mkdir(path.join(src, ".git"), { recursive: true });
    await writeFile(path.join(src, ".git/config"), "secret git config");
    await mkdir(path.join(src, "node_modules/dep"), { recursive: true });
    await writeFile(path.join(src, "node_modules/dep/index.js"), "dep code");
    await writeFile(path.join(src, ".DS_Store"), "apple junk");

    // Pack 1
    const p1 = await packPluginDirectory(src);
    assert.equal(typeof p1.sha256, "string");
    assert.equal(p1.sha256.length, 64);
    assert.ok(p1.buffer instanceof Buffer);
    assert.equal(p1.fileCount, 3);

    // Pack 2 (determinism)
    const p2 = await packPluginDirectory(src);
    assert.equal(p1.sha256, p2.sha256);
    assert.deepEqual(p1.buffer, p2.buffer);

    // Unpack
    const res = await unpackBundle(p1.buffer, dst);
    assert.equal(res.fileCount, 3);

    const pluginJson = await readFile(path.join(dst, "paseo-plugin.json"), "utf8");
    assert.deepEqual(JSON.parse(pluginJson), { id: "my-plugin", name: "My Plugin" });
    const indexJs = await readFile(path.join(dst, "index.js"), "utf8");
    assert.equal(indexJs, "console.log('hello');");
    const icon = await readFile(path.join(dst, "assets/icon.png"), "utf8");
    assert.equal(icon, "fake-png-content");

    // Verify ignored files do NOT exist
    let gitExists = false;
    try {
      await readFile(path.join(dst, ".git/config"));
      gitExists = true;
    } catch {}
    assert.equal(gitExists, false);

    let nmExists = false;
    try {
      await readFile(path.join(dst, "node_modules/dep/index.js"));
      nmExists = true;
    } catch {}
    assert.equal(nmExists, false);

    let dsExists = false;
    try {
      await readFile(path.join(dst, ".DS_Store"));
      dsExists = true;
    } catch {}
    assert.equal(dsExists, false);
  } finally {
    await rm(src, { recursive: true, force: true });
    await rm(dst, { recursive: true, force: true });
  }
});

test("unpackBundle rejects directory traversal in tar headers", async () => {
  const dst = await mkdtemp(path.join(tmpdir(), "bundle-traversal-"));
  try {
    // Manually create a tar archive containing a traversal path "../escape.txt"
    const maliciousTar = buildTarBuffer([
      { name: "../escape.txt", content: Buffer.from("attack") }
    ]);
    const gzipped = zlib.gzipSync(maliciousTar);

    await assert.rejects(
      async () => {
        await unpackBundle(gzipped, dst);
      },
      {
        message: /Path traversal detected/,
      }
    );
  } finally {
    await rm(dst, { recursive: true, force: true });
  }
});

test("packPluginDirectory rejects plugins exceeding max bundle size", async () => {
  const src = await mkdtemp(path.join(tmpdir(), "bundle-limit-"));
  try {
    await writeFile(path.join(src, "huge.bin"), Buffer.alloc(2000));
    await assert.rejects(
      async () => {
        await packPluginDirectory(src, { maxSizeBytes: 1000 });
      },
      {
        message: /Bundle size exceeds limit/,
      }
    );
  } finally {
    await rm(src, { recursive: true, force: true });
  }
});

test("packPluginDirectory respects package.json files array when defined", async () => {
  const src = await mkdtemp(path.join(tmpdir(), "bundle-pkg-files-"));
  const dst = await mkdtemp(path.join(tmpdir(), "bundle-pkg-dst-"));
  try {
    await writeFile(
      path.join(src, "package.json"),
      JSON.stringify({
        name: "test-plugin",
        files: ["client/", "server/", "README.md", "!server/test.js"],
      }),
    );
    await writeFile(
      path.join(src, "paseo-plugin.json"),
      JSON.stringify({ id: "test-plugin" }),
    );
    await writeFile(path.join(src, "README.md"), "# Test Plugin");
    await mkdir(path.join(src, "client"), { recursive: true });
    await writeFile(path.join(src, "client/index.js"), "client code");
    await mkdir(path.join(src, "server"), { recursive: true });
    await writeFile(path.join(src, "server/index.js"), "server code");
    await writeFile(path.join(src, "server/test.js"), "test code (excluded)");
    await mkdir(path.join(src, "docs"), { recursive: true });
    await writeFile(path.join(src, "docs/large.png"), "huge doc screenshot");

    const packed = await packPluginDirectory(src);
    const res = await unpackBundle(packed.buffer, dst);
    assert.equal(res.fileCount, 5); // package.json, paseo-plugin.json, README.md, client/index.js, server/index.js
    assert.equal(await readFile(path.join(dst, "client/index.js"), "utf8"), "client code");
    assert.equal(await readFile(path.join(dst, "server/index.js"), "utf8"), "server code");
    await assert.rejects(async () => readFile(path.join(dst, "server/test.js")));
    await assert.rejects(async () => readFile(path.join(dst, "docs/large.png")));
  } finally {
    await rm(src, { recursive: true, force: true });
    await rm(dst, { recursive: true, force: true });
  }
});
