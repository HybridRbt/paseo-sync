const english = {
  "跳过 {plugin}：本机未安装，配置要求保持禁用。":
    "Skip {plugin}: not installed on this host and disabled in the profile.",
  "跳过 {plugin}：本地开发或未受管插件，本次不发布它的变更。":
    "Skipped {plugin}: local development or untracked plugin; its changes are not published this time.",
  "跳过 {plugin}：本地开发或未受管插件，本次不应用到本机。":
    "Skipped {plugin}: local development or untracked plugin; it is not applied on this host.",
  "本机安装目录：{checkout}":
    "Installed at: {checkout}",
  "该插件本次保持本机现状，未被同步修改。请先核对其安装来源或移除该安装（如 paseo plugin uninstall {plugin}），再重新预览差异。":
    "The plugin stays as installed on this host. Inspect or remove the installation (e.g. `paseo plugin uninstall {plugin}`), then preview the changes again.",
  "跳过 {plugin}：备份或本机插件缺少可识别的安装来源，本次恢复不改动该插件。":
    "Skipped {plugin}: the install source is not identifiable from the backup or on this host; the restore leaves the plugin untouched.",
  "跳过 {plugin}：注册表安装插件不支持直接切换固定版本（本机 {head}，云端 {revision}），本次保留本机版本。":
    "Skipped {plugin}: registry-installed plugins do not support in-place version pinning (host {head}, cloud {revision}); keeping host version.",
  "本机配置与云端存在冲突：{label}。可选择「用本机配置覆盖云端」或「忽略本机改动，用云端覆盖本机」。":
    "Local changes conflict with the cloud profile: {label}. Choose “Overwrite cloud with this host” or “Ignore local changes and apply cloud profile”.",
  "注册表安装的插件不支持直接切换历史版本：{plugin}。可选择「用本机配置覆盖云端」，或选择「用云端覆盖本机」以跳过该插件版本切换。":
    "Exact registry version transition is not supported: {plugin}. Choose “Overwrite cloud with this host”, or choose “Apply cloud profile” to skip this plugin's version transition.",
  "云端配置仓库存在尚未应用到本机的插件变更：{plugin}。可先同步到本机，或选择「强制用本机配置覆盖云端」。":
    "The configuration repository has unapplied changes for {plugin}. Sync to this host first, or choose “Force overwrite cloud with this host”.",
  "云端配置仓库存在尚未应用到本机的设置变更：{file}。可先同步到本机，或选择「强制用本机配置覆盖云端」。":
    "The configuration repository has unapplied settings changes: {file}. Sync to this host first, or choose “Force overwrite cloud with this host”.",
  "用本机配置覆盖云端（预览发布）":
    "Overwrite cloud with this host (preview publish)",
  "忽略本机改动，用云端覆盖本机（重新预览）":
    "Ignore local changes, overwrite this host with cloud (re-preview)",
  "忽略云端未应用改动，强制用本机配置覆盖云端（重新预览）":
    "Ignore unapplied cloud changes, force overwrite cloud with this host (re-preview)",
  "已启用「用云端覆盖本机」模式：将忽略本机自上次同步以来的本地修改，按云端配置应用。":
    "“Overwrite host with cloud” mode enabled: local edits since the last sync will be overwritten by the cloud profile.",
  "已启用「用本机覆盖云端」模式：将忽略云端未应用的远端修改，直接导出本机当前配置。":
    "“Overwrite cloud with host” mode enabled: unapplied cloud changes will be overwritten by this host's current configuration.",
  "预览并应用或发布同步配置":
    "Preview and apply or publish the configuration",
  "跳过 {plugin}：本地源码有未提交改动，本次不发布它的变更。":
    "Skipped {plugin}: local source has uncommitted changes; its changes are not published this time.",
  "跳过 {plugin}：本机源码与安装版本不一致，本次不发布它的变更。":
    "Skipped {plugin}: local source HEAD differs from the installed revision; its changes are not published this time.",
  "跳过 {plugin}：本地源码有未提交改动，本次不应用到本机。":
    "Skipped {plugin}: local source has uncommitted changes; it is not applied to this host this time.",
  "跳过 {plugin}：本机源码与安装版本不一致，本次不应用到本机。":
    "Skipped {plugin}: local source HEAD differs from the installed revision; it is not applied to this host this time.",
  "本机源码目录：{checkout}": "Local source checkout: {checkout}",
  "该插件本次保持本机现状，未被同步修改。在插件源码仓库提交并推送后，运行 paseo plugin update {plugin}，再发布一次让新版本进入配置仓库，然后重新预览差异即可完成同步。":
    "The plugin keeps its local state untouched this run. Commit and push in the plugin's source repository, run paseo plugin update {plugin}, then publish so the new revision enters the profile; preview the differences again and they converge.",
  "跳过 {plugin}：本地源码有未提交改动，本次恢复不改动该插件。":
    "Skipped {plugin}: local source has uncommitted changes; the restore leaves this plugin untouched.",
  "跳过 {plugin}：本机源码与安装版本不一致，本次恢复不改动该插件。":
    "Skipped {plugin}: local source HEAD differs from the installed revision; the restore leaves this plugin untouched.",
  "该插件本次保持本机现状，未被恢复修改。完成本次恢复后，在插件源码仓库提交并推送，运行 paseo plugin update {plugin}，再重新预览恢复即可恢复备份中的版本。":
    "The plugin keeps its local state untouched this run. After completing this restore, commit and push in the plugin's source repository, run paseo plugin update {plugin}, then preview the restore again to bring the backed-up version back.",
  "备份生成后本机数据已发生变化，需先处理变更后方可恢复：":
    "Current managed data changed after the backup; resolve those changes before restoring:",
  "备份生成后本机数据已发生变化，需先处理变更后方可恢复。":
    "Current managed data changed after the backup; resolve those changes before restoring.",
  "插件 {plugin}：本地源码有未提交改动。":
    "Plugin {plugin}: local source has uncommitted changes.",
  "插件 {plugin}：本机源码与安装版本不一致。":
    "Plugin {plugin}: local source HEAD differs from the installed revision.",
  "插件 {plugin}：备份记录了本地源码改动，与当前状态不一致。":
    "Plugin {plugin}: the backup recorded local source changes differing from the current checkout.",
  "在插件源码仓库提交或撤销改动后，重新预览恢复。":
    "Commit or discard changes in the plugin source repository, then preview the restore again.",
  "运行 paseo plugin update {plugin} 或对齐提交后，重新预览恢复。":
    "Run paseo plugin update {plugin} or align HEAD, then preview the restore again.",
  "在插件源码仓库对齐备份改动，或重新执行操作建立新备份后，重新预览恢复。":
    "Align the plugin source with the recorded changes or create a fresh backup, then preview the restore again.",
  "插件状态在备份后发生变化：{plugins}":
    "Plugin configuration changed after the backup: {plugins}",
  "设置在备份后发生变化：{settings}":
    "Settings changed after the backup: {settings}",
  "补丁在备份后发生变化：{patches}":
    "Patches changed after the backup: {patches}",
  "全局插件开关在备份后发生变化：{from} -> {to}":
    "Global plugin switch changed after the backup: {from} -> {to}",
  在终端中打开: "Open in terminal",
  在文件管理器中打开: "Open in file manager",
  "在终端中打开 {plugin} 源码目录": "Open {plugin} source checkout in terminal",
  "在文件管理器中打开 {plugin} 源码目录":
    "Open {plugin} source checkout in file manager",
  已打开终端: "Terminal opened",
  已在文件管理器中打开: "Opened in file manager",
  复制路径: "Copy path",
  "复制 {plugin} 源码目录路径": "Copy {plugin} source checkout path",
  已复制路径: "Path copied",
  "复制失败：{error}，路径已显示在上方，可手动选中复制。":
    "Copy failed: {error}. The path is shown above; select and copy it manually.",
  "打开失败：{error}。可点击「复制路径」获取目录路径。":
    "Failed to open: {error}. Use “Copy path” to get the checkout path.",
  "当前平台不支持该快捷方式。可点击「复制路径」获取目录路径。":
    "Shortcut unsupported on this platform. Use “Copy path” to get the checkout path.",
  未知错误: "Unknown error",
  "改动文件：{files}": "Changed files: {files}",
  "配置仓库沿用该插件已发布的版本。":
    "The configuration repository keeps this plugin's previously published version.",
  "该插件尚未发布过，本次不出现在配置中。":
    "This plugin has never been published; it stays out of the profile this time.",
  "在插件源码仓库提交并推送后，运行 paseo plugin update {plugin}，再重新预览发布即可带上新版本。":
    "Commit and push in the plugin's source repository, run paseo plugin update {plugin}, then preview and publish again to include the new revision.",
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
  离线归档: "Offline bundle",
  新增离线归档包: "Add offline bundle archive",
  更新离线归档包: "Update offline bundle archive",
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
export function canConfirmPreview(preview) {
  if (!preview) return false;
  return (
    Boolean(preview.approval) &&
    Boolean(preview.confirmKind) &&
    !preview.conflicts?.length &&
    !preview.currentChangedSinceBackup
  );
}
export function renderDriftDisclosure(drift, t) {
  if (!drift) return [];
  if (typeof drift !== "object") {
    return [t("备份生成后本机数据已发生变化，需先处理变更后方可恢复。")];
  }
  const lines = [t("备份生成后本机数据已发生变化，需先处理变更后方可恢复：")];
  for (const s of drift.source ?? []) {
    let descKey;
    let guideKey;
    if (s.reason === "head-differs") {
      descKey = "插件 {plugin}：本机源码与安装版本不一致。";
      guideKey = "运行 paseo plugin update {plugin} 或对齐提交后，重新预览恢复。";
    } else if (s.reason === "recorded-source-dirty") {
      descKey = "插件 {plugin}：备份记录了本地源码改动，与当前状态不一致。";
      guideKey = "在插件源码仓库对齐备份改动，或重新执行操作建立新备份后，重新预览恢复。";
    } else {
      descKey = "插件 {plugin}：本地源码有未提交改动。";
      guideKey = "在插件源码仓库提交或撤销改动后，重新预览恢复。";
    }
    lines.push(
      t(descKey, { plugin: s.plugin }) +
        (s.files?.length
          ? " " + t("改动文件：{files}", { files: s.files.join(", ") })
          : ""),
    );
    if (s.checkout) {
      lines.push(t("本机源码目录：{checkout}", { checkout: s.checkout }));
    }
    lines.push(t(guideKey, { plugin: s.plugin }));
  }
  if (drift.plugins?.length) {
    lines.push(
      t("插件状态在备份后发生变化：{plugins}", {
        plugins: drift.plugins.map((p) => p.plugin).join(", "),
      }),
    );
  }
  if (drift.settings?.length) {
    lines.push(
      t("设置在备份后发生变化：{settings}", {
        settings: drift.settings.join(", "),
      }),
    );
  }
  if (drift.patches?.length) {
    lines.push(
      t("补丁在备份后发生变化：{patches}", {
        patches: drift.patches.join(", "),
      }),
    );
  }
  if (drift.pluginsEnabled) {
    lines.push(
      t("全局插件开关在备份后发生变化：{from} -> {to}", {
        from: String(drift.pluginsEnabled.from),
        to: String(drift.pluginsEnabled.to),
      }),
    );
  }
  return lines;
}

export function formatConflict(conflict, t) {
  if (typeof conflict !== "string") return String(conflict ?? "");
  const mLocal = conflict.match(
    /^Local changes conflict with profile: (.+?)\. Export local changes or review --prefer-profile\.$/,
  );
  if (mLocal) {
    return t(
      "本机配置与云端存在冲突：{label}。可选择「用本机配置覆盖云端」或「忽略本机改动，用云端覆盖本机」。",
      { label: mLocal[1] },
    );
  }
  const mRegistry = conflict.match(
    /^Exact registry version transition is not supported: (.+?)\. Review registry provenance separately; no reinstall will be attempted\.$/,
  );
  if (mRegistry) {
    return t(
      "注册表安装的插件不支持直接切换历史版本：{plugin}。可选择「用本机配置覆盖云端」，或选择「用云端覆盖本机」以跳过该插件版本切换。",
      { plugin: mRegistry[1] },
    );
  }
  const mUnappliedPlugin = conflict.match(
    /^Repository has unapplied changes for (.+?); apply or reconcile before exporting\.$/,
  );
  if (mUnappliedPlugin) {
    return t(
      "云端配置仓库存在尚未应用到本机的插件变更：{plugin}。可先同步到本机，或选择「强制用本机配置覆盖云端」。",
      { plugin: mUnappliedPlugin[1] },
    );
  }
  const mUnappliedSettings = conflict.match(
    /^Repository has unapplied settings changes: (.+)$/,
  );
  if (mUnappliedSettings) {
    return t(
      "云端配置仓库存在尚未应用到本机的设置变更：{file}。可先同步到本机，或选择「强制用本机配置覆盖云端」。",
      { file: mUnappliedSettings[1] },
    );
  }
  return conflict;
}

