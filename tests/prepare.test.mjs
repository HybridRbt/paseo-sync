import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import {
  escapeWindowsCmdValue,
  isWindowsCommandScript,
  shouldUseWindowsShell,
  readBuildCommands,
  runPluginBuildCommands,
  prepareBundleDirectory,
  sanitizeBuildEnv,
  RUNTIME_CONTROL_ENV_KEYS,
} from "../server/core/prepare.mjs";

function fakeChild({ exitCode = 0, stdout = "", stderr = "" } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 4242;
  process.nextTick(() => {
    if (stdout) child.stdout.emit("data", Buffer.from(stdout));
    if (stderr) child.stderr.emit("data", Buffer.from(stderr));
    child.emit("close", exitCode);
  });
  return child;
}

test("escapeWindowsCmdValue caret-escapes metacharacters and quotes values with spaces", () => {
  assert.equal(escapeWindowsCmdValue("npm"), "npm");
  assert.equal(escapeWindowsCmdValue("a&b|c"), "a^&b^|c");
  assert.equal(escapeWindowsCmdValue("--omit=dev"), "--omit=dev");
  assert.equal(escapeWindowsCmdValue("--flag with spaces"), '"--flag with spaces"');
  assert.equal(escapeWindowsCmdValue('say "hi"'), '"say \\"hi\\""');
  // A lone trailing backslash stays untouched: doubling only applies inside
  // quotes, where it would otherwise escape the closing quote.
  assert.equal(escapeWindowsCmdValue("trailing\\"), "trailing\\");
});

test("shouldUseWindowsShell selects the shell for bare and .cmd commands on Windows only", () => {
  assert.equal(shouldUseWindowsShell("npm", "win32"), true);
  assert.equal(shouldUseWindowsShell("npm.cmd", "win32"), true);
  assert.equal(shouldUseWindowsShell("npm.bat", "win32"), true);
  assert.equal(shouldUseWindowsShell("C:\\Tools\\node.exe", "win32"), false);
  assert.equal(shouldUseWindowsShell("C:\\Tools\\npm.cmd", "win32"), true);
  assert.equal(shouldUseWindowsShell("npm", "darwin"), false);
  assert.equal(shouldUseWindowsShell("npm", "linux"), false);
  assert.equal(isWindowsCommandScript("npm.cmd", "darwin"), false);
});

test("runPluginBuildCommands spawns each command in the plugin directory", async (t) => {
  const calls = [];
  const spawnFn = (command, args, options) => {
    calls.push({ command, args, options });
    return fakeChild();
  };
  await runPluginBuildCommands(
    "/tmp/plugin",
    [
      ["npm", "ci", "--omit=dev"],
      ["node", "-e", "0"],
    ],
    { spawn: spawnFn, platform: "linux", timeoutMs: 1000 },
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[0].command, "npm");
  assert.deepEqual(calls[0].args, ["ci", "--omit=dev"]);
  assert.equal(calls[0].options.cwd, "/tmp/plugin");
  assert.equal(calls[0].options.shell, false);
  assert.deepEqual(calls[0].options.env, sanitizeBuildEnv(process.env));
});

test("runPluginBuildCommands quotes command and args for the cmd shell on Windows", async (t) => {
  const calls = [];
  const spawnFn = (command, args, options) => {
    calls.push({ command, args, options });
    return fakeChild();
  };
  await runPluginBuildCommands("C:\\Users\\a\\.paseo\\local-plugins\\flowly", [["npm", "ci", "--omit=dev"]], {
    spawn: spawnFn,
    platform: "win32",
    timeoutMs: 1000,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "npm");
  assert.deepEqual(calls[0].args, ["ci", "--omit=dev"]);
  assert.equal(calls[0].options.shell, true);
});

test("runPluginBuildCommands throws with output tail when a command exits non-zero", async () => {
  const spawnFn = () => fakeChild({ exitCode: 1, stderr: "npm ERR! network missing" });
  await assert.rejects(
    runPluginBuildCommands("/tmp/plugin", [["npm", "ci"]], {
      spawn: spawnFn,
      platform: "linux",
      timeoutMs: 1000,
    }),
    (err) =>
      /Plugin build command failed \(exit 1\): "npm" "ci"/.test(err.message) &&
      err.message.includes("npm ERR! network missing"),
  );
});

test("runPluginBuildCommands reports spawn failures", async () => {
  const spawnFn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.pid = undefined;
    process.nextTick(() => {
      child.emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }));
      child.emit("close", null);
    });
    return child;
  };
  await assert.rejects(
    runPluginBuildCommands("/tmp/plugin", [["definitely-missing-tool"]], {
      spawn: spawnFn,
      platform: "linux",
      timeoutMs: 1000,
    }),
    (err) => /failed to start/.test(err.message) && err.message.includes("spawn ENOENT"),
  );
});

