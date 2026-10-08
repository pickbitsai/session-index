import assert from "node:assert/strict";
import { test } from "node:test";
import { closureStatus, detectClosedTogether, detectLiveSetDrop, mergeClosures, parseClosures } from "../closures.mjs";
import { buildLiveSnapshot } from "../liveness.mjs";

const closedMs = Date.parse("2026-10-08T15:36:00.723Z");
const iso = (time) => new Date(time).toISOString();
const options = { nowMs: closedMs + 60_000, bootTimeMs: closedMs - 3_600_000 };
function session(sessionId, time = closedMs, interactive = true, exited = true) {
  return { agent: "claude", sessionId, title: `Session ${sessionId}`, folder: `C:\\new\\${sessionId}`,
    activityAt: iso(time), metadata: { interactive, exited } };
}
function closure(time = closedMs, sessions = [session("one"), session("two")], source = "activity") {
  return { closedAt: iso(time), source, sessions };
}
function snapshot(sessions, time = closedMs, processCounts = { claude: 0, codex: 0 }) {
  return buildLiveSnapshot({ matched: sessions, now: time, bootAt: iso(options.bootTimeMs),
    unidentifiedCount: 0, processCounts });
}

test("incident isolates eight interactive Claude exits from open, batch and unknown sessions", () => {
  const interactive = Array.from({ length: 8 }, (_, index) => session(`cli-${index}`, closedMs + Math.round(index * 598 / 7), true, true));
  const open = [session("open-one", closedMs, true, false), session("open-two", closedMs + 500, true, false)];
  const batch = Array.from({ length: 20 }, (_, index) => session(`sdk-${index}`, closedMs + index, false));
  const unknown = [session("unknown-1", closedMs, null), session("unknown-2", closedMs, null)];
  const result = detectClosedTogether([...interactive, ...open, ...batch, ...unknown], options);
  assert.equal(result.length, 1);
  assert.equal(result[0].closedAt, "2026-10-08T15:36:01.321Z");
  assert.equal(result[0].spreadMs, 598);
  assert.equal(result[0].source, "activity");
  assert.deepEqual(result[0].sessions.map((entry) => entry.sessionId).sort(), interactive.map((entry) => entry.sessionId).sort());
  assert.deepEqual(Object.keys(result[0].sessions[0]), ["agent", "sessionId", "title", "folder", "activityAt"]);
});

test("idle open Claude tabs with settled activity one second apart do not form closures", () => {
  const sessions = [session("one", closedMs, true, false), session("two", closedMs + 1_000, true, false)];
  assert.deepEqual(detectClosedTogether(sessions, options), []);
});

test("Claude sessions relaunched together and now idle do not form closures", () => {
  const sessions = [session("resumed-one", closedMs + 20_000, true, false),
    session("resumed-two", closedMs + 20_500, true, false)];
  assert.deepEqual(detectClosedTogether(sessions, options), []);
});

test("Claude activity requires an explicit exit marker", () => {
  for (const exited of [null, undefined]) {
    const sessions = [session("one"), session("two")].map((entry) => ({
      ...entry, metadata: { interactive: true, exited },
    }));
    assert.deepEqual(detectClosedTogether(sessions, options), []);
  }
});

test("Codex sessions never form activity clusters; a parent and its spawned thread share a timestamp", () => {
  // Real case 2026-10-08: a codex-tui thread and its guardian review sub-thread both last wrote at 11:11:08.9.
  const sessions = [session("parent", closedMs, true, null), session("guardian", closedMs + 56, true, null)]
    .map((entry) => ({ ...entry, agent: "codex" }));
  assert.deepEqual(detectClosedTogether(sessions, options), []);
  const mixed = [...sessions, session("claude-one"), session("claude-two", closedMs + 300)];
  const result = detectClosedTogether(mixed, options);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].sessions.map((entry) => entry.sessionId).sort(), ["claude-one", "claude-two"]);
});

