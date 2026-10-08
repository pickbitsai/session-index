# Privacy

Session Index is designed to be inspectable and local-only. It has no telemetry, analytics, account system, cloud database, remote fonts, advertisements, or outbound HTTP requests.

## What the local server reads

When you press **Scan projects**, or after you explicitly enable auto-scan, the server reads JSONL session logs from the configured Codex and Claude Code profile directories. It extracts only the fields needed by the list:

- provider and session ID;
- recorded working directory and activity time (the newer of file modification time and valid log-record timestamps);
- a detected title and a prompt excerpt of at most 240 characters;
- available model, token/context, effort, branch, count, and log-size metadata.

The response excludes sessions whose recorded working directory is outside `SESSION_SCAN_ROOT`. Parsing currently reads a bounded prefix and tail of each candidate log; it does not copy full transcripts into browser storage.

For Codex, the detected summary is the first useful user prompt. For Claude Code, it prefers the provider's `last-prompt` record and otherwise uses the first useful user prompt. Environment and setup wrappers are filtered out.

## What open-window detection reads

On Windows, opening **Remember open sessions**, or running the enabled live-session heartbeat, makes the local server inspect visible top-level windows owned only by recognized terminal-host processes. It reads those terminal window titles together with each window's process ID and local process name; titles belonging to all other applications are filtered out before they can enter the server process. Terminal window titles can contain task descriptions. Session Index uses them only to match open terminal windows to the scanned session list.

Window-probe results are cached in server memory for up to twenty seconds. The larger session lookup used for matching and relaunch validation is warmed in the background at server start and cached for fifteen seconds. These caches remain in memory; the heartbeat writes only the selected matched-session fields and counts described below. The raw terminal-window list never leaves the server. The workspace dialog receives matched session details, counts, and unmatched terminal titles only; every title shown under **Windows needing assignment** belongs to a recognized terminal host. Nothing is sent outside the local Session Index page. macOS and Linux do not attempt window enumeration; the dialog falls back to recently active sessions.

## What the live-session snapshot stores

While the server runs on Windows, macOS, or Linux, the heartbeat writes `live-sessions.json` containing a format version (`version: 1`), save time (`savedAt`), operating-system boot time (`bootAt`), matched sessions (`sessions`), unidentified-window count (`unidentifiedCount`), valid Codex lock-ID count before matching (`lockCount`), window-probe status (`windowProbe`, `ok` or `unavailable`), and running-agent counts (`processCounts.claude` and `processCounts.codex`, or null when unavailable). Each session stores only its agent, session ID, detected title from the session log, folder, activity time, and evidence source (`agent`, `sessionId`, `title`, `folder`, `activityAt`, `source: "window" | "lock"`). Older snapshots without `lockCount`, `windowProbe`, or `source` remain readable. No raw window titles, process IDs, process names, or command lines are written. Detected session titles can contain prompt-derived text. Failed Windows probes retain previous window evidence for at most ten minutes since the last successful probe and cannot count as session closures.

On every platform, the heartbeat also reads only file names in Codex's `<CODEX_HOME>/thread-writer-locks` directory to learn which Codex sessions are open, including desktop-app sessions with no terminal window and TUI windows titled only `codex`. It ignores dotfiles such as `.coordination.lock`, non-`.lock` names, and invalid session IDs. No lock file content is read (the files are empty), and nothing from a lock name beyond the session ID is stored. Lock IDs must match Codex sessions in the current scan; unknown IDs and sessions outside `SESSION_SCAN_ROOT` are dropped. The snapshot merges these sessions with Windows terminal matches without duplicating a session.

The files stay on this machine in `SESSION_STATE_DIR`, defaulting to `%LOCALAPPDATA%\SessionIndex` on Windows (or `%USERPROFILE%\AppData\Local\SessionIndex` if `LOCALAPPDATA` is missing) and `~/.local/state/session-index` elsewhere. A live write first uses `live-sessions.json.tmp`, then atomically renames it. Startup copies qualifying pre-boot evidence to `live-sessions.prev-boot.json`, which restart detection reads and checks against the current boot and shutdown time. It does not copy transcripts or browser notes.

Set `SESSION_LIVENESS=off` to disable heartbeat collection and writes. Existing snapshot files remain local and can still supply restart evidence; disabling the heartbeat does not delete them. The default interval is 60 seconds (`SESSION_LIVENESS_INTERVAL_MS`, minimum 15 seconds), with unchanged session lists refreshed after five minutes. Lock-based heartbeats run on every platform; terminal window enumeration remains Windows-only.

## What restart detection reads

