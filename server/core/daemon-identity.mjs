import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
export async function parentPid(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return 0;
  try {
    const command = process.platform === "win32" ? "powershell.exe" : "ps";
    const args =
      process.platform === "win32"
        ? [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" | Select-Object -ExpandProperty ParentProcessId`,
          ]
        : ["-p", String(pid), "-o", "ppid="];
    const { stdout } = await exec(command, args, {
      timeout: 10000,
      windowsHide: true,
      maxBuffer: 4096,
    });
    const value = Number(stdout.trim());
    return Number.isSafeInteger(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}
export async function belongsToDaemon(reported, parent, getParent = parentPid) {
  if (
    !Number.isSafeInteger(reported) ||
    reported <= 1 ||
    !Number.isSafeInteger(parent) ||
    parent <= 1
  )
    return false;
  const seen = new Set();
  let pid = parent;
  for (let i = 0; i < 5 && pid > 1 && !seen.has(pid); i++) {
    if (pid === reported) return true;
    seen.add(pid);
    pid = await getParent(pid);
  }
  return false;
}
