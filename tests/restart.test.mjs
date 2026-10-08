import assert from "node:assert/strict";
import { test } from "node:test";

import {
  clusterSessionsByActivity,
  detectRestartCasualties,
  parseShutdownProbeOutput,
  resolveRestartSequence,
} from "../restart.mjs";

const bootTimeMs = Date.parse("2026-08-14T09:24:22.000Z");
const interruptedAt = "2026-08-14T09:20:10.000Z";

function session(id, activityAt = interruptedAt) {
  return {
    agent: "claude",
    sessionId: id,
    title: `Session ${id}`,
    folder: `C:\\new\\${id}`,
    activityAt,
  };
}

test("detects the 11-session restart cluster and ignores older decoys", () => {
  const casualties = Array.from({ length: 11 }, (_, index) => session(`casualty-${index + 1}`));
  const decoys = [
    session("decoy-28m", new Date(bootTimeMs - 28 * 60_000).toISOString()),
    session("decoy-1h", new Date(bootTimeMs - 60 * 60_000).toISOString()),
    session("decoy-3h", new Date(bootTimeMs - 3 * 60 * 60_000).toISOString()),
  ];

  const result = detectRestartCasualties([...decoys, ...casualties], { bootTimeMs });

  assert.deepEqual(result.sessions.map((entry) => entry.sessionId), casualties.map((entry) => entry.sessionId));
  assert.equal(result.interruptedAt, interruptedAt);
  assert.equal(result.confidence, "high");
  assert.equal(result.clusterSize, 11);
});

test("never returns sessions active after boot", () => {
  const beforeBoot = session("before", new Date(bootTimeMs - 1_000).toISOString());
  const afterBoot = session("after", new Date(bootTimeMs + 1_000).toISOString());

  const result = detectRestartCasualties([afterBoot, beforeBoot], { bootTimeMs });

  assert.deepEqual(result.sessions.map((entry) => entry.sessionId), ["before"]);
  assert.equal(result.confidence, "low");
});

test("returns a lone clustered session with low confidence", () => {
  const result = detectRestartCasualties([session("only")], { bootTimeMs });

  assert.deepEqual(result.sessions.map((entry) => entry.sessionId), ["only"]);
  assert.equal(result.confidence, "low");
  assert.equal(result.clusterSize, 1);
});

test("falls back to the boot-time cluster when shutdown enrichment does not match", () => {
  const result = detectRestartCasualties([session("only")], {
    bootTimeMs,
    shutdownTimeMs: Date.parse("2026-08-14T09:23:45.000Z"),
  });

  assert.deepEqual(result.sessions.map((entry) => entry.sessionId), ["only"]);
  assert.equal(result.interruptedAt, interruptedAt);
  assert.equal(result.confidence, "low");
  assert.equal(result.clusterSize, 1);
});

test("regression: a later reboot in the chain cannot erase the 11-session casualty cluster", () => {
  const exactInterruptedAt = "2026-08-14T09:20:10.935Z";
  const casualties = Array.from(
    { length: 11 },
    (_, index) => session(`casualty-${index + 1}`, exactInterruptedAt),
  );

  const result = detectRestartCasualties(casualties, {
    bootTimeMs,
    shutdownTimeMs: Date.parse("2026-08-14T09:23:45.000Z"),
  });

  assert.deepEqual(result.sessions.map((entry) => entry.sessionId), casualties.map((entry) => entry.sessionId));
  assert.equal(result.interruptedAt, exactInterruptedAt);
  assert.equal(result.confidence, "high");
  assert.equal(result.clusterSize, 11);
});

test("shutdown enrichment never returns fewer sessions than the boot-time baseline", () => {
  const casualties = Array.from({ length: 11 }, (_, index) => session(`casualty-${index + 1}`));
  const baseline = detectRestartCasualties(casualties, { bootTimeMs });
  const enriched = detectRestartCasualties(casualties, {
    bootTimeMs,
    shutdownTimeMs: Date.parse("2026-08-14T06:00:00.000Z"),
  });
  const enrichedIds = new Set(enriched.sessions.map((entry) => entry.sessionId));

  assert.ok(baseline.sessions.every((entry) => enrichedIds.has(entry.sessionId)));
  assert.ok(enriched.sessions.length >= baseline.sessions.length);
});

test("a cluster flushed after shutdown initiation matches with high confidence", () => {
  const shutdownTimeMs = Date.parse("2026-08-14T09:20:07.000Z");
  const result = detectRestartCasualties([
    session("flushed-late", new Date(shutdownTimeMs + 3_000).toISOString()),
  ], { bootTimeMs, shutdownTimeMs });

  assert.deepEqual(result.sessions.map((entry) => entry.sessionId), ["flushed-late"]);
  assert.equal(result.confidence, "high");
});

test("the default lookback catches casualties before an earlier reboot", () => {
  const earlierShutdown = Date.parse("2026-08-14T09:20:07.000Z");
  const sessions = [
    session("first", new Date(earlierShutdown + 3_000).toISOString()),
    session("second", new Date(earlierShutdown + 3_000).toISOString()),
  ];

  const result = detectRestartCasualties(sessions, { bootTimeMs });

  assert.deepEqual(result.sessions.map((entry) => entry.sessionId), ["first", "second"]);
  assert.equal(result.interruptedAt, interruptedAt);
  assert.equal(result.confidence, "high");
});

