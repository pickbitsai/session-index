# Session Index

<p align="center">
  <img src="assets/session-index-mascot.png" width="180" alt="Session Index archivist robot mascot">
</p>

A small, dependency-free dashboard for finding, resuming, and following up on local Codex and Claude Code sessions.

Session Index runs on your machine, listens only on localhost, and has no telemetry, account, cloud database, remote assets, or third-party requests. Local discovery is opt-in on first run.

## Quick start

Node.js 18 or newer is required.

```powershell
npm start
```

Open `http://127.0.0.1:4173`, review the privacy explanation, then choose a manual scan or enable automatic scans.

## What it does

- Discovers Codex and Claude Code sessions whose recorded working directory is under the configured project root.
- Copies the correct resume command: `codex resume <id>` or `claude --resume <id>`.
- Matches CLI-set terminal-window titles to local sessions; renamed tabs and untitled sessions can be assigned once and remembered in the browser. The confirmed set can then be relaunched after a restart, with recent activity and copyable commands as fallbacks.
- Filters by agent, project folder, follow-up status, review-queue status, and search text.
- **Mission control**: states the standing routing objective (Claude plans/reviews, paid-for engines execute,
  downsize checkpoint Aug 19, 2026) and meters each engine's 7-day utilization — Claude token load and
  Fable/Opus share, Codex weekly-quota percentage (read from the newest local rollout's rate-limit snapshot),
  a manual Jules task counter, and local Ollama model status. Utilization is numbers-only: no prompt text is
  read into the metering results.
- **Routing lens**: flags "off-plan" sessions (long execution loops running on a planning-tier Claude model)
  directly in the session list.
- **Review queue**: mark any session "awaiting review" so executor output waits in a visible inbox.
- Lets you rename a session and replace its generated summary without losing those edits on the next scan.
- Stores a private next-step note with any follow-up session.
- Shows available local metadata such as model, context usage, log size, effort, branch, and turn/message count.
- Imports and exports a JSON backup.

## Remember and relaunch a workspace

Use **Remember open sessions** before restarting. On Windows, Session Index enumerates visible top-level windows owned by recognized terminal hosts and matches CLI-set titles to scanned sessions. Claude task titles are matched directly after removing leading status glyphs; Codex folder-leaf titles are matched to session working folders. **Open windows** is the default source when this probe is available, and every matched session starts ticked.

The dialog reports the total terminal-window count, matched sessions, unidentified terminal titles, and terminal windows ignored as non-agent processes. A Windows Terminal tab renamed by the user no longer contains a detectable project or session name, and an untitled CLI session may report only `claude` or `codex`; either can be assigned once to an unmatched local session and the manual claim is then remembered in this browser. A remembered assignment is never silently redirected: if its session leaves the scanned list, the dialog marks it stale and offers Reassign or Forget. When no unmatched local session log exists (for example, a remote session or a folder outside `SESSION_SCAN_ROOT`), the window cannot be assigned or relaunched from Session Index. The raw window list stays on the server. You can switch to **Recently active** to use the existing 1, 4, 12, or 24 hour last-activity window. On macOS, Linux, or when the Windows probe fails, the source toggle is hidden and recently active sessions are used as the fallback.

When you return, the saved-workspace banner can relaunch the confirmed sessions in separate terminals. **Review** shows each launch result. If terminal launching is disabled or unavailable, **Copy all commands** produces one folder-prefixed resume command per line so you can paste the block into a shell yourself.

## Where discovery looks

By default, Windows projects are filtered to `C:\new`; other platforms use `~/new`. Session logs are read from:

> **Metering scope note:** the Mission Control utilization endpoint (`/api/usage`) aggregates token counts
> across the **full** local Codex and Claude stores (subscription caps are account-wide, so partial metering
> would mislead). It extracts numbers, model names, timestamps, and rate-limit snapshots only — never prompt
> text. It also probes Ollama at `127.0.0.1:11434` (override with `OLLAMA_HOST_URL`); that is a same-machine
> request, and the app still makes no network requests.

- Codex: `%USERPROFILE%\.codex\sessions` (or `$CODEX_HOME/sessions`)
- Claude Code: `%USERPROFILE%\.claude\projects` (or `$CLAUDE_CONFIG_DIR/projects`)

Only sessions whose own recorded working directory is inside the project root are returned to the page. Configure discovery with environment variables:

| Variable | Purpose | Default |
| --- | --- | --- |
| `SESSION_SCAN_ROOT` | Allowed project tree | `C:\new` on Windows, `~/new` elsewhere |
| `SESSION_SCAN_LIMIT` | Maximum results shown in the session list, from 1 to 250 | `80` |
| `SESSION_LOOKUP_LIMIT` | Maximum sessions checked for window matching and relaunch, from 1 to 2000 | `500` |
| `CODEX_HOME` | Codex data directory | `%USERPROFILE%\.codex` |
| `CLAUDE_CONFIG_DIR` | Claude Code data directory | `%USERPROFILE%\.claude` |
| `SESSION_LAUNCH` | Terminal launching: `on`, `off`, or validation-only `dry-run` | `on` |
| `PORT` | Local HTTP port | `4173` |

PowerShell example:

```powershell
$env:SESSION_SCAN_ROOT = 'D:\projects'
npm start
```

## Where the displayed text comes from

- Codex names and summaries use the first useful user prompt in the local session log.
- Claude Code uses its recorded AI title when present. Its summary prefers the recorded last prompt, then falls back to the first useful user prompt.
- Environment wrappers and setup instructions are excluded, whitespace is compacted, and excerpts are capped at 240 characters.

Rename or edit a discovered session to create a browser-local override. Later scans refresh the detected data and metadata while preserving your name, summary, follow-up state, and note.

Metadata differs by provider and CLI version. Codex usually records model, effort, context window, and latest-turn token use. Claude usually records model, branch, and latest input/cache use but may not record a context-window size. Counts are shown only when they can be read cheaply and reliably; missing fields are hidden instead of estimated.

## Data and safety

The server binds to `127.0.0.1`, rejects unexpected Host and Origin headers, serves only files inside this project, and makes no outbound network requests. Browser data is stored under the `session-index.sessions.v1`, `session-index.workspace.v1`, and `session-index.window-map.v1` localStorage keys. JSON exports can contain prompt excerpts and notes, so treat them as private.

Read [PRIVACY.md](PRIVACY.md) for the exact data flow and [SECURITY.md](SECURITY.md) for the security model and reporting process.

## Development

There are no runtime packages to install.

```powershell
npm test
npm run check
```

See [CONTRIBUTING.md](CONTRIBUTING.md) before submitting a change. In particular, never commit real session logs or transcripts as fixtures.

## License

[MIT](LICENSE)