test("runPluginBuildCommands stops at the first failing command", async () => {
  const calls = [];
  const spawnFn = (_command, _args, _options) => {
    calls.push(_command);
    return fakeChild({ exitCode: calls.length === 1 ? 3 : 0 });
  };
  await assert.rejects(
    runPluginBuildCommands("/tmp/plugin", [
      ["first"],
      ["second"],
    ], { spawn: spawnFn, platform: "linux", timeoutMs: 1000 }),
  );
  assert.equal(calls.length, 1);
});

test("readBuildCommands returns declared commands and tolerates absent manifests", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "prepare-"));
  assert.deepEqual(await readBuildCommands(dir), []);
  await writeFile(path.join(dir, "paseo-plugin.json"), JSON.stringify({ id: "x" }));
  assert.deepEqual(await readBuildCommands(dir), []);
  await writeFile(
    path.join(dir, "paseo-plugin.json"),
    JSON.stringify({ id: "x", build: [["npm", "ci", "--omit=dev"]] }),
  );
  assert.deepEqual(await readBuildCommands(dir), [["npm", "ci", "--omit=dev"]]);
  await writeFile(path.join(dir, "paseo-plugin.json"), JSON.stringify({ id: "x", build: "npm ci" }));
  await assert.rejects(readBuildCommands(dir), /Invalid build commands/);
});

test("prepareBundleDirectory runs real build commands inside the directory", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "prepare-"));
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "paseo-plugin.json"),
    JSON.stringify({
      id: "probe",
      build: [[process.execPath, "-e", "require('node:fs').writeFileSync('prepared.txt','ok')"]],
    }),
  );
  const count = await prepareBundleDirectory(dir);
  assert.equal(count, 1);
  const { readFile } = await import("node:fs/promises");
  assert.equal(await readFile(path.join(dir, "prepared.txt"), "utf8"), "ok");
});

test("prepareBundleDirectory is a no-op without build commands", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "prepare-"));
  await writeFile(path.join(dir, "paseo-plugin.json"), JSON.stringify({ id: "x" }));
  assert.equal(await prepareBundleDirectory(dir), 0);
});

test("a timed-out build command rejects promptly even while a grandchild holds the pipe", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "prepare-"));
  // The command spawns a grandchild that inherits stdout and outlives the
  // timeout; waiting only for the immediate child's `close` would block until
  // the grandchild exits (Codex P2).
  const script =
    'const { spawn } = require("child_process");' +
    'spawn(process.execPath, ["-e", "setTimeout(() => {}, 8000)"], { stdio: ["ignore", 1, 2] });' +
    'setTimeout(() => {}, 8000);';
  const started = Date.now();
  await assert.rejects(
    runPluginBuildCommands(dir, [[process.execPath, "-e", script]], {
      timeoutMs: 400,
    }),
    /timed out/,
  );
  const elapsed = Date.now() - started;
  assert.ok(
    elapsed < 4000,
    `timeout rejection should be bounded by the tree kill, took ${elapsed}ms`,
  );
});

