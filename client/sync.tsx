import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc, useSettings } from "@getpaseo/plugin/client";
import {
  SettingsSection,
  SettingsCard,
  SettingsInput,
  SettingsAction,
} from "@getpaseo/plugin/client/ui";
import { useEffect, useState, useRef } from "react";
import { ScrollView, Text, View, Pressable } from "react-native";
import { syncSettings } from "../shared/settings";
import { startRpc, jobRpc, unlockRpc, discoverRpc } from "../shared/rpc";
import type { z } from "zod";
import { translator, readLanguage, saveLanguage } from "./i18n.mjs";
import { mergeDiscovery } from "../shared/onboarding.mjs";
type Discovery = z.infer<typeof discoverRpc.output>;
type Request = z.infer<typeof startRpc.input>;
type Job = {
  id: string;
  kind: string;
  status: string;
  phase?: string;
  error?: string;
  backupId?: string;
  result?: unknown;
};
type Preview = {
  approval?: string;
  confirmKind?: Request["kind"];
  backupId?: string;
  conflicts?: string[];
};
export function SyncScreen({ theme, host }: PluginSurfaceProps) {
  const settings = useSettings(syncSettings),
    discover = useRpc(discoverRpc),
    start = useRpc(startRpc),
    getJob = useRpc(jobRpc),
    unlock = useRpc(unlockRpc);
  const [draft, setDraft] = useState({
    checkout: "",
    repositoryUrl: "",
    cliPath: "",
    daemonHome: "",
  });
  const [language, setLanguage] = useState(readLanguage);
  const t = translator(language);
  const [discovery, setDiscovery] = useState<Discovery | null>(null);
  const [searching, setSearching] = useState(false),
    [searchError, setSearchError] = useState(false);
  const [editing, setEditing] = useState(false);
  const searchEpoch = useRef(0);
  async function findRepositories(requested = draft) {
    const epoch = ++searchEpoch.current;
    setSearching(true);
    setSearchError(false);
    try {
      const found = await discover({ checkout: requested.checkout });
      if (epoch !== searchEpoch.current) return;
      setDiscovery(found);
      setDraft((current) => mergeDiscovery(current, requested, found.selected));
    } catch {
      if (epoch === searchEpoch.current) setSearchError(true);
    } finally {
      if (epoch === searchEpoch.current) setSearching(false);
    }
  }
  const [details, setDetails] = useState(false);
  const [job, setJob] = useState<Job | null>(null),
    [pending, setPending] = useState(false),
    [error, setError] = useState(""),
    [backup, setBackup] = useState("");
  useEffect(() => {
    if (settings.status === "ready") setDraft(settings.values);
  }, [settings.status, settings.status === "ready" ? settings.revision : ""]);
  useEffect(() => {
    if (settings.status !== "ready") return;
    void findRepositories(settings.values);
    return () => {
      searchEpoch.current++;
    };
  }, [host.id, settings.status === "ready"]);
  useEffect(() => {
    let active = true;
    getJob({})
      .then((v) => {
        if (active && v) setJob(v as Job);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [host.id, getJob]);
  const running = job?.status === "queued" || job?.status === "running";
  useEffect(() => {
    if (!running || !job?.id) return;
    let active = true;
    const timer = setInterval(() => {
      getJob({ id: job.id })
        .then((v) => {
          if (active && v) setJob(v as Job);
        })
        .catch((e) => {
          if (active) setError(String(e));
        });
    }, 1000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [running, job?.id, getJob]);
  const dirty =
    settings.status === "ready" &&
    JSON.stringify(draft) !== JSON.stringify(settings.values);
  const busy = pending || running || settings.saving || searching;
  const selectedRepository = discovery?.candidates.find(
    (c) => c.checkout === draft.checkout,
  );
  const disabled = busy || dirty || settings.status !== "ready";
  async function run(input: Request) {
    setError("");
    setPending(true);
    try {
      const next = await start(input);
      setJob(next);
    } catch (e) {
      setError(String(e));
    } finally {
      setPending(false);
    }
  }
  useEffect(() => setDetails(false), [job?.id]);
  const result = job?.status === "succeeded" ? job.result : undefined;
  const preview = (
    result && typeof result === "object" ? result : {}
  ) as Preview;
  const canConfirm =
    !!preview.approval && !!preview.confirmKind && !preview.conflicts?.length;
  const text = { color: theme.colors.foreground };
  const muted = { color: theme.colors.foregroundMuted };
  const fields = [
    ["checkout", "配置仓库本机绝对路径"],
    ["repositoryUrl", "仓库 URL（首次克隆时使用，勿填 token）"],
    ["cliPath", "Paseo CLI 绝对路径（留空自动查找）"],
    ["daemonHome", "Daemon home（留空使用主机默认）"],
  ] as const;
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.colors.surface0 }}
      contentContainerStyle={{ padding: 20, gap: 16 }}
    >
      <Text style={[text, { fontSize: 22, fontWeight: "600" }]}>
        Paseo Sync
      </Text>
      <Text style={muted}>
        {t("操作主机：{host}。任务在此主机执行；每台 daemon 分别同步。", {
          host: host.label,
        })}
      </Text>
      <SettingsSection title={t("界面语言")}>
        <Text style={muted}>
          {t("当前 Paseo 未提供语言接口，请在此选择；此选择仅用于当前客户端。")}
        </Text>
        <View style={{ flexDirection: "row", gap: 16 }}>
          {(
            [
              ["zh", "中文"],
              ["en", "English"],
            ] as const
          ).map(([code, label]) => (
            <Pressable
              key={code}
              accessibilityRole="button"
              accessibilityState={{ selected: language === code }}
              onPress={() => {
                saveLanguage(code);
                setLanguage(code);
              }}
            >
              <Text
                style={[
                  text,
                  { fontWeight: language === code ? "700" : "400", padding: 8 },
                ]}
              >
                {language === code ? "✓ " : ""}
                {label}
              </Text>
            </Pressable>
          ))}
        </View>
      </SettingsSection>
      <SettingsSection title={t("连接配置仓库")}>
        <SettingsCard>
          {searching ? (
            <Text style={muted}>{t("正在查找配置仓库…")}</Text>
          ) : null}
          {searchError ? (
            <Text style={muted}>{t("搜索失败，可手动填写。")}</Text>
          ) : null}
          {discovery?.savedInvalid ? (
            <Text style={muted}>
              {t("已保存路径不可用，请选择候选仓库或手动输入。")}
            </Text>
          ) : null}
          {discovery?.limited ? (
            <Text style={muted}>{t("查找范围有限，其他目录可手动输入。")}</Text>
          ) : null}
          {selectedRepository && !editing ? (
            <View style={{ gap: 8, padding: 12 }}>
              <Text style={muted}>{t("已找到配置仓库")}</Text>
              <Text selectable style={text}>
                {selectedRepository.checkout}
              </Text>
              {selectedRepository.repositoryUrl ? (
                <Text selectable style={text}>
                  {selectedRepository.repositoryUrl}
                </Text>
              ) : (
                <Text style={muted}>
                  {t("仓库没有可用的 origin URL，请手动输入。")}
                </Text>
              )}
              {selectedRepository.pushUrl &&
              selectedRepository.pushUrl !==
                selectedRepository.repositoryUrl ? (
                <Text selectable style={muted}>
                  {t("推送地址：")}
                  {selectedRepository.pushUrl}
                </Text>
              ) : null}
              {selectedRepository.remoteWarning ? (
                <Text style={muted}>
                  {t("远端地址含凭据、格式不支持或无法读取，请检查 Git 配置。")}
                </Text>
              ) : null}
            </View>
          ) : null}
          {!selectedRepository && discovery?.candidates.length ? (
            <View style={{ gap: 8, padding: 12 }}>
              <Text style={muted}>{t("请选择配置仓库")}</Text>
              {discovery.candidates.map((c) => (
                <SettingsAction
                  key={c.checkout}
                  label={c.checkout}
                  hint={c.repositoryUrl ?? ""}
                  actionLabel={t("使用此仓库")}
                  disabled={busy}
                  onPress={() => {
                    setDraft((d) => ({
                      ...d,
                      checkout: c.checkout,
                      repositoryUrl: c.repositoryUrl ?? "",
                    }));
                    setEditing(false);
                  }}
                />
              ))}
            </View>
          ) : null}
          {!searching && discovery?.candidates.length === 0 ? (
            <Text style={muted}>
              {t("未找到配置仓库，请输入本机绝对路径。")}
            </Text>
          ) : null}
          <SettingsAction
            label={t("连接配置仓库")}
            actionLabel={t("重新查找")}
            disabled={busy || settings.status !== "ready"}
            onPress={() => void findRepositories()}
          />
          {selectedRepository ? (
            <SettingsAction
              label={t("配置仓库本机绝对路径")}
              actionLabel={t(editing ? "取消更改" : "更改")}
              disabled={busy}
              onPress={() => setEditing((v) => !v)}
            />
          ) : null}
          {fields
            .filter(
              ([key]) =>
                !selectedRepository ||
                editing ||
                (key !== "checkout" &&
                  (key !== "repositoryUrl" ||
                    !selectedRepository.repositoryUrl)),
            )
            .map(([key, label]) => (
              <SettingsInput
                key={`${key}:${settings.status === "ready" ? settings.revision : ""}:${discovery?.selected?.checkout ?? ""}:${selectedRepository?.checkout ?? ""}`}
                label={t(label)}
                initialValue={draft[key]}
                disabled={busy}
                onChangeText={(v) => {
                  if (key === "checkout") setDiscovery(null);
                  setDraft((d) => ({
                    ...d,
                    [key]: v,
                    ...(key === "checkout" ? { repositoryUrl: "" } : {}),
                  }));
                }}
              />
            ))}
          <SettingsAction
            label={t("保存主机设置")}
            actionLabel={t("保存")}
            disabled={busy || settings.status !== "ready" || !dirty}
            onPress={() => {
              if (settings.status === "ready")
                void settings.save(draft, settings.revision);
            }}
          />
        </SettingsCard>
      </SettingsSection>
      {settings.status === "error" || settings.status === "invalid" ? (
        <Text style={text}>{settings.error}</Text>
      ) : null}
      {settings.saveError ? (
        <Text style={text}>{settings.saveError}</Text>
      ) : null}
      {dirty ? (
        <Text style={muted}>{t("请先保存设置，再执行同步操作。")}</Text>
      ) : null}
      <SettingsSection title={t("手动同步")}>
        <SettingsCard>
          <SettingsAction
            label={t("初始化或拉取仓库")}
            hint={t("仅允许快进；工作区有修改或历史分叉时停止。")}
            actionLabel={t("拉取")}
            disabled={disabled}
            onPress={() => void run({ kind: "prepare" })}
          />
          <SettingsAction
            label={t("检查主机环境")}
            actionLabel={t("检查")}
            disabled={disabled}
            onPress={() => void run({ kind: "inspect" })}
          />
          <SettingsAction
            label={t("检查 Cafe 自动更新冲突")}
            hint={t("预览后确认，将受管插件加入更新排除列表。")}
            actionLabel={t("预览")}
            disabled={disabled}
            onPress={() => void run({ kind: "cafePlan" })}
          />
          <SettingsAction
            label={t("同步仓库配置到本机")}
            actionLabel={t("预览差异")}
            disabled={disabled}
            onPress={() => void run({ kind: "plan" })}
          />
          <SettingsAction
            label={t("发布本机配置")}
            hint={t("预览导出内容，确认后提交并推送到配置仓库。")}
            actionLabel={t("预览发布")}
            disabled={disabled}
            onPress={() => void run({ kind: "publishPlan" })}
          />
          <SettingsAction
            label={t("验证同步结果")}
            actionLabel={t("验证")}
            disabled={disabled}
            onPress={() => void run({ kind: "verify" })}
          />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title={t("恢复")}>
        <SettingsCard>
          <SettingsAction
            label={t("列出当前配置仓库的备份")}
            actionLabel={t("查看")}
            disabled={disabled}
            onPress={() => void run({ kind: "backups" })}
          />
          <SettingsInput
            label={t("备份 ID（Cafe 使用 cafe: 前缀）")}
            initialValue={backup}
            disabled={busy}
            onChangeText={setBackup}
          />
          <SettingsAction
            label={t("恢复备份")}
            actionLabel={t("预览恢复")}
            disabled={disabled || !backup}
            onPress={() =>
              void run({ kind: "restorePlan", backupId: backup.trim() })
            }
          />
          <SettingsAction
            label={t("中断后解除任务锁")}
            hint={t(
              "只允许已确认原进程退出的任务；执行锁仍需人工检查备份后处理。",
            )}
            actionLabel={t("检查并解锁")}
            disabled={busy}
            onPress={() => {
              setError("");
              void unlock({})
                .then(() => setJob(null))
                .catch((e) => setError(String(e)));
            }}
          />
        </SettingsCard>
      </SettingsSection>
      {error ? (
        <Text selectable style={text}>
          {error}
        </Text>
      ) : null}
      {job ? (
        <View style={{ gap: 8 }}>
          <Text style={text}>
            {t("任务：")}
            {t(job.kind)} · {t(job.status)} {t(job.phase ?? "")}
          </Text>
          {job.error ? (
            <Text selectable style={text}>
              {job.error}
            </Text>
          ) : null}
          {job.backupId ? (
            <Text selectable style={text}>
              {t("备份：")}
              {job.backupId}
            </Text>
          ) : null}
          {result !== undefined ? (
            <>
              <ResultSummary
                value={result}
                color={theme.colors.foreground}
                t={t}
              />
              <Pressable
                accessibilityRole="button"
                onPress={() => setDetails((v) => !v)}
              >
                <Text style={muted}>
                  {t(details ? "收起技术详情" : "查看技术详情")}
                </Text>
              </Pressable>
              {details ? (
                <Text
                  selectable
                  style={[text, { fontFamily: "monospace", fontSize: 12 }]}
                >
                  {JSON.stringify(result, null, 2)}
                </Text>
              ) : null}
            </>
          ) : null}
          {canConfirm ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("确认执行预览")}
              disabled={disabled}
              style={{
                padding: 14,
                backgroundColor: theme.colors.accent,
                opacity: disabled ? 0.5 : 1,
              }}
              onPress={() =>
                void run({
                  kind: preview.confirmKind!,
                  approval: preview.approval!,
                  ...(preview.backupId ? { backupId: preview.backupId } : {}),
                })
              }
            >
              <Text style={{ color: theme.colors.accentForeground }}>
                {t("确认在 {host} 执行以上变更", { host: host.label })}
              </Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      <Text style={muted}>
        {t(
          "只同步插件清单与允许的设置。凭据、会话和客户端本地偏好保留在本机。同步插件自身需单独更新。",
        )}
      </Text>
    </ScrollView>
  );
}

function ResultSummary({
  value,
  color,
  t,
}: {
  value: unknown;
  color: string;
  t: ReturnType<typeof translator>;
}) {
  const r = (value ?? {}) as {
    conflicts?: string[];
    changes?: {
      plugin: string;
      actions: string[];
      from?: { revision: string } | null;
      to?: { revision: string };
      settings?: { document: string; before: unknown; after: unknown }[];
    }[];
    pushUrl?: string;
    upstream?: string;
    files?: { path: string; before: string | null; after: string }[];
    missing?: string[];
    backups?: { id: string; status: string }[];
    configurationMatches?: boolean;
    runtimeHealthy?: boolean;
    changed?: boolean;
    restored?: boolean;
    committed?: boolean;
    pushed?: boolean;
    backupId?: string;
    ready?: boolean;
    home?: string;
    daemonVersion?: string;
  };
  const text = { color };
  return (
    <View style={{ gap: 8 }}>
      {r.pushUrl ? (
        <Text selectable style={text}>
          {t("发布到：")}
          {r.pushUrl} · {r.upstream}
        </Text>
      ) : null}
      {r.conflicts?.map((c, i) => (
        <Text selectable key={i} style={text}>
          {t("需处理：")}
          {c}
        </Text>
      ))}
      {r.changes?.length === 0 ? (
        <Text style={text}>{t("配置一致，无需修改。")}</Text>
      ) : null}
      {r.changes?.map((c) => (
        <View key={c.plugin} style={{ gap: 4 }}>
          <Text style={text}>
            {c.plugin}：{c.from?.revision ?? t("未安装")} → {c.to?.revision} ·{" "}
            {c.actions
              .map(
                (a) =>
                  ({
                    install: "安装",
                    update: "切换版本",
                    enable: "启用",
                    disable: "停用",
                    reload: "重载",
                    patch: "应用补丁",
                  })[a] ?? "更新设置",
              )
              .map((a) => t(a))
              .join(", ")}
          </Text>
          {c.settings?.map((s) => (
            <Text selectable key={s.document} style={text}>
              {s.document}：{JSON.stringify(s.before)} →{" "}
              {JSON.stringify(s.after)}
            </Text>
          ))}
        </View>
      ))}
      {r.files?.length === 0 ? (
        <Text style={text}>
          {t("导出内容没有变化；确认发布可推送尚未推送的提交。")}
        </Text>
      ) : null}
      {r.files?.map((f) => (
        <View key={f.path} style={{ gap: 4 }}>
          <Text style={text}>{f.path}</Text>
          <Text selectable style={text}>
            {t("修改前：")}
            {f.before ?? t("文件不存在")}
          </Text>
          <Text selectable style={text}>
            {t("修改后：")}
            {f.after}
          </Text>
        </View>
      ))}
      {r.missing ? (
        <Text style={text}>
          {r.missing.length
            ? t("将加入 Cafe 自动更新排除列表：") + r.missing.join(", ")
            : t("Cafe 没有待处理的自动更新冲突。")}
        </Text>
      ) : null}
      {r.backups?.map((b) => (
        <Text selectable key={b.id} style={text}>
          {b.id} · {t(b.status)}
        </Text>
      ))}
      {r.backups?.length === 0 ? (
        <Text style={text}>{t("当前仓库尚无备份。")}</Text>
      ) : null}
      {r.configurationMatches !== undefined ? (
        <Text style={text}>
          {t("配置：")}
          {t(r.configurationMatches ? "一致" : "存在差异")} · {t("运行状态：")}
          {t(r.runtimeHealthy ? "正常" : "需检查")}
        </Text>
      ) : null}
      {r.ready ? (
        <Text style={text}>{t("仓库已就绪，可以检查同步差异。")}</Text>
      ) : null}
      {r.home ? (
        <Text style={text}>
          Daemon home：{r.home}；Paseo {r.daemonVersion}
        </Text>
      ) : null}
      {r.changed !== undefined ? (
        <Text style={text}>{t(r.changed ? "变更已应用。" : "无需修改。")}</Text>
      ) : null}
      {r.restored ? <Text style={text}>{t("备份已恢复。")}</Text> : null}
      {r.committed !== undefined ? (
        <Text style={text}>
          {t(r.committed ? "配置已提交。" : "没有新的文件修改。")}
          {r.pushed ? t("已推送到配置仓库。") : ""}
        </Text>
      ) : null}
      {r.backupId ? (
        <Text selectable style={text}>
          {t("备份 ID：")}
          {r.backupId}
        </Text>
      ) : null}
    </View>
  );
}
