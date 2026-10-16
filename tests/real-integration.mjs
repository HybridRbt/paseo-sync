// Opt-in only: isolated temporary home, no personal configuration repository.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { writeJson } from "../server/core/files.mjs";
import { makeAdapter } from "../server/core/paseo.mjs";
if (process.env.PASEO_INTEGRATION !== "1")
  throw new Error("Set PASEO_INTEGRATION=1 to run a temporary daemon test");
const exec = promisify(execFile),
  root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
  base = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "paseo-native-integration-")),
  );
const home = path.join(base, "home"),
  repo = path.join(base, "profile");
await mkdir(home);
await mkdir(repo);
await writeJson(path.join(home, "config.json"), {
  version: 1,
  daemon: { listen: "127.0.0.1:0", relay: { enabled: false } },
  features: { dictation: { enabled: false }, voiceMode: { enabled: false } },
  pluginsEnabled: true,
  plugins: {},
});
await writeJson(path.join(repo, "profile.json"), {
  schemaVersion: 1,
  plugins: [],
  settings: [],
  patches: [],
});
for (const a of [
  ["init", "-q"],
  ["config", "user.name", "Integration"],
  ["config", "user.email", "test@example.invalid"],
  ["add", "profile.json"],
  ["commit", "-qm", "initial"],
])
  await exec("git", ["-c", "core.fsmonitor=false", "-C", repo, ...a]);
const adapter = await makeAdapter(home),
  env = {
    ...process.env,
    PASEO_HOME: home,
    PASEO_SYNC_STATE: path.join(base, "state"),
  };
let client;
try {
  await exec(
    adapter.executable,
    ["daemon", "start", "--home", home, "--timeout", "60"],
    { env, timeout: 90000, maxBuffer: 2 * 1024 * 1024 },
  );
  const installed = JSON.parse(
    (
      await exec(
        adapter.executable,
        ["plugin", "install", root, "--home", home, "--json"],
        { env, timeout: 120000, maxBuffer: 2 * 1024 * 1024 },
      )
    ).stdout,
  );
  assert.equal(installed.status, "running");
  console.log("PASS: native plugin server and client compile on Paseo 0.11.4");
  const status = await adapter.status();
  client = new DaemonClient({
    url: `ws://${status.listen}/ws`,
    clientId: "paseo-sync-integration",
    clientType: "browser",
    appVersion: "0.11.4",
    reconnect: { enabled: false },
  });
  await client.connect();
  const rpc = (method, input) =>
    client.invokePluginRpc("paseo-sync", method, input);
  const settings = await rpc("settings.connection.read", {});
  assert.equal(settings.status, "ready");
  const saved = await rpc("settings.connection.write", {
    revision: settings.revision,
    values: {
      checkout: repo,
      repositoryUrl: "",
      daemonHome: home,
      cliPath: adapter.executable,
    },
  });
  assert.equal(saved.status, "saved");
  async function operation(input) {
    const j = await rpc("sync.start", input);
    for (let i = 0; i < 120; i++) {
      const r = await rpc("sync.job", { id: j.id });
      if (["succeeded", "failed"].includes(r.status)) {
        assert.equal(r.status, "succeeded", r.error);
        return r.result;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error("Operation timeout");
  }
  const inspect = await operation({ kind: "inspect" });
  assert.equal(inspect.home, home);
  const plan = await operation({ kind: "plan" });
  assert.deepEqual(plan.conflicts, []);
  const applied = await operation({ kind: "apply", approval: plan.approval });
  assert.equal(applied.changed, false);
  console.log(
    "PASS: native settings, daemon PID binding, RPC jobs, preview approval and idempotent apply",
  );
  const exportPlan = await operation({ kind: "publishPlan" });
  assert.equal(exportPlan.files.length, 0);
  console.log(
    "PASS: controller directory installation excluded from portable export",
  );
  // Existing configured ID: direct npm upgrade/downgrade preserves disabled state.
  const target = {
    id: "recap-probe",
    source: "npm:paseo-recap",
    revision: "0.2.2",
    enabled: true,
  };
  await adapter.install(target);
  await adapter.act("disable", target.id);
  await adapter.update({ ...target, revision: "0.2.3" });
  let row = (await adapter.list()).find((x) => x.id === target.id);
  assert.equal(row.installation.currentRevision, "0.2.3");
  assert.equal(row.enabled, false);
  await adapter.update(target);
  row = (await adapter.list()).find((x) => x.id === target.id);
  assert.equal(row.installation.currentRevision, "0.2.2");
  assert.equal(row.enabled, false);
  console.log(
    "PASS: real npm upgrade and downgrade with configured ID and disabled state preserved",
  );
  console.log(JSON.stringify({ result: "passed", temporaryHome: home }));
} finally {
  await client?.close().catch(() => {});
  await exec(
    adapter.executable,
    ["daemon", "stop", "--home", home, "--timeout", "15", "--json"],
    { env, timeout: 30000, maxBuffer: 1024 * 1024 },
  ).catch(() => {});
}
