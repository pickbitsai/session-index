function timestamp(value) {
  return typeof value === "string" ? Date.parse(value) : NaN;
}

function isCount(value) {
  return Number.isInteger(value) && value >= 0;
}

function sessionKey(session) {
  return `${session.agent}:${session.sessionId}`;
}

export function sessionIdsFromLockNames(names) {
  const ids = new Set();
  for (const name of names) {
    if (typeof name !== "string" || name.startsWith(".") || !name.endsWith(".lock")) continue;
    const id = name.slice(0, -".lock".length);
    if (/^[A-Za-z0-9][A-Za-z0-9._-]{5,127}$/.test(id) && !/\s/.test(id)) ids.add(id);
  }
  return [...ids];
}

export function buildLiveSnapshot({ matched, unidentifiedCount, lockCount = 0, processCounts, now, bootAt }) {
  return {
    version: 1,
    savedAt: new Date(now).toISOString(),
    bootAt,
    sessions: matched.map(({ agent, sessionId, title, folder, activityAt }) => ({
      agent, sessionId, title, folder, activityAt,
    })),
    unidentifiedCount,
    lockCount,
    processCounts: { claude: processCounts.claude, codex: processCounts.codex },
  };
}

export function parseLiveSnapshot(text) {
  try {
    if (typeof text !== "string" || !text.trim()) return null;
    const snapshot = JSON.parse(text);
    if (
      !snapshot || snapshot.version !== 1 ||
      !Number.isFinite(timestamp(snapshot.savedAt)) ||
      !Number.isFinite(timestamp(snapshot.bootAt)) ||
      !Array.isArray(snapshot.sessions) ||
      !snapshot.sessions.every((session) => (
        session && ["claude", "codex"].includes(session.agent) &&
        typeof session.sessionId === "string" && session.sessionId.length > 0 &&
        typeof session.title === "string" && typeof session.folder === "string" &&
        Number.isFinite(timestamp(session.activityAt))
      )) ||
      !isCount(snapshot.unidentifiedCount) ||
      (Object.hasOwn(snapshot, "lockCount") && !isCount(snapshot.lockCount)) || !snapshot.processCounts ||
      ![snapshot.processCounts.claude, snapshot.processCounts.codex]
        .every((count) => count === null || isCount(count))
    ) return null;
    return snapshot;
  } catch {
    return null;
  }
}

export function snapshotIsPreBoot(snapshot, { bootTimeMs, shutdownTimeMs, maxAgeMs = 600_000 }) {
  const savedTimeMs = timestamp(snapshot?.savedAt);
  const referenceTimeMs = Number.isFinite(shutdownTimeMs) ? shutdownTimeMs : bootTimeMs;
  return Number.isFinite(bootTimeMs) && Number.isFinite(savedTimeMs) &&
    Number.isFinite(maxAgeMs) && maxAgeMs >= 0 &&
    savedTimeMs < bootTimeMs && savedTimeMs <= referenceTimeMs &&
    referenceTimeMs - savedTimeMs <= maxAgeMs;
}

export function mergeRestartDetection(detection, snapshot, options) {
  if (!snapshotIsPreBoot(snapshot, options)) {
    return {
      ...detection,
      clusterSize: detection.clusterSize ?? detection.sessions.length,
      sources: { cluster: detection.sessions.length, snapshot: 0 },
    };
  }

  const merged = new Map();
  for (const session of detection.sessions) {
    if (!merged.has(sessionKey(session))) {
      merged.set(sessionKey(session), { ...session, source: "activity" });
    }
  }
  const cluster = merged.size;
  const currentSessions = new Map(options.sessions.map((session) => [sessionKey(session), session]));
  const additions = new Map();
  for (const saved of snapshot.sessions) {
    const key = sessionKey(saved);
    const current = currentSessions.get(key);
    // Use the fresh log, including its title and folder, rather than stale snapshot fields.
    if (!current || !(timestamp(current.activityAt) < options.bootTimeMs) || merged.has(key)) continue;
    additions.set(key, { ...current, source: "snapshot" });
  }
  const sessions = [...merged.values(), ...[...additions.values()]
    .sort((left, right) => timestamp(right.activityAt) - timestamp(left.activityAt))];
  return {
    ...detection,
    sessions,
    clusterSize: sessions.length,
    sources: { cluster, snapshot: additions.size },
    confidence: additions.size ? "high" : detection.confidence,
    interruptedAt: additions.size
      ? Number.isFinite(options.shutdownTimeMs)
        ? new Date(options.shutdownTimeMs).toISOString()
        : detection.interruptedAt || snapshot.savedAt
      : detection.interruptedAt,
  };
}
