const LEADING_NON_ALPHANUMERIC = /^[^\p{L}\p{N}]+/u;
const STARTS_WITH_PATH = /^(?:[A-Za-z]:[\\/]|[\\/])/u;
const BARE_EXECUTABLE_PATH = /[\\/].*\.exe$/i;

function windowTitle(windowInfo) {
  if (typeof windowInfo === "string") return windowInfo;
  return typeof windowInfo?.title === "string" ? windowInfo.title : "";
}

function newestFirst(left, right) {
  const leftTime = Date.parse(left?.activityAt || left?.updatedAt || "") || 0;
  const rightTime = Date.parse(right?.activityAt || right?.updatedAt || "") || 0;
  return rightTime - leftTime;
}

function folderLeaf(folder) {
  return String(folder || "").split(/[\\/]/).filter(Boolean).pop() || "";
}

function trimFolderTitle(value) {
  return String(value || "").replace(/[-\s]+$/u, "");
}

function prefixMatches(left, right) {
  if (!left || !right) return false;
  const sharedLength = Math.min(left.length, right.length);
  return sharedLength >= 20 && (left.startsWith(right) || right.startsWith(left));
}

function pickNewest(sessions) {
  return [...sessions].sort(newestFirst)[0];
}

function sessionKey(session) {
  return `${session?.agent}:${session?.sessionId}`;
}

function isWindowAssignment(assignment) {
  return (
    assignment &&
    ["claude", "codex"].includes(assignment.agent) &&
    typeof assignment.sessionId === "string" &&
    assignment.sessionId
  );
}

export function parseVisibleWindowsProbeOutput(output) {
  const unavailable = { available: false, windows: [] };
  if (typeof output !== "string" || !output.trim()) return unavailable;

  let envelope;
  try {
    envelope = JSON.parse(output);
  } catch {
    return unavailable;
  }

  if (envelope?.ok !== true || !Array.isArray(envelope.windows)) return unavailable;

  const windows = envelope.windows
    .filter((entry) => typeof entry?.Title === "string" && entry.Title.trim())
    .map((entry) => ({
      title: entry.Title,
      processName: typeof entry.ProcessName === "string" ? entry.ProcessName : "",
      pid: Number(entry.Pid) || 0,
    }));
  return { available: true, windows };
}

export function normalizeWindowTitle(title) {
  const normalized = String(title || "").trim();
  if (!normalized || STARTS_WITH_PATH.test(normalized)) return normalized;

  const stripped = normalized.replace(LEADING_NON_ALPHANUMERIC, "").trim();
  return stripped.length >= 3 ? stripped : normalized;
}

export function getAssignableSessions(sessions, matchedWindows) {
  const usedSessions = new Set(
    (Array.isArray(matchedWindows) ? matchedWindows : [])
      .filter((entry) => entry?.agent && entry?.sessionId)
      .map(sessionKey),
  );

  return (Array.isArray(sessions) ? sessions : [])
    .filter((session) => (
      ["claude", "codex"].includes(session?.agent) &&
      typeof session?.sessionId === "string" &&
      session.sessionId &&
      !usedSessions.has(sessionKey(session))
    ))
    .sort(newestFirst);
}

