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

## What the browser stores

Saved sessions, detected excerpts, custom names and summaries, follow-up state, and follow-up notes are stored in browser localStorage under `session-index.sessions.v1`. The auto-scan choice is stored under `session-index.auto-scan.v1`.

Use **Clear all** to remove saved session data from the app. Browser site-data controls can remove both keys. A manual scan remains available when auto-scan is disabled.

## Data leaving the machine

The app makes no outbound network requests. Its HTTP server binds to `127.0.0.1` and accepts only matching localhost Host and Origin values. The Content Security Policy allows connections and assets from the same local origin only.

Exported JSON is downloaded by the browser and may contain prompt excerpts, local folder paths, session IDs, custom notes, and resume information. Store and share exports with the same care as the underlying session logs.

## Scope

Session Index is a convenience view over local developer-tool logs, not a security boundary for a shared operating-system account. Any process or person already able to read your profile directories or browser profile may be able to read the same underlying information.
