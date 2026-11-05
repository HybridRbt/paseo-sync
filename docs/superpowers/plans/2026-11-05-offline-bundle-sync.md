# Offline Bundle Sync (Plan A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable automatic multi-device synchronization for directory-installed/untracked plugins (`installation.identity.kind === "directory"`) by packaging clean plugin archives (`bundles/<id>.tar.gz`) during export and auto-extracting/installing them during apply.

**Architecture:** 
- A pure Node.js tar/gzip archiving utility (`server/core/bundle.mjs`) deterministically packages directory plugins while strictly filtering out development overhead (`.git`, `node_modules`, `.DS_Store`, build caches).
- Plugin schema in `server/core/profile.mjs` is extended to support `source: "bundle:bundles/<id>.tar.gz"` with a 64-character SHA-256 revision.
- `server/core/export.mjs` packages directory plugins into the configuration repository's `bundles/` folder instead of skipping them.
- `server/core/sync.mjs` detects bundle-sourced plugins, unpacks them safely to local managed plugin storage, and invokes `paseo plugin install` to restore them on target machines.

**Tech Stack:** Node.js standard library (`node:zlib`, `node:fs/promises`, `node:crypto`, `node:path`), TypeScript, React, Paseo Plugin API.

**Spec:** Kanban Idea "支持未受管/目录安装插件的离线同步或配置保留" (Scope: here, Option A - Offline Bundle Sync).

## Global Constraints
- Pure Node.js standard library for archiving: no external native CLI dependencies (`tar` executable) or new npm dependencies.
- Strict path traversal security: unpacking must reject directory traversal attempts (`..`, absolute paths, symlinks resolving outside target).
- Volume limit: reject bundles exceeding 25MB to protect git sync repositories from bloat.
- Zero breakage to existing portable `git:` and `npm:` plugin sync.
- Backward compatibility: if a directory plugin cannot be packaged or user elects to skip, preserve existing `skipped (reason: "untracked")` behavior.

## Review Focus
1. Bundle contents exclude `.git` and `node_modules`: ensure node_modules from development are never packed into git.
2. Malicious archive extraction defense: archive containing `../` or `/etc/` paths must throw and abort cleanly.
3. Deterministic SHA-256: packing the same directory without content changes must yield the identical archive SHA-256 hash.
4. Idempotent apply: re-applying the same bundle version does not reinstall or flap plugin state.
5. Verification with full test suite: all existing tests (116+) remain green alongside new bundle tests.

---

### Task 1: Deterministic Tar/Gzip Packaging Engine (`server/core/bundle.mjs`)

**Files:**
- Create: `server/core/bundle.mjs`
- Test: `tests/bundle.test.mjs`

- [ ] **Step 1: Write failing test for packaging and extracting directory**
  Create `tests/bundle.test.mjs` with tests asserting:
  - Packaging directory filters out `.git/`, `node_modules/`, `.DS_Store`.
  - Computes valid SHA256 and writes `.tar.gz`.
  - Extraction reconstructs original file structure and content accurately.
  - Path traversal attempts (`../../evil.txt`) throw security error.
- [ ] **Step 2: Run test to confirm failure**
  Run `node --test tests/bundle.test.mjs` and verify module not found.
- [ ] **Step 3: Implement ustar tar & gzip pack/unpack in `server/core/bundle.mjs`**
  Implement:
  - `packPluginDirectory(sourceDir, options)`
  - `unpackBundle(archiveBufferOrPath, targetDir, options)`
  - `safeArchiveRelativePath(entryPath)`
- [ ] **Step 4: Run test to verify pass**
  Run `node --test tests/bundle.test.mjs` and confirm all tests pass.
- [ ] **Step 5: Commit changes**
  Commit with `feat(bundle): implement pure Node.js tarball pack and safe unpack`.

---

### Task 2: Profile Schema and Validation for Bundles (`server/core/profile.mjs`)

**Files:**
- Modify: `server/core/profile.mjs`
- Test: `tests/profile.test.mjs`