The `/api/restart` endpoint compares session last-activity times with the current boot time reported by the local operating system and merges qualifying entries from the preserved live-session snapshot. On Windows only, a best-effort probe reads up to ten recent shutdown records from the local System event log to obtain their times, event IDs, planned statuses, and initiating processes. Records no more than fifteen minutes apart are treated as one reboot sequence; its earliest event supplies the effective shutdown time and short reason, and the response includes the sequence count. These fields are used only to match the interruption evidence and explain the restart. The probe does not require elevation, does not read prompt text, makes no network requests, and is cached in server memory for five minutes. If the shutdown probe is unavailable, boot time supplies the snapshot's age reference and the activity-cluster baseline. Without a qualifying snapshot, restart detection uses log activity alone.

## What closed-together detection stores

`closures.json` stays locally in the same `SESSION_STATE_DIR`. Its version-one records contain `closedAt`, evidence sources (`activity` and/or `snapshot`), and each affected session's agent, session ID, title, folder, and activity time. It stores up to ten closure events from the last seven days, with no transcripts or browser notes; titles can contain prompt-derived text. Writes use `closures.json.tmp` followed by atomic rename and occur only when content changes. Recorded sessions remain in the event after resuming, allowing `/api/closures` to report resumed counts while omitting them from the pending list.

Detection reads the existing scanned logs' interactive markers and activity times, plus changes in local live-session snapshots. Activity clusters exclude batch and unknown sessions. The endpoint also checks current window matches and Codex lock filenames. Everything stays on this machine. `SESSION_LIVENESS=off` prevents closure-file writes while still allowing on-demand detection and reading existing evidence. The browser stores only the last 20 dismissed `closedAt` values under `session-index.closures.v1`.

## What the utilization endpoint reads

The Mission Control panel (`/api/usage`) streams the **full** local Codex and Claude stores — not just
`SESSION_SCAN_ROOT` — because subscription limits are account-wide and partial numbers would mislead. It
extracts only token counts, model names, message timestamps, project folder names, and Codex rate-limit
snapshots. No prompt or response text is parsed into its results. It also probes a local Ollama instance at
`127.0.0.1:11434` (models installed and running); this is a same-machine request. Utilization aggregates are
kept in server memory, not written to disk.

## What the browser stores

Saved sessions, detected excerpts, custom names and summaries, follow-up state, review-queue state, and follow-up notes are stored in browser localStorage under `session-index.sessions.v1`. A remembered workspace is stored under `session-index.workspace.v1`; it contains the save time, selected source, recent-activity window, and the selected agents, session IDs, titles, folders, and activity times. It does not store raw window titles. User-made normalized window-title to session assignments are stored under `session-index.window-map.v1`, including the chosen agent and session ID, the remembered session title, and the assignment time. These assignments stay in the browser and are not sent back to the server. Dismissing an interrupted-session banner stores only that interruption timestamp under `session-index.restart.v1`, allowing a later restart to show a new banner. The auto-scan choice is stored under `session-index.auto-scan.v1`, and the manual Jules weekly task count under `session-index.jules-tasks.v1`.

Use **Clear all** to remove saved session data from the app, and **Discard** on the workspace banner to remove the remembered workspace. Browser site-data controls can remove all localStorage keys. A manual scan remains available when auto-scan is disabled.

## Process and window checks, and terminal launching

The running-agent endpoint performs a separate best-effort local process probe. It reads process names and command lines only to distinguish running `claude` and `codex` CLIs from similarly named desktop or helper processes. It returns and briefly caches counts only; command lines are never sent to the browser or stored. The workspace dialog uses the visible-window probe described above as its primary source instead of treating process counts as sessions.

The local launch endpoint starts a terminal with only the fixed `claude --resume <session-id>` or `codex resume <session-id>` command. The working folder comes from a fresh server-side session scan, never from the browser request, and must still be an existing directory inside `SESSION_SCAN_ROOT`.

## Data leaving the machine

The process probe, restart probe, session scan, and terminal launch all remain on the same machine. The app makes zero outbound network requests. Its HTTP server binds to `127.0.0.1` and accepts only matching localhost Host and Origin values. The Content Security Policy allows connections and assets from the same local origin only.

Exported JSON is downloaded by the browser and may contain prompt excerpts, local folder paths, session IDs, custom notes, and resume information. Store and share exports with the same care as the underlying session logs.

## Scope

Session Index is a convenience view over local developer-tool logs, not a security boundary for a shared operating-system account. Any process or person already able to read your profile directories or browser profile may be able to read the same underlying information.