test("single exits and exits ten seconds apart do not form closures", () => {
  assert.deepEqual(detectClosedTogether([session("one")], options), []);
  assert.deepEqual(detectClosedTogether([session("one"), session("two", closedMs + 10_000)], options), []);
  assert.deepEqual(detectClosedTogether([session("one"), session("one")], options), []);
});

test("activity respects boot, settle, lookback and live keys including boundary times", () => {
  const pair = (time) => [session("one", time), session("two", time)];
  assert.deepEqual(detectClosedTogether(pair(options.bootTimeMs - 1), options), []);
  assert.equal(detectClosedTogether(pair(options.bootTimeMs), options).length, 1);
  assert.deepEqual(detectClosedTogether(pair(options.nowMs - 29_999), options), []);
  assert.equal(detectClosedTogether(pair(options.nowMs - 30_000), options).length, 1);
  assert.deepEqual(detectClosedTogether(pair(closedMs), { ...options, lookbackMs: 59_999 }), []);
  assert.deepEqual(detectClosedTogether(pair(closedMs), { ...options, liveKeys: new Set(["claude:one"]) }), []);
  assert.equal(detectClosedTogether(pair(closedMs), { ...options, liveKeys: new Set(["codex:one"]) }).length, 1);
});

test("activity clusters are newest first and span the full tolerance instead of chaining", () => {
  const result = detectClosedTogether([session("a"), session("b", closedMs + 4_000),
    session("c", closedMs + 8_000), session("d", closedMs + 20_000), session("e", closedMs + 21_000)], options);
  assert.equal(result.length, 2);
  assert.equal(result[0].closedAt, iso(closedMs + 21_000));
  assert.deepEqual(result[1].sessions.map((entry) => entry.sessionId), ["c", "b"]);
});

test("live-set drops require at least two sessions and comparable available probes and boots", () => {
  const sessions = [session("one"), session("two"), session("three"), session("kept")];
  const previous = snapshot(sessions);
  const current = snapshot([session("kept")], closedMs + 40_000);
  const result = detectLiveSetDrop(previous, current, { sessions });
  assert.equal(result.closedAt, current.savedAt);
  assert.equal(result.source, "snapshot");
  assert.deepEqual(result.sessions.map((entry) => entry.sessionId), ["one", "two", "three"]);
  assert.equal(detectLiveSetDrop(snapshot([session("one")]), snapshot([]), { sessions }), null);
  assert.equal(detectLiveSetDrop({ ...previous, windowProbe: "unavailable" }, current, { sessions }), null);
  assert.equal(detectLiveSetDrop(previous, { ...current, windowProbe: "unavailable" }, { sessions }), null);
  assert.equal(detectLiveSetDrop(previous, { ...current, bootAt: iso(options.bootTimeMs + 5_001) }, { sessions }), null);
  assert.ok(detectLiveSetDrop(previous, { ...current, bootAt: iso(options.bootTimeMs + 5_000) }, { sessions }));
  assert.equal(detectLiveSetDrop(null, current, { sessions }), null);
  assert.equal(detectLiveSetDrop(previous, null, { sessions }), null);
  assert.equal(detectLiveSetDrop(previous, current), null);
});

test("switching two terminal tabs with unchanged process counts is not a live-set closure", () => {
  const sessions = ["a", "b", "c", "d"].map((id) => session(id, closedMs, true, false));
  const counts = { claude: 4, codex: 0 };
  const previous = snapshot(sessions.slice(0, 2), closedMs, counts);
  const current = snapshot(sessions.slice(2), closedMs + 40_000, counts);
  assert.equal(detectLiveSetDrop(previous, current, { sessions }), null);
});

test("a process count drop confirms all eight lost window-sourced Claude sessions", () => {
  const sessions = Array.from({ length: 9 }, (_, index) => session(`cli-${index}`, closedMs, true, false));
  const previous = snapshot(sessions, closedMs, { claude: 9, codex: 0 });
  const current = snapshot(sessions.slice(8), closedMs + 40_000, { claude: 1, codex: 0 });
  const result = detectLiveSetDrop(previous, current, { sessions });
  assert.equal(result.source, "snapshot");
  assert.deepEqual(result.sessions.map((entry) => entry.sessionId), sessions.slice(0, 8).map((entry) => entry.sessionId));
});

