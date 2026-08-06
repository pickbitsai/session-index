function commandArguments(commandLine) {
  const trimmed = commandLine.trim();
  const executable = trimmed.match(/^(?:"[^"]*"|'[^']*'|\S+)/)?.[0] || "";
  return trimmed.slice(executable.length).trimStart();
}

function isDesktopAppProcess({ commandLine }) {
  // Desktop GUI applications are not interactive terminal sessions that can be resumed.
  return /[\\/]windowsapps[\\/](?:claude_|openai\.codex_)/i.test(commandLine);
}

function isDesktopAppHelper({ commandLine }) {
  // Chromium renderer and crash-reporting children belong to desktop apps, not CLI sessions.
  return /(?:^|\s)--type=/i.test(commandLine) || /crashpad/i.test(commandLine);
}

function isCodexHelper({ agent, commandLine }) {
  // Codex app-server and sandbox subprocesses support a CLI session but are not sessions themselves.
  return agent === "codex" && /^(?:app-server|sandbox)(?:\s|$)/i.test(commandArguments(commandLine));
}

function isClaudePrintRun({ agent, commandLine }) {
  // Claude print mode is headless and has no terminal session to relaunch.
  return agent === "claude" && /(?:^|\s)(?:--print|-p)(?=\s|$)/i.test(commandLine);
}

const nonResumableAgentPredicates = [
  isDesktopAppProcess,
  isDesktopAppHelper,
  isCodexHelper,
  isClaudePrintRun,
];

function isNonResumable(agent, commandLine) {
  return nonResumableAgentPredicates.some((predicate) => predicate({ agent, commandLine }));
}

export function countWindowsAgentProcesses(processes) {
  const entries = Array.isArray(processes)
    ? processes
    : processes && typeof processes === "object"
      ? [processes]
      : [];
  const counts = { claude: 0, codex: 0 };

  for (const processInfo of entries) {
    if (typeof processInfo?.CommandLine !== "string" || !processInfo.CommandLine.trim()) continue;
    const name = String(processInfo?.Name || "").toLowerCase();
    const agent = name === "claude.exe" ? "claude" : name === "codex.exe" ? "codex" : null;
    if (!agent || isNonResumable(agent, processInfo.CommandLine)) continue;
    counts[agent] += 1;
  }

  return counts;
}

function executableName(commandLine) {
  const executable = commandLine.trim().match(/^(?:"([^"]*)"|'([^']*)'|(\S+))/);
  const path = executable?.[1] || executable?.[2] || executable?.[3] || "";
  return path.split(/[\\/]/).pop().toLowerCase();
}

export function countPosixAgentProcesses(lines, ignorePath) {
  const entries = Array.isArray(lines)
    ? lines
    : typeof lines === "string"
      ? lines.split(/\r?\n/)
      : [];
  const counts = { claude: 0, codex: 0 };

  for (const line of entries) {
    if (typeof line !== "string") continue;
    const commandLine = line.trim();
    if (!commandLine || (ignorePath && commandLine.includes(ignorePath))) continue;
    const executable = executableName(commandLine);
    const agent = executable === "claude" ? "claude" : executable === "codex" ? "codex" : null;
    if (!agent || isNonResumable(agent, commandLine)) continue;
    counts[agent] += 1;
  }

  return counts;
}