test("a timed-out build rejects even when the launcher already exited zero", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "prepare-"));
  // The launcher exits 0 immediately while the descendant keeps building on
  // inherited pipes; the timeout must still fail the run instead of letting
  // the launcher's exit code read as success (Codex P2).
  const script =
    'const { spawn } = require("child_process");' +
    'spawn(process.execPath, ["-e", "setTimeout(() => {}, 3000)"], { stdio: ["ignore", 1, 2] });';
  await assert.rejects(
    runPluginBuildCommands(dir, [[process.execPath, "-e", script]], {
      timeoutMs: 400,
    }),
    /failed \(timed out\)/,
  );
});

test("sanitizeBuildEnv strips runtime control variables like ELECTRON_RUN_AS_NODE and ESBUILD_BINARY_PATH case-insensitively", () => {
  const dirtyEnv = {
    PATH: "/bin:/usr/bin",
    ELECTRON_RUN_AS_NODE: "1",
    electron_no_attach_console: "1",
    PASEO_NODE_ENV: "production",
    Paseo_Desktop_Managed: "1",
    paseo_supervised: "1",
    ESBUILD_BINARY_PATH: "/opt/esbuild",
    CUSTOM_VAR: "custom_val",
  };
  const cleaned = sanitizeBuildEnv(dirtyEnv);
  assert.equal(cleaned.CUSTOM_VAR, "custom_val");
  assert.equal(cleaned.PATH, "/bin:/usr/bin");
  assert.equal(cleaned.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(cleaned.electron_no_attach_console, undefined);
  assert.equal(cleaned.PASEO_NODE_ENV, undefined);
  assert.equal(cleaned.Paseo_Desktop_Managed, undefined);
  assert.equal(cleaned.paseo_supervised, undefined);
  assert.equal(cleaned.ESBUILD_BINARY_PATH, undefined);
});

test("readBuildCommands parses manifests with UTF-8 BOM", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "prepare-bom-"));
  await writeFile(
    path.join(dir, "paseo-plugin.json"),
    "\uFEFF" + JSON.stringify({ id: "bom-plugin", build: [["npm", "ci"]] }),
    "utf8",
  );
  assert.deepEqual(await readBuildCommands(dir), [["npm", "ci"]]);
});

test("readBuildCommands retries on transient Windows file lock errors and succeeds", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "prepare-retry-"));
  const manifestPath = path.join(dir, "paseo-plugin.json");
  await writeFile(
    manifestPath,
    JSON.stringify({ id: "retry-plugin", build: [["npm", "ci"]] }),
  );
  const fs = await import("node:fs/promises");
  const originalReadFile = fs.default.readFile;
  const platform = process.platform;
  let attempts = 0;
  t.mock.method(fs.default, "readFile", async (...args) => {
    if (args[0] === manifestPath && attempts++ < 2) {
      const err = new Error("Resource temporarily locked by antivirus");
      err.code = "EPERM";
      throw err;
    }
    return originalReadFile(...args);
  });
  Object.defineProperty(process, "platform", { value: "win32" });
  try {
    const commands = await readBuildCommands(dir);
    assert.deepEqual(commands, [["npm", "ci"]]);
    assert.equal(attempts, 3);
  } finally {
    Object.defineProperty(process, "platform", { value: platform });
  }
});

test("readBuildCommands surfaces persistent non-SyntaxError file read errors", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "prepare-fail-"));
  const manifestPath = path.join(dir, "paseo-plugin.json");
  await writeFile(
    manifestPath,
    JSON.stringify({ id: "fail-plugin", build: [["npm", "ci"]] }),
  );
  const fs = await import("node:fs/promises");
  const platform = process.platform;
  t.mock.method(fs.default, "readFile", async (...args) => {
    if (args[0] === manifestPath) {
      const err = new Error("Hard disk corrupted");
      err.code = "EIO";
      throw err;
    }
    return fs.default.readFile(...args);
  });
  Object.defineProperty(process, "platform", { value: "win32" });
  try {
    await assert.rejects(readBuildCommands(dir), /Hard disk corrupted/);
  } finally {
    Object.defineProperty(process, "platform", { value: platform });
  }
});
