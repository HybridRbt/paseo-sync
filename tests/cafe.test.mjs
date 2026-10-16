import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeJson } from "../server/core/files.mjs";
import * as cafe from "../server/core/cafe.mjs";
async function fixture() {
  const base = await mkdtemp(path.join(os.tmpdir(), "paseo-cafe-test-"));
  const home = path.join(base, "home"),
    state = path.join(base, "state");
  await mkdir(home);
  await mkdir(state);
  const file = path.join(
    home,
    "plugin-settings/paseo-cafe/directory-settings.json",
  );
  const original = {
    version: 1,
    values: { autoUpdateOptOuts: ["other"], somePreference: "keep" },
  };
  await writeJson(file, original);
  let enabled = true;
  const calls = [];
  const ctx = {
    home,
    state,
    adapter: {
      list: async () => [{ id: "paseo-cafe", enabled }],
      act: async (a) => {
        calls.push(a);
        enabled = a === "enable";
      },
    },
  };
  return { ctx, file, original, calls };
}
test("Cafe exclusions preserve unrelated fields and can be restored", async () => {
  assert.equal(typeof cafe.cafePlan, "function");
  const f = await fixture();
  const p = await cafe.cafePlan(f.ctx, ["demo", "paseo-cafe"]);
  assert.deepEqual(p.missing, ["demo", "paseo-cafe"]);
  const r = await cafe.applyCafe(f.ctx, ["demo", "paseo-cafe"], p.approval);
  const d = JSON.parse(await readFile(f.file, "utf8"));
  assert.equal(d.values.somePreference, "keep");
  assert.deepEqual(d.values.autoUpdateOptOuts, ["demo", "other", "paseo-cafe"]);
  assert.deepEqual(f.calls, ["disable", "enable"]);
  const restore = await cafe.cafeRestorePlan(f.ctx, r.backupId);
  await cafe.restoreCafe(f.ctx, r.backupId, restore.approval);
  assert.deepEqual(JSON.parse(await readFile(f.file, "utf8")), f.original);
});
test("Cafe stale previews and concurrent writes are rejected", async () => {
  const f = await fixture();
  const p = await cafe.cafePlan(f.ctx, ["demo"]);
  await writeJson(f.file, {
    version: 1,
    values: { autoUpdateOptOuts: ["new"] },
  });
  await assert.rejects(cafe.applyCafe(f.ctx, ["demo"], p.approval), /stale/i);
  assert.deepEqual(f.calls, []);
  const next = await cafe.cafePlan(f.ctx, ["demo"]);
  const act = f.ctx.adapter.act;
  f.ctx.adapter.act = async (a) => {
    await act(a);
    if (a === "disable")
      await writeJson(f.file, {
        version: 1,
        values: { autoUpdateOptOuts: ["concurrent"] },
      });
  };
  await assert.rejects(
    cafe.applyCafe(f.ctx, ["demo"], next.approval),
    /concurrent/i,
  );
  assert.deepEqual(
    JSON.parse(await readFile(f.file, "utf8")).values.autoUpdateOptOuts,
    ["concurrent"],
  );
});

test("accepts current Cafe v5 documents and preserves browse and registry values", async () => {
  const f = await fixture();
  const current = {
    version: 5,
    values: {
      registryUrl: "https://plugins.paseo.sh",
      browse: { query: "keep", categories: [] },
      autoUpdateOptOuts: ["other"],
    },
  };
  await writeJson(f.file, current);
  const p = await cafe.cafePlan(f.ctx, ["demo"]);
  const r = await cafe.applyCafe(f.ctx, ["demo"], p.approval);
  const after = JSON.parse(await readFile(f.file, "utf8"));
  assert.equal(after.version, 5);
  assert.deepEqual(after.values.browse, current.values.browse);
  assert.equal(after.values.registryUrl, current.values.registryUrl);
  const restore = await cafe.cafeRestorePlan(f.ctx, r.backupId);
  await cafe.restoreCafe(f.ctx, r.backupId, restore.approval);
  assert.deepEqual(JSON.parse(await readFile(f.file, "utf8")), current);
});
test("Cafe failed enable can be restored and restores original enabled state", async () => {
  const f = await fixture(),
    act = f.ctx.adapter.act;
  let fail = true;
  f.ctx.adapter.act = async (a) => {
    if (a === "enable" && fail) throw new Error("enable failure");
    return act(a);
  };
  const p = await cafe.cafePlan(f.ctx, ["demo"]);
  let backupId;
  await assert.rejects(cafe.applyCafe(f.ctx, ["demo"], p.approval), (e) => {
    backupId = e.backupId;
    return !!backupId;
  });
  fail = false;
  const restore = await cafe.cafeRestorePlan(f.ctx, backupId);
  await cafe.restoreCafe(f.ctx, backupId, restore.approval);
  assert.equal((await f.ctx.adapter.list())[0].enabled, true);
  assert.deepEqual(JSON.parse(await readFile(f.file, "utf8")), f.original);
});
test("Cafe restore rejects enabled-state changes made after the operation", async () => {
  const f = await fixture(),
    p = await cafe.cafePlan(f.ctx, ["demo"]);
  const r = await cafe.applyCafe(f.ctx, ["demo"], p.approval);
  await f.ctx.adapter.act("disable");
  const restore = await cafe.cafeRestorePlan(f.ctx, r.backupId);
  assert.ok(restore.conflicts.length);
  await assert.rejects(cafe.restoreCafe(f.ctx, r.backupId, restore.approval));
});
