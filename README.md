# Strava MCP

Small read-only MCP server for personal Strava data.

## Setup

Copy the env template:

```bash
cp .env.example .env
```

Fill in:

```bash
STRAVA_CLIENT_ID=...
STRAVA_CLIENT_SECRET=...
STRAVA_REFRESH_TOKEN=...
STRAVA_TOKEN_FILE=/absolute/path/to/strava-mcp/.strava-token.json
```

Install and verify:

```bash
npm install
npm run check
```

Run locally:

```bash
npm run dev
```

## Tools

- `strava_recent_activities`
- `strava_athlete_profile`
- `strava_activity_detail`
- `strava_activity_streams`
- `strava_athlete_stats`

## Codex MCP config

Use an absolute path for this repo on your machine:

```toml
[mcp_servers.strava]
command = "node"
args = ["/absolute/path/to/strava-mcp/dist/server.js"]
```

Keep this read-only unless you intentionally add write scopes and write tools.

`STRAVA_TOKEN_FILE` is optional but recommended. Strava can rotate refresh tokens, and the server writes the newest token there after refresh.

Local exports are ignored by git. Use them for audits, but do not treat them as source files.
