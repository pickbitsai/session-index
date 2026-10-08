import { clusterSessionsByActivity } from "./restart.mjs";

function timestamp(value) {
  return typeof value === "string" ? Date.parse(value) : NaN;
}

function sessionKey(session) {
  return `${session.agent}:${session.sessionId}`;
}

function validSession(session) {
  return session && ["claude", "codex"].includes(session.agent) &&
    typeof session.sessionId === "string" && session.sessionId.length > 0 &&
    typeof session.title === "string" && typeof session.folder === "string" &&
    Number.isFinite(timestamp(session.activityAt));
}

function savedSession({ agent, sessionId, title, folder, activityAt }) {
  return { agent, sessionId, title, folder, activityAt };
}

function validSources(sources) {
  return Array.isArray(sources) && sources.length > 0 &&
    sources.every((source) => ["activity", "snapshot"].includes(source));
}

export function parseClosures(text) {
  try {
    if (typeof text !== "string" || !text.trim()) return null;
    const file = JSON.parse(text);
    if (!file || file.version !== 1 || !Array.isArray(file.closures) ||
      !file.closures.every((closure) => closure &&
        Number.isFinite(timestamp(closure.closedAt)) && validSources(closure.sources) &&
        Array.isArray(closure.sessions) && closure.sessions.every(validSession))) return null;
    return file;
  } catch {
    return null;
  }
}

export function detectClosedTogether(sessions, options) {
  try {
    const { nowMs, bootTimeMs, liveKeys = new Set(), windowMs = 5_000,
      minSessions = 2, settleMs = 30_000, lookbackMs = 86_400_000 } = options;
    if (!Array.isArray(sessions) || !Number.isFinite(nowMs) || !Number.isFinite(bootTimeMs) ||
      ![windowMs, settleMs, lookbackMs].every((value) => Number.isFinite(value) && value >= 0) ||
      !Number.isInteger(minSessions) || minSessions < 1) return [];
    const candidates = new Map();
    for (const session of sessions) {
      if (!validSession(session) || session.metadata?.interactive !== true) continue;
      // Codex logs have no exit marker: a killed TUI's last activity is its last turn, not the close,
      // so Codex activity only clusters by coincidence. detectLiveSetDrop covers Codex instead.
      if (session.agent !== "claude" || session.metadata.exited !== true) continue;
      const time = timestamp(session.activityAt);
      const key = sessionKey(session);
      if (time < bootTimeMs || time > nowMs - settleMs || time < nowMs - lookbackMs || liveKeys.has(key)) continue;
      if (!candidates.has(key) || time > timestamp(candidates.get(key).activityAt)) candidates.set(key, session);
    }
    return clusterSessionsByActivity([...candidates.values()], windowMs)
      .filter((cluster) => cluster.sessions.length >= minSessions)
      .map((cluster) => ({
        closedAt: cluster.at,
        spreadMs: timestamp(cluster.at) - Math.min(...cluster.sessions.map((session) => timestamp(session.activityAt))),
        source: "activity",
        sessions: cluster.sessions.map(savedSession),
      }));
  } catch {
    return [];
  }
}

