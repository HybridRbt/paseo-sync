# Sync Direction Choice (Prefer Local / Prefer Profile) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable users to resolve local-vs-cloud configuration conflicts in either direction—overwriting the cloud profile with local state (`preferLocal`) or overwriting local state with the cloud profile (`preferProfile`)—directly from the Paseo Sync UI without dead-end conflict screens.

**Architecture:** Extend the shared RPC contract (`shared/rpc.ts`) and service layer (`server/service.mjs`) with explicit `preferLocal` and `preferProfile` flags bound into preview approval digests. Update `server/core/export.mjs` and `server/core/repository.mjs` to support `preferLocal` (and skip untracked directory plugins), update `server/core/sync.mjs` to skip unsupported registry version pins as disclosed `skipped` entries when `preferProfile` is active, allow `publish` to complete step 5 of `shared/setupFlow.mjs`, and render bilingual conflict explanations and direction-choice buttons in `client/sync.tsx` / `client/i18n.mjs`.

**Tech Stack:** Node.js >=22.18 (`node:test`, `node:assert/strict`), TypeScript 5.9, React Native, `@getpaseo/plugin` 0.11.4, Zod 4.

**Spec:** `docs/superpowers/specs/2026-11-05-sync-direction-choice-design.md`

## Global Constraints

