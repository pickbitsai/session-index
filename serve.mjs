import { createReadStream, statSync } from "node:fs";
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

const host = "127.0.0.1";
const port = Number(process.env.PORT || 4173);
const root = process.cwd();
const profileRoot = process.env.USERPROFILE || homedir();
const defaultScanRoot = process.platform === "win32" ? "C:\\new" : join(homedir(), "new");
const scanRoot = resolve(process.env.SESSION_SCAN_ROOT || defaultScanRoot);
const scanLimit = Math.min(250, Math.max(1, Number(process.env.SESSION_SCAN_LIMIT || 80)));
const codexStore = process.env.CODEX_HOME || join(profileRoot, ".codex");
const claudeStore = process.env.CLAUDE_CONFIG_DIR || join(profileRoot, ".claude");
const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
};
const securityHeaders = {
  "Content-Security-Policy": "default-src 'self'; base-uri 'none'; connect-src 'self'; font-src 'self'; form-action 'none'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

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

async function scanSessions() {
  const [codexFiles, claudeFiles] = await Promise.all([
    listJsonlRecursive(join(codexStore, "sessions")),
    listClaudeProjectSessions(join(claudeStore, "projects")),
  ]);
  const [codexCandidates, claudeCandidates] = await Promise.all([
    withStats(codexFiles, 120),
    withStats(claudeFiles, 180),
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
    .slice(0, scanLimit);
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    ...securityHeaders,
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

function requestIsLocal(request) {
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const allowedOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
  const requestHost = request.headers.host || "";
  const requestOrigin = request.headers.origin;
  return allowedHosts.has(requestHost) && (!requestOrigin || allowedOrigins.has(requestOrigin));
}

createServer(async (request, response) => {
  if (!requestIsLocal(request)) {
    sendJson(response, 403, { error: "Local requests only." });
    return;
  }

  if (request.method !== "GET") {
    response.writeHead(405, { ...securityHeaders, Allow: "GET" }).end("Method not allowed");
    return;
  }

  const url = new URL(request.url, `http://${host}`);

  if (request.method === "GET" && url.pathname === "/api/health") {
    sendJson(response, 200, { ok: true });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/config") {
    sendJson(response, 200, {
      scanRoot,
      scanLimit,
      stores: {
        codex: join(codexStore, "sessions"),
        claude: join(claudeStore, "projects"),
      },
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/sessions/scan") {
    try {
      const sessions = await scanSessions();
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
});
