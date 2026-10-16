import test from "node:test";
import assert from "node:assert/strict";
import * as identity from "../server/core/daemon-identity.mjs";
test("accepts daemon supervisor ancestry and rejects unrelated or invalid PIDs", async () => {
  assert.equal(typeof identity.belongsToDaemon, "function");
  const parents = new Map([
      [12, 11],
      [11, 10],
      [10, 1],
    ]),
    parent = async (pid) => parents.get(pid) ?? 0;
  assert.equal(await identity.belongsToDaemon(10, 12, parent), true);
  assert.equal(await identity.belongsToDaemon(12, 12, parent), true);
  assert.equal(await identity.belongsToDaemon(99, 12, parent), false);
  assert.equal(await identity.belongsToDaemon(undefined, 12, parent), false);
  assert.equal(await identity.belongsToDaemon(99, 12, async () => 12), false);
});
