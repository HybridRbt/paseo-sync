import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW_PATH = path.join(REPO_ROOT, ".github", "workflows", "github-issues-to-multica.yml");

function findPythonExecutable() {
  for (const candidate of ["python3", "python"]) {
    const probe = spawnSync(candidate, ["-c", "import sys; assert sys.version_info >= (3, 8)"], {
      stdio: "ignore",
    });
    if (probe.status === 0) return candidate;
  }
  return null;
}

const PYTHON_BIN = findPythonExecutable();

async function extractWorkflowPythonScript() {
  const workflowText = await fs.readFile(WORKFLOW_PATH, "utf8");
  const match = workflowText.match(/python3 - <<'PY'\r?\n([\s\S]*?)\r?\n\s*PY\b/);
  assert.ok(match, "Expected inline Python heredoc in github-issues-to-multica.yml");
  const lines = match[1].split(/\r?\n/);
  const indents = lines
    .filter((line) => line.trim().length > 0)
    .map((line) => line.match(/^(\s*)/)[1].length);
  const minIndent = Math.min(...indents);
  return lines.map((line) => line.slice(minIndent)).join("\n") + "\n";
}

async function runWorkflowScript({
  eventName = "issues",
  eventPayload,
  runId = "42325341568",
  webhookUrl = "https://multica.example.com/api/webhooks/autopilots/awt_test_secret_token",
  githubToken = "ghs_test_token",
  mockRoutes = {},
}) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "paseo-multica-wf-"));
  try {
    const script = await extractWorkflowPythonScript();
    const scriptPath = path.join(tempDir, "relay.py");
    const eventPath = path.join(tempDir, "event.json");
    const capturedPath = path.join(tempDir, "captured.json");
    const routesPath = path.join(tempDir, "routes.json");
    const siteCustomizePath = path.join(tempDir, "sitecustomize.py");

    await fs.writeFile(scriptPath, script, "utf8");
    await fs.writeFile(eventPath, JSON.stringify(eventPayload), "utf8");
    await fs.writeFile(routesPath, JSON.stringify(mockRoutes), "utf8");
    await fs.writeFile(capturedPath, "[]", "utf8");

    await fs.writeFile(
      siteCustomizePath,
      [
        "import io",
        "import json",
        "import os",
        "import urllib.error",
        "import urllib.request",
        "",
        "class _MockResponse(io.BytesIO):",
        "    def __init__(self, body_bytes, status=200):",
        "        super().__init__(body_bytes)",
        "        self.status = status",
        "    def __enter__(self):",
        "        return self",
        "    def __exit__(self, exc_type, exc, tb):",
        "        self.close()",
        "        return False",
        "",
        "class _MockOpener:",
        "    def open(self, request, timeout=None):",
        "        with open(os.environ['TEST_CAPTURED_PATH'], encoding='utf-8') as f:",
        "            captured = json.load(f)",
        "        raw_data = request.data.decode('utf-8') if request.data else None",
        "        captured.append({",
        "            'url': request.full_url,",
        "            'method': request.get_method(),",
        "            'headers': {k.lower(): v for k, v in request.header_items()},",
        "            'body': json.loads(raw_data) if raw_data else None,",
        "        })",
        "        with open(os.environ['TEST_CAPTURED_PATH'], 'w', encoding='utf-8') as f:",
        "            json.dump(captured, f)",
        "        with open(os.environ['TEST_ROUTES_PATH'], encoding='utf-8') as f:",
        "            routes = json.load(f)",
        "        route = routes.get(request.full_url) or routes.get('*')",
        "        if not route:",
        "            raise RuntimeError('No mock route for ' + request.full_url)",
        "        status = int(route.get('status', 200))",
        "        body_bytes = json.dumps(route.get('body', {})).encode('utf-8')",
        "        if status >= 400:",
        "            raise urllib.error.HTTPError(request.full_url, status, 'HTTP Error', {}, io.BytesIO(body_bytes))",
        "        return _MockResponse(body_bytes, status=status)",
        "",
        "urllib.request.build_opener = lambda *args, **kwargs: _MockOpener()",
        "",
      ].join("\n"),
      "utf8",
    );

    const proc = spawnSync(PYTHON_BIN, [scriptPath], {
      env: {
        ...process.env,
        PYTHONPATH: tempDir,
        GITHUB_EVENT_NAME: eventName,
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_RUN_ID: runId,
        MULTICA_WEBHOOK_URL: webhookUrl,
        GITHUB_TOKEN: githubToken,
        TEST_CAPTURED_PATH: capturedPath,
        TEST_ROUTES_PATH: routesPath,
      },
      encoding: "utf8",
    });

    const captured = JSON.parse(await fs.readFile(capturedPath, "utf8"));
    return {
      status: proc.status,
      stdout: proc.stdout,
      stderr: proc.stderr,
      captured,
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

const SAMPLE_ISSUE_EVENT = {
  action: "opened",
  repository: { full_name: "HybridRbt/paseo-sync" },
  issue: {
    number: 21,
    html_url: "https://github.com/HybridRbt/paseo-sync/issues/21",
    title: "[Autopilot 试跑] 添加 docs/autopilot-smoke-test.md，PR 等待人工验收",
    body: "Smoke test body",
  },
};

test(
  "github-issues-to-multica workflow script handles accepted, ignored, duplicate, skipped, and workflow_dispatch",
  { skip: !PYTHON_BIN && "python3/python is not available" },
  async (t) => {
    await t.test("accepted response succeeds and prints run_id and delivery_id", async () => {
      const res = await runWorkflowScript({
        eventPayload: SAMPLE_ISSUE_EVENT,
        mockRoutes: {
          "*": {
            status: 200,
            body: {
              status: "accepted",
              delivery_id: "01a1b3aa-39e2-7357-befb-fe9a30000001",
              run_id: "01a1b3aa-39e2-7357-befb-fe9a30000002",
            },
          },
        },
      });
      assert.equal(res.status, 0, res.stderr);
      assert.match(res.stdout, /Multica admission=accepted; run_id=01a1b3aa-39e2-7357-befb-fe9a30000002/);
      assert.equal(res.captured.length, 1);
      assert.equal(res.captured[0].headers["idempotency-key"], "gh-actions:HybridRbt/paseo-sync:42325341568");
      assert.equal(res.captured[0].headers["x-github-event"], "issues");
    });

    await t.test("ignored response (e.g. event_filtered on Attempt 1) reports safe diagnostics", async () => {
      const res = await runWorkflowScript({
        eventPayload: SAMPLE_ISSUE_EVENT,
        mockRoutes: {
          "*": {
            status: 200,
            body: {
              status: "ignored",
              delivery_id: "01a1b3aa-39e2-7357-befb-fe9a30000001",
              reason: "event_filtered",
              event: "github.issues.opened",
            },
          },
        },
      });
      assert.equal(res.status, 1);
      assert.match(res.stderr, /Ignored by Multica/);
      assert.match(res.stderr, /delivery_id=01a1b3aa-39e2-7357-befb-fe9a30000001/);
      assert.match(res.stderr, /reason=event_filtered/);
      assert.match(res.stderr, /event=github\.issues\.opened/);
    });

    await t.test("duplicate response without run_id (Attempt 2 after ignored Attempt 1) explains why re-run cannot admit", async () => {
      const res = await runWorkflowScript({
        eventPayload: SAMPLE_ISSUE_EVENT,
        mockRoutes: {
          "*": {
            status: 200,
            body: {
              status: "duplicate",
              delivery_id: "01a1b3aa-39e2-7357-befb-fe9a30000001",
            },
          },
        },
      });
      assert.equal(res.status, 1);
      assert.match(res.stderr, /Duplicate delivery without run_id/);
      assert.match(res.stderr, /delivery_id=01a1b3aa-39e2-7357-befb-fe9a30000001/);
    });

    await t.test("duplicate response with valid run_id succeeds idempotently on Actions re-run", async () => {
      const res = await runWorkflowScript({
        eventPayload: SAMPLE_ISSUE_EVENT,
        mockRoutes: {
          "*": {
            status: 200,
            body: {
              status: "duplicate",
              delivery_id: "01a1b3aa-39e2-7357-befb-fe9a30000001",
              run_id: "01a1b3aa-39e2-7357-befb-fe9a30000002",
            },
          },
        },
      });
      assert.equal(res.status, 0, res.stderr);
      assert.match(res.stdout, /Multica admission=duplicate; run_id=01a1b3aa-39e2-7357-befb-fe9a30000002/);
    });

    await t.test("skipped response includes validated reason and exits non-zero", async () => {
      const res = await runWorkflowScript({
        eventPayload: SAMPLE_ISSUE_EVENT,
        mockRoutes: {
          "*": {
            status: 200,
            body: {
              status: "skipped",
              delivery_id: "01a1b3aa-39e2-7357-befb-fe9a30000001",
              run_id: "01a1b3aa-39e2-7357-befb-fe9a30000002",
              reason: "runtime_offline",
            },
          },
        },
      });
      assert.equal(res.status, 1);
      assert.match(res.stdout, /Multica admission=skipped; run_id=01a1b3aa-39e2-7357-befb-fe9a30000002/);
      assert.match(res.stderr, /Skipped.*reason=runtime_offline/);
    });

    await t.test("workflow_dispatch loads the target issue via GitHub API and forwards with the fresh run_id", async () => {
      const webhookUrl = "https://multica.example.com/api/webhooks/autopilots/awt_test_secret_token";
      const res = await runWorkflowScript({
        eventName: "workflow_dispatch",
        runId: "42399999999",
        webhookUrl,
        eventPayload: {
          repository: { full_name: "HybridRbt/paseo-sync" },
          inputs: { issue_number: "21" },
        },
        mockRoutes: {
          "https://api.github.com/repos/HybridRbt/paseo-sync/issues/21": {
            status: 200,
            body: SAMPLE_ISSUE_EVENT.issue,
          },
          [webhookUrl]: {
            status: 200,
            body: {
              status: "accepted",
              delivery_id: "01a1b3aa-39e2-7357-befb-fe9a30000009",
              run_id: "01a1b3aa-39e2-7357-befb-fe9a30000010",
            },
          },
        },
      });
      assert.equal(res.status, 0, res.stderr);
      assert.equal(res.captured.length, 2);
      assert.equal(res.captured[0].url, "https://api.github.com/repos/HybridRbt/paseo-sync/issues/21");
      assert.equal(res.captured[1].url, webhookUrl);
      assert.equal(res.captured[1].headers["idempotency-key"], "gh-actions:HybridRbt/paseo-sync:42399999999");
      assert.equal(res.captured[1].body.issue.number, 21);
      assert.equal(res.captured[1].body.action, "opened");
    });

    await t.test("never echoes unvalidated URL-like strings from response fields", async () => {
      const leakedSecret = "https://multica.example.com/api/webhooks/autopilots/awt_leaked_token";
      const res = await runWorkflowScript({
        eventPayload: SAMPLE_ISSUE_EVENT,
        mockRoutes: {
          "*": {
            status: 200,
            body: {
              status: "ignored",
              delivery_id: leakedSecret,
              reason: leakedSecret,
              event: leakedSecret,
            },
          },
        },
      });
      assert.equal(res.status, 1);
      assert.ok(!res.stdout.includes("awt_leaked_token"));
      assert.ok(!res.stderr.includes("awt_leaked_token"));
    });
  },
);
