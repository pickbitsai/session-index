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
- Filters by agent, project folder, follow-up status, and search text.
- Lets you rename a session and replace its generated summary without losing those edits on the next scan.
- Stores a private next-step note with any follow-up session.
- Shows available local metadata such as model, context usage, log size, effort, branch, and turn/message count.
- Imports and exports a JSON backup.

## Where discovery looks

By default, Windows projects are filtered to `C:\new`; other platforms use `~/new`. Session logs are read from:

- Codex: `%USERPROFILE%\.codex\sessions` (or `$CODEX_HOME/sessions`)
- Claude Code: `%USERPROFILE%\.claude\projects` (or `$CLAUDE_CONFIG_DIR/projects`)

Only sessions whose own recorded working directory is inside the project root are returned to the page. Configure discovery with environment variables:

| Variable | Purpose | Default |
| --- | --- | --- |
| `SESSION_SCAN_ROOT` | Allowed project tree | `C:\new` on Windows, `~/new` elsewhere |
| `SESSION_SCAN_LIMIT` | Maximum results, from 1 to 250 | `80` |
| `CODEX_HOME` | Codex data directory | `%USERPROFILE%\.codex` |
| `CLAUDE_CONFIG_DIR` | Claude Code data directory | `%USERPROFILE%\.claude` |
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

The server binds to `127.0.0.1`, rejects unexpected Host and Origin headers, serves only files inside this project, and makes no outbound network requests. Browser data is stored under the `session-index.sessions.v1` localStorage key. JSON exports can contain prompt excerpts and notes, so treat them as private.

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