export function detectLiveSetDrop(previous, current, options = {}) {
  try {
    const { minSessions = 2, sessions = [] } = options;
    if (!previous || !current || !Number.isInteger(minSessions) || minSessions < 1 ||
      previous.windowProbe === "unavailable" || current.windowProbe === "unavailable" ||
      !Number.isFinite(timestamp(previous.bootAt)) || !Number.isFinite(timestamp(current.bootAt)) ||
      Math.abs(timestamp(previous.bootAt) - timestamp(current.bootAt)) > 5_000 ||
      !Number.isFinite(timestamp(current.savedAt)) ||
      !Array.isArray(previous.sessions) || !previous.sessions.every(validSession) ||
      !Array.isArray(current.sessions) || !current.sessions.every(validSession) ||
      !Array.isArray(sessions)) return null;
    const liveKeys = new Set(current.sessions.map(sessionKey));
    const fresh = new Map(sessions.filter(validSession).map((session) => [sessionKey(session), session]));
    const lost = new Map(previous.sessions.filter((session) => !liveKeys.has(sessionKey(session)))
      .map((session) => [sessionKey(session), session]));
    const confirmed = new Set();
    const unconfirmed = new Map();
    for (const [key, session] of lost) {
      const metadata = fresh.get(key)?.metadata;
      if (metadata?.interactive !== true) continue;
      if (session.source === "lock" || metadata.exited === true) {
        confirmed.add(key);
      } else if (session.source === "window") {
        if (!unconfirmed.has(session.agent)) unconfirmed.set(session.agent, []);
        unconfirmed.get(session.agent).push(key);
      }
    }
    for (const [agent, keys] of unconfirmed) {
      const before = previous.processCounts?.[agent];
      const after = current.processCounts?.[agent];
      if (Number.isInteger(before) && Number.isInteger(after) && before - after >= keys.length) {
        for (const key of keys) confirmed.add(key);
      }
    }
    return confirmed.size >= minSessions
      ? { closedAt: current.savedAt, source: "snapshot",
        sessions: [...lost.values()].filter((session) => confirmed.has(sessionKey(session))).map(savedSession) }
      : null;
  } catch {
    return null;
  }
}

export function mergeClosures(stored, detected, options = {}) {
  try {
    const { mergeWindowMs = 120_000, maxClosures = 10, maxAgeMs = 7 * 86_400_000, nowMs } = options;
    if (!Array.isArray(stored) || !Array.isArray(detected) || !Number.isFinite(nowMs) ||
      ![mergeWindowMs, maxAgeMs].every((value) => Number.isFinite(value) && value >= 0) ||
      !Number.isInteger(maxClosures) || maxClosures < 0) return [];
    const ordered = [...stored, ...detected].filter((closure) => closure &&
      Number.isFinite(timestamp(closure.closedAt)) &&
      validSources(closure.sources ?? [closure.source]) &&
      Array.isArray(closure.sessions) && closure.sessions.every(validSession))
      .sort((left, right) => timestamp(left.closedAt) - timestamp(right.closedAt));
    const groups = [];
    for (const closure of ordered) {
      const time = timestamp(closure.closedAt);
      let group = groups.at(-1);
      if (!group || time - group.latestTime > mergeWindowMs) {
        group = { closedAt: closure.closedAt, latestTime: time, sources: new Set(), sessions: new Map() };
        groups.push(group);
      }
      group.latestTime = time;
      for (const source of closure.sources ?? [closure.source]) group.sources.add(source);
      for (const session of closure.sessions) {
        const key = sessionKey(session);
        const saved = group.sessions.get(key);
        if (!saved || timestamp(session.activityAt) >= timestamp(saved.activityAt)) {
          group.sessions.set(key, savedSession(session));
        }
      }
    }
    return groups.filter((group) => timestamp(group.closedAt) >= nowMs - maxAgeMs)
      .reverse().slice(0, maxClosures).map((group) => ({
        closedAt: group.closedAt,
        sources: [...group.sources].sort(),
        sessions: [...group.sessions.values()],
      }));
  } catch {
    return [];
  }
}

export function closureStatus(closure, sessions, liveKeys = new Set()) {
  const current = new Map((Array.isArray(sessions) ? sessions : []).filter(validSession)
    .map((session) => [sessionKey(session), session]));
  const entries = closure.sessions.map((saved) => {
    const key = sessionKey(saved);
    const fresh = current.get(key);
    const resumed = liveKeys.has(key) || timestamp(fresh?.activityAt) > timestamp(closure.closedAt) + 10_000;
    return {
      ...saved,
      title: fresh?.title ?? saved.title,
      folder: fresh?.folder ?? saved.folder,
      status: resumed ? "resumed" : "pending",
    };
  });
  const resumedCount = entries.filter((session) => session.status === "resumed").length;
  return { ...closure, sessions: entries, pendingCount: entries.length - resumedCount, resumedCount };
}
