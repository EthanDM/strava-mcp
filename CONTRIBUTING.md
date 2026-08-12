# Contributing

## Scope

Keep this a small, read-only local Strava MCP. Do not add write scopes or activity mutations without a concrete use case.

## Setup

1. Use Node.js 22 or newer.
2. Copy `.env.example` to `.env` and complete the OAuth setup in the README.
3. Run `npm ci`.

## Verification

Run before opening a pull request:

```bash
npm run check
npm test
```

Live Strava calls are not part of automated verification. Keep unit and transport tests deterministic; do not add real credentials, tokens, activity exports, or personal paths to the repository.

## Change Guidelines

- Keep MCP responses bounded and explicitly read-only.
- Store credentials, caches, and exports under `STRAVA_DATA_DIR`, never in the repository.
- Update the README when tool behavior or required scopes change.
- Add focused tests for client behavior, cache behavior, and MCP registration when applicable.
