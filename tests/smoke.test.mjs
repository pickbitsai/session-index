import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

const root = process.cwd();
const port = 43_000 + (process.pid % 1_000);
let server;
let serverOutput = "";
let fixtureRoot;
let scanRoot;

function httpRequest(pathname, { hostHeader = `127.0.0.1:${port}`, method = "GET" } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({
      hostname: "127.0.0.1",
      port,
      path: pathname,
      method,
      headers: { Host: hostHeader },
    }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function waitForServer() {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    try {
      const response = await httpRequest("/api/health");
      if (response.status === 200) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error(`Server did not start. Output:\n${serverOutput}`);
}

before(async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "session-index-test-"));
  scanRoot = join(fixtureRoot, "projects");
  const codexHome = join(fixtureRoot, "codex");
  const claudeHome = join(fixtureRoot, "claude");
  const codexDirectory = join(codexHome, "sessions", "2026", "07", "21");
  const claudeProjectKey = scanRoot.replace(/[:\\/]/g, "-").toLowerCase();
  const claudeDirectory = join(claudeHome, "projects", claudeProjectKey);
  await mkdir(codexDirectory, { recursive: true });
  await mkdir(claudeDirectory, { recursive: true });

  const codexRecords = [
    { type: "session_meta", payload: { id: "codex-test", cwd: join(scanRoot, "widget"), context_window: 100_000 } },
    { type: "response_item", payload: { role: "user", content: [{ type: "input_text", text: "Build the synthetic widget." }] } },
    { type: "turn_context", payload: { model: "gpt-test", effort: "low" } },
    { type: "event_msg", payload: { type: "user_message", message: "Build the synthetic widget." } },
    { type: "event_msg", payload: { type: "token_count", info: { model_context_window: 100_000, last_token_usage: { total_tokens: 25_000 } } } },
  ];
  await writeFile(join(codexDirectory, "codex-test.jsonl"), `${codexRecords.map(JSON.stringify).join("\n")}\n`);

  const claudeRecords = [
    { type: "user", cwd: join(scanRoot, "review"), sessionId: "claude-test", gitBranch: "main", message: { content: "Review the synthetic widget." } },
    { type: "last-prompt", sessionId: "claude-test", lastPrompt: "Ignore this earlier prompt." },
    { type: "assistant", cwd: join(scanRoot, "review"), gitBranch: "main", effort: "high", message: { model: "claude-test-model", usage: { input_tokens: 10, cache_creation_input_tokens: 20, cache_read_input_tokens: 30 } } },
    { type: "last-prompt", sessionId: "claude-test", lastPrompt: "Check the synthetic result." },
    { type: "ai-title", sessionId: "claude-test", aiTitle: "Synthetic review" },
  ];
  await writeFile(join(claudeDirectory, "claude-test.jsonl"), `${claudeRecords.map(JSON.stringify).join("\n")}\n`);

  server = spawn(process.execPath, ["serve.mjs"], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      SESSION_SCAN_ROOT: scanRoot,
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
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1);
  assert.doesNotThrow(() => new Function(scripts[0][1]));
  assert.doesNotMatch(html, /Pick up where/i);
  assert.doesNotMatch(html, /One quiet place for your Codex/i);
  assert.match(html, /autoScan: storedScanPreference === "enabled"/);
});

test("serves the app with local security headers", async () => {
  const response = await httpRequest("/");
  assert.equal(response.status, 200);
  assert.match(response.body, /Session Index/);
  assert.match(response.headers["content-security-policy"], /connect-src 'self'/);
  assert.equal(response.headers["x-frame-options"], "DENY");
  assert.equal(response.headers["x-content-type-options"], "nosniff");
});

test("exposes local configuration and parses synthetic provider metadata", async () => {
  const config = await httpRequest("/api/config");
  assert.equal(config.status, 200);
  assert.equal(JSON.parse(config.body).scanRoot, scanRoot);

  const scan = await httpRequest("/api/sessions/scan");
  assert.equal(scan.status, 200);
  const sessions = JSON.parse(scan.body).sessions;
  assert.equal(sessions.length, 2);
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

test("rejects non-local hosts, non-GET methods, and traversal", async () => {
  assert.equal((await httpRequest("/", { hostHeader: "example.com" })).status, 403);
  assert.equal((await httpRequest("/api/health", { method: "POST" })).status, 405);
  assert.equal((await httpRequest("/%2e%2e%2fREADME.md")).status, 403);
});
