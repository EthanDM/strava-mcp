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
STRAVA_GRANTED_SCOPES=read,activity:read,activity:read_all,profile:read_all
```

Install and verify:

```bash
npm install
npm run check
npm test
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
- `strava_gear_detail`
- `strava_athlete_zones`
- `strava_activity_zones`
- `strava_activity_laps`
- `strava_rate_limit_status`
- `strava_sync_activities`
- `strava_cache_status`
- `strava_activity_summary`
- `strava_gear_usage`
- `strava_activity_search`
- `strava_export_activities`

## Common Codex workflows

Sync activity history into the ignored local cache:

```json
{
  "after": 1648771200,
  "maxPages": 20
}
```

Query from cache only after a sync:

```json
{
  "after": 1648771200,
  "sportTypes": ["MountainBikeRide", "Ride"],
  "groupBy": "month",
  "source": "cache"
}
```

Use `source` on bounded analysis and export tools:

- `cache_then_api` uses local cache when covered, then syncs missing history if needed. This is the default.
- `cache` never calls Strava and fails clearly if the cache does not cover the range.
- `api` calls Strava directly and does not require cache coverage.

Export an audit snapshot from the same resolved activity set:

```json
{
  "after": 1648771200,
  "sportTypes": ["MountainBikeRide", "Ride"],
  "source": "cache"
}
```

Inspect local cache/rate-limit metadata with `strava_cache_status`, `strava_rate_limit_status`, or the MCP resource `strava://cache/status`.

For long activities, prefer compact streams:

```json
{
  "id": 123456789,
  "keys": ["time", "distance", "heartrate", "latlng"],
  "maxPoints": 500
}
```

## Codex MCP config

Use an absolute path for this repo on your machine:

```toml
[mcp_servers.strava]
command = "node"
args = ["/absolute/path/to/strava-mcp/dist/server.js"]
```

Keep this read-only unless you intentionally add write scopes and write tools.

`STRAVA_TOKEN_FILE` is optional but recommended. Strava can rotate refresh tokens, and the server writes the newest token there after refresh.

`STRAVA_GRANTED_SCOPES` is optional but recommended. Copy the comma-separated `scope` value from the OAuth callback URL so scope errors fail locally with a clear message.

Ignored local data:

- `.strava-token.json`: rotated OAuth token cache.
- `exports/cache/activities.json`: local activity-history cache.
- `exports/*.json` and `exports/*.csv`: raw and compact audit exports.

Local exports are ignored by git. Use them for audits, but do not treat them as source files.