- Zero third-party runtime dependencies; keep strict `client/`, `server/`, and `shared/` module boundaries.
- Default calls to `buildPlan(ctx)`, `applyPlan(ctx, approval)`, and `exportProfile(ctx)` (when `preferProfile` / `preferLocal` are omitted) must preserve existing behavior and error messages expected by the test suite.
- Never run `paseo plugin remove` to force a registry version change (removing deletes the plugin's settings directory in Paseo).
- Every preview approval digest (`approval`) must bind `preferProfile` / `preferLocal` so a normal preview cannot be confirmed as an overwrite or vice versa.
- All new UI labels, conflict disclosures, and skip notices must have both Chinese (`zh`) and English (`en`) translations in `client/i18n.mjs`.

## Review Focus

1. Unapplied remote plugin or settings changes in `publishPlan(ctx)` when `preferLocal` is false: must surface in `preview.conflicts` (disabling `canConfirmPreview`) rather than throwing an uncaught job failure, while `publishPlan({ ...ctx, preferLocal: true })` clears those conflicts and allows publishing.
2. Approval binding for `preferLocal` and `preferProfile`: confirming `publish` or `apply` with a mismatched `preferLocal` / `preferProfile` flag must reject with a stale preview error.
3. Registry-installed plugin version differences (`now.revision !== target.revision && now.registry`) under `preferProfile: true`: must be recorded in `plan.skipped` with `reason: "registry-version-transition"` so other plugins and settings apply cleanly and baseline/backup scope excludes the skipped registry plugin.
4. Untracked directory plugins (such as `flowly` installed from a local worktree) during `exportProfile` / `publishPlan` / `capture`: must be skipped with `reason: "untracked"` instead of throwing `Cannot export untracked plugin`.
5. First-time setup step 5 completion: completing `publish` must mark `applied: true` and `cafe: true` in `progressFromJob` just like `apply`.

---

### Task 1: Export & Publish Overwrite (`preferLocal`) and Portable Plugin Support

**Files:**
- Modify: `server/core/profile.mjs:137-150`, `server/core/profile.mjs:265-285`
- Modify: `server/core/export.mjs:10-21`, `server/core/export.mjs:80-185`
- Modify: `server/core/repository.mjs:79-220`
- Test: `tests/export.test.mjs`, `tests/repository.test.mjs`

**Interfaces:**
- Produces:
  - `isPortablePlugin(row: object): boolean` in `server/core/profile.mjs`
  - `exportProfile(ctx: { root: string, home: string, state?: string, adapter: object, selfId?: string, selfIds?: string[], preferLocal?: boolean }): Promise<{ exported: true, plugins: number, settings: number, patches: number, profileHash: string, skipped: Array<object>, warnings: string[] }>` in `server/core/export.mjs`
  - `publishPlan(ctx: { root: string, home: string, state: string, lockRoot?: string, adapter: object, selfIds?: string[], preferLocal?: boolean }): Promise<{ head: string, origin: string | null, upstream: string | null, pushUrl: string | null, files: Array<{ path: string, before: string | null, after: string }>, skipped: Array<object>, conflicts: string[], preferLocal: boolean, approval: string }>` in `server/core/repository.mjs`
  - `publish(ctx: object, approval: string, options?: { push?: boolean }): Promise<{ committed: boolean, pushed: boolean, commit: string }>` in `server/core/repository.mjs`

- [ ] **Step 1: Write failing tests in `tests/export.test.mjs` and `tests/repository.test.mjs`**

Update `tests/export.test.mjs` to test skipping untracked plugins, allowing `chatEnabled` in `presentation` settings, and overwriting unapplied remote changes when `preferLocal: true`:

```js
test("export skips untracked plugin without portable identity instead of refusing", async () => {
  const ctx = await fixture();
  ctx.rows.push({ id: "mystery", enabled: true, path: "/tmp/unknown" });
  const result = await exportProfile(ctx);
  assert.deepEqual(result.skipped, [{ plugin: "mystery", reason: "untracked" }]);
  const manifest = JSON.parse(
    await readFile(path.join(ctx.root, "profile.json"), "utf8"),
  );
  assert.deepEqual(manifest.plugins.map((p) => p.id), ["better-paseo"]);
});

test("export with preferLocal overwrites unapplied remote plugin and settings changes", async () => {
  const ctx = await fixture();
  const plugin = {
    id: "better-paseo",
    source: "git:https://github.com/RoundRedDot/better-paseo",
    revision: "a".repeat(40),
    enabled: true,
  };
  const extra = {
    id: "skills",
    source: "npm:@gpambrozio/paseo-skills",
    revision: "0.4.0",
    enabled: true,
  };
  const doc = {
    plugin: "better-paseo",
    document: "presentation",
    file: "settings/better-paseo/presentation.json",
  };
  await writeJson(path.join(ctx.root, "profile.json"), {
    schemaVersion: 1,
    plugins: [plugin, extra],
    settings: [doc],
    patches: [],
  });
  await writeJson(path.join(ctx.root, doc.file), {
    version: 1,
    values: { previewWrap: false, chatEnabled: false },
  });
  await writeJson(path.join(ctx.state, "baseline.json"), {
    schemaVersion: 1,
    plugins: { "better-paseo": plugin },
    settings: {
      [doc.file]: Buffer.from(
        JSON.stringify({ version: 1, values: { previewWrap: true } }),
      ).toString("base64"),
    },
  });
  const git = (...args) =>
    execFileSync("git", ["-C", ctx.root, ...args], { stdio: "pipe" });
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  git("add", ".");
  git("commit", "-qm", "remote state");

  await assert.rejects(exportProfile(ctx), /unapplied/i);
  const res = await exportProfile({ ...ctx, preferLocal: true });
  assert.equal(res.exported, true);
  const manifest = JSON.parse(
    await readFile(path.join(ctx.root, "profile.json"), "utf8"),
  );
  assert.deepEqual(manifest.plugins.map((p) => p.id), ["better-paseo"]);
});
```

Add to `tests/repository.test.mjs`:

```js
test("publishPlan surfaces unapplied remote changes as conflicts by default and clears them with preferLocal", async () => {
  const f = await fixture();
  let p = await repository.publishPlan(f);
  await repository.publish(f, p.approval, { push: false });

  // Simulate baseline recording an older state while remote profile.json has an extra plugin
  const manifest = JSON.parse(
    await readFile(path.join(f.root, "profile.json"), "utf8"),
  );
  await writeJson(path.join(f.state, "baseline.json"), {
    schemaVersion: 1,
    profileHash: "old",
    plugins: { demo: manifest.plugins[0] },
    settings: {},
    patches: {},
  });
  manifest.plugins.push({
    id: "extra",
    source: "npm:extra",
    revision: "1.0.0",
    enabled: true,
  });
  await writeJson(path.join(f.root, "profile.json"), manifest);
  f.git("add", ".");
  f.git("commit", "-qm", "remote extra plugin");

  const blocked = await repository.publishPlan(f);
  assert.equal(blocked.preferLocal, false);
  assert.ok(blocked.conflicts.some((c) => /unapplied/i.test(c)));
  await assert.rejects(
    repository.publish(f, blocked.approval, { push: false }),
    /unapplied/i,
  );

  const forced = await repository.publishPlan({ ...f, preferLocal: true });
  assert.equal(forced.preferLocal, true);
  assert.deepEqual(forced.conflicts, []);
  await assert.rejects(
    repository.publish(f, forced.approval, { push: false }),
    /stale/i,
  );
  const committed = await repository.publish(
    { ...f, preferLocal: true },
    forced.approval,
    { push: false },
  );
  assert.equal(committed.committed, true);
  const updated = JSON.parse(
    await readFile(path.join(f.root, "profile.json"), "utf8"),
  );
  assert.deepEqual(updated.plugins.map((x) => x.id), ["demo"]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/export.test.mjs tests/repository.test.mjs`
Expected: FAIL (`exportProfile` rejects untracked plugin instead of skipping, rejects `chatEnabled`, and does not support `preferLocal`).

- [ ] **Step 3: Implement `isPortablePlugin`, `chatEnabled`, and `preferLocal` in `server/core/profile.mjs`, `server/core/export.mjs`, and `server/core/repository.mjs`**

1. In `server/core/profile.mjs`:
   - Add `"chatEnabled"` to `flags`.
   - Export `isPortablePlugin(row)` which returns `true` if `snapshotPlugin(row)` succeeds and `false` if it throws.
2. In `server/core/export.mjs`:
   - Import `isPortablePlugin` from `./profile.mjs`.
   - In `exportProfile(ctx)`, check `if (!isPortablePlugin(row)) { skipped.push({ plugin: row.id, reason: "untracked" }); continue; }` before the Git `sourceState` check.
   - Gate both unapplied-changes loops (`Repository has unapplied changes for ${id}...` and `Repository has unapplied settings changes: ${name}`) with `if (loaded && previous && !ctx.preferLocal)`.
3. In `server/core/repository.mjs`:
   - In `exportSnapshot(ctx)`:
     - Run `exportProfile({ ...ctx, root: temp, preferLocal: !!ctx.preferLocal })`; if `!ctx.preferLocal` and it throws an error matching `/Repository has unapplied/i`, capture `conflicts = [err.message]` and re-run `exportProfile({ ...ctx, root: temp, preferLocal: true })` on `temp` so the preview still computes `files`, `skipped`, and `_baseline`. Otherwise `conflicts = []`.
     - Return `conflicts`, `preferLocal: !!ctx.preferLocal`, and bind `preferLocal: !!ctx.preferLocal` and `conflicts` into `approval: objectHash({ head, origin, pushUrl, upstream, files, skipped: exported.skipped, conflicts, preferLocal: !!ctx.preferLocal })`.
   - In `publish(ctx, approval, { push = true } = {})`:
     - After `if (p.approval !== approval) throw new Error("Publish preview is stale");`, check `if (p.conflicts.length) throw new Error(p.conflicts.join("\n"));`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/export.test.mjs tests/repository.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/core/profile.mjs server/core/export.mjs server/core/repository.mjs tests/export.test.mjs tests/repository.test.mjs
git commit -m "feat(export): support preferLocal overwrite and skip untracked plugins"
```

---

### Task 2: Sync Overwrite (`preferProfile`) & Registry Version Skip Disclosure

**Files:**
- Modify: `server/core/sync.mjs:136-146`, `server/core/sync.mjs:374-415`
- Test: `tests/sync.test.mjs`

**Interfaces:**
- Produces:
  - Updated `buildPlan(ctx)` and `applyPlan(ctx, approval)` in `server/core/sync.mjs`:
    - In `capture(ctx, profile)`: tolerates non-portable/untracked plugins by catching `snapshotPlugin(row)` errors and setting `descriptor: null`.
    - In `planData(ctx)`: when `ctx.preferProfile === true` and `now && now.source === target.source && (now.pluginPath ?? ".") === (target.pluginPath ?? ".") && now.revision !== target.revision && now.registry && target.id !== "paseo-sync" && target.id !== ctx.selfId && !ctx.selfIds?.includes(target.id)`, pushes `{ plugin: target.id, reason: "registry-version-transition", head: now.revision, revision: target.revision }` to `skipped` and continues to the next plugin instead of pushing to `conflicts`.

- [ ] **Step 1: Write the failing test in `tests/sync.test.mjs`**

Add to `tests/sync.test.mjs`:

```js
test("preferProfile skips unsupported registry version transitions as disclosed skips while applying other plugins", async (t) => {
  const f = await fixture(t, { installed: true });
  // Initial sync to establish baseline
  let p = await buildPlan(f.ctx);
  await applyPlan(f.ctx, p.approval);

  // Add a registry-installed plugin locally at 1.1.1 while profile wants 1.0.1,
  // and modify better-paseo settings locally so both localConflict and registry transition exist.
  const list = f.adapter.list;
  f.adapter.list = async () => {
    const rows = await list();
    rows.push({
      id: "paseo-cafe",
      path: path.join(f.home, "plugins/paseo-cafe/1.1.1"),
      enabled: true,
      status: "running",
      installation: {
        identity: {
          kind: "npm",
          packageName: "paseo-cafe",
          pluginPath: ".",
          registry: { url: "https://plugins.paseo.sh", id: "paseo-cafe/cafe" },
        },
        currentRevision: "1.1.1",
      },
    });
    return rows;
  };
  f.manifest.plugins.push({
    id: "paseo-cafe",
    source: "npm:paseo-cafe",
    revision: "1.0.1",
    enabled: true,
    registry: { url: "https://plugins.paseo.sh", id: "paseo-cafe/cafe" },
  });
  await writeJson(path.join(f.root, "profile.json"), f.manifest);
  await writeJson(f.setting, { version: 1, values: { previewWrap: false } });
  await writeJson(path.join(f.root, f.manifest.settings[0].file), {
    version: 1,
    values: { previewWrap: true, previewStripes: true },
  });

  const normal = await buildPlan(f.ctx);
  assert.ok(normal.conflicts.some((x) => /Local changes conflict/i.test(x)));
  assert.ok(normal.conflicts.some((x) => /Exact registry version transition/i.test(x)));

  const preferred = await buildPlan({ ...f.ctx, preferProfile: true });
  assert.equal(preferred.preferProfile, true);
  assert.deepEqual(preferred.conflicts, []);
  assert.deepEqual(preferred.skipped, [
    {
      plugin: "paseo-cafe",
      reason: "registry-version-transition",
      head: "1.1.1",
      revision: "1.0.1",
    },
  ]);
  const res = await applyPlan(
    { ...f.ctx, preferProfile: true },
    preferred.approval,
  );
  assert.equal(res.changed, true);
  assert.equal(res.verification.configurationMatches, true);
  assert.deepEqual(JSON.parse(await readFile(f.setting, "utf8")).values, {
    previewWrap: true,
    previewStripes: true,
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/sync.test.mjs`
Expected: FAIL (`preferred.conflicts` still contains `Exact registry version transition is not supported: paseo-cafe`).

- [ ] **Step 3: Implement registry skip under `preferProfile` and safe `snapshotPlugin` in `server/core/sync.mjs`**

1. In `capture(ctx, profile)` (`server/core/sync.mjs:136-146`), wrap `snapshotPlugin(row)` in `try { descriptor = snapshotPlugin(row); } catch {}`.
2. In `planData(ctx)` (`server/core/sync.mjs:388-395`), before calling `transitionConflict`:
   ```js
   const selfId = ctx.selfIds?.includes(target.id) ? target.id : ctx.selfId;
   const blocked = transitionConflict(now, target, selfId);
   if (
     blocked &&
     ctx.preferProfile &&
     now &&
     now.revision !== target.revision &&
     now.registry &&
     now.source === target.source &&
     (now.pluginPath ?? ".") === (target.pluginPath ?? ".") &&
     target.id !== selfId &&
     target.id !== "paseo-sync"
   ) {
     skipped.push({
       plugin: target.id,
       reason: "registry-version-transition",
       head: now.revision,
       revision: target.revision,
     });
     continue;
   }
   ```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/sync.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/core/sync.mjs tests/sync.test.mjs
git commit -m "feat(sync): skip unsupported registry version transitions under preferProfile"
```

---

### Task 3: RPC Schema, Service Wiring & First-Time Setup Flow

**Files:**
- Modify: `shared/rpc.ts:3-30`
- Modify: `server/service.mjs:135-302`
- Modify: `shared/setupFlow.mjs:99-112`
- Test: `tests/service.test.mjs`, `tests/setup-flow.test.mjs`

**Interfaces:**
- Consumes: `publishPlan`, `publish`, `buildPlan`, `applyPlan` from Tasks 1–2.
- Produces:
  - `startRpc.input` in `shared/rpc.ts` accepting optional `preferProfile: z.boolean().optional()` and `preferLocal: z.boolean().optional()`.
  - `service.start(input)` in `server/service.mjs` forwarding `preferProfile` and `preferLocal` into `ctx` and binding them into `seal`.
  - `progressFromJob(progress, kind, checkout)` in `shared/setupFlow.mjs` marking `applied: true` and `cafe: true` when `kind === "publish"` as well as `kind === "apply"`.

- [ ] **Step 1: Write failing tests in `tests/setup-flow.test.mjs` and `tests/service.test.mjs`**

Add to `tests/setup-flow.test.mjs`:

```js
  assert.deepEqual(progressFromJob(base, "publish", "/profile"), {
    ...base,
    applied: true,
    cafe: true,
    prepared: true,
  });
```

Add to `tests/service.test.mjs`:

```js
test("service threads preferProfile and preferLocal through preview and execution and binds approvals", async () => {
  const f = await fixture();
  const s = service.createService(f);

  const p1 = await done(s, await s.start({ kind: "plan", preferProfile: true }));
  assert.equal(p1.status, "succeeded", p1.error);
  assert.equal(p1.result.preferProfile, true);
  // Mismatched preferProfile flag must reject as stale
  const mismatchApply = await done(
    s,
    await s.start({ kind: "apply", approval: p1.result.approval }),
  );
  assert.equal(mismatchApply.status, "failed");
  assert.match(mismatchApply.error, /stale/i);
  const okApply = await done(
    s,
    await s.start({
      kind: "apply",
      approval: p1.result.approval,
      preferProfile: true,
    }),
  );
  assert.equal(okApply.status, "succeeded", okApply.error);

  const pub1 = await done(
    s,
    await s.start({ kind: "publishPlan", preferLocal: true }),
  );
  assert.equal(pub1.status, "succeeded", pub1.error);
  assert.equal(pub1.result.preferLocal, true);
  const mismatchPub = await done(
    s,
    await s.start({ kind: "publish", approval: pub1.result.approval }),
  );
  assert.equal(mismatchPub.status, "failed");
  assert.match(mismatchPub.error, /stale/i);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/setup-flow.test.mjs tests/service.test.mjs`
Expected: FAIL (`progressFromJob` does not set `applied: true` for `"publish"`, and `service.mjs` ignores `preferProfile` / `preferLocal`).

- [ ] **Step 3: Implement RPC schema, service wiring, and `progressFromJob` update**

1. In `shared/rpc.ts`:
   Add `preferProfile: z.boolean().optional()` and `preferLocal: z.boolean().optional()` to `startRpc.input`.
2. In `server/service.mjs`:
   - Update `seal`:
     ```js
     const seal = (ctx, kind, inner, backupId = "") =>
       objectHash({
         root: ctx.root,
         home: ctx.home,
         kind,
         inner,
         backupId,
         preferProfile: !!ctx.preferProfile,
         preferLocal: !!ctx.preferLocal,
       });
     ```
   - In `execute(c, input, phase)`:
     Attach `preferProfile: Boolean(input.preferProfile)` and `preferLocal: Boolean(input.preferLocal)` to `ctx`:
     ```js
     const ctx = {
       ...(await context(c)),
       preferProfile: Boolean(input.preferProfile),
       preferLocal: Boolean(input.preferLocal),
     };
     ```
3. In `shared/setupFlow.mjs`:
   Update `if (kind === "apply")` to `if (kind === "apply" || kind === "publish")`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/setup-flow.test.mjs tests/service.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add shared/rpc.ts server/service.mjs shared/setupFlow.mjs tests/setup-flow.test.mjs tests/service.test.mjs
git commit -m "feat(service): wire preferProfile and preferLocal through RPC and setup flow"
```

---

### Task 4: Client UI & Bilingual Conflict / Overwrite Controls

**Files:**
- Modify: `client/i18n.mjs`
- Modify: `client/sync.tsx`
- Test: `tests/open-shortcut.test.mjs`

**Interfaces:**
- Consumes: `preferProfile` and `preferLocal` fields on `Preview` and `startRpc` from Task 3.
- Produces:
  - `formatConflict(conflict: string, t: (key: string, values?: Record<string, unknown>) => string): string` exported from `client/i18n.mjs` and re-exported from `client/sync.tsx`.
  - Bilingual translations in `client/i18n.mjs` and action buttons in `client/sync.tsx` for switching to `publishPlan` (`preferLocal: true`) or `plan` (`preferProfile: true`) when conflicts occur.

- [ ] **Step 1: Write failing tests in `tests/open-shortcut.test.mjs`**

Add a test in `tests/open-shortcut.test.mjs` verifying `formatConflict` and all new bilingual UI keys in `client/i18n.mjs`:

```js
test("formatConflict and overwrite mode translations render bilingually", async () => {
  const { translator, formatConflict } = await import("../client/i18n.mjs");
  const en = translator("en");
  const zh = translator("zh");

  assert.equal(
    formatConflict(
      "Local changes conflict with profile: better-paseo. Export local changes or review --prefer-profile.",
      zh,
    ),
    "本机配置与云端存在冲突：better-paseo。可选择「用本机配置覆盖云端」或「忽略本机改动，用云端覆盖本机」。",
  );
  assert.equal(
    formatConflict(
      "Local changes conflict with profile: better-paseo. Export local changes or review --prefer-profile.",
      en,
    ),
    "Local changes conflict with the cloud profile: better-paseo. Choose “Overwrite cloud with this host” or “Ignore local changes and apply cloud profile”.",
  );
  assert.equal(
    formatConflict(
      "Exact registry version transition is not supported: paseo-cafe. Review registry provenance separately; no reinstall will be attempted.",
      zh,
    ),
    "注册表安装的插件不支持直接切换历史版本：paseo-cafe。可选择「用本机配置覆盖云端」，或选择「用云端覆盖本机」以跳过该插件版本切换。",
  );
  assert.equal(
    formatConflict(
      "Repository has unapplied changes for extra; apply or reconcile before exporting.",
      zh,
    ),
    "云端配置仓库存在尚未应用到本机的插件变更：extra。可先同步到本机，或选择「强制用本机配置覆盖云端」。",
  );
  assert.equal(
    formatConflict(
      "Repository has unapplied settings changes: settings/better-paseo/presentation.json",
      zh,
    ),
    "云端配置仓库存在尚未应用到本机的设置变更：settings/better-paseo/presentation.json。可先同步到本机，或选择「强制用本机配置覆盖云端」。",
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/open-shortcut.test.mjs`
Expected: FAIL (`formatConflict` is not exported from `client/i18n.mjs`).

- [ ] **Step 3: Implement `formatConflict`, bilingual translations, and UI action buttons in `client/i18n.mjs` and `client/sync.tsx`**

1. In `client/i18n.mjs`:
   - Add English translations to `english` for all new Chinese keys:
     - `"跳过 {plugin}：本地开发或未受管插件，本次不发布它的变更。"` -> `"Skipped {plugin}: local development or untracked plugin; its changes are not published this time."`
     - `"跳过 {plugin}：注册表安装插件不支持直接切换固定版本（本机 {head}，云端 {revision}），本次保留本机版本。"` -> `"Skipped {plugin}: registry-installed plugins do not support in-place version pinning (host {head}, cloud {revision}); keeping host version."`
     - `"本机配置与云端存在冲突：{label}。可选择「用本机配置覆盖云端」或「忽略本机改动，用云端覆盖本机」。"` -> `"Local changes conflict with the cloud profile: {label}. Choose “Overwrite cloud with this host” or “Ignore local changes and apply cloud profile”."`
     - `"注册表安装的插件不支持直接切换历史版本：{plugin}。可选择「用本机配置覆盖云端」，或选择「用云端覆盖本机」以跳过该插件版本切换。"` -> `"Exact registry version transition is not supported: {plugin}. Choose “Overwrite cloud with this host”, or choose “Apply cloud profile” to skip this plugin's version transition."`
     - `"云端配置仓库存在尚未应用到本机的插件变更：{plugin}。可先同步到本机，或选择「强制用本机配置覆盖云端」。"` -> `"The configuration repository has unapplied changes for {plugin}. Sync to this host first, or choose “Force overwrite cloud with this host”."`
     - `"云端配置仓库存在尚未应用到本机的设置变更：{file}。可先同步到本机，或选择「强制用本机配置覆盖云端」。"` -> `"The configuration repository has unapplied settings changes: {file}. Sync to this host first, or choose “Force overwrite cloud with this host”."`
     - `"用本机配置覆盖云端（预览发布）"` -> `"Overwrite cloud with this host (preview publish)"`
     - `"忽略本机改动，用云端覆盖本机（重新预览）"` -> `"Ignore local changes, overwrite this host with cloud (re-preview)"`
     - `"忽略云端未应用改动，强制用本机配置覆盖云端（重新预览）"` -> `"Ignore unapplied cloud changes, force overwrite cloud with this host (re-preview)"`
     - `"已启用「用云端覆盖本机」模式：将忽略本机自上次同步以来的本地修改，按云端配置应用。"` -> `"“Overwrite host with cloud” mode enabled: local edits since the last sync will be overwritten by the cloud profile."`
     - `"已启用「用本机覆盖云端」模式：将忽略云端未应用的远端修改，直接导出本机当前配置。"` -> `"“Overwrite cloud with host” mode enabled: unapplied cloud changes will be overwritten by this host's current configuration."`
     - `"预览并应用或发布同步配置"` -> `"Preview and apply or publish the configuration"`
   - Export `formatConflict(conflict, t)` matching the server conflict patterns and falling back to `String(conflict ?? "")`.
2. In `client/sync.tsx`:
   - Import and re-export `formatConflict` from `./i18n.mjs`.
   - Add `preferProfile?: boolean; preferLocal?: boolean;` to `Preview` and `ResultSummary` props.
   - Update `SETUP_LABEL.apply` to `"预览并应用或发布同步配置"`.
   - In `ResultSummary`:
     - Render mode notice when `r.preferProfile` or `r.preferLocal` is true.
     - Render each `r.conflicts` item via `formatConflict(c, t)`.
     - Handle `s.reason === "untracked"` and `s.reason === "registry-version-transition"` in `r.skipped`.
   - In `SyncScreen` preview action bar:
     - Pass `...(preview.preferProfile ? { preferProfile: true } : {})` and `...(preview.preferLocal ? { preferLocal: true } : {})` when confirming `preview.confirmKind`.
     - When `preview.confirmKind === "apply"` and `preview.conflicts?.length`:
       - Render a button for `run({ kind: "publishPlan", preferLocal: true })` labeled `t("用本机配置覆盖云端（预览发布）")`.
       - When `!preview.preferProfile` and `preview.conflicts.some((c) => c.startsWith("Local changes conflict with profile:") || c.startsWith("Exact registry version transition is not supported:"))`, render a secondary button for `run({ kind: "plan", preferProfile: true })` labeled `t("忽略本机改动，用云端覆盖本机（重新预览）")`.
     - When `preview.confirmKind === "publish"` and `preview.conflicts?.length` and `!preview.preferLocal`:
       - Render a button for `run({ kind: "publishPlan", preferLocal: true })` labeled `t("忽略云端未应用改动，强制用本机配置覆盖云端（重新预览）")`.

- [ ] **Step 4: Run unit tests and TypeScript typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS with 0 errors.

- [ ] **Step 5: Commit**

```bash
git add client/i18n.mjs client/sync.tsx tests/open-shortcut.test.mjs
git commit -m "feat(ui): add bilingual overwrite choices for local-vs-cloud conflicts"
```
