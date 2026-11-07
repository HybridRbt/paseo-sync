import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  windowsLaunch,
  installArguments,
  parseJsonOutput,
  assertDaemonVersion,
  trampolineTarget,
} from "../server/core/paseo.mjs";

test("Windows desktop CLI bypasses cmd shell with native argument boundaries", () => {
  const result = windowsLaunch(
    "C:\\Program Files\\Paseo\\resources\\bin\\paseo.cmd",
  );
  assert.equal(result.command, "C:\\Program Files\\Paseo\\Paseo.exe");
  assert.ok(result.args[1].endsWith("node-entrypoint-runner.js"));
  assert.equal(result.env.ELECTRON_RUN_AS_NODE, "1");
  assert.equal(result.shell, false);
});
test("install arguments pin npm and git and retain explicit local home", () => {
  const p = { id: "x", source: "npm:@a/b", revision: "1.2.3", enabled: true };
  assert.deepEqual(installArguments(p, "C:\\Users\\J Yang\\.paseo"), [
    "plugin",
    "install",
    "npm:@a/b@1.2.3",
    "--id",
    "x",
    "--home",
    "C:\\Users\\J Yang\\.paseo",
    "--json",
  ]);
  const git = installArguments(
    {
      ...p,
      source: "git:https://github.com/a/b",
      revision: "a".repeat(40),
      pluginPath: "plugins/x",
    },
    "/tmp/home",
  );
  assert.ok(git.includes("--ref"));
  assert.ok(git.includes("plugins/x"));
});
test("CLI JSON errors are not accepted as successful responses", () => {
  assert.deepEqual(parseJsonOutput('[{"id":"x"}]'), [{ id: "x" }]);
  assert.throws(
    () => parseJsonOutput('{"error":{"code":"FAILED","message":"oops"}}'),
    /FAILED/,
  );
  assert.throws(() => parseJsonOutput("noise\n[]"));
});
test("requires confirmed supported daemon version", () => {
  assert.doesNotThrow(() => assertDaemonVersion("0.11.4"));
  assert.doesNotThrow(() => assertDaemonVersion("0.12.0"));
  for (const version of [undefined, "0.10.9", "0.11.3", "0.11.4-beta.1"])
    assert.throws(() => assertDaemonVersion(version));
});

function officialTrampoline(shimPath) {
  // Byte-for-byte the shape getpaseo/paseo's installCli writes on Windows.
  return [
    "@echo off",
    `set "BUNDLED_CLI=${shimPath}"`,
    `if not exist "%BUNDLED_CLI%" (`,
    `  echo Paseo CLI not found at %BUNDLED_CLI% — is Paseo installed? 1>&2`,
    `  exit /b 1`,
    `)`,
    `call "%BUNDLED_CLI%" %*`,
    `exit /b %errorlevel%`,
  ].join("\r\n");
}

test("trampolineTarget extracts the official first-run trampoline's baked-in path", () => {
  const trampoline = officialTrampoline(
    "C:\\Users\\J Yang\\AppData\\Local\\Programs\\Paseo\\resources\\bin\\paseo.cmd",
  );
  assert.equal(
    trampolineTarget(trampoline),
    "C:\\Users\\J Yang\\AppData\\Local\\Programs\\Paseo\\resources\\bin\\paseo.cmd",
  );
  assert.equal(
    trampolineTarget(`\uFEFF${trampoline}`),
    "C:\\Users\\J Yang\\AppData\\Local\\Programs\\Paseo\\resources\\bin\\paseo.cmd",
  );
  assert.equal(
    trampolineTarget(
      officialTrampoline("\\\\server\\share\\Paseo\\resources\\bin\\paseo.cmd"),
    ),
    "\\\\server\\share\\Paseo\\resources\\bin\\paseo.cmd",
  );
});

test("trampolineTarget rejects shims that are not the official trampoline", () => {
  // A custom forwarder that only borrows the variable name never gets resolved.
  assert.equal(
    trampolineTarget(
      '@echo off\r\nset "BUNDLED_CLI=C:\\Paseo\\resources\\bin\\paseo.cmd"\r\nnode C:\\my-own-cli.js %*\r\n',
    ),
    null,
  );
  assert.equal(trampolineTarget(officialTrampoline("paseo.cmd")), null);
  assert.equal(
    trampolineTarget(officialTrampoline("%LOCALAPPDATA%\\Paseo\\paseo.cmd")),
    null,
  );
  assert.equal(trampolineTarget(""), null);
  assert.equal(trampolineTarget(null), null);
  assert.equal(trampolineTarget("set \"BUNDLED_CLI=x\"".repeat(4096)), null);
});

