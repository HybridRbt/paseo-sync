import test from "node:test";
import assert from "node:assert/strict";
import {
  actionGate,
  classifyFailure,
  progressFromJob,
  setupSteps,
  loadProgress,
  saveProgress,
  absolutePathLike,
  EMPTY_PROGRESS,
} from "../shared/setupFlow.mjs";

const OK = {
  saved: true,
  dirty: false,
  checkoutSet: true,
  repoReady: true,
  backup: true,
};

test("known prerequisite failures are separated from real errors", () => {
  for (const message of [
    "ENOENT: no such file or directory, open '/x/profile.json'",
    "ENOENT: no such file or directory, scandir '/missing'",
    "Set an absolute profile checkout path first",
    "Checkout must be an absolute path outside the Paseo home",
    "Paseo CLI not found. Install its CLI entry from Paseo.",
    "Daemon PID mismatch (expected parent 1, CLI reported 2): this plugin may only operate its parent daemon.",
    "Paseo daemon >=0.11.4 is required.",
    "Repository has uncommitted or untracked changes; review before continuing.",
    "Repository behind or diverged; pull and reconcile before publishing",
    "Approval digest is required",
    "Choose a backup ID",
    "Another operation is active, or an interrupted operation requires review.",
    "Git push failed (128). Check repository state and noninteractive host credentials.",
    "Operation preview is stale. Review a new preview.",
    "Use your separate configuration repository, not the public plugin source",
  ])
    assert.equal(classifyFailure(message), "precondition", message);
  for (const message of [
    "Paseo command failed (plugin apply): unexpected exit",
    "Unexpected plugin list response",
    "Cannot read internal state",
  ])
    assert.equal(classifyFailure(message), "error", message);
  assert.equal(classifyFailure(""), "error");
});

test("client-side absolute path check mirrors the server gate without node:path", () => {
  assert.equal(absolutePathLike("/Users/x/profile"), true);
  assert.equal(absolutePathLike("C:\\profiles\\x"), true);
  assert.equal(absolutePathLike("C:/profiles/x"), true);
  assert.equal(absolutePathLike("profiles/x"), false);
  assert.equal(absolutePathLike(""), false);
  assert.equal(absolutePathLike(undefined), false);
});

test("actions are gated only when a missing prerequisite is known", () => {
  assert.deepEqual(actionGate("unlock", { ...OK, saved: false }), {
    disabled: false,
    reason: null,
  });
  assert.deepEqual(actionGate("prepare", { ...OK, saved: false }), {
    disabled: true,
    reason: "unsaved",
  });
  assert.deepEqual(actionGate("inspect", { ...OK, dirty: true }), {
    disabled: true,
    reason: "dirty",
  });
  assert.deepEqual(actionGate("prepare", { ...OK, checkoutSet: false }), {
    disabled: true,
    reason: "absolute",
  });
  // prepare and inspect are step 1/3: they do not require the repo step.
  for (const kind of ["prepare", "inspect"])
    assert.deepEqual(actionGate(kind, { ...OK, repoReady: false }), {
      disabled: false,
      reason: null,
    });
  for (const kind of [
    "plan",
    "cafePlan",
    "publishPlan",
    "verify",
    "backups",
    "restorePlan",
  ])
    assert.deepEqual(actionGate(kind, { ...OK, repoReady: false }), {
      disabled: true,
      reason: "repo",
    });
  assert.deepEqual(actionGate("restorePlan", { ...OK, backup: false }), {
    disabled: true,
    reason: "backup",
  });
  for (const kind of [
    "prepare",
    "inspect",
    "plan",
    "cafePlan",
    "publishPlan",
    "verify",
    "backups",
    "restorePlan",
  ])
    assert.deepEqual(actionGate(kind, OK), { disabled: false, reason: null });
});

test("a payable-free job history updates progress with implications and checkout invalidation", () => {
  const base = { ...EMPTY_PROGRESS, checkout: "/profile" };
  assert.deepEqual(progressFromJob(base, "inspect", "/profile"), {
    ...base,
    inspected: true,
  });
  assert.deepEqual(progressFromJob(base, "prepare", "/profile"), {
    ...base,
    prepared: true,
  });
  assert.deepEqual(progressFromJob(base, "plan", "/profile"), {
    ...base,
    prepared: true,
  });
  assert.deepEqual(progressFromJob(base, "cafe", "/profile"), {
    ...base,
    cafe: true,
    prepared: true,
  });
  assert.deepEqual(progressFromJob(base, "apply", "/profile"), {
    ...base,
    applied: true,
    cafe: true,
    prepared: true,
  });
  // Switching checkouts starts a fresh progress for that checkout.
  assert.deepEqual(progressFromJob(base, "apply", "/other"), {
    checkout: "/other",
    prepared: true,
    inspected: false,
    cafe: true,
    applied: true,
  });
});

test("setup steps derive done/current/waiting states and completion", () => {
  const all = setupSteps({
    saved: true,
    dirty: false,
    checkoutSet: true,
    repoReady: true,
    inspected: true,
    cafeDone: true,
    applied: true,
  });
  assert.equal(all.completed, true);
  assert.deepEqual(
    all.steps.map((s) => s.state),
    ["done", "done", "done", "done", "done"],
  );

  const fresh = setupSteps({
    saved: false,
    dirty: false,
    checkoutSet: false,
    repoReady: false,
    inspected: false,
    cafeDone: false,
    applied: false,
  });
  assert.equal(fresh.completed, false);
  assert.equal(fresh.steps[0].state, "current");
  assert.deepEqual(
    fresh.steps.slice(1).map((s) => s.state),
    ["waiting", "waiting", "waiting", "waiting"],
  );

  const partial = setupSteps({
    saved: true,
    dirty: false,
    checkoutSet: true,
    repoReady: true,
    inspected: false,
    cafeDone: false,
    applied: false,
  });
  assert.deepEqual(
    partial.steps.map((s) => s.state),
    ["done", "done", "current", "waiting", "waiting"],
  );
});

test("client setup progress persists per host with denied or corrupt storage falling back safely", () => {
  const values = new Map();
  const storage = {
    getItem: (k) => values.get(k),
    setItem: (k, v) => values.set(k, v),
  };
  const progress = { ...EMPTY_PROGRESS, checkout: "/profile", prepared: true };
  saveProgress("host-1", progress, storage);
  assert.deepEqual(loadProgress("host-1", storage), progress);
  assert.deepEqual(loadProgress("host-2", storage), EMPTY_PROGRESS);

  values.set("paseo-sync.setup:host-3", "{not json");
  assert.deepEqual(loadProgress("host-3", storage), EMPTY_PROGRESS);

  const denied = {
    getItem() {
      throw Error("denied");
    },
    setItem() {
      throw Error("denied");
    },
  };
  assert.deepEqual(loadProgress("host-4", denied), EMPTY_PROGRESS);
  assert.doesNotThrow(() => saveProgress("host-4", progress, denied));
});