test("partial or unknown process count coverage confirms no unconfirmed window sessions", () => {
  const sessions = ["one", "two", "three"].map((id) => session(id, closedMs, true, false));
  const previous = snapshot(sessions, closedMs, { claude: 3, codex: 0 });
  const current = snapshot([], closedMs + 40_000, { claude: 2, codex: 0 });
  assert.equal(detectLiveSetDrop(previous, current, { sessions }), null);
  assert.equal(detectLiveSetDrop(previous, current, { sessions, minSessions: 1 }), null);
  for (const count of [null, undefined, "3", 3.5]) {
    assert.equal(detectLiveSetDrop({ ...previous, processCounts: { claude: count } },
      { ...current, processCounts: { claude: 0 } }, { sessions }), null);
    assert.equal(detectLiveSetDrop(previous, { ...current, processCounts: { claude: count } }, { sessions }), null);
  }
});

test("lost interactive Codex writer locks confirm a closure with unchanged process counts", () => {
  const sessions = ["one", "two"].map((id) => ({ ...session(id, closedMs, true, null), agent: "codex", source: "lock" }));
  const previous = snapshot(sessions);
  const current = snapshot([], closedMs + 40_000);
  const result = detectLiveSetDrop(previous, current, { sessions });
  assert.deepEqual(result.sessions.map((entry) => entry.sessionId), ["one", "two"]);
  assert.deepEqual(Object.keys(result.sessions[0]), ["agent", "sessionId", "title", "folder", "activityAt"]);
});

test("lost Codex locks require interactive metadata in the fresh scan", () => {
  const sessions = ["one", "two"].map((id) => ({ ...session(id, closedMs, true, null), agent: "codex", source: "lock" }));
  const previous = snapshot(sessions);
  const current = snapshot([], closedMs + 40_000);
  for (const interactive of [false, null, undefined]) {
    const fresh = sessions.map((entry) => ({ ...entry, metadata: { interactive, exited: null } }));
    assert.equal(detectLiveSetDrop(previous, current, { sessions: fresh }), null);
  }
  assert.equal(detectLiveSetDrop(previous, current, { sessions: [] }), null);
});

test("Claude exit markers confirm lost window sessions with unchanged process counts", () => {
  const sessions = [session("one"), session("two")];
  const counts = { claude: 9, codex: 0 };
  const previous = snapshot(sessions, closedMs, counts);
  const current = snapshot([], closedMs + 40_000, counts);
  const result = detectLiveSetDrop(previous, current, { sessions });
  assert.deepEqual(result.sessions.map((entry) => entry.sessionId), ["one", "two"]);
});

test("process count confirmation is per agent and excludes already confirmed exits from coverage", () => {
  const sessions = [session("exited"), session("open-one", closedMs, true, false),
    session("open-two", closedMs, true, false),
    { ...session("codex-open", closedMs, true, null), agent: "codex" }];
  const previous = snapshot(sessions, closedMs, { claude: 3, codex: 1 });
  const current = snapshot([], closedMs + 40_000, { claude: 1, codex: 1 });
  const result = detectLiveSetDrop(previous, current, { sessions });
  assert.deepEqual(result.sessions.map((entry) => entry.sessionId), ["exited", "open-one", "open-two"]);
  assert.equal(detectLiveSetDrop(previous, current, { sessions, minSessions: 4 }), null);
});

test("merging activity and snapshot evidence keeps earliest time, latest fields and resumed members", () => {
  const activity = closure();
  const updated = { ...session("one", closedMs + 5_000), title: "New title", folder: "C:\\new\\moved" };
  const result = mergeClosures([activity], [closure(closedMs + 40_000, [updated, session("three")], "snapshot")], options);
  assert.equal(result.length, 1);
  assert.equal(result[0].closedAt, activity.closedAt);
  assert.deepEqual(result[0].sources, ["activity", "snapshot"]);
  assert.equal(result[0].sessions.length, 3);
  assert.equal(result[0].sessions[0].title, "New title");
  assert.equal(result[0].sessions[0].folder, updated.folder);
  const later = mergeClosures(result, [closure(closedMs, [session("two")])], options);
  assert.deepEqual(later, result);
  assert.equal(activity.sessions[0].title, "Session one");
});