test(
  "Windows trampoline resolves to the bundled desktop CLI without executing it",
  { skip: process.platform !== "win32" },
  async () => {
    const { resolveWindowsLaunch } = await import("../server/core/paseo.mjs");
    const root = await mkdtemp(path.join(os.tmpdir(), "paseo-trampoline-"));
    try {
      const install = path.join(root, "Programs", "Paseo");
      const resources = path.join(install, "resources");
      const runner = path.join(
        resources,
        "app.asar.unpacked",
        "dist",
        "daemon",
        "node-entrypoint-runner.js",
      );
      const bundled = path.join(resources, "bin", "paseo.cmd");
      await mkdir(path.dirname(bundled), { recursive: true });
      await mkdir(path.dirname(runner), { recursive: true });
      await writeFile(bundled, "@echo off\r\n");
      await writeFile(path.join(install, "Paseo.exe"), "");
      await writeFile(runner, "");
      const localBin = path.join(root, "home", ".local", "bin");
      await mkdir(localBin, { recursive: true });
      const trampoline = path.join(localBin, "paseo.cmd");
      await writeFile(trampoline, officialTrampoline(bundled));

      const launch = await resolveWindowsLaunch(await realpath(trampoline));
      assert.equal(launch.command, path.join(install, "Paseo.exe"));
      assert.ok(launch.args[1].endsWith("node-entrypoint-runner.js"));
      assert.equal(launch.env.PASEO_CLI, path.win32.resolve(bundled));
      assert.equal(launch.shell, false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "Windows trampoline with a missing bundled CLI fails with reinstall guidance",
  { skip: process.platform !== "win32" },
  async () => {
    const { resolveWindowsLaunch } = await import("../server/core/paseo.mjs");
    const root = await mkdtemp(path.join(os.tmpdir(), "paseo-stale-"));
    try {
      const trampoline = path.join(root, ".local", "bin", "paseo.cmd");
      await mkdir(path.dirname(trampoline), { recursive: true });
      const missing = path.join(root, "gone", "resources", "bin", "paseo.cmd");
      await writeFile(trampoline, officialTrampoline(missing));
      const resolved = await realpath(trampoline);
      await assert.rejects(resolveWindowsLaunch(resolved), (error) => {
        assert.match(error.message, /points to a bundled CLI/);
        assert.ok(
          error.message.includes(resolved) && error.message.includes(missing),
          `message should name the trampoline and its target, got: ${error.message}`,
        );
        return true;
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "custom Windows shim outside desktop or npm layout fails with guidance",
  { skip: process.platform !== "win32" },
  async () => {
    const { makeAdapter } = await import("../server/core/paseo.mjs");
    const dir = await mkdtemp(path.join(os.tmpdir(), "paseo-shim-"));
    try {
      const shim = path.join(dir, "paseo.cmd");
      await writeFile(shim, '@echo off\r\nrem custom forwarder, not npm layout\r\n');
      const resolved = await realpath(shim);
      await assert.rejects(
        makeAdapter(path.join(dir, "home"), shim),
        (error) => {
          assert.match(error.message, /Unsupported Windows Paseo shim/);
          assert.ok(
            error.message.includes(resolved),
            `message should name the shim, got: ${error.message}`,
          );
          return true;
        },
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test("updates exact npm and Git revisions without reinstalling configured IDs", async () => {
  const { updateArguments } = await import("../server/core/paseo.mjs");
  assert.equal(typeof updateArguments, "function");
  const p = { id: "demo", source: "npm:demo", revision: "1.2.3" };
  assert.deepEqual(updateArguments(p, "/home"), [
    "plugin",
    "update",
    "demo",
    "--version",
    "1.2.3",
    "--home",
    "/home",
    "--json",
  ]);
  assert.ok(
    updateArguments(
      {
        ...p,
        source: "git:https://github.com/example/demo",
        revision: "a".repeat(40),
      },
      "/home",
    ).includes("--ref"),
  );
});
