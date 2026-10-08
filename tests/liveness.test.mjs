import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildLiveSnapshot,
  mergeRestartDetection,
  parseLiveSnapshot,
  sessionIdsFromLockNames,
  snapshotIsPreBoot,
} from "../liveness.mjs";

const bootTimeMs = Date.parse("2026-09-10T09:45:00.000Z");
const shutdownTimeMs = bootTimeMs - 4 * 60_000;
const options = { bootTimeMs, shutdownTimeMs };
const iso = (time) => new Date(time).toISOString();

function session(sessionId, agent = "codex", activityAt = iso(bootTimeMs - 3_600_000)) {
  return { agent, sessionId, title: `Session ${sessionId}`, folder: `C:\\new\\${sessionId}`, activityAt };
}

function snapshot(matched = [], savedAt = shutdownTimeMs - 120_000) {
  return buildLiveSnapshot({
    matched,
    unidentifiedCount: 1,
    processCounts: { claude: 2, codex: 3 },
    now: savedAt,
    bootAt: iso(bootTimeMs - 86_400_000),
  });
}

function detection(sessions = []) {
  return {
    sessions,
    interruptedAt: sessions.length ? iso(shutdownTimeMs + 2_000) : null,
    confidence: sessions.length ? "low" : "none",
    clusterSize: sessions.length,
  };
}

test("lock names return unique session IDs and ignore coordination files and invalid stems", () => {
  const uuid = "01a08135-f245-7273-91b0-1b58b1bfc6bf";
  const longest = "a".repeat(128);
  assert.deepEqual(sessionIdsFromLockNames([
    ".coordination.lock", ".hidden-session.lock", "not-a-session.txt", "codex-locked.lock.tmp",
    "codex-locked.LOCK", ".lock", "short.lock", `${"a".repeat(129)}.lock`,
    "-invalid.lock", "_invalid.lock", "bad stem.lock", "bad/stem.lock", "bad\\stem.lock",
    "bad:id.lock", "éabcde.lock", "abcdef\n.lock", "abcdef\r.lock", "abcdef\t.lock",
    `${uuid}.lock`, "codex-locked.lock", "A1._-z.lock", `${longest}.lock`,
    `${uuid}.lock`, "codex-locked.lock",
  ]), [uuid, "codex-locked", "A1._-z", longest]);
  assert.deepEqual(sessionIdsFromLockNames([]), []);
});

test("snapshot stores only selected session fields and counts, never probe details", () => {
  const entry = session("open");
  const result = buildLiveSnapshot({
    matched: [{ ...entry, windowTitle: "private terminal title", pid: 123, confidence: "folder", commandLine: "secret" }],
    unidentifiedCount: 2,
    lockCount: 1,
    processCounts: { claude: null, codex: 1, commandLine: "secret", available: false },
    now: new Date(shutdownTimeMs - 60_000),
    bootAt: iso(bootTimeMs - 86_400_000),
  });
  assert.deepEqual(result, {
    version: 1,
    savedAt: iso(shutdownTimeMs - 60_000),
    bootAt: iso(bootTimeMs - 86_400_000),
    sessions: [entry],
    unidentifiedCount: 2,
    lockCount: 1,
    processCounts: { claude: null, codex: 1 },
  });
  assert.deepEqual(parseLiveSnapshot(JSON.stringify(result)), result);
});

test("parse accepts optional non-negative integer lock counts and older snapshots without them", () => {
  const { lockCount, ...legacy } = snapshot([session("open")]);
  assert.equal(lockCount, 0);
  assert.deepEqual(parseLiveSnapshot(JSON.stringify(legacy)), legacy);
  for (const count of [0, 1, 42]) {
    const saved = { ...legacy, lockCount: count };
    assert.deepEqual(parseLiveSnapshot(JSON.stringify(saved)), saved);
  }
  for (const count of [-1, 0.5, null, "1", false, {}, []]) {
    assert.equal(parseLiveSnapshot(JSON.stringify({ ...legacy, lockCount: count })), null);
  }
});

test("parse rejects missing, malformed, and wrong-version snapshots without throwing", () => {
  const valid = snapshot([session("open")]);
  for (const input of [undefined, null, 42, "", " ", "{", "null", "[]", "{}",
    JSON.stringify({ ...valid, version: 2 }),
    JSON.stringify({ ...valid, savedAt: "invalid" }),
    JSON.stringify({ ...valid, bootAt: "invalid" }),
    JSON.stringify({ ...valid, sessions: [null] }),
    JSON.stringify({ ...valid, sessions: [{ ...session("open"), activityAt: {} }] }),
    JSON.stringify({ ...valid, unidentifiedCount: -1 }),
    JSON.stringify({ ...valid, processCounts: {} }),
  ]) {
    assert.equal(parseLiveSnapshot(input), null);
  }
  assert.deepEqual(parseLiveSnapshot(JSON.stringify(valid)), valid);
});

test("pre-boot snapshot must be recent and at or before shutdown", () => {
  assert.equal(snapshotIsPreBoot(snapshot(), options), true);
  assert.equal(snapshotIsPreBoot(snapshot([], shutdownTimeMs - 20 * 60_000), options), false);
  assert.equal(snapshotIsPreBoot(snapshot([], shutdownTimeMs - 600_000), options), true);
  assert.equal(snapshotIsPreBoot(snapshot([], shutdownTimeMs - 600_001), options), false);
  assert.equal(snapshotIsPreBoot(snapshot([], shutdownTimeMs + 1), options), false);
  assert.equal(snapshotIsPreBoot(snapshot([], bootTimeMs + 1), options), false);
  assert.equal(snapshotIsPreBoot(snapshot([], bootTimeMs), { bootTimeMs }), false);
  assert.equal(snapshotIsPreBoot(snapshot(), { ...options, maxAgeMs: 60_000 }), false);
  assert.equal(snapshotIsPreBoot(null, options), false);
  assert.equal(snapshotIsPreBoot({ savedAt: "bad" }, options), false);
});

