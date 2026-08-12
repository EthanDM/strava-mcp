# AGENTS.md

Keep this a small, portable, read-only Strava MCP. Prefer direct TypeScript and a narrow MCP surface.

- Never commit `.env` files, OAuth tokens, activity caches, exports, athlete identifiers, or personal filesystem paths.
- Keep credentials and durable local data under `STRAVA_DATA_DIR` (default: `~/.config/strava-mcp`).
- Use `npm run check` and `npm test` before publishing changes.
- Add behavior-focused tests when changing the Strava client, cache, or MCP tool registrations.
