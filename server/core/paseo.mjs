import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, realpath, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const exec = promisify(execFile);
export function windowsLaunch(shim) {
  const resources = path.win32.dirname(path.win32.dirname(shim));
  return {
    command: path.win32.join(resources, "..", "Paseo.exe"),
    args: [
      "--disable-warning=DEP0040",
      path.win32.join(
        resources,
        "app.asar.unpacked",
        "dist",
        "daemon",
        "node-entrypoint-runner.js",
      ),
      "node-script",
      path.win32.join(
        resources,
        "app.asar",
        "node_modules",
        "@getpaseo",
        "cli",
        "dist",
        "index.js",
      ),
    ],
    env: {
      ELECTRON_RUN_AS_NODE: "1",
      PASEO_NODE_ENV: "production",
      PASEO_DESKTOP_MANAGED: "1",
      PASEO_CLI: shim,
    },
    shell: false,
  };
}
export function installArguments(p, home) {
  const args = [
    "plugin",
    "install",
    p.source.startsWith("npm:") ? `${p.source}@${p.revision}` : p.source,
    "--id",
    p.id,
  ];
  if (p.source.startsWith("git:")) args.push("--ref", p.revision);
  if (p.pluginPath && p.pluginPath !== ".") args.push("--path", p.pluginPath);
  return [...args, "--home", home, "--json"];
}
export function updateArguments(p, home) {
  return [
    "plugin",
    "update",
    p.id,
    p.source.startsWith("npm:") ? "--version" : "--ref",
    p.revision,
    "--home",
    home,
    "--json",
  ];
}
export function parseJsonOutput(stdout) {
  const value = JSON.parse(stdout.trim());
  if (value?.error)
    throw new Error(
      `Paseo ${value.error.code ?? "ERROR"}: ${value.error.message ?? "request failed"}`,
    );
  return value;
}
export function assertDaemonVersion(version) {
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version))
    throw new Error(
      "Cannot confirm a supported stable daemon version; Paseo >=0.11.4 is required.",
    );
  const [major, minor, patch] = version.split(".").map(Number);
  if (major === 0 && (minor < 11 || (minor === 11 && patch < 4)))
    throw new Error("Paseo daemon >=0.11.4 is required.");
}
async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}
async function locate(explicit) {
  if (explicit) return explicit;
  const names =
    process.platform === "win32"
      ? ["paseo.exe", "paseo.cmd", "paseo"]
      : ["paseo"];
  for (const folder of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!folder) continue;
    for (const name of names) {
      const p = path.join(folder, name);
      if (await exists(p)) return p;
    }
  }
  const candidates =
    process.platform === "darwin"
      ? [
          "/Applications/Paseo.app/Contents/Resources/bin/paseo",
          path.join(
            os.homedir(),
            "Applications/Paseo.app/Contents/Resources/bin/paseo",
          ),
        ]
      : [
          path.join(
            process.env.LOCALAPPDATA ?? os.homedir(),
            "Programs",
            "Paseo",
            "resources",
            "bin",
            "paseo.cmd",
          ),
        ];
  for (const p of candidates) if (await exists(p)) return p;
  throw new Error(
    "Paseo CLI not found. Install its CLI entry from Paseo, or pass --paseo <absolute executable/shim path>.",
  );
}
export async function makeAdapter(home, explicit) {
  const executable = await realpath(await locate(explicit));
  let launch = { command: executable, args: [], env: {}, shell: false };
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(executable)) {
    const desktop = windowsLaunch(executable);
    if ((await exists(desktop.command)) && (await exists(desktop.args[1])))
      launch = desktop;
    else {
      // npm's normal global shim: resolve its package bin without executing cmd.exe.
      const unsupported = () =>
        new Error(
          `Unsupported Windows Paseo shim ${executable}; use the official desktop CLI or npm @getpaseo/cli, or set the plugin CLI path setting.`,
        );
      const packageRoot = path.join(
        path.dirname(executable),
        "node_modules",
        "@getpaseo",
        "cli",
      );
      let pkg;
      try {
        pkg = JSON.parse(
          await readFile(path.join(packageRoot, "package.json"), "utf8"),
        );
      } catch (e) {
        if (e.code === "ENOENT") throw unsupported();
        throw e;
      }
      const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.paseo;
      if (!bin || path.isAbsolute(bin) || bin.split(/[\\/]/).includes(".."))
        throw unsupported();
      launch = {
        command: process.execPath,
        args: [path.join(packageRoot, bin)],
        env: {},
        shell: false,
      };
    }
  }
  const call = async (args) => {
    try {
      const childEnv = { ...process.env, ...launch.env };
      if (!launch.env.ELECTRON_RUN_AS_NODE)
        delete childEnv.ELECTRON_RUN_AS_NODE;
      const { stdout } = await exec(launch.command, [...launch.args, ...args], {
        env: childEnv,
        shell: false,
        timeout: 240000,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
      });
      return parseJsonOutput(stdout);
    } catch (error) {
      if (error.stdout) {
        try {
          parseJsonOutput(error.stdout);
        } catch (inner) {
          throw inner;
        }
      }
      const detail = (error.stderr ?? "")
        .split("\n")
        .filter(
          (line) =>
            !/(token|secret|api.?key|authorization|credential)/i.test(line),
        )
        .join("\n")
        .slice(-1600);
      throw new Error(
        `Paseo command failed (${args.slice(0, 2).join(" ")}): ${error.code ?? error.message}${detail ? "\n" + detail : ""}`,
      );
    }
  };
  return {
    executable,
    status: () => call(["status", "--home", home, "--json"]),
    async list() {
      const rows = await call(["plugin", "ls", "--home", home, "--json"]);
      if (!Array.isArray(rows))
        throw new Error("Unexpected plugin list response");
      return rows;
    },
    act: (action, id) => call(["plugin", action, id, "--home", home, "--json"]),
    install: (p) => call(installArguments(p, home)),
    update: (p) => call(updateArguments(p, home)),
  };
}