test("pre-boot snapshot falls back to boot when shutdown is unknown", () => {
  for (const shutdownTimeMs of [undefined, null, NaN, Infinity]) {
    assert.equal(snapshotIsPreBoot(snapshot([], bootTimeMs - 120_000), { bootTimeMs, shutdownTimeMs }), true);
    assert.equal(snapshotIsPreBoot(snapshot([], bootTimeMs - 20 * 60_000), { bootTimeMs, shutdownTimeMs }), false);
  }
});

test("merge adds idle Codex sessions using current scan fields and preserves cluster order", () => {
  const cluster = [session("claude-b", "claude"), session("claude-a", "claude")];
  const older = session("older");
  const newer = session("newer", "codex", iso(bootTimeMs - 1_800_000));
  const original = detection(cluster);
  const originalCopy = structuredClone(original);
  const saved = snapshot([older, { ...newer, title: "Stale title", folder: "Old folder" }]);
  const result = mergeRestartDetection(original, saved, { ...options, sessions: [...cluster, older, newer] });
  assert.deepEqual(result.sessions, [
    ...cluster.map((entry) => ({ ...entry, source: "activity" })),
    { ...newer, source: "snapshot" },
    { ...older, source: "snapshot" },
  ]);
  assert.deepEqual(result.sources, { cluster: 2, snapshot: 2 });
  assert.equal(result.clusterSize, 4);
  assert.equal(result.confidence, "high");
  assert.equal(result.interruptedAt, iso(shutdownTimeMs));
  assert.deepEqual(original, originalCopy);
});

test("merge uses saved lock-only sessions after locks disappear and adds nothing from an empty snapshot", () => {
  const entry = session("codex-locked");
  const saved = parseLiveSnapshot(JSON.stringify({
    ...snapshot([entry]), unidentifiedCount: 0, lockCount: 1,
    processCounts: { claude: null, codex: null },
  }));
  const currentOptions = { ...options, sessions: [entry] };
  assert.deepEqual(sessionIdsFromLockNames([".coordination.lock", "not-a-session.txt"]), []);
  const result = mergeRestartDetection(detection(), saved, currentOptions);
  assert.deepEqual(result.sessions, [{ ...entry, source: "snapshot" }]);
  assert.deepEqual(result.sources, { cluster: 0, snapshot: 1 });
  assert.equal(result.confidence, "high");

  for (const lockCount of [0, 1]) {
    const empty = parseLiveSnapshot(JSON.stringify({ ...saved, sessions: [], lockCount }));
    assert.deepEqual(mergeRestartDetection(detection(), empty, currentOptions), {
      ...detection(), sources: { cluster: 0, snapshot: 0 },
    });
  }
});

test("merge deduplicates by both agent and session ID and counts overlaps as activity", () => {
  const shared = session("shared", "claude");
  const otherAgent = session("shared", "codex");
  const original = detection([shared]);
  const result = mergeRestartDetection(original, snapshot([shared, shared, otherAgent, otherAgent]), {
    ...options, sessions: [shared, otherAgent],
  });
  assert.deepEqual(result.sessions, [{ ...shared, source: "activity" }, { ...otherAgent, source: "snapshot" }]);
  assert.deepEqual(result.sources, { cluster: 1, snapshot: 1 });
  const overlapOnly = mergeRestartDetection(original, snapshot([shared]), { ...options, sessions: [shared] });
  assert.equal(overlapOnly.confidence, original.confidence);
  assert.equal(overlapOnly.interruptedAt, original.interruptedAt);
});

test("merge drops deleted sessions and sessions resumed at or after boot", () => {
  const missing = session("missing");
  const resumed = session("resumed");
  const atBoot = session("at-boot");
  const result = mergeRestartDetection(detection(), snapshot([missing, resumed, atBoot]), {
    ...options,
    sessions: [
      { ...resumed, activityAt: iso(bootTimeMs + 1) },
      { ...atBoot, activityAt: iso(bootTimeMs) },
    ],
  });
  assert.deepEqual(result, { ...detection(), sources: { cluster: 0, snapshot: 0 } });
});

test("merge leaves detection unchanged apart from sources for a non-pre-boot snapshot", () => {
  const entry = session("cluster", "claude");
  const original = detection([entry]);
  for (const saved of [null, snapshot([session("open")], bootTimeMs + 1), snapshot([], shutdownTimeMs - 1_200_000)]) {
    assert.deepEqual(mergeRestartDetection(original, saved, { ...options, sessions: [entry] }), {
      ...original, sources: { cluster: 1, snapshot: 0 },
    });
  }
});

test("snapshot additions use the existing interruption or save time when shutdown is unknown", () => {
  const entry = session("open");
  const saved = snapshot([entry], bootTimeMs - 120_000);
  const result = mergeRestartDetection(detection(), saved, { bootTimeMs, sessions: [entry] });
  assert.equal(result.confidence, "high");
  assert.equal(result.interruptedAt, saved.savedAt);
  const cluster = session("cluster", "claude");
  const original = detection([cluster]);
  assert.equal(mergeRestartDetection(original, saved, { bootTimeMs, sessions: [cluster, entry] }).interruptedAt,
    original.interruptedAt);
});
