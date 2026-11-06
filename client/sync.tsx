import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc, useSettings } from "@getpaseo/plugin/client";
import {
  SettingsSection,
  SettingsCard,
  SettingsInput,
  SettingsAction,
  type SettingsInputProps,
  type SettingsInputHandle,
} from "@getpaseo/plugin/client/ui";
import { useEffect, useState, useRef } from "react";
import { ScrollView, Text, View, Pressable } from "react-native";
import { syncSettings } from "../shared/settings";
import { startRpc, jobRpc, unlockRpc, discoverRpc, openCheckoutRpc } from "../shared/rpc";
import type { z } from "zod";
import {
  translator,
  readLanguage,
  saveLanguage,
  canConfirmPreview,
  renderDriftDisclosure,
} from "./i18n.mjs";
import { mergeDiscovery, editCheckout } from "../shared/onboarding.mjs";
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
function SyncedSettingsInput({
  initialValue = "",
  ...props
}: SettingsInputProps) {
  const input = useRef<SettingsInputHandle>(null);
  useEffect(() => {
    if (input.current && input.current.getText() !== initialValue)
      input.current.replaceText(initialValue);
  }, [initialValue]);
  return <SettingsInput {...props} initialValue={initialValue} ref={input} />;
}
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
export type Preview = {
  approval?: string;
  confirmKind?: Request["kind"];
  backupId?: string;
  conflicts?: string[];
  currentChangedSinceBackup?:
    | boolean
    | {
        plugins?: { plugin: string; from?: unknown; to?: unknown }[];
        source?: {
          plugin: string;
          reason?: string;
          files?: string[];
          head?: string | null;
          checkout?: string | null;
        }[];
        settings?: string[];
        patches?: string[];
        pluginsEnabled?: { from: boolean; to: boolean };
      };
};
export { canConfirmPreview, renderDriftDisclosure };
// The first-time setup sequence shown at the top of the screen. Labels use the
// same wording as the matching actions below.
const SETUP_LABEL: Record<string, string> = {
  connect: "连接配置仓库并保存设置",
  prepare: "初始化或拉取仓库",
  inspect: "检查主机环境",
  cafe: "预览并确认 Cafe 排除项",
  apply: "预览并应用同步配置",
};

// Prerequisite notices and real failures render differently: a missing setup
// step is guidance, not a malfunction, and must not read as a bug.
function FailureNotice({
  message,
  theme,
  muted,
  t,
}: {
  message: string;
  theme: PluginSurfaceProps["theme"];
  muted: { color: string };
  t: ReturnType<typeof translator>;
}) {
  if (classifyFailure(message) === "precondition")
    return (
      <View style={{ gap: 4 }}>
        <Text style={{ color: theme.colors.statusWarning, fontWeight: "600" }}>
          {t("需要先完成的前置步骤")}
        </Text>
        <Text selectable style={muted}>
          {message}
        </Text>
        <Text style={muted}>
          {t("这是前置条件提示，不是插件故障；完成对应引导步骤后重试。")}
        </Text>
      </View>
    );
  return (
    <Text selectable style={{ color: theme.colors.statusDanger }}>
      {message}
    </Text>
  );
}

