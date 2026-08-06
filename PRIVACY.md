# Privacy

Session Index is designed to be inspectable and local-only. It has no telemetry, analytics, account system, cloud database, remote fonts, advertisements, or outbound HTTP requests.

## What the local server reads

When you press **Scan projects**, or after you explicitly enable auto-scan, the server reads JSONL session logs from the configured Codex and Claude Code profile directories. It extracts only the fields needed by the list:

- provider and session ID;
- recorded working directory and last-modified time;
- a detected title and a prompt excerpt of at most 240 characters;
- available model, token/context, effort, branch, count, and log-size metadata.

The response excludes sessions whose recorded working directory is outside `SESSION_SCAN_ROOT`. Parsing currently reads a bounded prefix and tail of each candidate log; it does not copy full transcripts into browser storage.

For Codex, the detected summary is the first useful user prompt. For Claude Code, it prefers the provider's `last-prompt` record and otherwise uses the first useful user prompt. Environment and setup wrappers are filtered out.

## What open-window detection reads

On Windows, opening **Remember open sessions** makes the local server inspect visible top-level windows owned only by recognized terminal-host processes. It reads those terminal window titles together with each window's process ID and local process name; titles belonging to all other applications are filtered out before they can enter the server process. Terminal window titles can contain task descriptions. Session Index uses them only to match open terminal windows to the scanned session list.

Window-probe results are cached in server memory for up to twenty seconds. The larger session lookup used for matching and relaunch validation is warmed in the background at server start and cached for fifteen seconds. Neither cache is written to disk. The raw terminal-window list never leaves the server. The workspace dialog receives matched session details, counts, and unmatched terminal titles only; every title shown under **Windows needing assignment** belongs to a recognized terminal host. Nothing is sent outside the local Session Index page. macOS and Linux do not attempt window enumeration; the dialog falls back to recently active sessions.

## What the utilization endpoint reads

The Mission Control panel (`/api/usage`) streams the **full** local Codex and Claude stores — not just
`SESSION_SCAN_ROOT` — because subscription limits are account-wide and partial numbers would mislead. It
extracts only token counts, model names, message timestamps, project folder names, and Codex rate-limit
snapshots. No prompt or response text is parsed into its results. It also probes a local Ollama instance at
`127.0.0.1:11434` (models installed and running); this is a same-machine request. Utilization aggregates are
kept in server memory, not written to disk.

## What the browser stores

Saved sessions, detected excerpts, custom names and summaries, follow-up state, review-queue state, and follow-up notes are stored in browser localStorage under `session-index.sessions.v1`. A remembered workspace is stored under `session-index.workspace.v1`; it contains the save time, selected source, recent-activity window, and the selected agents, session IDs, titles, folders, and activity times. It does not store raw window titles. User-made normalized window-title to session assignments are stored under `session-index.window-map.v1`, including the chosen agent and session ID, the remembered session title, and the assignment time. These assignments stay in the browser and are not sent back to the server. The auto-scan choice is stored under `session-index.auto-scan.v1`, and the manual Jules weekly task count under `session-index.jules-tasks.v1`.

Use **Clear all** to remove saved session data from the app, and **Discard** on the workspace banner to remove the remembered workspace. Browser site-data controls can remove all localStorage keys. A manual scan remains available when auto-scan is disabled.

## Process and window checks, and terminal launching

The running-agent endpoint performs a separate best-effort local process probe. It reads process names and command lines only to distinguish running `claude` and `codex` CLIs from similarly named desktop or helper processes. It returns and briefly caches counts only; command lines are never sent to the browser or stored. The workspace dialog uses the visible-window probe described above as its primary source instead of treating process counts as sessions.

The local launch endpoint starts a terminal with only the fixed `claude --resume <session-id>` or `codex resume <session-id>` command. The working folder comes from a fresh server-side session scan, never from the browser request, and must still be an existing directory inside `SESSION_SCAN_ROOT`.

## Data leaving the machine

The process probe, session scan, and terminal launch all remain on the same machine. The app makes zero outbound network requests. Its HTTP server binds to `127.0.0.1` and accepts only matching localhost Host and Origin values. The Content Security Policy allows connections and assets from the same local origin only.

Exported JSON is downloaded by the browser and may contain prompt excerpts, local folder paths, session IDs, custom notes, and resume information. Store and share exports with the same care as the underlying session logs.

## Scope

Session Index is a convenience view over local developer-tool logs, not a security boundary for a shared operating-system account. Any process or person already able to read your profile directories or browser profile may be able to read the same underlying information.
