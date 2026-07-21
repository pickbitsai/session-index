# Contributing

Thanks for helping make Session Index useful and trustworthy.

## Setup

Use Node.js 18 or newer. The app has no runtime dependencies.

```powershell
npm test
npm start
```

## Pull requests

Keep changes small, explain user-visible behavior, and add or update tests for security or parsing changes. Run `npm test` and `npm run check` before opening a pull request.

Privacy is part of the product contract:

- do not add telemetry, analytics, remote assets, or outbound requests;
- do not commit real session logs, prompts, user names, home paths, or session IDs;
- use synthetic JSONL fixtures if a parser test needs data;
- preserve first-run consent for automatic profile scanning;
- hide unavailable metadata instead of guessing it.

Avoid new dependencies unless the benefit clearly outweighs the additional install and supply-chain surface.
