# Paseo Sync

Paseo 原生插件，通过你自己的 Git 仓库同步插件固定版本、启用状态和允许的设置。每台 daemon 独立应用同一份配置；连接同一 daemon 的桌面、网页或手机客户端共享操作入口。

首版为手动同步：检查差异 → 确认 → 备份 → 应用 → 验证。个人配置仓库与此公开代码仓库分开维护。

## 安装

需要 Paseo 0.11.4、Git；安装 npm 来源插件还需要主机已有的 npm。Paseo 0.12 及以上尚未认证，清单暂不放开。命令行兜底工具需要 Node >=22.18。

在每台 daemon 主机执行：

```sh
paseo plugin install git:https://github.com/HybridRbt/paseo-sync --ref v0.1.0
```

也可以克隆本仓库，然后用 `paseo plugin install <代码仓库绝对路径>` 本地开发安装。无运行时 npm 依赖或构建脚本。

打开侧栏的 **Paseo Sync**，或插件的设置页：

1. 配置个人配置仓库的本机绝对路径。尚未克隆时同时填写 HTTPS 或 SSH 仓库 URL，凭据由主机的 Git credential helper / SSH agent 管理。
2. 保存设置，点击“初始化或拉取仓库”。仅允许干净工作区和快进更新；冲突保留现场。已有配置仓库可直接使用，不需要从本公开仓库复制个人文件。
3. 检查主机环境。如果 CLI 不在 GUI daemon 的 PATH，填写 CLI 绝对路径。自定义 daemon home 也需填写；插件会验证进程所属关系，拒绝操作其他 daemon。
4. 先预览并确认 Cafe 自动更新排除项，再预览并确认同步配置。
5. 修改本机配置后，用“发布本机配置”检查文件差异，确认后提交并推送。Git 作者身份及认证需提前在主机配置。

新仓库没有 `profile.json` 时，可以先预览发布本机配置来生成第一份清单。仓库需要已有初始提交；本地目录安装和无法追溯来源的第三方插件不能导出。同控制器的目录安装会被排除。

## 支持范围

| 内容 | 首版行为 |
| --- | --- |
| npm、HTTPS Git 固定版本 | 首次安装，以及同来源的明确版本更新；执行后核验实际版本。 |
| registry 安装的既有插件 | 相同版本可同步状态和设置；版本变化会阻止，避免绕过审核版本约束。 |
| 来源切换 | 明确阻止，需要单独迁移，不自动卸载重装。 |
| 禁用插件 | 可更新已存在且禁用的插件；缺失但目标禁用的插件不会被短暂启用安装。 |
| Better Paseo | 仅 `presentation` 中审核过的字段。未知字段拒绝，不能扫整个设置目录。 |
| 源码补丁 | 只执行清单明确列出的替换，校验原始和结果 SHA256；未知文件拒绝。 |
| Cafe | 为受管插件及控制器合并自动更新排除项，保留原字段、原排除项，单独备份和恢复。 |
| 同步插件自身 | 排除导出与应用，需在同步任务结束后通过 Paseo 管理入口单独更新。 |
| 额外本机插件 | 不自动删除。 |

凭据、配对、身份、会话、plugin-data 和客户端本地字体/快捷键等偏好不会导出。插件在 daemon 主机以当前用户权限读写配置、执行 Git 和 Paseo CLI；配置只发送到你指定的 Git 远端，不使用额外同步服务。

## 失败与恢复

任务在服务端执行，切换界面后可继续查看。失败会保留任务状态与备份 ID；在“恢复”中列出备份，输入 ID 预览，确认后恢复。Cafe 备份使用 `cafe:` 前缀。

新安装插件在恢复时停用并保留，避免删除数据。已有插件使用明确的 update 恢复版本，无法表达的 registry 转换会拒绝。恢复前检查当前状态与操作结束快照；有后续本地修改时拒绝覆盖。

进程异常退出会将任务标为 `interrupted`。先检查 daemon 实际状态、备份和锁，再解除锁；不能把中断视为成功。没有结束快照的备份不能自动恢复。首版保留所有备份，不自动清理，也不自动重新执行修改命令。

本机状态保存在 macOS/Linux 的 `~/.local/state/paseo-sync/` 或 Windows 的 `%LOCALAPPDATA%/PaseoSync/` 下，按 daemon home 和配置 checkout 分隔；操作锁按 daemon 共用。可以在启动 daemon 时用 `PASEO_SYNC_STATE` 指定状态根目录。

## 命令行与 agent 入口

```sh
node tools/paseo-profile.mjs inspect --repo /absolute/path/to/private-profile
node tools/paseo-profile.mjs plan --repo /absolute/path/to/private-profile
node tools/paseo-profile.mjs apply --repo /absolute/path/to/private-profile --approve <plan.approval>
node tools/paseo-profile.mjs verify --repo /absolute/path/to/private-profile
```

CLI 保留原有基线冲突、设置白名单、备份和摘要保护。原生入口还负责 Cafe 管理权预览、Git 发布和持久化任务。应用只同步当前仓库包含的项目，不对多个 daemon 批量执行。

## 开发与验证

```sh
npm ci --ignore-scripts
npm test
npm run typecheck
npm pack --dry-run --ignore-scripts
```

真实 daemon 测试为显式选择，创建独立临时 home，不使用个人配置：

```sh
PASEO_INTEGRATION=1 node tests/real-integration.mjs
```

Windows PowerShell 使用 `$env:PASEO_INTEGRATION='1'` 后运行测试。该集成脚本需要实际安装的 Paseo；普通 CI 单元测试不代表真实 Windows 客户端已通过。

设计、RPC 与验证边界见 [实施计划](docs/实施计划.md)、[接口设计](docs/接口设计.md)及[验证记录](docs/验证记录.md)。MIT License。
