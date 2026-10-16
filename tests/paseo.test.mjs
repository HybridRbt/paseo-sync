import test from "node:test";
import assert from "node:assert/strict";
import {
  windowsLaunch,
  installArguments,
  parseJsonOutput,
  assertDaemonVersion,
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
