# Paseo Sync

Inspect, publish, and apply your own Git configuration repository from inside Paseo, so several machines keep the same plugin versions, enabled states, and reviewed settings.

Each daemon installs and runs the sync on its own host, and clients connected to the same daemon share the interface. The configuration repository, Git credentials, and CLI paths are configured per host. Requires Paseo 0.11.4 to 0.15.x, Git, and npm on hosts that install npm-sourced plugins.

Every change shows a preview first, then runs with a backup and verification once you confirm. Supports reviewed Better Paseo presentation settings and explicitly recorded source patches. Cafe auto-update exclusions get their own preview and confirmation, so pinned versions are not overwritten by automatic updates.

The plugin reads local plugin configuration as the daemon user, runs Git and the Paseo CLI, and sends allowlisted settings only to the Git remote you choose. Credentials, identities, pairing, sessions, and other plugin data stay on the machine.

The first release syncs manually and does not update itself; version changes for registry-sourced plugins and plugin source switches are handled separately. The cross-platform interface uses React Native; see the project verification records for real-platform test results.

## 中文说明

在 Paseo 内检查、发布和应用自己的 Git 配置仓库，方便多台主机保持一致的插件版本、启用状态和已审核的设置。

每台 daemon 独立安装并执行同步。连接同一 daemon 的客户端共享界面。配置仓库、Git 认证与 CLI 路径在各主机设置；需要 Paseo 0.11.4–0.15.x、Git，以及安装 npm 来源插件时所需的 npm。

每次修改先显示预览，经确认后备份、执行、验证。支持 Better Paseo presentation 设置与显式记录的源码补丁。Cafe 自动更新排除项需要单独预览确认，避免固定版本被自动更新覆盖。

插件以 daemon 用户权限读取本机插件配置，执行 Git 与 Paseo CLI，并将允许的配置发送到用户指定的 Git 远端。凭据、身份、配对、会话和其他插件数据保留在本机。

首版手动同步，不自动更新自身；registry 来源的版本变更与插件来源切换需要单独处理。跨平台界面使用 React Native，真实平台验证情况请查看项目验证记录。
