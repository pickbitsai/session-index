import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyWindowMap,
  getAssignableSessions,
  matchWindowsToSessions,
  normalizeWindowTitle,
  parseVisibleWindowsProbeOutput,
} from "../windows.mjs";

await import("../launch-state.js");

const {
  classifyLaunchAvailability,
  launchUnavailableMessage,
} = globalThis.SessionIndexLaunchState;

const capturedClaudeWindows = [
  {
    windowTitle: "⠐ Add session persistence and recovery feature",
    title: "Add session persistence and recovery feature",
    folder: "C:\\new\\agent-session",
    sessionId: "claude-agent-session",
  },
  {
    windowTitle: "✳ Check if running locally",
    title: "Check if running locally",
    folder: "C:\\new\\pickbits.studio",
    sessionId: "claude-pickbits-studio",
  },
  {
    windowTitle: "✳ Apply playtest lessons to the remaining puzzle levels",
    title: "Apply playtest lessons to the remaining puzzle levels",
    folder: "C:\\new\\puzzle-box",
    sessionId: "claude-puzzle-box",
  },
  {
    windowTitle: "✳ Implement terrain sculpting without voxels",
    title: "Implement terrain sculpting without voxels",
    folder: "C:\\new\\terrain-lab",
    sessionId: "claude-terrain-lab",
  },
  {
    windowTitle: "✳ Review the release notes preview",
    title: "Review the release notes preview",
    folder: "C:\\new\\notes-site",
    sessionId: "claude-notes-site",
  },
  {
    windowTitle: "✳ Protect against compromised npm dependencies",
    title: "Protect against compromised npm dependencies",
    folder: "C:\\new",
    sessionId: "claude-new",
  },
];

const folderWindows = [
  { windowTitle: "AIOps", folder: "C:\\new\\AIOps", sessionId: "codex-aiops" },
  { windowTitle: "lighthouse-", folder: "C:\\new\\lighthouse", sessionId: "codex-lighthouse" },
  { windowTitle: "recipe-book", folder: "C:\\new\\recipe-book", sessionId: "codex-recipe-book" },
];

const sessions = [
  ...capturedClaudeWindows.map((entry, index) => ({
    agent: "claude",
    sessionId: entry.sessionId,
    title: entry.title,
    folder: entry.folder,
    activityAt: new Date(Date.UTC(2026, 7, 6, 12, index)).toISOString(),
  })),
  ...folderWindows.map((entry, index) => ({
    agent: "codex",
    sessionId: entry.sessionId,
    title: `Codex session ${index + 1}`,
    folder: entry.folder,
    activityAt: new Date(Date.UTC(2026, 7, 6, 13, index)).toISOString(),
  })),
];

test("requires an explicit successful window-probe envelope", () => {
  const failedOutputs = [
    "",
    '{"ok":false}',
    "not json",
    '{"windows":[]}',
  ];

  for (const output of failedOutputs) {
    assert.deepEqual(parseVisibleWindowsProbeOutput(output), {
      available: false,
      windows: [],
    });
  }
  assert.deepEqual(parseVisibleWindowsProbeOutput('{"ok":true,"windows":[]}'), {
    available: true,
    windows: [],
  });
});

test("distinguishes unreachable, stale, disabled, and available launch states", () => {
  const unreachable = classifyLaunchAvailability({ configReachable: false });
  const stale = classifyLaunchAvailability({ configReachable: true });
  const off = classifyLaunchAvailability({
    configReachable: true,
    launchToken: "test-token",
    launchMode: "off",
  });
  const available = classifyLaunchAvailability({
    configReachable: true,
    launchToken: "test-token",
    launchMode: "on",
  });

  assert.equal(unreachable, "unreachable");
  assert.equal(stale, "stale");
  assert.equal(off, "off");
  assert.equal(available, "available");
  assert.match(launchUnavailableMessage(unreachable), /not reachable/);
  assert.equal(
    launchUnavailableMessage(stale),
    "The local server is running an older build. Restart it (npm start) to enable relaunching.",
  );
  assert.match(launchUnavailableMessage(off), /SESSION_LAUNCH=off/);
});

test("normalizes captured Unicode and mangled status prefixes", () => {
  for (const { windowTitle, title } of capturedClaudeWindows) {
    assert.equal(normalizeWindowTitle(windowTitle), title);
  }
  assert.equal(
    normalizeWindowTitle("? Add session persistence and recovery feature"),
    "Add session persistence and recovery feature",
  );
  assert.equal(
    normalizeWindowTitle("� Check if running locally"),
    "Check if running locally",
  );
});

