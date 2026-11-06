# 双向冲突解决：用本地覆盖云端 & 强制用云端覆盖本地 设计文档

## 1. 背景与意图 (Intent & Why)
当本机插件或设置与云端配置仓库（`profile.json`）发生分叉或冲突时，当前界面在「同步仓库配置到本机 → 预览差异」中只展示英文 CLI 报错（`Local changes conflict with profile... Export local changes or review --prefer-profile.` 及 `Exact registry version transition is not supported...`），底部没有任何操作按钮；同时首次设置第 5 步强制要求执行 `apply`，且 `exportProfile` 在存在未应用远端变更时也会拒绝导出。用户需要能够自主选择**「用本地覆盖云端」**或**「强制用云端覆盖本地（`preferProfile`）」**，而不是被卡死在冲突预览界面。

## 2. 目标、非目标与反目标 (Goals, Non-Goals, Anti-Goals)
- **目标 (Goals)**：
  1. **冲突预览直接提供双向选择按钮**：在 `client/sync.tsx` 预览结果区，当存在本地与云端冲突时，直接提供 **「用本机配置覆盖云端（预览发布）」** 与 **「忽略本机改动，用云端覆盖本机（重新预览）」** 两个按钮。
  2. **打通「强制用云端覆盖本机（`preferProfile`）」全链路**：在 `shared/rpc.ts`、`server/service.mjs`、`server/core/sync.mjs` 中支持 `preferProfile: true`；当开启 `preferProfile: true` 时，忽略 `Local changes conflict with profile`，并将 Paseo CLI 不支持原位切换版本的注册表插件（`now.revision !== target.revision && now.registry`）转为显式披露的 `skipped`（`reason: "registry-version-transition"`），使其他插件、启用状态和设置仍能顺利应用。
  3. **打通「用本机配置覆盖云端（`preferLocal`）」全链路**：在 `shared/rpc.ts`、`server/service.mjs`、`server/core/repository.mjs`、`server/core/export.mjs` 中支持 `preferLocal: true`（并在 UI 触发发布覆盖时启用），跳过 `Repository has unapplied changes` 拦截；同时合入未受管目录插件（`isPortablePlugin`）跳过逻辑与 `chatEnabled` 设置白名单字段，确保真机可直接预览并发布。
  4. **首次设置第 5 步支持双向完成**：在 `shared/setupFlow.mjs` 中，`apply` 与 `publish` 成功均可完成第 5 步（「预览并应用或发布同步配置」）。
  5. **冲突与模式提示中英双语化**：在 `client/i18n.mjs` 与 `client/sync.tsx` 中将英文冲突提示格式化为清晰的中英文说明，并在 `preferProfile` / `preferLocal` 预览中展示当前覆盖模式提示。
- **非目标 (Non-Goals)**：不引入无预览的静默覆盖，所有写入仍须经过预览与 `approval` 摘要确认。
- **反目标 (Anti-Goals)**：绝不通过 `paseo plugin remove` 卸载重装注册表插件（会清空宿主内插件设置目录）。

## 3. 约束 (Constraints)
- 保持零第三方运行时依赖，遵循 `client/`、`server/`、`shared/` 目录边界。
- 默认（未传 `preferProfile` / `preferLocal` 时）底层函数行为与现有单元测试契约保持兼容。

## 4. 方案对比与选择 (Approaches)
- **方案 A（已选）：显式覆盖参数（`preferLocal` / `preferProfile`）+ 冲突预览内联快捷入口**
  - 默认预览保留冲突检测以提醒用户存在双边差异；当出现冲突时，界面底部直接提供两个方向的重新预览按钮，并将参数绑定进 `approval` 摘要。在 `preferProfile: true` 下将注册表版本差异降级为 `skipped` 披露项。
  - **取舍**：既保留了首次预览的安全提醒和现有测试兼容性，又让用户只需点一次按钮即可切换到任意方向的覆盖预览并确认执行。
- **方案 B（否决）：无条件移除所有默认冲突检查**
  - **否决原因**：会导致用户在不知情时直接覆盖另一端的修改，且破坏现有安全回归测试。

## 5. 用户已确认决策与实现留白
- **用户已确认**：同时支持「用本地覆盖云端」与「强制用云端覆盖本地（`preferProfile`）」。
- **实现细节（交由实现阶段完成）**：RPC schema 扩展、`service.mjs` 摘要绑定、`client/i18n.mjs` 双语格式化函数及单元测试补充。