export function SyncScreen({ theme, host }: PluginSurfaceProps) {
  const settings = useSettings(syncSettings),
    discover = useRpc(discoverRpc),
    start = useRpc(startRpc),
    getJob = useRpc(jobRpc),
    unlock = useRpc(unlockRpc),
    openCheckout = useRpc(openCheckoutRpc);
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
    [searchError, setSearchError] = useState("");
  const [editing, setEditing] = useState(false);
  const searchEpoch = useRef(0);
  const [progress, setProgress] = useState(() => loadProgress(host.id));
  const [showSetup, setShowSetup] = useState(false);
  async function findRepositories(requested = draft) {
    const epoch = ++searchEpoch.current;
    setSearching(true);
    setSearchError("");
    try {
      const found = await discover({ checkout: requested.checkout });
      if (epoch !== searchEpoch.current) return;
      setDiscovery(found);
      setDraft((current) => mergeDiscovery(current, requested, found.selected));
    } catch (e) {
      if (epoch === searchEpoch.current) setSearchError(String(e));
    } finally {
      if (epoch === searchEpoch.current) setSearching(false);
    }
  }
  const [details, setDetails] = useState(false);
  // A succeeded job records what the first-time setup has finished on this
  // host; persisted per client so the checklist does not come back confused.
  function adoptSucceeded(
    next: Job | null | undefined,
    checkout: string,
  ): Job | null {
    if (!next || next.status !== "succeeded") return next ?? null;
    setProgress((current) => {
      const updated = progressFromJob(current, next.kind, checkout);
      if (updated !== current) saveProgress(host.id, updated);
      return updated;
    });
    return next;
  }
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
    if (settings.status !== "ready") return;
    let active = true;
    getJob({})
      .then((v) => {
        if (active && v)
          setJob(adoptSucceeded(v as Job, settings.values.checkout));
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [host.id, getJob, settings.status === "ready"]);
  const running = job?.status === "queued" || job?.status === "running";
  useEffect(() => {
    if (!running || !job?.id || settings.status !== "ready") return;
    let active = true;
    const timer = setInterval(() => {
      getJob({ id: job.id })
        .then((v) => {
          if (active && v)
            setJob(adoptSucceeded(v as Job, settings.values.checkout));
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
  const trackedProgress =
    settings.status === "ready" && progress.checkout === settings.values.checkout
      ? progress
      : EMPTY_PROGRESS;
  const checkoutSet = absolutePathLike(
    settings.status === "ready" ? settings.values.checkout : "",
  );
  const repoReady =
    settings.status === "ready" &&
    checkoutSet &&
    (trackedProgress.prepared || !!discovery?.selected);
  const setup = setupSteps({
    saved: settings.status === "ready",
    dirty,
    checkoutSet,
    repoReady,
    inspected: trackedProgress.inspected,
    cafeDone: trackedProgress.cafe,
    applied: trackedProgress.applied,
  });
  const gate = (kind: Request["kind"]) =>
    actionGate(kind, {
      saved: settings.status === "ready",
      dirty,
      checkoutSet,
      repoReady,
      backup: backup.trim().length > 0,
    });
  const gateHint: Record<string, string> = {
    unsaved: t("请先完成第 1 步：保存主机设置。"),
    dirty: t("请先保存设置，再执行同步操作。"),
    absolute: t("配置仓库路径需为本机绝对路径。"),
    repo: t("请先完成第 2 步：初始化或拉取仓库。"),
    backup: t("请先输入备份 ID。"),
  };
  const prepareGate = gate("prepare");
  const inspectGate = gate("inspect");
  const cafeGate = gate("cafePlan");
  const planGate = gate("plan");
  const publishGate = gate("publishPlan");
  const verifyGate = gate("verify");
  const backupsGate = gate("backups");
  const restoreGate = gate("restorePlan");
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
  const canConfirm = canConfirmPreview(preview);
  const text = { color: theme.colors.foreground };
  const muted = { color: theme.colors.foregroundMuted };
  const fields = [
    ["checkout", "配置仓库本机绝对路径"],
    ["repositoryUrl", "仓库 URL（首次克隆时使用，勿填 token）"],
    ["cliPath", "Paseo CLI 绝对路径（留空自动查找）"],
    ["daemonHome", "Daemon home（留空使用主机默认）"],
  ] as const;
  const taskProgress = jobProgress(job);
  const jobPrecondition =
    job?.status === "failed" &&
    classifyFailure(job.error ?? "") === "precondition";
  const barColor =
    job?.status === "failed"
      ? jobPrecondition
        ? theme.colors.statusWarning
        : theme.colors.statusDanger
      : job?.status === "succeeded"
        ? theme.colors.statusSuccess
        : theme.colors.accent;
  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>
      {job || error ? (
        <View
          accessibilityRole="progressbar"
          accessibilityValue={{
            min: 0,
            max: 100,
            now: Math.round(taskProgress * 100),
          }}
          style={{
            gap: 6,
            paddingHorizontal: 20,
            paddingVertical: 12,
            backgroundColor: theme.colors.surface1,
            borderBottomWidth: 1,
            borderBottomColor: theme.colors.border,
          }}
        >
          {job ? (
            <>
              <View
                style={{
                  flexDirection: "row",
                  justifyContent: "space-between",
                  gap: 8,
                }}
              >
                <Text style={[text, { flexShrink: 1 }]}>
                  {t("任务：")}
                  {t(job.kind)} · {t(job.status)} {t(job.phase ?? "")}
                </Text>
                <Text style={muted}>{Math.round(taskProgress * 100)}%</Text>
              </View>
              <View
                style={{
                  height: 4,
                  borderRadius: 2,
                  overflow: "hidden",
                  backgroundColor: theme.colors.surface2,
                }}
              >
                <View
                  style={{
                    height: "100%",
                    width: `${taskProgress * 100}%`,
                    backgroundColor: barColor,
                  }}
                />
              </View>
              {job.error ? (
                <FailureNotice
                  message={job.error}
                  theme={theme}
                  muted={muted}
                  t={t}
                />
              ) : null}
              {job.backupId ? (
                <Text selectable style={text}>
                  {t("备份：")}
                  {job.backupId}
                </Text>
              ) : null}
            </>
          ) : null}
          {error ? (
            <FailureNotice message={error} theme={theme} muted={muted} t={t} />
          ) : null}
        </View>
      ) : null}
    <ScrollView
      style={{ flex: 1 }}
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
      <SettingsSection
        title={t("首次设置")}
        info={t("首次安装后按从上到下的顺序完成；完成后清单收起为一行。")}
      >
        <SettingsCard>
          {setup.completed ? (
            <SettingsAction
              label={t("首次设置已完成")}
              actionLabel={t(showSetup ? "收起" : "查看")}
              onPress={() => setShowSetup((v) => !v)}
            />
          ) : null}
          {(!setup.completed || showSetup) ? (
            <View style={{ gap: 8, padding: 12 }}>
              {setup.steps.map((step, index) => {
                const mark =
                  step.state === "done"
                    ? "✓"
                    : step.state === "current"
                      ? "▶"
                      : "·";
                const suffix =
                  step.state === "current"
                    ? ` · ${t("当前步骤")}`
                    : step.state === "waiting"
                      ? ` · ${t("等待前置")}`
                      : "";
                return (
                  <View
                    key={step.id}
                    style={{ flexDirection: "row", gap: 10 }}
                  >
                    <Text
                      style={{
                        color:
                          step.state === "done"
                            ? theme.colors.statusSuccess
                            : step.state === "current"
                              ? theme.colors.accent
                              : theme.colors.foregroundMuted,
                        width: 16,
                      }}
                    >
                      {mark}
                    </Text>
                    <Text
                      style={
                        step.state === "waiting" || step.state === "done"
                          ? muted
                          : text
                      }
                    >
                      {`${index + 1}. ${t(SETUP_LABEL[step.id])}`}
                      {suffix}
                    </Text>
                  </View>
                );
              })}
            </View>
          ) : null}
        </SettingsCard>
      </SettingsSection>
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
          {searchError ? (
            <Text selectable style={muted}>
              {searchError}
            </Text>
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
              <SyncedSettingsInput
                key={`${host.id}:${key}:${settings.status === "ready" ? settings.revision : ""}`}
                label={t(label)}
                initialValue={draft[key]}
                disabled={busy}
                onChangeText={(v) => {
                  if (key === "checkout") {
                    setDiscovery(null);
                    setDraft((d) => editCheckout(d, v, selectedRepository));
                  } else setDraft((d) => ({ ...d, [key]: v }));
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
            hint={
              prepareGate.reason
                ? gateHint[prepareGate.reason]
                : t("仅允许快进；工作区有修改或历史分叉时停止。")
            }
            actionLabel={t("拉取")}
            disabled={busy || prepareGate.disabled}
            onPress={() => void run({ kind: "prepare" })}
          />
          <SettingsAction
            label={t("检查主机环境")}
            hint={inspectGate.reason ? gateHint[inspectGate.reason] : undefined}
            actionLabel={t("检查")}
            disabled={busy || inspectGate.disabled}
            onPress={() => void run({ kind: "inspect" })}
          />
          <SettingsAction
            label={t("检查 Cafe 自动更新冲突")}
            hint={
              cafeGate.reason
                ? gateHint[cafeGate.reason]
                : t("预览后确认，将受管插件加入更新排除列表。")
            }
            actionLabel={t("预览")}
            disabled={busy || cafeGate.disabled}
            onPress={() => void run({ kind: "cafePlan" })}
          />
          <SettingsAction
            label={t("同步仓库配置到本机")}
            hint={planGate.reason ? gateHint[planGate.reason] : undefined}
            actionLabel={t("预览差异")}
            disabled={busy || planGate.disabled}
            onPress={() => void run({ kind: "plan" })}
          />
          <SettingsAction
            label={t("发布本机配置")}
            hint={
              publishGate.reason
                ? gateHint[publishGate.reason]
                : t("预览导出内容，确认后提交并推送到配置仓库。")
            }
            actionLabel={t("预览发布")}
            disabled={busy || publishGate.disabled}
            onPress={() => void run({ kind: "publishPlan" })}
          />
          <SettingsAction
            label={t("验证同步结果")}
            hint={verifyGate.reason ? gateHint[verifyGate.reason] : undefined}
            actionLabel={t("验证")}
            disabled={busy || verifyGate.disabled}
            onPress={() => void run({ kind: "verify" })}
          />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title={t("恢复")}>
        <SettingsCard>
          {(() => {
            const g = gate("backups");
            return (
              <SettingsAction
                label={t("列出当前配置仓库的备份")}
                hint={g.reason ? gateHint[g.reason] : undefined}
                actionLabel={t("查看")}
                disabled={busy || g.disabled}
                onPress={() => void run({ kind: "backups" })}
              />
            );
          })()}
          <SettingsInput
            label={t("备份 ID（Cafe 使用 cafe: 前缀）")}
            initialValue={backup}
            disabled={busy}
            onChangeText={setBackup}
          />
          {(() => {
            const g = gate("restorePlan");
            return (
              <SettingsAction
                label={t("恢复备份")}
                hint={g.reason ? gateHint[g.reason] : undefined}
                actionLabel={t("预览恢复")}
                disabled={busy || g.disabled}
                onPress={() =>
                  void run({ kind: "restorePlan", backupId: backup.trim() })
                }
              />
            );
          })()}
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
      {job && (result !== undefined || canConfirm) ? (
        <View style={{ gap: 8 }}>
          {result !== undefined ? (
            <>
              <ResultSummary
                value={result}
                color={theme.colors.foreground}
                theme={theme}
                t={t}
                onOpenCheckout={(path, target) =>
                  openCheckout({ path, target })
                }
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
    </View>
  );
}

// The server reports phases, not percentages: queued → checking → work → complete.
const PHASE_PROGRESS: Record<string, number> = {
  queued: 0.1,
  checking: 0.3,
  "git-fetch-and-fast-forward": 0.65,
  preview: 0.65,
  "backup-and-execute": 0.65,
  complete: 1,
};
function jobProgress(job: Job | null): number {
  if (!job) return 0;
  if (job.status === "succeeded" || job.status === "failed") return 1;
  return PHASE_PROGRESS[job.phase ?? ""] ?? 0.1;
}

export function CheckoutShortcuts({
  plugin,
  checkout,
  theme,
  t,
  onOpen,
}: {
  plugin: string;
  checkout: string;
  theme?: PluginSurfaceProps["theme"];
  t: ReturnType<typeof translator>;
  onOpen?: (
    path: string,
    target: "terminal" | "fileManager",
  ) => Promise<{ status: "opened" | "unsupported" | "failed"; error?: string }>;
}) {
  const [opening, setOpening] = useState<"terminal" | "fileManager" | null>(
    null,
  );
  const [status, setStatus] = useState<{
    type: "terminal" | "fileManager";
    status: "opened" | "unsupported" | "failed";
    error?: string;
  } | null>(null);

  async function handleOpen(target: "terminal" | "fileManager") {
    if (!onOpen || opening) return;
    setOpening(target);
    setStatus(null);
    try {
      const res = await onOpen(checkout, target);
      setStatus({ type: target, status: res.status, error: res.error });
    } catch (e) {
      setStatus({
        type: target,
        status: "failed",
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setOpening(null);
    }
  }

  const borderCol = theme?.colors?.border ?? "#ccc";
  const bgCol = theme?.colors?.surface1 ?? "#f5f5f5";
  const fgCol = theme?.colors?.foreground ?? "#000";
  const mutedCol = theme?.colors?.foregroundMuted ?? "#666";
  const dangerCol = theme?.colors?.statusDanger ?? "#d32f2f";
  const successCol = theme?.colors?.statusSuccess ?? "#388e3c";

  return (
    <View style={{ gap: 4 }}>
      <View
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          alignItems: "center",
          gap: 8,
        }}
      >
        <Text style={{ fontSize: 13, fontWeight: "500", color: fgCol }}>
          {plugin}:
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("在终端中打开 {plugin} 源码目录", { plugin })}
          disabled={Boolean(opening)}
          style={{
            paddingVertical: 4,
            paddingHorizontal: 8,
            borderRadius: 4,
            borderWidth: 1,
            borderColor: borderCol,
            backgroundColor: bgCol,
            opacity: opening === "terminal" ? 0.6 : 1,
          }}
          onPress={() => void handleOpen("terminal")}
        >
          <Text style={{ fontSize: 12, color: fgCol }}>
            {t("在终端中打开")}
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("在文件管理器中打开 {plugin} 源码目录", {
            plugin,
          })}
          disabled={Boolean(opening)}
          style={{
            paddingVertical: 4,
            paddingHorizontal: 8,
            borderRadius: 4,
            borderWidth: 1,
            borderColor: borderCol,
            backgroundColor: bgCol,
            opacity: opening === "fileManager" ? 0.6 : 1,
          }}
          onPress={() => void handleOpen("fileManager")}
        >
          <Text style={{ fontSize: 12, color: fgCol }}>
            {t("在文件管理器中打开")}
          </Text>
        </Pressable>
      </View>
      {status ? (
        <Text
          selectable
          style={{
            fontSize: 12,
            paddingLeft: 4,
            color:
              status.status === "opened"
                ? successCol
                : status.status === "failed"
                  ? dangerCol
                  : mutedCol,
          }}
        >
          {status.status === "opened"
            ? status.type === "terminal"
              ? t("已打开终端")
              : t("已在文件管理器中打开")
            : status.status === "unsupported"
              ? t("当前平台不支持该快捷方式。")
              : t("打开失败：{error}", {
                  error: status.error || t("未知错误"),
                })}
        </Text>
      ) : null}
    </View>
  );
}

export function ResultSummary({
  value,
  color,
  t,
  theme,
  onOpenCheckout,
}: {
  value: unknown;
  color: string;
  t: ReturnType<typeof translator>;
  theme?: PluginSurfaceProps["theme"];
  onOpenCheckout?: (
    path: string,
    target: "terminal" | "fileManager",
  ) => Promise<{ status: "opened" | "unsupported" | "failed"; error?: string }>;
}) {
  const r = (value ?? {}) as {
    conflicts?: string[];
    currentChangedSinceBackup?: Preview["currentChangedSinceBackup"];
    skipped?: {
      plugin: string;
      reason: string;
      files?: string[];
      head?: string;
      revision?: string;
      published?: boolean;
      // Present only on apply-side skips: the local checkout left untouched.
      checkout?: string;
      // Present only on restore-side skips: the same dirty checkout
      // disclosure, with restore-specific repair guidance.
      restore?: boolean;
    }[];
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
      {r.currentChangedSinceBackup ? (
        <View style={{ gap: 6 }}>
          <View style={{ gap: 4 }}>
            {renderDriftDisclosure(r.currentChangedSinceBackup, t).map(
              (line: string, idx: number) => (
                <Text
                  selectable
                  key={idx}
                  style={[text, idx > 0 ? { paddingLeft: 8 } : null]}
                >
                  {line}
                </Text>
              ),
            )}
          </View>
          {typeof r.currentChangedSinceBackup === "object" &&
          r.currentChangedSinceBackup.source?.some((s) => s.checkout) ? (
            <View style={{ gap: 8, paddingLeft: 8, paddingTop: 4 }}>
              {r.currentChangedSinceBackup.source
                .filter((s) => Boolean(s.checkout))
                .map((s) => (
                  <CheckoutShortcuts
                    key={s.plugin}
                    plugin={s.plugin}
                    checkout={s.checkout!}
                    theme={theme}
                    t={t}
                    onOpen={onOpenCheckout}
                  />
                ))}
            </View>
          ) : null}
        </View>
      ) : null}
      {r.skipped?.map((s) =>
        s.reason === "local-source-changes" || s.reason === "head-differs" ? (
          s.restore ? (
            // Restore side: reinstalling the pinned revision would destroy
            // the local edits, so the dirty plugin keeps its local state and
            // the disclosure shows how to converge before restoring.
            <View key={s.plugin} style={{ gap: 4 }}>
              <Text selectable style={text}>
                {t(
                  s.reason === "head-differs"
                    ? "跳过 {plugin}：本机源码与安装版本不一致，本次恢复不改动该插件。"
                    : "跳过 {plugin}：本地源码有未提交改动，本次恢复不改动该插件。",
                  { plugin: s.plugin },
                )}
                {s.files?.length
                  ? " " +
                    t("改动文件：{files}", { files: s.files.join(", ") })
                  : ""}
              </Text>
              <Text selectable style={text}>
                {t("本机源码目录：{checkout}", { checkout: s.checkout })}
              </Text>
              {s.checkout ? (
                <View style={{ paddingLeft: 8, paddingTop: 2 }}>
                  <CheckoutShortcuts
                    plugin={s.plugin}
                    checkout={s.checkout}
                    theme={theme}
                    t={t}
                    onOpen={onOpenCheckout}
                  />
                </View>
              ) : null}
              <Text selectable style={text}>
                {t(
                  "该插件本次保持本机现状，未被恢复修改。完成本次恢复后，在插件源码仓库提交并推送，运行 paseo plugin update {plugin}，再重新预览恢复即可恢复备份中的版本。",
                  { plugin: s.plugin },
                )}
              </Text>
            </View>
          ) : s.checkout !== undefined ? (
            // Apply side: the dirty local source keeps its local state; the
            // checkout path and repair steps tell the user how to converge.
            <View key={s.plugin} style={{ gap: 4 }}>
              <Text selectable style={text}>
                {t(
                  s.reason === "head-differs"
                    ? "跳过 {plugin}：本机源码与安装版本不一致，本次不应用到本机。"
                    : "跳过 {plugin}：本地源码有未提交改动，本次不应用到本机。",
                  { plugin: s.plugin },
                )}
                {s.files?.length
                  ? " " +
                    t("改动文件：{files}", { files: s.files.join(", ") })
                  : ""}
              </Text>
              <Text selectable style={text}>
                {t("本机源码目录：{checkout}", { checkout: s.checkout })}
              </Text>
              {s.checkout ? (
                <View style={{ paddingLeft: 8, paddingTop: 2 }}>
                  <CheckoutShortcuts
                    plugin={s.plugin}
                    checkout={s.checkout}
                    theme={theme}
                    t={t}
                    onOpen={onOpenCheckout}
                  />
                </View>
              ) : null}
              <Text selectable style={text}>
                {t(
                  "该插件本次保持本机现状，未被同步修改。在插件源码仓库提交并推送后，运行 paseo plugin update {plugin}，再发布一次让新版本进入配置仓库，然后重新预览差异即可完成同步。",
                  { plugin: s.plugin },
                )}
              </Text>
            </View>
          ) : (
            <View key={s.plugin} style={{ gap: 4 }}>
              <Text selectable style={text}>
                {t(
                  s.reason === "head-differs"
                    ? "跳过 {plugin}：本机源码与安装版本不一致，本次不发布它的变更。"
                    : "跳过 {plugin}：本地源码有未提交改动，本次不发布它的变更。",
                  { plugin: s.plugin },
                )}
                {s.files?.length
                  ? " " +
                    t("改动文件：{files}", { files: s.files.join(", ") })
                  : ""}
              </Text>
              <Text selectable style={text}>
                {s.published
                  ? t("配置仓库沿用该插件已发布的版本。")
                  : t("该插件尚未发布过，本次不出现在配置中。")}{" "}
                {t(
                  "在插件源码仓库提交并推送后，运行 paseo plugin update {plugin}，再重新预览发布即可带上新版本。",
                  { plugin: s.plugin },
                )}
              </Text>
            </View>
          )
        ) : (
          <Text key={s.plugin} style={text}>
            {t("跳过 {plugin}：本机未安装，配置要求保持禁用。", {
              plugin: s.plugin,
            })}
          </Text>
        ),
      )}
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
