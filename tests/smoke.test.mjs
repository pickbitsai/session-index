import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir, uptime } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { parseLiveSnapshot } from "../liveness.mjs";

const root = process.cwd();
const port = 43_000 + (process.pid % 1_000);
let server;
let serverOutput = "";
let fixtureRoot;
let scanRoot;
let codexHome;
let claudeHome;
let stateDir;
const hiddenSessionId = "codex-lookup-hidden";

function httpRequest(pathname, {
  hostHeader,
  method = "GET",
  headers = {},
  body,
  targetPort = port,
} = {}) {
  return new Promise((resolve, reject) => {
    const requestBody = body === undefined ? null : JSON.stringify(body);
    const req = request({
      hostname: "127.0.0.1",
      port: targetPort,
      path: pathname,
      method,
      headers: {
        Host: hostHeader || `127.0.0.1:${targetPort}`,
        ...(requestBody ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(requestBody) } : {}),
        ...headers,
      },
    }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body }));
    });
    req.on("error", reject);
    req.end(requestBody);
  });
}

async function waitForServer(targetPort = port, getOutput = () => serverOutput) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    try {
      const response = await httpRequest("/api/health", { targetPort });
      if (response.status === 200) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error(`Server did not start. Output:\n${getOutput()}`);
}

before(async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "session-index-test-"));
  scanRoot = join(fixtureRoot, "projects");
  codexHome = join(fixtureRoot, "codex");
  claudeHome = join(fixtureRoot, "claude");
  stateDir = join(fixtureRoot, "state");
  const codexDirectory = join(codexHome, "sessions", "2026", "07", "21");
  const claudeProjectKey = scanRoot.replace(/[:\\/]/g, "-").toLowerCase();
  const claudeDirectory = join(claudeHome, "projects", claudeProjectKey);
  await mkdir(codexDirectory, { recursive: true });
  await mkdir(claudeDirectory, { recursive: true });
  await mkdir(join(scanRoot, "widget"), { recursive: true });
  await mkdir(join(scanRoot, "review"), { recursive: true });

  // More than the old 120-file Codex candidate cap, all older than the two
  // display sessions. The final fixture is therefore hidden by both the
  // display limit and the previous hard-coded candidate limit.
  for (let index = 0; index < 125; index += 1) {
    const sessionId = index === 124 ? hiddenSessionId : `codex-older-${String(index).padStart(3, "0")}`;
    const sessionFolder = join(scanRoot, sessionId);
    const filePath = join(codexDirectory, `${sessionId}.jsonl`);
    await mkdir(sessionFolder, { recursive: true });
    const records = [
      { type: "session_meta", payload: { id: sessionId, cwd: sessionFolder } },
      { type: "response_item", payload: { role: "user", content: [{ type: "input_text", text: `Synthetic older session ${index}.` }] } },
    ];
    await writeFile(filePath, `${records.map(JSON.stringify).join("\n")}\n`);
    const timestamp = new Date(Date.UTC(2024, 0, 2, 0, -index));
    await utimes(filePath, timestamp, timestamp);
  }

  const codexRecords = [
    { type: "session_meta", payload: { id: "codex-test", cwd: join(scanRoot, "widget"), context_window: 100_000 } },
    { type: "response_item", payload: { role: "user", content: [{ type: "input_text", text: "Build the synthetic widget." }] } },
    { type: "turn_context", payload: { model: "gpt-test", effort: "low" } },
    { type: "event_msg", payload: { type: "user_message", message: "Build the synthetic widget." } },
    { type: "event_msg", payload: { type: "token_count", info: { model_context_window: 100_000, last_token_usage: { total_tokens: 25_000 } } } },
  ];
  const codexTestPath = join(codexDirectory, "codex-test.jsonl");
  await writeFile(codexTestPath, `${codexRecords.map(JSON.stringify).join("\n")}\n`);
  await utimes(codexTestPath, new Date("2025-01-01T00:00:00.000Z"), new Date("2025-01-01T00:00:00.000Z"));

  const claudeRecords = [
    { type: "user", cwd: join(scanRoot, "review"), sessionId: "claude-test", gitBranch: "main", message: { content: "Review the synthetic widget." } },
    { type: "last-prompt", sessionId: "claude-test", lastPrompt: "Ignore this earlier prompt." },
    { type: "assistant", cwd: join(scanRoot, "review"), gitBranch: "main", effort: "high", message: { model: "claude-test-model", usage: { input_tokens: 10, cache_creation_input_tokens: 20, cache_read_input_tokens: 30 } } },
    { type: "last-prompt", sessionId: "claude-test", lastPrompt: "Check the synthetic result." },
    { type: "ai-title", sessionId: "claude-test", aiTitle: "Synthetic review" },
  ];
  const claudeTestPath = join(claudeDirectory, "claude-test.jsonl");
  await writeFile(claudeTestPath, `${claudeRecords.map(JSON.stringify).join("\n")}\n`);
  await utimes(claudeTestPath, new Date("2025-01-02T00:00:00.000Z"), new Date("2025-01-02T00:00:00.000Z"));

  server = spawn(process.execPath, ["serve.mjs"], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      SESSION_SCAN_ROOT: scanRoot,
      SESSION_SCAN_LIMIT: "2",
      SESSION_LOOKUP_LIMIT: "150",
      SESSION_LAUNCH: "dry-run",
      SESSION_STATE_DIR: stateDir,
      SESSION_LIVENESS: "off",
      SESSION_LIVENESS_INTERVAL_MS: "60000",
      CODEX_HOME: codexHome,
      CLAUDE_CONFIG_DIR: claudeHome,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (chunk) => { serverOutput += chunk; });
  server.stderr.on("data", (chunk) => { serverOutput += chunk; });
  await waitForServer();
});

