// Pure client logic for the first-time setup flow: step derivation, action
// gating and failure classification. Kept free of React and node:path so the
// UI stays thin and the rules stay testable.

export const EMPTY_PROGRESS = Object.freeze({
  checkout: "",
  prepared: false,
  inspected: false,
  cafe: false,
  applied: false,
});

// These operations read the repository itself; other kinds only need the
// saved settings (prepare creates the repository, inspect only inspects).
const REPO_KINDS = new Set([
  "plan",
  "cafePlan",
  "publishPlan",
  "verify",
  "backups",
  "restorePlan",
]);

// Server messages about missing configuration or environment vs. unexpected
// operational failures. The UI renders these neutrally, not as errors.
const PRECONDITION_PATTERNS = [
  /enoent: no such file or directory/i,
  /\beacc?es\b/i,
  /\beperm\b/i,
  /set an absolute profile checkout path/i,
  /checkout (path )?must be/i,
  /must be outside the paseo home/i,
  /paseo cli not found/i,
  /daemon pid mismatch/i,
  /cannot confirm a supported stable daemon version/i,
  /paseo daemon >=/i,
  /repository has uncommitted or untracked/i,
  /repository behind or diverged/i,
  /upstream must be origin/i,
  /checkout must be the repository root/i,
  /detached checkout requires a branch/i,
  /symlink checkout refused/i,
  /exactly one reviewed push url is required/i,
  /credential/i,
  /approval digest is required/i,
  /choose a backup id/i,
  /preview is stale/i,
  /another operation is active, or an interrupted operation/i,
  /git \S+ failed/i,
  /use your separate configuration repository, not the public plugin source/i,
  /repository url must use https/i,
  /invalid repository url/i,
  /daemon home must be absolute/i,
  /profile checkout must be outside/i,
];

export function classifyFailure(message) {
  const text = String(message ?? "");
  if (!text) return "error";
  return PRECONDITION_PATTERNS.some((re) => re.test(text))
    ? "precondition"
    : "error";
}

export function absolutePathLike(value) {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("/")) return true;
  return /^[A-Za-z]:[\\/]/.test(trimmed);
}

// state: { saved, dirty, checkoutSet, repoReady, backup }
export function actionGate(kind, state) {
  if (kind === "unlock") return { disabled: false, reason: null };
  if (!state.saved) return { disabled: true, reason: "unsaved" };
  if (state.dirty) return { disabled: true, reason: "dirty" };
  if (!state.checkoutSet) return { disabled: true, reason: "absolute" };
  if (REPO_KINDS.has(kind) && !state.repoReady)
    return { disabled: true, reason: "repo" };
  if (kind === "restorePlan" && !state.backup)
    return { disabled: true, reason: "backup" };
  return { disabled: false, reason: null };
}

function turned(a, b) {
  return (
    a.checkout !== b.checkout ||
    a.prepared !== b.prepared ||
    a.inspected !== b.inspected ||
    a.cafe !== b.cafe ||
    a.applied !== b.applied
  );
}

// A succeeded job proves part of the flow finished. Successes other than
// inspect imply the repository was connected; apply also implies the Cafe
// stage was reviewed, because the apply preview blocks on pending conflicts.
export function progressFromJob(progress, kind, checkout) {
  if (typeof checkout !== "string") return progress;
  const base =
    progress.checkout === checkout ? progress : { ...EMPTY_PROGRESS, checkout };
  const next = { ...base };
  if (kind === "inspect") next.inspected = true;
  else next.prepared = true;
  if (kind === "cafe") next.cafe = true;
  if (kind === "apply") {
    next.applied = true;
    next.cafe = true;
  }
  return turned(progress, next) ? next : progress;
}

// step state: done | current | waiting. The first unfinished step is current.
export function setupSteps(state) {
  let current = false;
  const steps = [
    ["connect", state.saved && state.checkoutSet && !state.dirty],
    ["prepare", state.repoReady],
    ["inspect", !!state.inspected],
    ["cafe", !!state.cafeDone],
    ["apply", !!state.applied],
  ].map(([id, done]) => {
    const stepState = done ? "done" : current ? "waiting" : "current";
    if (!done && !current) current = true;
    return { id, state: stepState };
  });
  return { steps, completed: steps.every((s) => s.state === "done") };
}

const storageKey = (hostId) => `paseo-sync.setup:${hostId}`;

function clientStorage() {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function sanitize(value) {
  if (!value || typeof value !== "object") return { ...EMPTY_PROGRESS };
  const progress = { ...EMPTY_PROGRESS, checkout: "" };
  if (typeof value.checkout === "string") progress.checkout = value.checkout;
  for (const flag of ["prepared", "inspected", "cafe", "applied"])
    if (value[flag] === true) progress[flag] = true;
  return progress;
}

export function loadProgress(hostId, storage = clientStorage()) {
  try {
    return sanitize(JSON.parse(storage?.getItem(storageKey(hostId)) ?? ""));
  } catch {
    return { ...EMPTY_PROGRESS };
  }
}

export function saveProgress(hostId, progress, storage = clientStorage()) {
  try {
    storage?.setItem(storageKey(hostId), JSON.stringify(sanitize(progress)));
  } catch {
    /* The choice still survives for this session in React state. */
  }
}
