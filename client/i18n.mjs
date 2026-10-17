const english = {
  "跳过 {plugin}：本机未安装，配置要求保持禁用。":
    "Skip {plugin}: not installed on this host and disabled in the profile.",
  "操作主机：{host}。任务在此主机执行；每台 daemon 分别同步。":
    "Host: {host}. Tasks run here; sync each daemon separately.",
  配置仓库本机绝对路径: "Configuration repository absolute path",
  "仓库 URL（首次克隆时使用，勿填 token）":
    "Repository URL (for initial clone; never include tokens)",
  "Paseo CLI 绝对路径（留空自动查找）":
    "Paseo CLI absolute path (blank to detect)",
  "Daemon home（留空使用主机默认）": "Daemon home (blank for host default)",
  连接配置仓库: "Configuration repository",
  保存主机设置: "Save host settings",
  保存: "Save",
  "请先保存设置，再执行同步操作。":
    "Save settings before running sync operations.",
  手动同步: "Manual sync",
  初始化或拉取仓库: "Initialize or pull repository",
  "仅允许快进；工作区有修改或历史分叉时停止。":
    "Fast-forward only; stops for local changes or diverged history.",
  拉取: "Pull",
  检查主机环境: "Check host environment",
  检查: "Check",
  "检查 Cafe 自动更新冲突": "Check Cafe auto-update conflicts",
  "预览后确认，将受管插件加入更新排除列表。":
    "Preview and confirm to exclude managed plugins from auto-updates.",
  预览: "Preview",
  同步仓库配置到本机: "Apply repository configuration to this host",
  预览差异: "Preview changes",
  发布本机配置: "Publish host configuration",
  "预览导出内容，确认后提交并推送到配置仓库。":
    "Preview the export, then confirm to commit and push to the configuration repository.",
  预览发布: "Preview publish",
  验证同步结果: "Verify sync result",
  验证: "Verify",
  恢复: "Recovery",
  列出当前配置仓库的备份: "List backups for this repository",
  查看: "View",
  "备份 ID（Cafe 使用 cafe: 前缀）":
    "Backup ID (Cafe backups use the cafe: prefix)",
  恢复备份: "Restore backup",
  预览恢复: "Preview restore",
  中断后解除任务锁: "Unlock an interrupted task",
  "只允许已确认原进程退出的任务；执行锁仍需人工检查备份后处理。":
    "Only after the owner process has exited. Execution locks require manual backup inspection.",
  检查并解锁: "Check and unlock",
  "任务：": "Task:",
  "备份：": "Backup:",
  收起技术详情: "Hide technical details",
  查看技术详情: "Show technical details",
  确认执行预览: "Confirm preview",
  "确认在 {host} 执行以上变更": "Confirm these changes on {host}",
  "只同步插件清单与允许的设置。凭据、会话和客户端本地偏好保留在本机。同步插件自身需单独更新。":
    "Syncs the plugin list and allowlisted settings. Credentials, sessions and client preferences stay local. Update Paseo Sync separately.",
  "发布到：": "Publish to:",
  "需处理：": "Needs attention:",
  "配置一致，无需修改。": "Configuration matches; no changes needed.",
  未安装: "Not installed",
  安装: "Install",
  切换版本: "Change version",
  启用: "Enable",
  停用: "Disable",
  重载: "Reload",
  应用补丁: "Apply patch",
  更新设置: "Update settings",
  "导出内容没有变化；确认发布可推送尚未推送的提交。":
    "No export changes. Confirm publishing to push any unpushed commits.",
  "修改前：": "Before:",
  文件不存在: "File does not exist",
  "修改后：": "After:",
  "将加入 Cafe 自动更新排除列表：": "Add to Cafe auto-update exclusions:",
  "Cafe 没有待处理的自动更新冲突。": "No pending Cafe auto-update conflicts.",
  "当前仓库尚无备份。": "No backups for this repository yet.",
  "配置：": "Configuration:",
  一致: "Matches",
  存在差异: "Differences found",
  "运行状态：": "Runtime:",
  正常: "Healthy",
  需检查: "Needs inspection",
  "仓库已就绪，可以检查同步差异。":
    "Repository ready. You can preview sync changes.",
  "变更已应用。": "Changes applied.",
  "无需修改。": "No changes needed.",
  "备份已恢复。": "Backup restored.",
  "配置已提交。": "Configuration committed.",
  "没有新的文件修改。": "No new file changes.",
  "已推送到配置仓库。": "Pushed to the configuration repository.",
  "备份 ID：": "Backup ID:",
  界面语言: "Interface language",
  "当前 Paseo 未提供语言接口，请在此选择；此选择仅用于当前客户端。":
    "This Paseo version does not expose its UI language. Select a language here; the choice is local to this client.",
  "正在查找配置仓库…": "Looking for configuration repositories…",
  重新查找: "Search again",
  更改: "Change",
  取消更改: "Cancel editing",
  已找到配置仓库: "Configuration repository found",
  请选择配置仓库: "Choose a configuration repository",
  "未找到配置仓库，请输入本机绝对路径。":
    "No configuration repository found. Enter an absolute path on this host.",
  "已保存路径不可用，请选择候选仓库或手动输入。":
    "The saved path is unavailable. Choose a candidate or enter a path manually.",
  "查找范围有限，其他目录可手动输入。":
    "Search is limited. Enter a path manually for other locations.",
  "远端地址含凭据、格式不支持或无法读取，请检查 Git 配置。":
    "Remote URLs contain credentials, are unsupported or cannot be read. Check Git configuration.",
  "仓库没有可用的 origin URL，请手动输入。":
    "No usable origin URL. Enter the repository URL manually.",
  "推送地址：": "Push URL:",
  使用此仓库: "Use this repository",
  "搜索失败，可手动填写。":
    "Search failed. You can enter the details manually.",
  首次设置: "First-time setup",
  "首次安装后按从上到下的顺序完成；完成后清单收起为一行。":
    "Complete these in order after installing; the list collapses to one line when finished.",
  "连接配置仓库并保存设置":
    "Connect the configuration repository and save settings",
  "预览并确认 Cafe 排除项": "Preview and confirm Cafe exclusions",
  "预览并应用同步配置": "Preview and apply the repository configuration",
  当前步骤: "Current step",
  等待前置: "Waiting for earlier steps",
  "首次设置已完成": "First-time setup complete",
  收起: "Collapse",
  "需要先完成的前置步骤": "A prerequisite step is missing",
  "这是前置条件提示，不是插件故障；完成对应引导步骤后重试。":
    "This is a prerequisite notice, not a malfunction. Complete the corresponding guided step and retry.",
  "请先完成第 1 步：保存主机设置。":
    "Complete step 1 first: save the host settings.",
  "请先完成第 2 步：初始化或拉取仓库。":
    "Complete step 2 first: initialize or pull the repository.",
  "配置仓库路径需为本机绝对路径。":
    "The repository path must be an absolute path on this host.",
  "请先输入备份 ID。": "Enter a backup ID first.",
  queued: "Queued",
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
  interrupted: "Interrupted",
  prepare: "Prepare",
  inspect: "Inspect",
  plan: "Preview sync",
  apply: "Apply sync",
  publishPlan: "Preview publish",
  publish: "Publish",
  cafePlan: "Preview Cafe exclusions",
  cafe: "Apply Cafe exclusions",
  backups: "List backups",
  restorePlan: "Preview restore",
  restore: "Restore",
  verify: "Verify",
  checking: "Checking",
  preview: "Preview",
  "git-fetch-and-fast-forward": "Fetching and fast-forwarding",
  "backup-and-execute": "Backing up and applying",
  complete: "Complete",
  starting: "Starting",
  validating: "Validating",
  executing: "Executing",
};
export function resolveLanguage(selection, hostLocale) {
  if (selection === "en" || selection === "zh") return selection;
  if (typeof hostLocale !== "string" || !hostLocale) return "zh";
  return /^zh(?:-|$)/i.test(hostLocale) ? "zh" : "en";
}
const chineseStatus = {
  queued: "等待中",
  running: "执行中",
  succeeded: "成功",
  failed: "失败",
  interrupted: "已中断",
  prepare: "初始化或拉取",
  inspect: "检查环境",
  plan: "同步预览",
  apply: "应用同步",
  publishPlan: "发布预览",
  publish: "发布",
  cafePlan: "Cafe 排除项预览",
  cafe: "应用 Cafe 排除项",
  backups: "列出备份",
  restorePlan: "恢复预览",
  restore: "恢复",
  verify: "验证",
  checking: "检查中",
  preview: "预览",
  "git-fetch-and-fast-forward": "拉取并快进",
  "backup-and-execute": "备份并执行",
  complete: "完成",
  starting: "正在开始",
  validating: "校验中",
  executing: "执行中",
};
export function translator(language) {
  return (key, values = {}) => {
    const text =
      language === "en" ? (english[key] ?? key) : (chineseStatus[key] ?? key);
    return text.replace(/\{([a-zA-Z]+)\}/g, (match, name) =>
      Object.hasOwn(values, name) ? String(values[name]) : match,
    );
  };
}
const key = "paseo-sync.ui-language";
let sessionLanguage = "zh";
let explicitlySelected = false;
function clientStorage() {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}
export function readLanguage(storage = clientStorage()) {
  if (explicitlySelected) return sessionLanguage;
  try {
    const value = storage?.getItem(key);
    if (value === "en" || value === "zh") sessionLanguage = value;
  } catch {
    /* Native or restricted clients use session memory. */
  }
  return sessionLanguage;
}
export function saveLanguage(language, storage = clientStorage()) {
  if (!["en", "zh"].includes(language)) return;
  sessionLanguage = language;
  explicitlySelected = true;
  try {
    storage?.setItem(key, language);
  } catch {
    /* The choice still lasts for this client session. */
  }
}