test("merging applies age and count limits and unions sources across adjacent evidence", () => {
  const events = Array.from({ length: 14 }, (_, index) => closure(closedMs - index * 180_000));
  events.push(closure(options.nowMs - 7 * 86_400_000 - 1));
  assert.equal(mergeClosures(events, [], options).length, 10);
  assert.deepEqual(mergeClosures(events, [], { ...options, maxClosures: 0 }), []);
  assert.equal(mergeClosures(events, [], { ...options, maxAgeMs: 60_000 }).length, 1);
  assert.equal(mergeClosures(events, [], { ...options, maxClosures: 20 }).length, 14);
  const bridge = mergeClosures([closure(closedMs - 200_000), closure(closedMs)],
    [closure(closedMs - 100_000, [session("bridge")], "snapshot")], options);
  assert.equal(bridge.length, 1);
  assert.equal(bridge[0].closedAt, iso(closedMs - 200_000));
});

test("status uses live keys and activity strictly after ten seconds, refreshing titles and folders", () => {
  const saved = closure(closedMs, [session("active"), session("live"), session("boundary"), session("missing")]);
  const fresh = [session("active", closedMs + 10_001), session("boundary", closedMs + 10_000)];
  fresh[0].title = "Fresh title";
  fresh[0].folder = "C:\\new\\fresh";
  const result = closureStatus(saved, fresh, new Set(["claude:live"]));
  assert.deepEqual(result.sessions.map((entry) => entry.status), ["resumed", "resumed", "pending", "pending"]);
  assert.equal(result.sessions[0].title, "Fresh title");
  assert.equal(result.sessions[0].folder, fresh[0].folder);
  assert.equal(result.pendingCount, 2);
  assert.equal(result.resumedCount, 2);
  assert.equal(saved.sessions[0].status, undefined);
});

test("closure files validate every field and accept valid version-one files", () => {
  const valid = { version: 1, closures: mergeClosures([], [closure()], options) };
  assert.deepEqual(parseClosures(JSON.stringify(valid)), valid);
  assert.deepEqual(parseClosures('{"version":1,"closures":[]}'), { version: 1, closures: [] });
  const entry = valid.closures[0];
  for (const invalid of [undefined, null, 1, "", "{", "null", "[]", "{}",
    JSON.stringify({ ...valid, version: 2 }), JSON.stringify({ version: 1, closures: {} }),
    ...[null, {}, { ...entry, closedAt: "bad" }, { ...entry, sources: [] },
      { ...entry, sources: ["other"] }, { ...entry, sources: "activity" }, { ...entry, sessions: [null] },
      ...["agent", "sessionId", "title", "folder", "activityAt"].map((field) => ({
        ...entry, sessions: [{ ...entry.sessions[0], [field]: null }],
      }))].map((bad) => JSON.stringify({ ...valid, closures: [bad] })),
  ]) assert.equal(parseClosures(invalid), null);
});

test("bad detector and merger inputs fail closed without throwing", () => {
  for (const input of [null, undefined, {}, 1, [null], [{ activityAt: "bad" }]]) {
    assert.deepEqual(detectClosedTogether(input, options), []);
    assert.equal(detectLiveSetDrop(input, input), null);
    assert.deepEqual(mergeClosures(input, [], options), []);
  }
  for (const badOptions of [null, undefined, {}, { ...options, liveKeys: null }, { ...options, windowMs: -1 }]) {
    assert.deepEqual(detectClosedTogether([session("one"), session("two")], badOptions), []);
  }
  assert.deepEqual(mergeClosures([], [], null), []);
});
