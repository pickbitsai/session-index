import { spawn } from "node:child_process";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream, readFileSync, statSync } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import {
  basename,
  extname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
} from "node:path";
import { countPosixAgentProcesses, countWindowsAgentProcesses } from "./processes.mjs";
import { createUsageScanner } from "./usage.mjs";
import { matchWindowsToSessions, parseVisibleWindowsProbeOutput } from "./windows.mjs";

const host = "127.0.0.1";
const port = Number(process.env.PORT || 4173);
const root = process.cwd();
const startedAt = new Date().toISOString();
let version;
try {
  const packageMetadata = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (typeof packageMetadata.version === "string" && packageMetadata.version) {
    version = packageMetadata.version;
  }
} catch {
  // Build identity is informational and must never prevent the server from starting.
}
const healthPayload = { ok: true };
if (version) healthPayload.version = version;
healthPayload.startedAt = startedAt;
const profileRoot = process.env.USERPROFILE || homedir();
const defaultScanRoot = process.platform === "win32" ? "C:\\new" : join(homedir(), "new");
const scanRoot = resolve(process.env.SESSION_SCAN_ROOT || defaultScanRoot);
const scanLimit = clampSessionLimit(process.env.SESSION_SCAN_LIMIT, 80, 250);
const lookupLimit = clampSessionLimit(process.env.SESSION_LOOKUP_LIMIT, 500, 2_000);
const codexStore = process.env.CODEX_HOME || join(profileRoot, ".codex");
const claudeStore = process.env.CLAUDE_CONFIG_DIR || join(profileRoot, ".claude");
// SESSION_LAUNCH: "on" (default) | "off" | "dry-run" (validate + return the command, spawn nothing)
const launchMode = ["off", "dry-run"].includes(String(process.env.SESSION_LAUNCH || "").toLowerCase())
  ? String(process.env.SESSION_LAUNCH).toLowerCase()
  : "on";
// Per-process CSRF token. The page reads it from /api/config (same-origin only) and must
// echo it on POST, so no other origin can reach the process-spawning endpoint.
const launchToken = randomUUID();
const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
};
const usageScanner = createUsageScanner({ codexStore, claudeStore });
const ollamaBase = process.env.OLLAMA_HOST_URL || "http://127.0.0.1:11434";
const securityHeaders = {
  "Content-Security-Policy": "default-src 'self'; base-uri 'none'; connect-src 'self'; font-src 'self'; form-action 'none'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

function clampSessionLimit(value, fallback, maximum) {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.min(maximum, Math.max(1, Math.trunc(parsed)))
    : fallback;
}

async function listJsonlRecursive(directory, results = []) {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = join(directory, entry.name);
      if (entry.isDirectory()) await listJsonlRecursive(entryPath, results);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) results.push(entryPath);
    }
  } catch {
    // A missing agent store simply means that provider is not installed yet.
  }
  return results;
}

async function listClaudeProjectSessions(directory) {
  const results = [];
  try {
    const projectDirectories = await readdir(directory, { withFileTypes: true });
    const rootKey = scanRoot.replace(/[:\\/]/g, "-").toLowerCase();

    for (const projectDirectory of projectDirectories) {
      if (!projectDirectory.isDirectory()) continue;
      const projectKey = projectDirectory.name.toLowerCase();
      if (projectKey !== rootKey && !projectKey.startsWith(`${rootKey}-`)) continue;

      const projectPath = join(directory, projectDirectory.name);
      const entries = await readdir(projectPath, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith(".jsonl")) {
          results.push(join(projectPath, entry.name));
        }
      }
    }
  } catch {
    // A missing Claude store is handled as an empty result.
  }
  return results;
}

async function withStats(paths, limit) {
  const entries = await Promise.all(
    paths.map(async (filePath) => {
      try {
        return { filePath, fileStat: await stat(filePath) };
      } catch {
        return null;
      }
    }),
  );

  return entries
    .filter(Boolean)
    .sort((a, b) => b.fileStat.mtimeMs - a.fileStat.mtimeMs)
    .slice(0, limit);
}

