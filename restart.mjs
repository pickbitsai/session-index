const EMPTY_DETECTION = Object.freeze({
  sessions: [],
  interruptedAt: null,
  confidence: "none",
  clusterSize: 0,
});

const UNAVAILABLE_SHUTDOWN = Object.freeze({
  available: false,
  shutdownTimeMs: null,
  reason: "",
  planned: null,
  initiator: "",
  rebootCount: 0,
});

function activityTime(session) {
  try {
    if (typeof session?.activityAt !== "string" || !session.activityAt.trim()) return null;
    const time = Date.parse(session.activityAt);
    return Number.isFinite(time) ? time : null;
  } catch {
    return null;
  }
}

function nonNegativeNumber(value, fallback) {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function emptyDetection() {
  return { ...EMPTY_DETECTION, sessions: [] };
}

function unavailableShutdown() {
  return { ...UNAVAILABLE_SHUTDOWN };
}

function reasonForShutdown(eventId, initiator) {
  if (eventId === 6008) return "Unexpected shutdown";
  if (eventId === 41) return "Power loss or crash";
  if (eventId !== 1074) return "";

  const normalizedInitiator = initiator.toLowerCase();
  if (/mousocoreworker|usoclient|update orchestrator/u.test(normalizedInitiator)) {
    return "Windows Update";
  }
  if (/trustedinstaller|tiworker/u.test(normalizedInitiator)) {
    return "Windows servicing";
  }

  const processName = initiator.split(/[\\/]/u).filter(Boolean).pop() || "";
  return processName.replace(/\.exe$/iu, "") || "Planned restart";
}

export function clusterSessionsByActivity(sessions, toleranceMs) {
  try {
    const tolerance = nonNegativeNumber(toleranceMs, 0);
    const ordered = (Array.isArray(sessions) ? sessions : [])
      .map((session) => ({ session, time: activityTime(session) }))
      .filter((entry) => entry.time !== null)
      .sort((left, right) => right.time - left.time);
    const clusters = [];

    for (const entry of ordered) {
      const current = clusters.at(-1);
      if (!current || current.newestTime - entry.time > tolerance) {
        clusters.push({
          newestTime: entry.time,
          at: new Date(entry.time).toISOString(),
          sessions: [entry.session],
        });
        continue;
      }
      current.sessions.push(entry.session);
    }

    return clusters.map(({ at, sessions: clusterSessions }) => ({
      at,
      sessions: clusterSessions,
    }));
  } catch {
    return [];
  }
}

export function detectRestartCasualties(sessions, options) {
  try {
    if (!options || typeof options !== "object") return emptyDetection();
    const bootTimeMs = options.bootTimeMs;
    if (!Number.isFinite(bootTimeMs) || Number.isNaN(new Date(bootTimeMs).getTime())) {
      return emptyDetection();
    }

    const lookbackMs = nonNegativeNumber(options.lookbackMs, 1_800_000);
    const toleranceMs = nonNegativeNumber(options.toleranceMs, 90_000);
    const flushWindowMs = nonNegativeNumber(options.flushWindowMs, 180_000);
    const candidates = (Array.isArray(sessions) ? sessions : []).filter((session) => {
      const time = activityTime(session);
      return time !== null && time < bootTimeMs && time >= bootTimeMs - lookbackMs;
    });
    const clusters = clusterSessionsByActivity(candidates, toleranceMs);
    if (!clusters.length) return emptyDetection();

    const shutdownTimeMs = Number.isFinite(options.shutdownTimeMs)
      ? options.shutdownTimeMs
      : null;
    const baselineCluster = clusters[0];
    let winningCluster = baselineCluster;
    let matchedShutdown = false;
    if (shutdownTimeMs !== null) {
      const matchedCluster = clusters
        .map((cluster) => {
          const clusterTimeMs = Date.parse(cluster.at);
          return {
            cluster,
            clusterTimeMs,
            distance: Math.abs(clusterTimeMs - shutdownTimeMs),
          };
        })
        .filter((entry) => (
          entry.clusterTimeMs >= shutdownTimeMs - toleranceMs &&
          entry.clusterTimeMs <= shutdownTimeMs + flushWindowMs
        ))
        .sort((left, right) => left.distance - right.distance)[0]
        ?.cluster;
      winningCluster = matchedCluster || baselineCluster;
      matchedShutdown = Boolean(matchedCluster);
    }

    const times = winningCluster.sessions.map(activityTime).filter((time) => time !== null);
    const spreadMs = Math.max(...times) - Math.min(...times);
    const independentlyHighConfidence = (
      winningCluster.sessions.length >= 2 && spreadMs <= 5_000
    );
    const confidence = matchedShutdown || independentlyHighConfidence ? "high" : "low";

    return {
      sessions: [...winningCluster.sessions],
      interruptedAt: winningCluster.at,
      confidence,
      clusterSize: winningCluster.sessions.length,
    };
  } catch {
    return emptyDetection();
  }
}

export function resolveRestartSequence(events, options = {}) {
  try {
    const gapMs = nonNegativeNumber(options?.gapMs, 900_000);
    const ordered = (Array.isArray(events) ? events : [events])
      .map((event) => ({
        event,
        time: typeof event?.shutdownTime === "string" ? Date.parse(event.shutdownTime) : NaN,
      }))
      .filter(({ event, time }) => (
        event &&
        typeof event === "object" &&
        !Array.isArray(event) &&
        Number.isFinite(time)
      ))
      .sort((left, right) => right.time - left.time);
    if (!ordered.length) return null;

    const sequence = [ordered[0]];
    for (let index = 1; index < ordered.length; index += 1) {
      const previous = sequence.at(-1);
      const current = ordered[index];
      if (previous.time - current.time > gapMs) break;
      sequence.push(current);
    }

    return {
      ...sequence.at(-1).event,
      rebootCount: sequence.length,
    };
  } catch {
    return null;
  }
}

export function parseShutdownProbeOutput(output) {
  if (typeof output !== "string" || !output.trim()) return unavailableShutdown();

  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    return unavailableShutdown();
  }

  const event = resolveRestartSequence(Array.isArray(parsed) ? parsed : [parsed]);
  if (!event || typeof event !== "object" || Array.isArray(event)) return unavailableShutdown();
  if (
    !Object.hasOwn(event, "shutdownTime") ||
    !Object.hasOwn(event, "eventId") ||
    !Object.hasOwn(event, "planned") ||
    !Object.hasOwn(event, "initiator")
  ) return unavailableShutdown();

  const shutdownTimeMs = typeof event.shutdownTime === "string"
    ? Date.parse(event.shutdownTime)
    : NaN;
  const eventId = Number(event.eventId);
  if (
    !Number.isFinite(shutdownTimeMs) ||
    ![41, 1074, 6008].includes(eventId) ||
    typeof event.planned !== "boolean" ||
    (event.initiator !== null && typeof event.initiator !== "string")
  ) return unavailableShutdown();

  const initiator = typeof event.initiator === "string" ? event.initiator.trim() : "";
  const reason = reasonForShutdown(eventId, initiator);
  if (!reason) return unavailableShutdown();

  return {
    available: true,
    shutdownTimeMs,
    reason,
    planned: event.planned,
    initiator,
    rebootCount: event.rebootCount,
  };
}