test("clusters split when their newest activity is beyond the tolerance", () => {
  const clusters = clusterSessionsByActivity([
    session("newest", "2026-08-14T09:20:10.000Z"),
    session("near", "2026-08-14T09:19:30.000Z"),
    session("older", "2026-08-14T09:18:39.999Z"),
  ], 90_000);

  assert.deepEqual(clusters.map((cluster) => cluster.sessions.map((entry) => entry.sessionId)), [
    ["newest", "near"],
    ["older"],
  ]);
  assert.deepEqual(clusters.map((cluster) => cluster.at), [
    "2026-08-14T09:20:10.000Z",
    "2026-08-14T09:18:39.999Z",
  ]);
});

test("collapses reboot events 3m38s apart and returns the earliest event", () => {
  const newest = {
    shutdownTime: "2026-08-14T09:23:45.000Z",
    eventId: 1074,
    planned: true,
    initiator: "C:\\WINDOWS\\servicing\\TrustedInstaller.exe",
  };
  const earliest = {
    shutdownTime: "2026-08-14T09:20:07.000Z",
    eventId: 1074,
    planned: true,
    initiator: "C:\\Windows\\UUS\\amd64\\MoUsoCoreWorker.exe",
  };

  assert.deepEqual(resolveRestartSequence([newest, earliest]), {
    ...earliest,
    rebootCount: 2,
  });
});

test("does not collapse restart events three hours apart", () => {
  const newest = {
    shutdownTime: "2026-08-14T09:23:45.000Z",
    eventId: 1074,
    planned: true,
    initiator: "C:\\WINDOWS\\servicing\\TrustedInstaller.exe",
  };
  const older = {
    shutdownTime: "2026-08-14T06:23:45.000Z",
    eventId: 1074,
    planned: true,
    initiator: "C:\\Windows\\UUS\\amd64\\MoUsoCoreWorker.exe",
  };

  assert.deepEqual(resolveRestartSequence([newest, older]), {
    ...newest,
    rebootCount: 1,
  });
});

test("parses a multiple-event shutdown probe array using the restart sequence", () => {
  const laterEvent = {
    shutdownTime: "2026-08-14T02:23:45.0000000-07:00",
    eventId: 1074,
    planned: true,
    initiator: "C:\\WINDOWS\\servicing\\TrustedInstaller.exe",
  };
  const earlierEvent = {
    shutdownTime: "2026-08-14T02:20:07.0000000-07:00",
    eventId: 1074,
    planned: true,
    initiator: "C:\\Windows\\UUS\\amd64\\MoUsoCoreWorker.exe",
  };

  assert.deepEqual(parseShutdownProbeOutput(JSON.stringify([laterEvent, earlierEvent])), {
    available: true,
    shutdownTimeMs: Date.parse(earlierEvent.shutdownTime),
    reason: "Windows Update",
    planned: true,
    initiator: earlierEvent.initiator,
    rebootCount: 2,
  });
});

test("parses a single shutdown probe object for backwards compatibility", () => {
  const probeEvent = {
    shutdownTime: "2026-08-14T02:20:07.0000000-07:00",
    eventId: 1074,
    planned: true,
    initiator: "C:\\Windows\\UUS\\amd64\\MoUsoCoreWorker.exe",
  };

  assert.deepEqual(parseShutdownProbeOutput(JSON.stringify(probeEvent)), {
    available: true,
    shutdownTimeMs: Date.parse(probeEvent.shutdownTime),
    reason: "Windows Update",
    planned: true,
    initiator: probeEvent.initiator,
    rebootCount: 1,
  });
});

test("rejects empty, non-JSON, and incomplete shutdown probe output", () => {
  const unavailable = {
    available: false,
    shutdownTimeMs: null,
    reason: "",
    planned: null,
    initiator: "",
    rebootCount: 0,
  };

  assert.deepEqual(parseShutdownProbeOutput(""), unavailable);
  assert.deepEqual(parseShutdownProbeOutput("not json"), unavailable);
  assert.deepEqual(parseShutdownProbeOutput("[]"), unavailable);
  assert.deepEqual(parseShutdownProbeOutput('{"shutdownTime":"2026-08-14T09:20:07.000Z"}'), unavailable);
});

test("returns none only when there is no candidate cluster", () => {
  const afterBoot = session("after", new Date(bootTimeMs + 1_000).toISOString());
  const tooOld = session("too-old", new Date(bootTimeMs - 1_800_001).toISOString());

  assert.deepEqual(detectRestartCasualties([afterBoot, tooOld], {
    bootTimeMs,
    shutdownTimeMs: Date.parse("2026-08-14T09:23:45.000Z"),
  }), {
    sessions: [],
    interruptedAt: null,
    confidence: "none",
    clusterSize: 0,
  });
});

test("malformed activity times are ignored without throwing", () => {
  const malformed = [
    null,
    {},
    { activityAt: null },
    { activityAt: "" },
    { activityAt: "not a date" },
  ];

  assert.doesNotThrow(() => clusterSessionsByActivity(malformed, 90_000));
  assert.deepEqual(clusterSessionsByActivity(malformed, 90_000), []);
  assert.doesNotThrow(() => detectRestartCasualties(malformed, { bootTimeMs }));
  assert.deepEqual(detectRestartCasualties(malformed, { bootTimeMs }), {
    sessions: [],
    interruptedAt: null,
    confidence: "none",
    clusterSize: 0,
  });
});