async function readJsonlPrefix(filePath, maxBytes) {
  let fileHandle;
  try {
    fileHandle = await open(filePath, "r");
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await fileHandle.read(buffer, 0, maxBytes, 0);
    const lines = buffer.subarray(0, bytesRead).toString("utf8").split(/\r?\n/);
    if (bytesRead === maxBytes) lines.pop();
    return lines.flatMap((line) => {
      if (!line.trim()) return [];
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  } finally {
    await fileHandle?.close();
  }
}

async function readJsonlTail(filePath, fileSize, maxBytes) {
  let fileHandle;
  try {
    fileHandle = await open(filePath, "r");
    const start = Math.max(0, fileSize - maxBytes);
    const buffer = Buffer.alloc(Math.min(maxBytes, fileSize));
    const { bytesRead } = await fileHandle.read(buffer, 0, buffer.length, start);
    const lines = buffer.subarray(0, bytesRead).toString("utf8").split(/\r?\n/);
    if (start > 0) lines.shift();
    return lines.flatMap((line) => {
      if (!line.trim()) return [];
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  } finally {
    await fileHandle?.close();
  }
}

function isPathInside(basePath, candidatePath) {
  const pathFromRoot = relative(basePath, candidatePath);
  return pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot));
}

function isInsideScanRoot(cwd) {
  return Boolean(cwd && typeof cwd === "string" && isPathInside(scanRoot, resolve(cwd)));
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => (typeof item === "string" ? item : item?.text || item?.input_text || ""))
    .filter(Boolean)
    .join(" ");
}

function cleanText(value, maxLength = 240) {
  const text = String(value || "")
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1).trimEnd()}…`;
}

function isUsefulPrompt(value) {
  const text = String(value || "").trim();
  if (!text || text.length > 12_000) return false;
  return !(
    text.startsWith("<environment_context>") ||
    text.startsWith("<permissions instructions>") ||
    text.startsWith("<collaboration_mode>") ||
    text.startsWith("Caveat: The messages below were generated by the user while running local commands") ||
    text.includes("# AGENTS.md instructions")
  );
}

function titleFrom(value, fallback) {
  const cleaned = cleanText(value, 160);
  if (!cleaned) return fallback;
  const firstLine = cleaned.split(/[.!?]\s/)[0];
  return cleanText(firstLine, 72) || fallback;
}

function dateOnly(date) {
  return date.toISOString().slice(0, 10);
}

async function parseCodexSession(candidate) {
  const prefixBytes = 1_250_000;
  const records = await readJsonlPrefix(candidate.filePath, prefixBytes);
  const metadata = records.find((record) => record.type === "session_meta")?.payload;
  if (!metadata?.id || !isInsideScanRoot(metadata.cwd)) return null;

  const tailRecords = candidate.fileStat.size > prefixBytes
    ? await readJsonlTail(candidate.filePath, candidate.fileStat.size, 640_000)
    : records;
  const latestTurnContext = [...records, ...tailRecords]
    .reverse()
    .find((record) => record.type === "turn_context")?.payload;
  const latestTokenInfo = [...records, ...tailRecords]
    .reverse()
    .find((record) => record.type === "event_msg" && record.payload?.type === "token_count" && record.payload?.info)
    ?.payload?.info;
  const latestUsage = latestTokenInfo?.last_token_usage;

  const prompts = records
    .filter((record) => record.type === "response_item" && record.payload?.role === "user")
    .map((record) => contentText(record.payload?.content))
    .filter(isUsefulPrompt);
  const firstPrompt = prompts[0] || "";
  const fallbackTitle = basename(metadata.cwd) || "Codex session";

  return {
    agent: "codex",
    sessionId: metadata.id,
    title: titleFrom(firstPrompt, fallbackTitle),
    about: cleanText(firstPrompt, 240) || `Codex work in ${metadata.cwd}`,
    folder: metadata.cwd,
    updatedAt: dateOnly(candidate.fileStat.mtime),
    activityAt: candidate.fileStat.mtime.toISOString(),
    metadata: {
      model: latestTurnContext?.model,
      effort: latestTurnContext?.effort,
      turns: candidate.fileStat.size <= prefixBytes
        ? records.filter((record) => record.type === "event_msg" && record.payload?.type === "user_message").length
        : undefined,
      logBytes: candidate.fileStat.size,
      contextTokens: latestUsage?.total_tokens,
      contextWindow: latestTokenInfo?.model_context_window || metadata.context_window,
    },
  };
}

async function parseClaudeSession(candidate) {
  const prefixBytes = 420_000;
  const records = await readJsonlPrefix(candidate.filePath, prefixBytes);
  const firstUser = records.find((record) => record.type === "user" && record.cwd);
  const cwd = firstUser?.cwd;
  if (!isInsideScanRoot(cwd)) return null;

  const sessionId =
    firstUser?.sessionId ||
    records.find((record) => record.sessionId)?.sessionId ||
    basename(candidate.filePath, ".jsonl");
  if (!sessionId) return null;

  const tailRecords = candidate.fileStat.size > prefixBytes
    ? await readJsonlTail(candidate.filePath, candidate.fileStat.size, 640_000)
    : [];
  const recentRecords = [...records, ...tailRecords];
  const aiTitle = [...recentRecords].reverse().find((record) => record.type === "ai-title")?.aiTitle;
  const lastPrompt = [...recentRecords].reverse().find((record) => record.type === "last-prompt")?.lastPrompt;
  const firstPrompt = records
    .filter((record) => record.type === "user")
    .map((record) => contentText(record.message?.content))
    .find(isUsefulPrompt);
  const fallbackTitle = basename(cwd) || "Claude session";
  const latestAssistant = [...recentRecords]
    .reverse()
    .find((record) => record.type === "assistant" && record.message);
  const latestRecordedCwd = [...recentRecords]
    .reverse()
    .find((record) => record.cwd);
  const latestMessageCount = [...recentRecords]
    .reverse()
    .find((record) => record.type === "system" && Number.isFinite(record.messageCount))
    ?.messageCount;
  const usage = latestAssistant?.message?.usage;
  const contextTokens = usage
    ? Number(usage.input_tokens || 0) +
      Number(usage.cache_creation_input_tokens || 0) +
      Number(usage.cache_read_input_tokens || 0)
    : undefined;
  const exactTurns = candidate.fileStat.size <= prefixBytes
    ? records.filter((record) => {
      if (record.type !== "user") return false;
      const content = record.message?.content;
      return typeof content === "string" || (Array.isArray(content) && content.some((item) => item?.type === "text"));
    }).length
    : undefined;

  return {
    agent: "claude",
    sessionId,
    title:
      cleanText(isUsefulPrompt(aiTitle) ? aiTitle : "", 72) ||
      titleFrom(firstPrompt || lastPrompt, fallbackTitle),
    about:
      cleanText(lastPrompt || firstPrompt, 240) ||
      `Claude Code work in ${cwd}`,
    folder: cwd,
    updatedAt: dateOnly(candidate.fileStat.mtime),
    activityAt: candidate.fileStat.mtime.toISOString(),
    metadata: {
      model: latestAssistant?.message?.model,
      effort: latestAssistant?.effort,
      branch: latestRecordedCwd?.gitBranch,
      turns: exactTurns,
      messages: exactTurns === undefined ? latestMessageCount : undefined,
      logBytes: candidate.fileStat.size,
      contextTokens,
    },
  };
}

async function scanSessions(limit) {
  const [codexFiles, claudeFiles] = await Promise.all([
    listJsonlRecursive(join(codexStore, "sessions")),
    listClaudeProjectSessions(join(claudeStore, "projects")),
  ]);
  const [codexCandidates, claudeCandidates] = await Promise.all([
    withStats(codexFiles, Math.max(120, limit)),
    withStats(claudeFiles, Math.max(180, limit)),
  ]);
  const [codexSessions, claudeSessions] = await Promise.all([
    Promise.all(codexCandidates.map(parseCodexSession)),
    Promise.all(claudeCandidates.map(parseClaudeSession)),
  ]);

  const unique = new Map();
  for (const session of [...codexSessions, ...claudeSessions].filter(Boolean)) {
    const key = `${session.agent}:${session.sessionId}`;
    const current = unique.get(key);
    if (!current || session.activityAt > current.activityAt) unique.set(key, session);
  }

  return [...unique.values()]
    .sort((a, b) => b.activityAt.localeCompare(a.activityAt))
    .slice(0, limit);
}

let sessionLookupCache = null;
let sessionLookupCachedAt = 0;
let sessionLookupInFlight = null;

function getCachedLookupSessions() {
  if (sessionLookupCache && Date.now() - sessionLookupCachedAt < 15_000) {
    return Promise.resolve(sessionLookupCache);
  }
  sessionLookupInFlight ||= scanSessions(lookupLimit)
    .then((sessions) => {
      sessionLookupCache = sessions;
      sessionLookupCachedAt = Date.now();
      return sessions;
    })
    .finally(() => { sessionLookupInFlight = null; });
  return sessionLookupInFlight;
}

function runProbe(command, args, timeoutMs = 1_500) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let output = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.length > 1_000_000) child.kill();
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (timedOut || code !== 0 || output.length > 1_000_000) {
        reject(new Error("Process check failed."));
        return;
      }
      resolve(output);
    });
  });
}

async function probeRunningAgents() {
  const checkedAt = new Date().toISOString();
  try {
    if (process.platform === "win32") {
      const script = "Get-CimInstance Win32_Process -Filter \"Name='claude.exe' or Name='codex.exe'\" | Select-Object Name,CommandLine | ConvertTo-Json -Compress";
      const output = await runProbe("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
      const parsed = output.trim() ? JSON.parse(output) : [];
      const { claude, codex } = countWindowsAgentProcesses(parsed);
      return { available: true, claude, codex, checkedAt };
    }

    if (["darwin", "linux"].includes(process.platform)) {
      const output = await runProbe("ps", ["-eo", "args="]);
      const serverPath = resolve(process.argv[1] || "");
      const { claude, codex } = countPosixAgentProcesses(output.split(/\r?\n/), serverPath);
      return { available: true, claude, codex, checkedAt };
    }
  } catch {
    // Process enumeration is a sanity check, not a prerequisite for the app.
  }
  return { available: false, claude: null, codex: null, checkedAt };
}

let runningAgentsCache = null;
let runningAgentsCachedAt = 0;
let runningAgentsInFlight = null;

function getRunningAgents() {
  if (runningAgentsCache && Date.now() - runningAgentsCachedAt < 5_000) {
    return Promise.resolve(runningAgentsCache);
  }
  runningAgentsInFlight ||= probeRunningAgents()
    .then((result) => {
      runningAgentsCache = result;
      runningAgentsCachedAt = Date.now();
      return result;
    })
    .finally(() => { runningAgentsInFlight = null; });
  return runningAgentsInFlight;
}

const visibleWindowsScript = [
  "$ErrorActionPreference = 'Stop'",
  "try {",
  "  $utf8Encoding = New-Object System.Text.UTF8Encoding",
  "  [Console]::OutputEncoding = $utf8Encoding",
  "  $OutputEncoding = $utf8Encoding",
  "  Add-Type -TypeDefinition @'",
  "using System;",
  "using System.Collections.Generic;",
  "using System.Runtime.InteropServices;",
  "using System.Text;",
  "",
  "public static class SessionIndexNativeWindowProbeV5",
  "{",
  "    public sealed class WindowInfo",
  "    {",
  "        public uint Pid { get; set; }",
  "        public string Title { get; set; }",
  "    }",
  "",
  "    private delegate bool EnumWindowCallback(IntPtr h, IntPtr l);",
  "",
  "    [DllImport(\"user32.dll\")]",
  "    [return: MarshalAs(UnmanagedType.Bool)]",
  "    private static extern bool EnumWindows(EnumWindowCallback callback, IntPtr extraData);",
  "",
  "    [DllImport(\"user32.dll\")]",
  "    [return: MarshalAs(UnmanagedType.Bool)]",
  "    private static extern bool IsWindowVisible(IntPtr h);",
  "",
  "    [DllImport(\"user32.dll\", CharSet = CharSet.Unicode, SetLastError = true)]",
  "    private static extern int GetWindowTextW(IntPtr h, StringBuilder title, int maxCount);",
  "",
  "    [DllImport(\"user32.dll\", SetLastError = true)]",
  "    private static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);",
  "",
  "    public static WindowInfo[] GetVisibleWindows(uint[] terminalPids)",
  "    {",
  "        List<WindowInfo> windows = new List<WindowInfo>();",
  "        HashSet<uint> terminalPidSet = new HashSet<uint>(terminalPids ?? new uint[0]);",
  "        EnumWindows(delegate(IntPtr h, IntPtr l) {",
  "            if (!IsWindowVisible(h)) return true;",
  "            uint pid;",
  "            GetWindowThreadProcessId(h, out pid);",
  "            if (!terminalPidSet.Contains(pid)) return true;",
  "            StringBuilder title = new StringBuilder(32768);",
  "            if (GetWindowTextW(h, title, title.Capacity) <= 0) return true;",
  "            string text = title.ToString();",
  "            if (String.IsNullOrWhiteSpace(text)) return true;",
  "            windows.Add(new WindowInfo { Pid = pid, Title = text });",
  "            return true;",
  "        }, IntPtr.Zero);",
  "        return windows.ToArray();",
  "    }",
  "}",
  "'@",
  "  $terminalHosts = @('WindowsTerminal', 'OpenConsole', 'conhost', 'cmd', 'powershell', 'pwsh', 'wt', 'alacritty', 'WezTerm', 'wezterm-gui', 'Hyper', 'mintty', 'Tabby', 'ConEmu', 'ConEmu64')",
  "  $terminalProcesses = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $terminalHosts -contains $_.ProcessName })",
  "  $processNames = @{}",
  "  $terminalProcesses | ForEach-Object { $processNames[[int]$_.Id] = $_.ProcessName }",
  "  $terminalPids = [uint32[]]@($terminalProcesses | ForEach-Object { [uint32]$_.Id })",
  "  $windows = @([SessionIndexNativeWindowProbeV5]::GetVisibleWindows($terminalPids) | ForEach-Object {",
  "    [PSCustomObject]@{ Pid = [int]$_.Pid; Title = $_.Title; ProcessName = $processNames[[int]$_.Pid] }",
  "  })",
  "  [PSCustomObject]@{ ok = $true; windows = $windows } | ConvertTo-Json -Compress -Depth 3",
  "} catch {",
  "  [Console]::Error.WriteLine([string]$_.Exception.Message)",
  "  exit 1",
  "}",
].join("\n");

async function probeVisibleWindows() {
  const checkedAt = new Date().toISOString();
  if (process.platform !== "win32") {
    return { available: false, windows: [], checkedAt };
  }

  try {
    const output = await runProbe(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", visibleWindowsScript],
      8_000,
    );
    return { ...parseVisibleWindowsProbeOutput(output), checkedAt };
  } catch {
    // Open-window detection is optional and must never prevent the app from loading.
    return { available: false, windows: [], checkedAt };
  }
}

let visibleWindowsCache = null;
let visibleWindowsCachedAt = 0;
let visibleWindowsInFlight = null;

function getVisibleWindows() {
  if (visibleWindowsCache && Date.now() - visibleWindowsCachedAt < 20_000) {
    return Promise.resolve(visibleWindowsCache);
  }
  visibleWindowsInFlight ||= probeVisibleWindows()
    .then((result) => {
      visibleWindowsCache = result;
      visibleWindowsCachedAt = Date.now();
      return result;
    })
    .finally(() => { visibleWindowsInFlight = null; });
  return visibleWindowsInFlight;
}

async function getWindowSessionOverview() {
  const result = await getVisibleWindows();
  const windowCount = Array.isArray(result.windows) ? result.windows.length : 0;
  if (!result.available) {
    return {
      available: false,
      matched: [],
      unidentified: [],
      ignoredCount: 0,
      windowCount,
      checkedAt: result.checkedAt,
    };
  }

  try {
    const sessions = await getCachedLookupSessions();
    const matching = matchWindowsToSessions(result.windows, sessions);
    const sessionsByKey = new Map(
      sessions.map((session) => [session.agent + ":" + session.sessionId, session]),
    );
    return {
      available: true,
      matched: matching.matched.map((match) => {
        const session = sessionsByKey.get(match.agent + ":" + match.sessionId);
        return {
          ...match,
          folder: session?.folder || "",
          activityAt: session?.activityAt || "",
        };
      }),
      unidentified: matching.unidentified,
      ignoredCount: matching.ignored.length,
      windowCount,
      checkedAt: result.checkedAt,
    };
  } catch {
    // A failed session scan should not turn this best-effort endpoint into an error.
    const matching = matchWindowsToSessions(result.windows, []);
    return {
      available: true,
      matched: [],
      unidentified: matching.unidentified,
      ignoredCount: matching.ignored.length,
      windowCount,
      checkedAt: result.checkedAt,
    };
  }
}

function readJsonBody(request, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("Request body is too large."));
        request.resume();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (size > maxBytes) return;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("Request body must be valid JSON."));
      }
    });
    request.on("error", reject);
  });
}

function tokenMatches(value) {
  const supplied = Buffer.from(String(value || ""));
  const expected = Buffer.from(launchToken);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function spawnDetached(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      detached: true,
      shell: false,
      stdio: "ignore",
    });
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
    child.once("error", reject);
  });
}

function shellSingleQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

async function launchTerminal(folder, command) {
  if (process.platform === "win32") {
    try {
      await spawnDetached("wt.exe", ["-w", "0", "nt", "-d", folder, "powershell.exe", "-NoLogo", "-NoExit", "-Command", command]);
      return "windows-terminal";
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await spawnDetached("powershell.exe", ["-NoLogo", "-NoExit", "-Command", command], {
      cwd: folder,
      windowsHide: false,
    });
    return "powershell";
  }

  if (process.platform === "darwin") {
    const terminalCommand = `cd ${shellSingleQuote(folder)} && ${command}`
      .replaceAll("\\", "\\\\")
      .replaceAll('"', '\\"');
    await spawnDetached("osascript", [
      "-e", `tell application \"Terminal\" to do script \"${terminalCommand}\"`,
      "-e", "tell application \"Terminal\" to activate",
    ]);
    return "terminal.app";
  }

  if (process.platform === "linux") {
    const attempts = [
      ["gnome-terminal", [`--working-directory=${folder}`, "--", "bash", "-lc", `${command}; exec bash`]],
      ["konsole", ["--workdir", folder, "-e", "bash", "-lc", `${command}; exec bash`]],
      ["xfce4-terminal", [`--working-directory=${folder}`, "-e", `bash -lc \"${command}; exec bash\"`]],
      ["x-terminal-emulator", ["-e", "bash", "-lc", `${command}; exec bash`]],
      ["xterm", ["-e", "bash", "-lc", `${command}; exec bash`]],
    ];
    for (const [terminal, args] of attempts) {
      try {
        await spawnDetached(terminal, args, { cwd: folder });
        return terminal;
      } catch {
        // Desktop environments expose different terminal launchers.
      }
    }
    throw new Error("No supported terminal emulator was found.");
  }

  throw new Error("No supported terminal emulator was found.");
}