- [ ] **Step 1: Write failing test in `tests/profile.test.mjs`**
  Add tests for:
  - `validatePlugin` accepts valid `bundle:bundles/<id>.tar.gz` with 64-char hex SHA256.
  - `validatePlugin` rejects mismatched bundle ID, invalid paths, or invalid hashes.
  - `loadProfile` loads bundle file and includes bundle hashes in `profile.hash`.
- [ ] **Step 2: Run test to confirm failure**
  Run `node --test tests/profile.test.mjs`.
- [ ] **Step 3: Implement bundle source validation in `server/core/profile.mjs`**
  - Update `validatePlugin` to permit `bundle:bundles/${p.id}.tar.gz`.
  - Update `loadProfile` to verify presence and digest of bundle archives in repository.
- [ ] **Step 4: Run test to verify pass**
  Run `node --test tests/profile.test.mjs`.
- [ ] **Step 5: Commit changes**
  Commit with `feat(profile): support bundle source validation and integrity checks`.

---

### Task 3: Bundle Export in `server/core/export.mjs`

**Files:**
- Modify: `server/core/export.mjs`
- Test: `tests/export.test.mjs`

- [ ] **Step 1: Write failing test in `tests/export.test.mjs`**
  Add test verifying:
  - Directory plugin with `paseo-plugin.json` is exported into `bundles/<id>.tar.gz`.
  - Manifest plugin entry records `source: "bundle:bundles/<id>.tar.gz"` with archive SHA256.
  - Invalid/empty directory plugins without manifest continue to be skipped cleanly.
- [ ] **Step 2: Run test to confirm failure**
  Run `node --test tests/export.test.mjs`.
- [ ] **Step 3: Implement directory plugin packaging in `exportProfile`**
  - In `exportProfile`, pack directory plugins using `packPluginDirectory`.
  - Write archive to `bundles/<id>.tar.gz` in repository.
  - Add bundle descriptor to exported `plugins`.
- [ ] **Step 4: Run test to verify pass**
  Run `node --test tests/export.test.mjs`.
- [ ] **Step 5: Commit changes**
  Commit with `feat(export): package untracked directory plugins as offline bundles`.

---

### Task 4: Bundle Extraction and Installation in `server/core/sync.mjs`

**Files:**
- Modify: `server/core/sync.mjs`
- Modify: `server/core/paseo.mjs`
- Test: `tests/sync.test.mjs`

- [ ] **Step 1: Write failing test in `tests/sync.test.mjs`**
  Add test verifying:
  - `applyPlan` identifies missing bundle plugin and plans `"install"`.
  - `apply` unpacks bundle into managed directory and installs plugin via adapter.
  - Idempotent on second apply.
- [ ] **Step 2: Run test to confirm failure**
  Run `node --test tests/sync.test.mjs`.
- [ ] **Step 3: Implement bundle install handling in `sync.mjs`**
  - In `applyPlan`, handle `target.source.startsWith("bundle:")`.
  - In `apply`, unpack bundle archive to `path.join(ctx.home, "local-plugins", target.id)` and call `ctx.adapter.install`.
- [ ] **Step 4: Run test to verify pass**
  Run `node --test tests/sync.test.mjs`.
- [ ] **Step 5: Commit changes**
  Commit with `feat(sync): extract and install bundle plugins during apply`.

---

### Task 5: UI Presentation and Bilingual Translation (`client/`)

**Files:**
- Modify: `client/sync.tsx`
- Modify: `client/i18n.mjs`
- Test: `tests/open-shortcut.test.mjs`

- [ ] **Step 1: Write test for bundle UI strings in `tests/open-shortcut.test.mjs`**
  Assert translation keys for bundle source badges and descriptions.
- [ ] **Step 2: Update `client/i18n.mjs` and `client/sync.tsx`**
  - Add Chinese and English strings for bundle status.
  - Display "离线归档 / Offline Bundle" tag in preview change list.
- [ ] **Step 3: Run full verification suite**
  Run `npm test` across all tests.
- [ ] **Step 4: Commit changes**
  Commit with `feat(ui): display offline bundle badges and translations in sync preview`.