after(async () => {
  server?.kill();
  await rm(fixtureRoot, { recursive: true, force: true });
});

test("the inline application script parses", async () => {
  const html = await readFile(join(root, "index.html"), "utf8");
  const launchState = await readFile(join(root, "launch-state.js"), "utf8");
  const scripts = [...html.matchAll(/<script type="module">([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1);
  const applicationSource = scripts[0][1].replace(/^\s*import\s+\{[^}]+\}\s+from\s+"[^"]+";\s*/u, "");
  assert.doesNotThrow(() => new Function(applicationSource));
  assert.doesNotMatch(html, /Pick up where/i);
  assert.doesNotMatch(html, /One quiet place for your Codex/i);
  assert.match(html, /autoScan: storedScanPreference === "enabled"/);
  assert.match(html, /<script src="\.\/launch-state\.js"><\/script>/);
  assert.match(html, /session-index\.window-map\.v1/);
  assert.match(html, /import \{ applyWindowMap, getAssignableSessions, normalizeWindowTitle \} from "\.\/windows\.mjs"/);
  assert.match(launchState, /Launching is disabled \(SESSION_LAUNCH=off\)\. Copy the commands instead\./);
  assert.match(launchState, /The local server is not reachable, so sessions cannot be relaunched from here\. Copy the commands instead\./);
  assert.match(launchState, /The local server is running an older build\. Restart it \(npm start\) to enable relaunching\./);
});

test("serves the app with local security headers", async () => {
  const response = await httpRequest("/");
  assert.equal(response.status, 200);
  assert.match(response.body, /Session Index/);
  assert.match(response.headers["content-security-policy"], /connect-src 'self'/);
  assert.equal(response.headers["x-frame-options"], "DENY");
  assert.equal(response.headers["x-content-type-options"], "nosniff");

  const windowHelpers = await httpRequest("/windows.mjs");
  assert.equal(windowHelpers.status, 200);
  assert.match(windowHelpers.headers["content-type"], /^text\/javascript/);
});

test("reports health and build identity without changing the launcher signature", async () => {
  const response = await httpRequest("/api/health");
  assert.equal(response.status, 200);
  assert.match(response.body, /"ok":true/);

  const health = JSON.parse(response.body);
  assert.equal(health.ok, true);
  assert.equal(health.version, "0.1.0");
  assert.equal(typeof health.startedAt, "string");
  assert.equal(Number.isNaN(Date.parse(health.startedAt)), false);
});

test("exposes local configuration and parses synthetic provider metadata", async () => {
  const config = await httpRequest("/api/config");
  assert.equal(config.status, 200);
  const configBody = JSON.parse(config.body);
  assert.equal(configBody.scanRoot, scanRoot);
  assert.equal(configBody.scanLimit, 2);
  assert.equal(configBody.lookupLimit, 150);
  assert.ok(configBody.launchToken);
  assert.equal(configBody.launchMode, "dry-run");
  assert.equal(configBody.stateDir, stateDir);
  assert.deepEqual(configBody.liveness, {
    enabled: false, intervalMs: 60_000, codexLockDir: join(codexHome, "thread-writer-locks"),
  });

  const scan = await httpRequest("/api/sessions/scan");
  assert.equal(scan.status, 200);
  const sessions = JSON.parse(scan.body).sessions;
  assert.equal(sessions.length, 2);
  assert.equal(sessions.some((session) => session.sessionId === hiddenSessionId), false);
  const codex = sessions.find((session) => session.sessionId === "codex-test");
  const claude = sessions.find((session) => session.sessionId === "claude-test");
  assert.equal(codex.title, "Build the synthetic widget.");
  assert.equal(codex.metadata.model, "gpt-test");
  assert.equal(codex.metadata.contextTokens, 25_000);
  assert.equal(codex.metadata.contextWindow, 100_000);
  assert.equal(claude.title, "Synthetic review");
  assert.equal(claude.about, "Check the synthetic result.");
  assert.equal(claude.metadata.model, "claude-test-model");
  assert.equal(claude.metadata.contextTokens, 60);
});

test("serves engine utilization with the expected shape", async () => {
  const response = await httpRequest("/api/usage?days=7");
  assert.equal(response.status, 200);
  const usage = JSON.parse(response.body);
  assert.equal(usage.windowDays, 7);
  assert.ok(usage.claude);
  assert.ok(Array.isArray(usage.claude.byDay));
  assert.equal(usage.claude.byDay.length, 7);
  assert.ok(usage.codex);
  assert.ok(Array.isArray(usage.codex.byDay));
  assert.ok(usage.ollama);
  assert.equal(typeof usage.ollama.available, "boolean");
});

test("rejects non-local hosts, non-GET methods, and traversal", async () => {
  assert.equal((await httpRequest("/", { hostHeader: "example.com" })).status, 403);
  assert.equal((await httpRequest("/api/health", { method: "POST" })).status, 405);
  assert.equal((await httpRequest("/%2e%2e%2fREADME.md")).status, 403);
});

test("requires the launch token", async () => {
  const response = await httpRequest("/api/launch", {
    method: "POST",
    headers: { Origin: `http://127.0.0.1:${port}` },
    body: { agent: "claude", sessionId: "claude-test" },
  });
  assert.equal(response.status, 403);
  assert.equal(JSON.parse(response.body).error, "Invalid launch token.");
});

test("dry-runs a launch for a session outside the display and old candidate caps", async () => {
  const config = JSON.parse((await httpRequest("/api/config")).body);
  const response = await httpRequest("/api/launch", {
    method: "POST",
    headers: {
      Origin: `http://127.0.0.1:${port}`,
      "x-session-index-token": config.launchToken,
    },
    body: { agent: "codex", sessionId: hiddenSessionId },
  });

  assert.equal(response.status, 200);
  const result = JSON.parse(response.body);
  assert.equal(result.ok, true);
  assert.equal(result.launcher, "dry-run");
  assert.equal(result.command, `codex resume ${hiddenSessionId}`);
  assert.equal(result.folder, join(scanRoot, hiddenSessionId));
});

test("dry-runs Claude and Codex launches using server-scanned folders", async () => {
  const config = JSON.parse((await httpRequest("/api/config")).body);
  const headers = {
    Origin: `http://127.0.0.1:${port}`,
    "x-session-index-token": config.launchToken,
  };

  const claudeResponse = await httpRequest("/api/launch", {
    method: "POST",
    headers,
    body: { agent: "claude", sessionId: "claude-test" },
  });
  assert.equal(claudeResponse.status, 200);
  const claude = JSON.parse(claudeResponse.body);
  assert.equal(claude.ok, true);
  assert.equal(claude.command, "claude --resume claude-test");
  assert.equal(claude.folder, join(scanRoot, "review"));

  const codexResponse = await httpRequest("/api/launch", {
    method: "POST",
    headers,
    body: { agent: "codex", sessionId: "codex-test" },
  });
  assert.equal(codexResponse.status, 200);
  const codex = JSON.parse(codexResponse.body);
  assert.equal(codex.ok, true);
  assert.equal(codex.command, "codex resume codex-test");
  assert.equal(codex.folder, join(scanRoot, "widget"));
});

test("an explicit session scan bypasses the launch lookup cache", async () => {
  const newSessionDirectory = join(codexHome, "sessions", "2026", "07", "22");
  const newSessionFolder = join(scanRoot, "fresh-session");
  await mkdir(newSessionDirectory, { recursive: true });
  await mkdir(newSessionFolder, { recursive: true });
  const records = [
    { type: "session_meta", payload: { id: "codex-fresh", cwd: newSessionFolder } },
    { type: "response_item", payload: { role: "user", content: [{ type: "input_text", text: "Find the fresh session." }] } },
  ];
  await writeFile(join(newSessionDirectory, "codex-fresh.jsonl"), `${records.map(JSON.stringify).join("\n")}\n`);

  const response = await httpRequest("/api/sessions/scan");
  assert.equal(response.status, 200);
  const sessions = JSON.parse(response.body).sessions;
  assert.ok(sessions.some((session) => session.sessionId === "codex-fresh"));
});

test("rejects foreign launch origins and invalid or unknown session ids", async () => {
  const config = JSON.parse((await httpRequest("/api/config")).body);
  const tokenHeader = { "x-session-index-token": config.launchToken };
  const evilOrigin = await httpRequest("/api/launch", {
    method: "POST",
    headers: { ...tokenHeader, Origin: "http://evil.test" },
    body: { agent: "claude", sessionId: "claude-test" },
  });
  assert.equal(evilOrigin.status, 403);

  const localHeaders = { ...tokenHeader, Origin: `http://127.0.0.1:${port}` };
  const invalidId = await httpRequest("/api/launch", {
    method: "POST",
    headers: localHeaders,
    body: { agent: "claude", sessionId: "../../etc/passwd" },
  });
  assert.equal(invalidId.status, 400);
  assert.equal(JSON.parse(invalidId.body).error, "Invalid session id.");

  const unknownId = await httpRequest("/api/launch", {
    method: "POST",
    headers: localHeaders,
    body: { agent: "claude", sessionId: "ghost-session" },
  });
  assert.equal(unknownId.status, 404);
  assert.equal(
    JSON.parse(unknownId.body).error,
    "That session could not be found. Its session log may have been deleted, or its recorded folder may be outside SESSION_SCAN_ROOT.",
  );
  assert.doesNotMatch(JSON.parse(unknownId.body).error, /rescan/i);
});

test("reports the best-effort running agent probe", async () => {
  const response = await httpRequest("/api/agents/running");
  assert.equal(response.status, 200);
  assert.equal(typeof JSON.parse(response.body).available, "boolean");
});

test("reports the best-effort visible-window probe", async () => {
  const response = await httpRequest("/api/windows");
  assert.equal(response.status, 200);
  const body = JSON.parse(response.body);
  assert.equal(typeof body.available, "boolean");
  assert.ok(Array.isArray(body.matched));
  assert.ok(Array.isArray(body.unidentified));
  assert.equal(typeof body.ignoredCount, "number");
  assert.equal(typeof body.windowCount, "number");
  assert.equal(typeof body.checkedAt, "string");
  assert.equal(Object.hasOwn(body, "windows"), false);
  assert.equal(Object.hasOwn(body, "ignored"), false);
});

test("SESSION_LAUNCH=off disables the launch endpoint", async (t) => {
  const offPort = port + 1_000;
  let offOutput = "";
  const offServer = spawn(process.execPath, ["serve.mjs"], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(offPort),
      SESSION_SCAN_ROOT: scanRoot,
      SESSION_LAUNCH: "off",
      SESSION_STATE_DIR: stateDir,
      SESSION_LIVENESS: "off",
      CODEX_HOME: codexHome,
      CLAUDE_CONFIG_DIR: claudeHome,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  offServer.stdout.on("data", (chunk) => { offOutput += chunk; });
  offServer.stderr.on("data", (chunk) => { offOutput += chunk; });
  t.after(() => new Promise((resolve) => {
    if (offServer.exitCode !== null) return resolve();
    offServer.once("exit", resolve);
    offServer.kill();
  }));
  await waitForServer(offPort, () => offOutput);

  const response = await httpRequest("/api/launch", {
    targetPort: offPort,
    method: "POST",
    headers: { Origin: `http://127.0.0.1:${offPort}` },
    body: { agent: "claude", sessionId: "claude-test" },
  });
  assert.equal(response.status, 403);
  assert.equal(JSON.parse(response.body).error, "Launching is disabled (SESSION_LAUNCH=off).");
});

test("content activity and persisted pre-boot evidence survive stale file times", async (t) => {
  const snapshotPort = port + 2_000;
  const snapshotStateDir = join(fixtureRoot, "snapshot-state");
  const bootTimeMs = Date.now() - uptime() * 1_000;
  let savedAt = new Date(bootTimeMs - 60_000).toISOString();
  // Windows may report shutdown several minutes before boot. Keep the fixture
  // before that reference too, without depending on this machine's event log.
  const overview = JSON.parse((await httpRequest("/api/restart")).body);
  if (overview.shutdown.available && Number.isFinite(overview.shutdown.shutdownTimeMs)) {
    savedAt = new Date(Math.min(Date.parse(savedAt), overview.shutdown.shutdownTimeMs - 60_000)).toISOString();
  }
  const recordAt = new Date(bootTimeMs - 3_600_000).toISOString();
  const oldMtime = new Date(bootTimeMs - 7_200_000);
  const sessionId = "codex-stale-mtime";
  const folder = join(scanRoot, sessionId);
  const codexPath = join(codexHome, "sessions", `${sessionId}.jsonl`);
  await mkdir(folder, { recursive: true });
  const records = [
    { type: "session_meta", timestamp: oldMtime.toISOString(), payload: { id: sessionId, cwd: folder } },
    { type: "response_item", payload: { role: "user", content: [{ type: "input_text", text: "Recover the idle Codex session." }] } },
    { type: "padding", payload: "x".repeat(1_300_000) },
    { type: "event_msg", timestamp: recordAt, payload: { type: "task_complete" } },
    { type: "event_msg", timestamp: "unparseable", payload: {} },
    { type: "event_msg", timestamp: { invalid: true }, payload: {} },
    { type: "event_msg", timestamp: 123, payload: {} },
  ];
  await writeFile(codexPath, `${records.map(JSON.stringify).join("\n")}\n`);
  await utimes(codexPath, oldMtime, oldMtime);

  const snapshot = {
    version: 1,
    savedAt,
    bootAt: new Date(Date.parse(savedAt) - 86_400_000).toISOString(),
    sessions: [{ agent: "codex", sessionId, title: "Old detected title", folder, activityAt: oldMtime.toISOString() }],
    unidentifiedCount: 0,
    processCounts: { claude: 0, codex: 1 },
  };
  await mkdir(snapshotStateDir, { recursive: true });
  const previousPath = join(snapshotStateDir, "live-sessions.prev-boot.json");
  const livePath = join(snapshotStateDir, "live-sessions.json");
  await writeFile(previousPath, JSON.stringify(snapshot));

  let snapshotServer;
  async function stopSnapshotServer() {
    if (!snapshotServer || snapshotServer.exitCode !== null) return;
    await new Promise((resolve) => {
      snapshotServer.once("exit", resolve);
      snapshotServer.kill();
    });
  }
  async function startSnapshotServer() {
    let output = "";
    snapshotServer = spawn(process.execPath, ["serve.mjs"], {
      cwd: root,
      env: {
        ...process.env,
        PORT: String(snapshotPort),
        SESSION_SCAN_ROOT: scanRoot,
        SESSION_SCAN_LIMIT: "250",
        SESSION_LOOKUP_LIMIT: "250",
        SESSION_LAUNCH: "off",
        SESSION_STATE_DIR: snapshotStateDir,
        SESSION_LIVENESS: "off",
        SESSION_LIVENESS_INTERVAL_MS: "1",
        CODEX_HOME: codexHome,
        CLAUDE_CONFIG_DIR: claudeHome,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    snapshotServer.stdout.on("data", (chunk) => { output += chunk; });
    snapshotServer.stderr.on("data", (chunk) => { output += chunk; });
    await waitForServer(snapshotPort, () => output);
  }
  t.after(stopSnapshotServer);
  await startSnapshotServer();
  const localRequest = (path) => httpRequest(path, { targetPort: snapshotPort });

  await t.test("scan uses the newest valid Codex tail timestamp despite old mtime", async () => {
    const response = await localRequest("/api/sessions/scan");
    assert.equal(response.status, 200);
    const entry = JSON.parse(response.body).sessions.find((session) => session.sessionId === sessionId);
    assert.ok(entry);
    assert.equal(entry.activityAt, recordAt);
    assert.equal(entry.updatedAt, recordAt.slice(0, 10));
    const config = JSON.parse((await localRequest("/api/config")).body);
    assert.deepEqual(config.liveness, {
      enabled: false, intervalMs: 15_000, codexLockDir: join(codexHome, "thread-writer-locks"),
    });
  });

  await t.test("restart adds the idle Codex fixture from the previous-boot snapshot", async () => {
    const response = await localRequest("/api/restart");
    assert.equal(response.status, 200);
    const result = JSON.parse(response.body);
    const entry = result.sessions.find((session) => session.sessionId === sessionId);
    assert.ok(entry);
    assert.equal(entry.source, "snapshot");
    assert.equal(entry.activityAt, recordAt);
    assert.equal(entry.title, "Recover the idle Codex session.");
    assert.equal(result.sources.snapshot, 1);
    assert.equal(result.confidence, "high");
    assert.equal(result.clusterSize, result.sessions.length);
  });

  await t.test("startup preserves pre-boot live evidence and retains it on a same-boot server restart", async () => {
    await stopSnapshotServer();
    const preserved = { ...snapshot, unidentifiedCount: 2 };
    await writeFile(livePath, JSON.stringify(preserved));
    await startSnapshotServer();
    await localRequest("/api/restart");
    assert.deepEqual(JSON.parse(await readFile(previousPath, "utf8")), preserved);
    await stopSnapshotServer();
    const current = { ...snapshot, savedAt: new Date().toISOString(), sessions: [] };
    await writeFile(livePath, JSON.stringify(current));
    await startSnapshotServer();
    const result = JSON.parse((await localRequest("/api/restart")).body);
    assert.deepEqual(JSON.parse(await readFile(previousPath, "utf8")), preserved);
    assert.equal(result.sessions.find((entry) => entry.sessionId === sessionId)?.source, "snapshot");
    assert.deepEqual(JSON.parse(await readFile(livePath, "utf8")), current);
  });
});

test("heartbeat records Codex writer locks without a window probe on any platform", { timeout: 14_000 }, async (t) => {
  const heartbeatPort = port + 3_000;
  const heartbeatCodexHome = join(fixtureRoot, "heartbeat-codex");
  const heartbeatStateDir = join(fixtureRoot, "heartbeat-state");
  const lockDir = join(heartbeatCodexHome, "thread-writer-locks");
  const sessionDir = join(heartbeatCodexHome, "sessions");
  const folder = join(scanRoot, "codex-locked");
  await Promise.all([lockDir, sessionDir, folder].map((path) => mkdir(path, { recursive: true })));
  const records = [
    { type: "session_meta", payload: { id: "codex-locked", cwd: folder } },
    { type: "response_item", payload: { role: "user", content: [{ type: "input_text", text: "Keep this Codex session open." }] } },
  ];
  const lockPath = join(lockDir, "codex-locked.lock");
  await Promise.all([
    writeFile(join(sessionDir, "rollout-codex-locked.jsonl"), `${records.map(JSON.stringify).join("\n")}\n`),
    writeFile(lockPath, ""),
    writeFile(join(lockDir, ".coordination.lock"), ""),
    writeFile(join(lockDir, "not-a-session.txt"), ""),
  ]);
  const env = {
    ...process.env,
    PORT: String(heartbeatPort),
    SESSION_SCAN_ROOT: scanRoot,
    SESSION_LAUNCH: "off",
    SESSION_STATE_DIR: heartbeatStateDir,
    SESSION_LIVENESS: "on",
    SESSION_LIVENESS_INTERVAL_MS: "15000",
    CODEX_HOME: heartbeatCodexHome,
    CLAUDE_CONFIG_DIR: join(fixtureRoot, "heartbeat-claude"),
  };
  // Force optional OS probes to be unavailable, including on Windows. Node itself
  // is spawned by absolute path; remove all PATH spellings for Windows environments.
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === "path") delete env[key];
  }
  env.PATH = lockDir;
  let output = "";
  const heartbeatServer = spawn(process.execPath, ["serve.mjs"], {
    cwd: root, env, stdio: ["ignore", "pipe", "pipe"],
  });
  heartbeatServer.stdout.on("data", (chunk) => { output += chunk; });
  heartbeatServer.stderr.on("data", (chunk) => { output += chunk; });
  t.after(() => new Promise((resolve) => {
    if (heartbeatServer.exitCode !== null || heartbeatServer.signalCode !== null) return resolve();
    heartbeatServer.once("exit", resolve);
    heartbeatServer.kill();
  }));

  let saved;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      saved = parseLiveSnapshot(await readFile(join(heartbeatStateDir, "live-sessions.json"), "utf8"));
      if (saved) break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    assert.equal(heartbeatServer.exitCode, null, `Heartbeat server exited. Output:\n${output}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(saved, `Heartbeat did not write a valid snapshot within 10 seconds. Output:\n${output}`);
  assert.equal(saved.lockCount, 1);
  assert.equal(saved.unidentifiedCount, 0);
  assert.equal(saved.sessions.length, 1);
  assert.deepEqual(saved.sessions[0], {
    agent: "codex", sessionId: "codex-locked", title: "Keep this Codex session open.",
    folder, activityAt: saved.sessions[0].activityAt,
  });
  const response = await httpRequest("/api/config", { targetPort: heartbeatPort });
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.body).liveness, {
    enabled: true, intervalMs: 15_000, codexLockDir: lockDir,
  });
  // Snapshot parsing and restart merging after closure are covered by unit tests;
  // do not wait for another heartbeat or the five-minute unchanged-list refresh.
  await rm(lockPath);
});