test("does not strip paths or a prefix that would leave fewer than three characters", () => {
  assert.equal(
    normalizeWindowTitle("C:\\Program Files\\nodejs\\node.exe"),
    "C:\\Program Files\\nodejs\\node.exe",
  );
  assert.equal(normalizeWindowTitle("\\\\server\\share\\node.exe"), "\\\\server\\share\\node.exe");
  assert.equal(normalizeWindowTitle("/usr/local/bin/node"), "/usr/local/bin/node");
  assert.equal(normalizeWindowTitle("? ab"), "? ab");
});

test("matches the captured Claude titles and Codex folder titles", () => {
  const nodeTitle = "C:\\Program Files\\nodejs\\node.exe";
  const windows = [
    ...capturedClaudeWindows.map((entry) => entry.windowTitle),
    ...folderWindows.map((entry) => entry.windowTitle),
    "claude",
    "claude",
    nodeTitle,
    nodeTitle,
  ];

  const result = matchWindowsToSessions(windows, sessions);
  assert.equal(result.matched.length, 9);
  assert.equal(result.matched.filter((match) => match.confidence === "exact").length, 6);
  assert.equal(result.matched.filter((match) => match.confidence === "folder").length, 3);
  assert.deepEqual(result.unidentified, ["claude", "claude"]);
  assert.deepEqual(result.ignored, [nodeTitle, nodeTitle]);

  const sessionByWindowTitle = new Map(
    result.matched.map((match) => [match.windowTitle, match.sessionId]),
  );
  for (const entry of [...capturedClaudeWindows, ...folderWindows]) {
    assert.equal(sessionByWindowTitle.get(entry.windowTitle), entry.sessionId);
  }
});

test("matches a question-mark-damaged status prefix to the same Claude session", () => {
  const [session] = sessions;
  const result = matchWindowsToSessions(
    ["? Add session persistence and recovery feature"],
    [session],
  );

  assert.equal(result.matched.length, 1);
  assert.equal(result.matched[0].sessionId, "claude-agent-session");
  assert.equal(result.matched[0].confidence, "exact");
  assert.deepEqual(result.unidentified, []);
});

test("a remembered window assignment promotes only a session present in the browser session list", () => {
  const session = sessions[0];
  const overview = {
    available: true,
    matched: [],
    unidentified: ["AIOps"],
    ignoredCount: 0,
    windowCount: 1,
  };
  const windowMap = {
    AIOps: {
      agent: session.agent,
      sessionId: session.sessionId,
      title: session.title,
      assignedAt: "2026-08-06T18:00:00.000Z",
    },
  };

  const promoted = applyWindowMap(overview, [session], windowMap);
  assert.equal(promoted.matched.length, 1);
  assert.equal(promoted.matched[0].sessionId, session.sessionId);
  assert.equal(promoted.matched[0].confidence, "manual");
  assert.deepEqual(promoted.unidentified, []);

  const absent = applyWindowMap(overview, [], windowMap);
  assert.deepEqual(absent.matched, []);
  assert.deepEqual(absent.unidentified, ["AIOps"]);
});

test("window assignments use normalized titles when a status glyph appears", () => {
  const session = sessions[0];
  const result = applyWindowMap(
    { available: true, matched: [], unidentified: ["✳ AIOps"] },
    [session],
    {
      AIOps: {
        agent: session.agent,
        sessionId: session.sessionId,
        assignedAt: "2026-08-06T18:00:00.000Z",
      },
    },
  );

  assert.equal(result.matched.length, 1);
  assert.equal(result.matched[0].windowTitle, "✳ AIOps");
  assert.deepEqual(result.unidentified, []);
});

test("a missing remembered session produces a stale assignment instead of a wrong match", () => {
  const availableSession = sessions[1];
  const result = applyWindowMap(
    { available: true, matched: [], unidentified: ["claude"] },
    [availableSession],
    {
      claude: {
        agent: "claude",
        sessionId: "ff2bfda4-c681-44f1-a76d-dbd0b088db85",
        title: "Find next steps on company intranet",
        assignedAt: "2026-08-06T18:00:00.000Z",
      },
    },
  );

  assert.deepEqual(result.matched, []);
  assert.deepEqual(result.unidentified, ["claude"]);
  assert.equal(result.assignmentIssues.length, 1);
  assert.equal(result.assignmentIssues[0].state, "stale");
  assert.equal(result.assignmentIssues[0].assignment.title, "Find next steps on company intranet");
  assert.notEqual(result.assignmentIssues[0].assignment.sessionId, availableSession.sessionId);
});

test("assignable sessions exclude matches and sort the remaining sessions by recent activity", () => {
  const matchedSession = sessions[0];
  const olderSession = sessions[1];
  const newerSession = sessions[2];
  const candidates = getAssignableSessions(
    [olderSession, matchedSession, newerSession],
    [{ agent: matchedSession.agent, sessionId: matchedSession.sessionId }],
  );

  assert.deepEqual(
    candidates.map((session) => session.sessionId),
    [newerSession.sessionId, olderSession.sessionId],
  );
});
