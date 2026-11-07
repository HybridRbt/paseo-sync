import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

const OUTPUT_LIMIT = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

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

function runCommand(directory, command, options) {
  return new Promise((resolve) => {
    const spec = spawnSpec(command, options.platform);
    let stdout = "",
      stderr = "",
      spawnError = null,
      settled = false;
    let child;
    try {
      child = options.spawnFn(spec.command, spec.args, {
        cwd: directory,
        env: options.env ?? process.env,
        shell: spec.shell,
        windowsHide: true,
      });
    } catch (err) {
      resolve({ exitCode: null, stdout, stderr, error: err });
      return;
    }
    const timer = options.timeoutMs
      ? setTimeout(() => {
          if (!settled && child.pid !== undefined) {
            stderr += `\nBuild command timed out after ${options.timeoutMs}ms`;
            child.kill();
          }
        }, options.timeoutMs)
      : null;
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
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ exitCode, stdout, stderr, error: spawnError });
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
    });
    if (result.error)
      throw new Error(
        `Plugin build command failed to start: ${formatCommand(command)}\n${result.error.message}`,
      );
    if (result.exitCode !== 0)
      throw new Error(
        `Plugin build command failed (exit ${result.exitCode ?? "unknown"}): ${formatCommand(command)}${formatOutput(result)}`,
      );
  }
}

export async function prepareBundleDirectory(directory, options = {}) {
  const commands = await readBuildCommands(directory);
  if (commands.length) await runPluginBuildCommands(directory, commands, options);
  return commands.length;
}
