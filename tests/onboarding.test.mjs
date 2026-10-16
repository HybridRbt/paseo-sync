import test from "node:test";
import assert from "node:assert/strict";
import { mergeDiscovery } from "../shared/onboarding.mjs";
import {
  translator,
  resolveLanguage,
  readLanguage,
  saveLanguage,
} from "../client/i18n.mjs";
test("late discovery cannot overwrite a path or URL edited while search was running", () => {
  const initial = { checkout: "", repositoryUrl: "" };
  const c = {
    checkout: "/found",
    repositoryUrl: "https://example.com/profile.git",
  };
  assert.deepEqual(
    mergeDiscovery({ ...initial, checkout: "/manual" }, initial, c),
    { checkout: "/manual", repositoryUrl: "" },
  );
  assert.deepEqual(
    mergeDiscovery(
      { ...initial, repositoryUrl: "https://example.com/manual" },
      initial,
      c,
    ),
    { checkout: "", repositoryUrl: "https://example.com/manual" },
  );
  assert.deepEqual(mergeDiscovery(initial, initial, c), {
    checkout: "/found",
    repositoryUrl: "https://example.com/profile.git",
  });
});
test("repository without origin keeps a manually supplied clone URL", () => {
  const d = {
    checkout: "/profile",
    repositoryUrl: "https://example.com/profile",
  };
  assert.equal(
    mergeDiscovery(d, d, { checkout: "/profile", repositoryUrl: null })
      .repositoryUrl,
    d.repositoryUrl,
  );
});
test("manual language wins, optional host locale resolves, unsupported host defaults to English", () => {
  assert.equal(resolveLanguage("en", "zh-CN"), "en");
  assert.equal(resolveLanguage("auto", "zh-CN"), "zh");
  assert.equal(resolveLanguage("auto", "fr"), "en");
  assert.equal(resolveLanguage("auto", undefined), "zh");
});
test("English UI interpolates host and translated status while technical values stay literal", () => {
  const t = translator("en");
  assert.equal(
    t("操作主机：{host}。任务在此主机执行；每台 daemon 分别同步。", {
      host: "Mac.local",
    }),
    "Host: Mac.local. Tasks run here; sync each daemon separately.",
  );
  assert.equal(t("预览差异"), "Preview changes");
  assert.equal(t("存在差异"), "Differences found");
  assert.equal(translator("zh")("预览差异"), "预览差异");
});
test("client language preference survives with local storage and denied storage falls back to session memory", () => {
  const values = new Map();
  const storage = {
    getItem: (k) => values.get(k),
    setItem: (k, v) => values.set(k, v),
  };
  saveLanguage("en", storage);
  assert.equal(readLanguage(storage), "en");
  const denied = {
    getItem() {
      throw Error("denied");
    },
    setItem() {
      throw Error("denied");
    },
  };
  saveLanguage("zh", denied);
  assert.equal(readLanguage(denied), "zh");
});

test("editing a clone target preserves a manually entered URL and clears only a discovered URL", async () => {
  const { editCheckout } = await import("../shared/onboarding.mjs");
  const draft = {
    checkout: "/old",
    repositoryUrl: "https://example.com/manual.git",
    cliPath: "cli",
  };
  assert.deepEqual(editCheckout(draft, "/new", null), {
    ...draft,
    checkout: "/new",
  });
  const found = { repositoryUrl: "https://example.com/auto.git" };
  assert.equal(
    editCheckout(
      { ...draft, repositoryUrl: found.repositoryUrl },
      "/new",
      found,
    ).repositoryUrl,
    "",
  );
  assert.equal(
    editCheckout(draft, "/new", found).repositoryUrl,
    draft.repositoryUrl,
  );
});
test("a session choice wins when storage is readable but refuses writes", () => {
  const storage = {
    getItem: () => "zh",
    setItem: () => {
      throw Error("quota");
    },
  };
  saveLanguage("en", storage);
  assert.equal(readLanguage(storage), "en");
});
