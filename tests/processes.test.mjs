import assert from "node:assert/strict";
import { test } from "node:test";

import { countWindowsAgentProcesses } from "../processes.mjs";

const UUID = "12345678-1234-1234-1234-123456789abc";

test("returns zero counts for empty input", () => {
  assert.deepEqual(countWindowsAgentProcesses([]), { claude: 0, codex: 0 });
});

test("accepts a single non-array process object", () => {
  assert.deepEqual(
    countWindowsAgentProcesses({
      Name: "claude.exe",
      CommandLine: `"C:\\Users\\developer\\bin\\claude.exe" --resume ${UUID}`,
    }),
    { claude: 1, codex: 0 },
  );
});

test("ignores process entries with no command line", () => {
  assert.deepEqual(
    countWindowsAgentProcesses({ Name: "claude.exe" }),
    { claude: 0, codex: 0 },
  );
});

test("excludes desktop, app-server, sandbox, and Claude print processes", () => {
  const excluded = [
    {
      label: "Codex desktop app",
      process: {
        Name: "Codex.exe",
        CommandLine: '"C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.730.10331.0_x64__8wekyb3d8bbwe\\app\\Codex.exe"',
      },
    },
    {
      label: "Codex app-server helper",
      process: {
        Name: "codex.exe",
        CommandLine: '"C:\\tools\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\codex\\codex.exe" app-server --listen stdio://',
      },
    },
    {
      label: "Codex sandbox helper",
      process: {
        Name: "codex.exe",
        CommandLine: '"C:\\tools\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\codex\\codex.exe" sandbox -c whoami',
      },
    },
    {
      label: "Claude print run",
      process: {
        Name: "claude.exe",
        CommandLine: '"C:\\Users\\developer\\bin\\claude.exe" --print "summarize this"',
      },
    },
  ];

  for (const { label, process } of excluded) {
    assert.deepEqual(
      countWindowsAgentProcesses(process),
      { claude: 0, codex: 0 },
      label,
    );
  }
});

test("counts resumable Claude and vendored Codex CLI processes", () => {
  const processes = [
    {
      Name: "claude.exe",
      CommandLine: '"C:\\Users\\developer\\bin\\claude.exe"',
    },
    {
      Name: "claude.exe",
      CommandLine: `"C:\\Users\\developer\\bin\\claude.exe" --resume ${UUID}`,
    },
    {
      Name: "claude.exe",
      CommandLine: '"C:\\Users\\developer\\bin\\claude.exe" --model claude-sonnet-4-5',
    },
    {
      Name: "codex.exe",
      CommandLine: '"C:\\tools\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\codex\\codex.exe"',
    },
    {
      Name: "codex.exe",
      CommandLine: `"C:\\tools\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\codex\\codex.exe" resume ${UUID}`,
    },
  ];

  assert.deepEqual(
    countWindowsAgentProcesses(processes),
    { claude: 3, codex: 2 },
  );
});