export function applyWindowMap(windowOverview, sessions, windowMap) {
  const overview = windowOverview && typeof windowOverview === "object" ? windowOverview : {};
  const sessionEntries = Array.isArray(sessions) ? sessions : [];
  const assignments = windowMap && typeof windowMap === "object" && !Array.isArray(windowMap)
    ? windowMap
    : {};
  const matched = Array.isArray(overview.matched) ? [...overview.matched] : [];
  const usedSessions = new Set(
    matched
      .filter((entry) => entry?.agent && entry?.sessionId)
      .map(sessionKey),
  );
  const sessionsByKey = new Map(
    sessionEntries
      .filter((session) => session?.agent && session?.sessionId)
      .map((session) => [sessionKey(session), session]),
  );
  const unidentified = [];
  const assignmentIssues = [];

  for (const windowTitle of Array.isArray(overview.unidentified) ? overview.unidentified : []) {
    const normalizedTitle = normalizeWindowTitle(windowTitle);
    const assignment = Object.prototype.hasOwnProperty.call(assignments, normalizedTitle)
      ? assignments[normalizedTitle]
      : null;
    if (!isWindowAssignment(assignment)) {
      unidentified.push(windowTitle);
      continue;
    }

    const key = sessionKey(assignment);
    const session = sessionsByKey.get(key);
    if (!session) {
      unidentified.push(windowTitle);
      assignmentIssues.push({
        state: "stale",
        windowTitle,
        normalizedTitle,
        assignment,
      });
      continue;
    }
    if (usedSessions.has(key)) {
      unidentified.push(windowTitle);
      assignmentIssues.push({
        state: "conflict",
        windowTitle,
        normalizedTitle,
        assignment,
      });
      continue;
    }

    usedSessions.add(key);
    matched.push({
      agent: session.agent,
      sessionId: session.sessionId,
      title: session.customTitle || session.title,
      folder: session.folder,
      activityAt: session.activityAt || session.updatedAt,
      windowTitle,
      confidence: "manual",
    });
  }

  return {
    ...overview,
    matched,
    unidentified,
    assignmentIssues,
  };
}

export function matchWindowsToSessions(windows, sessions) {
  const windowEntries = Array.isArray(windows) ? windows : [];
  const sessionEntries = Array.isArray(sessions) ? sessions : [];
  const usedSessions = new Set();
  const matched = [];
  const unidentified = [];
  const ignored = [];

  for (const windowInfo of windowEntries) {
    const originalTitle = windowTitle(windowInfo);
    const title = normalizeWindowTitle(originalTitle);

    if (BARE_EXECUTABLE_PATH.test(title)) {
      ignored.push(originalTitle);
      continue;
    }

    if (/^(?:claude|codex|cmd|powershell|pwsh)$/i.test(title)) {
      unidentified.push(originalTitle);
      continue;
    }

    const available = sessionEntries.filter((session) => {
      const key = `${session?.agent}:${session?.sessionId}`;
      return session?.agent && session?.sessionId && !usedSessions.has(key);
    });
    const exactCase = available.filter((session) => title === String(session.title || ""));
    const exactInsensitive = exactCase.length
      ? []
      : available.filter((session) => title.toLocaleLowerCase() === String(session.title || "").toLocaleLowerCase());
    const prefixCase = exactCase.length || exactInsensitive.length
      ? []
      : available.filter((session) => prefixMatches(title, String(session.title || "")));
    const lowerTitle = title.toLocaleLowerCase();
    const prefixInsensitive = exactCase.length || exactInsensitive.length || prefixCase.length
      ? []
      : available.filter((session) => prefixMatches(lowerTitle, String(session.title || "").toLocaleLowerCase()));
    const normalizedFolderTitle = trimFolderTitle(title).toLocaleLowerCase();
    const folderMatches = exactCase.length || exactInsensitive.length || prefixCase.length || prefixInsensitive.length
      ? []
      : available.filter((session) => (
        normalizedFolderTitle &&
        normalizedFolderTitle === trimFolderTitle(folderLeaf(session.folder)).toLocaleLowerCase()
      ));

    const candidates = exactCase.length
      ? exactCase
      : exactInsensitive.length
        ? exactInsensitive
        : prefixCase.length
          ? prefixCase
          : prefixInsensitive.length
            ? prefixInsensitive
            : folderMatches;
    const confidence = exactCase.length || exactInsensitive.length
      ? "exact"
      : prefixCase.length || prefixInsensitive.length
        ? "prefix"
        : folderMatches.length
          ? "folder"
          : null;
    const session = pickNewest(candidates);

    if (!session || !confidence) {
      unidentified.push(originalTitle);
      continue;
    }

    usedSessions.add(`${session.agent}:${session.sessionId}`);
    matched.push({
      agent: session.agent,
      sessionId: session.sessionId,
      title: session.title,
      windowTitle: originalTitle,
      confidence,
    });
  }

  return { matched, unidentified, ignored };
}
