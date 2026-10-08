# Security policy

## Supported versions

Security fixes are applied to the latest version on the default branch.

## Reporting a vulnerability

Please do not open a public issue containing session data, local paths, tokens, or exploit details. Use GitHub Private Vulnerability Reporting when it is enabled for the repository. If it is unavailable, contact the maintainer through a private channel listed on the repository owner's profile and include a minimal reproduction with synthetic data.

You should receive an acknowledgement within seven days. Please allow time for a fix before public disclosure.

## Security model

The server is intended for one user on one machine. It binds only to `127.0.0.1`, validates Host and Origin headers, prevents static-file path traversal, and adds a restrictive Content Security Policy. It does not authenticate local users and should not be exposed through a reverse proxy, port-forward, tunnel, or public network interface.

The server has one process-spawning route, `POST /api/launch`. It is protected by a per-process token obtained from same-origin `/api/config`, a strict required `Origin` check, and a session ID allowlist regex. The working folder is looked up from the server's own session scan, confined to `SESSION_SCAN_ROOT`, and rechecked as an existing directory. Terminal programs and fixed resume commands are passed as argument arrays without shell interpolation or `shell: true`. Set `SESSION_LAUNCH=off` to disable the endpoint entirely; `dry-run` validates requests and returns the command without spawning a process.

Session logs and JSON exports may contain sensitive prompts and paths. Do not attach real logs to bug reports; create a small synthetic fixture instead.
