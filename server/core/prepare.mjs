import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

const OUTPUT_LIMIT = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const FORCE_SETTLE_MS = 5000;
// A bundle follows npm-publish "files" allowlist semantics, which drop build
// inputs the manifest's own build commands need; point the author at the fix
// instead of leaving a bare MODULE_NOT_FOUND.
const BUILD_FAILURE_HINT =
  "\nIf the bundle lacks files the build command needs (an npm \"files\" allowlist does not ship build scripts), add them to the allowlist in the source plugin.";

export function isWindowsCommandScript(command, platform = process.platform) {
  const extension = path.extname(command).toLowerCase();
  return platform === "win32" && (extension === ".cmd" || extension === ".bat");
}

// `npm` on Windows resolves to npm.cmd: spawning it without a shell is
// rejected with EINVAL, and an extension-less bare name needs cmd.exe to be
// found on PATH at all. The daemon's own preparation runs use the same rule
// (spawnProcess in @getpaseo/server), so bundle restores execute build
// commands exactly like a git install would.
export function shouldUseWindowsShell(command, platform = process.platform) {
  if (isWindowsCommandScript(command, platform)) return true;
  return (
    platform === "win32" &&
    !command.includes("/") &&
    !command.includes("\\") &&
    !path.extname(command)
  );
}

export function escapeWindowsCmdValue(value) {
  const isQuoted = value.startsWith('"') && value.endsWith('"');
  const unquoted = isQuoted ? value.slice(1, -1) : value;
  // No %% doubling: on the command line cmd.exe keeps %% literal, which breaks
  // atoms like git's --format=%(refname).
  const escaped = unquoted.replace(/([&|^<>()!])/g, "^$1");
  if (isQuoted || /[\s"]/u.test(unquoted)) {
    const quoted = escaped
      .replace(/(\\*)"/g, (_match, slashes) => `${slashes}${slashes}\\"`)
      .replace(/\\+$/u, (slashes) => `${slashes}${slashes}`);
    return `"${quoted}"`;
  }
  return escaped;
}

function spawnSpec(command, platform) {
  const shell = shouldUseWindowsShell(command[0], platform);
  if (platform !== "win32" || !shell) return { command: command[0], args: command.slice(1), shell };
  return {
    command: escapeWindowsCmdValue(command[0]),
    args: command.slice(1).map(escapeWindowsCmdValue),
    shell,
  };
}

export async function readBuildCommands(directory) {
  // A missing or unparseable manifest is the daemon's error to report on
  // install; preparation only claims the `build` field when it is present.
  let manifest;
  try {
    manifest = JSON.parse(await readFile(path.join(directory, "paseo-plugin.json"), "utf8"));
  } catch {
    return [];
  }
  const build = manifest?.build;
  if (build === undefined || build === null) return [];
  if (
    !Array.isArray(build) ||
    !build.every(
      (command) =>
        Array.isArray(command) &&
        command.length > 0 &&
        command.every((part) => typeof part === "string"),
    )
  )
    throw new Error(
      `Invalid build commands in plugin manifest: ${path.join(directory, "paseo-plugin.json")}`,
    );
  return build;
}

function formatCommand(command) {
  return command.map((part) => JSON.stringify(part)).join(" ");
}

function formatOutput(result) {
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  return output ? `\n${output}` : "";
}

function killProcessTree(child, platform) {
  if (child.pid === undefined) {
    child.kill("SIGKILL");
    return;
  }
  if (platform === "win32") {
    // taskkill /T reaches descendants behind cmd.exe launchers; a failure
    // falls back to killing the immediate child only.
    const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
    });
    killer.once("error", () => {
      try {
        child.kill("SIGKILL");
      } catch {}
    });
    return;
  }
  // The child was spawned detached, so it leads its own process group and the
  // negative pid signals every descendant at once.
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {}
  }
}

function runCommand(directory, command, options) {
  return new Promise((resolve) => {
    const spec = spawnSpec(command, options.platform);
    const isWindows = options.platform === "win32";
    let stdout = "",
      stderr = "",
      spawnError = null;
    let settled = false;
    let timeoutTimer = null,
      forceTimer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (forceTimer) clearTimeout(forceTimer);
      resolve(result);
    };
    let child;
    try {
      child = options.spawnFn(spec.command, spec.args, {
        cwd: directory,
        env: options.env ?? process.env,
        shell: spec.shell,
        windowsHide: true,
        detached: !isWindows,
      });
    } catch (err) {
      finish({ exitCode: null, stdout, stderr, error: err });
      return;
    }
    if (options.timeoutMs) {
      timeoutTimer = setTimeout(() => {
        if (settled) return;
        stderr += `\nBuild command timed out after ${options.timeoutMs}ms`;
        (options.killTree ?? killProcessTree)(child, options.platform);
        // Killing the tree normally delivers `close` promptly, but a
        // descendant that keeps an inherited pipe open must not hold the
        // synchronization operation forever: settle after a bounded grace.
        forceTimer = setTimeout(
          () => finish({ exitCode: null, stdout, stderr, error: spawnError }),
          FORCE_SETTLE_MS,
        );
      }, options.timeoutMs);
    }
    child.stdout?.on("data", (chunk) => {
      stdout = `${stdout}${chunk}`.slice(-OUTPUT_LIMIT);
    });
    child.stderr?.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-OUTPUT_LIMIT);
    });
    child.once("error", (err) => {
      spawnError = err;
    });
    child.once("close", (exitCode) => {
      finish({ exitCode, stdout, stderr, error: spawnError });
    });
  });
}

export async function runPluginBuildCommands(directory, commands, options = {}) {
  for (const command of commands) {
    const result = await runCommand(directory, command, {
      spawnFn: options.spawn ?? spawn,
      platform: options.platform ?? process.platform,
      env: options.env,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      killTree: options.killTree,
    });
    if (result.error)
      throw new Error(
        `Plugin build command failed to start: ${formatCommand(command)}\n${result.error.message}`,
      );
    if (result.exitCode !== 0)
      throw new Error(
        `Plugin build command failed (exit ${result.exitCode ?? "unknown"}): ${formatCommand(command)}${formatOutput(result)}${BUILD_FAILURE_HINT}`,
      );
  }
}

export async function prepareBundleDirectory(directory, options = {}) {
  const commands = await readBuildCommands(directory);
  if (commands.length) await runPluginBuildCommands(directory, commands, options);
  return commands.length;
}