// Local-machine probe only (127.0.0.1 Ollama). Never a network request.
async function probeOllama() {
  const get = async (path) => {
    const response = await fetch(`${ollamaBase}${path}`, { signal: AbortSignal.timeout(600) });
    if (!response.ok) throw new Error(`Ollama ${path} ${response.status}`);
    return response.json();
  };
  try {
    const [tags, ps] = await Promise.all([get("/api/tags"), get("/api/ps")]);
    return {
      available: true,
      models: (tags.models || []).map((model) => ({
        name: model.name,
        sizeGb: model.size ? Number((model.size / 1e9).toFixed(1)) : null,
      })),
      running: (ps.models || []).map((model) => model.name),
    };
  } catch {
    return { available: false, models: [], running: [] };
  }
}

let usageInFlight = null;

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    ...securityHeaders,
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

function requestIsLocal(request, requireOrigin = false) {
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const allowedOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
  const requestHost = request.headers.host || "";
  const requestOrigin = request.headers.origin;
  return allowedHosts.has(requestHost) && (requireOrigin ? allowedOrigins.has(requestOrigin) : (!requestOrigin || allowedOrigins.has(requestOrigin)));
}

createServer(async (request, response) => {
  const url = new URL(request.url, `http://${host}`);
  const isLaunchPost = request.method === "POST" && url.pathname === "/api/launch";

  if (request.method !== "GET" && !isLaunchPost) {
    if (!requestIsLocal(request)) {
      sendJson(response, 403, { error: "Local requests only." });
      return;
    }
    response.writeHead(405, { ...securityHeaders, Allow: "GET" }).end("Method not allowed");
    return;
  }

  if (!requestIsLocal(request, isLaunchPost)) {
    sendJson(response, 403, { error: "Local requests only." });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/health") {
    sendJson(response, 200, healthPayload);
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/config") {
    sendJson(response, 200, {
      scanRoot,
      scanLimit,
      lookupLimit,
      launchToken,
      launchMode,
      platform: process.platform,
      stores: {
        codex: join(codexStore, "sessions"),
        claude: join(claudeStore, "projects"),
      },
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/agents/running") {
    sendJson(response, 200, await getRunningAgents());
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/windows") {
    sendJson(response, 200, await getWindowSessionOverview());
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/sessions/scan") {
    try {
      const sessions = await scanSessions(scanLimit);
      sendJson(response, 200, {
        root: scanRoot,
        sessions,
        scannedAt: new Date().toISOString(),
      });
    } catch (error) {
      console.error("Session scan failed", error);
      sendJson(response, 500, { error: "Could not scan the local agent session stores." });
    }
    return;
  }

  if (isLaunchPost) {
    if (launchMode === "off") {
      sendJson(response, 403, { error: "Launching is disabled (SESSION_LAUNCH=off)." });
      return;
    }
    if (!tokenMatches(request.headers["x-session-index-token"])) {
      sendJson(response, 403, { error: "Invalid launch token." });
      return;
    }

    let body;
    try {
      body = await readJsonBody(request, 4_096);
    } catch (error) {
      sendJson(response, 400, { error: error.message });
      return;
    }
    if (!body || !["codex", "claude"].includes(body.agent)) {
      sendJson(response, 400, { error: "Invalid agent." });
      return;
    }
    if (typeof body.sessionId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{5,127}$/.test(body.sessionId)) {
      sendJson(response, 400, { error: "Invalid session id." });
      return;
    }

    let sessions;
    try {
      sessions = await getCachedLookupSessions();
    } catch (error) {
      console.error("Session scan failed", error);
      sendJson(response, 500, { error: "Could not scan the local agent session stores." });
      return;
    }
    const session = sessions.find((item) => item.agent === body.agent && item.sessionId === body.sessionId);
    if (!session) {
      sendJson(response, 404, {
        error: "That session could not be found. Its session log may have been deleted, or its recorded folder may be outside SESSION_SCAN_ROOT.",
      });
      return;
    }

    let folderIsSafe = false;
    try {
      folderIsSafe = isInsideScanRoot(session.folder) && (await stat(session.folder)).isDirectory();
    } catch {
      folderIsSafe = false;
    }
    const command = session.agent === "codex"
      ? `codex resume ${session.sessionId}`
      : `claude --resume ${session.sessionId}`;
    if (!folderIsSafe) {
      sendJson(response, 409, { error: "The session folder is unavailable or outside the scan root.", command, folder: session.folder });
      return;
    }
    if (launchMode === "dry-run") {
      sendJson(response, 200, { ok: true, launcher: "dry-run", command, folder: session.folder });
      return;
    }

    try {
      const launcher = await launchTerminal(session.folder, command);
      sendJson(response, 200, { ok: true, launcher, command, folder: session.folder });
    } catch (error) {
      sendJson(response, 501, {
        ok: false,
        reason: error?.message || "No supported terminal emulator was found.",
        command,
        folder: session.folder,
      });
    }
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/usage") {
    try {
      const days = Math.min(30, Math.max(1, Number(url.searchParams.get("days")) || 7));
      // Concurrent requests share one scan; the incremental cache makes
      // follow-up scans cheap, but the first one reads the recent stores.
      usageInFlight ||= usageScanner
        .scan(days)
        .finally(() => { usageInFlight = null; });
      const [usage, ollama] = await Promise.all([usageInFlight, probeOllama()]);
      sendJson(response, 200, { ...usage, ollama });
    } catch (error) {
      console.error("Usage scan failed", error);
      sendJson(response, 500, { error: "Could not compute engine utilization." });
    }
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    response.writeHead(400, securityHeaders).end("Bad request");
    return;
  }
  const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const filePath = normalize(join(root, relativePath));

  if (!isPathInside(root, filePath)) {
    response.writeHead(403, securityHeaders).end("Forbidden");
    return;
  }

  try {
    if (!statSync(filePath).isFile()) throw new Error("Not a file");
    response.writeHead(200, {
      ...securityHeaders,
      "Content-Type": mimeTypes[extname(filePath)] || "application/octet-stream",
    });
    createReadStream(filePath).pipe(response);
  } catch {
    response.writeHead(404, securityHeaders).end("Not found");
  }
}).listen(port, host, () => {
  console.log(`Session Index available at http://${host}:${port}`);
  console.log(`Session scan root: ${scanRoot}`);
  // Warm the larger lookup scan without delaying listen. Window matching and
  // launching can then share the existing short-lived cache.
  void getCachedLookupSessions().catch(() => {});
});
