# Strava MCP

Small, read-only local MCP server for querying your own Strava data from Codex. It uses Strava's API on behalf of one authenticated athlete; it is not a hosted or multi-user service.

## Requirements

- Node.js 22+
- A Strava API application and an account authorized for its requested read scopes

## Quick Start

1. Create a Strava API application in the [Strava API settings](https://www.strava.com/settings/api).
2. Complete the OAuth flow described below and copy the resulting refresh token.
3. Copy the environment template:

```bash
cp .env.example .env
```

Fill in:

```bash
STRAVA_CLIENT_ID=...
STRAVA_CLIENT_SECRET=...
STRAVA_REFRESH_TOKEN=...
STRAVA_GRANTED_SCOPES=read,activity:read,activity:read_all,profile:read_all
```

4. Install and verify:

```bash
npm install
npm run check
npm test
```

5. Build and run locally:

```bash
npm run build
npm start
```

Use `npm run dev` only while developing.

## OAuth Setup

This server intentionally has no browser-auth CLI: Strava's authorization flow is one-time setup, and the server refreshes and persists tokens afterward.

1. Set your app's authorization callback domain in Strava's API settings. For a local manual flow, use a loopback callback such as `localhost`.
2. Open an authorization URL using your client id and the scopes below. Replace `<client-id>` and `<redirect-uri>`:

```text
https://www.strava.com/oauth/authorize?client_id=<client-id>&response_type=code&redirect_uri=<redirect-uri>&approval_prompt=force&scope=read,activity:read_all,profile:read_all
```

3. After approval, exchange the returned `code` at `https://www.strava.com/oauth/token` with your client id, client secret, authorization code, and `grant_type=authorization_code`.
4. Put the returned `refresh_token` in `STRAVA_REFRESH_TOKEN`. Copy the callback's granted `scope` value into `STRAVA_GRANTED_SCOPES`.

The server stores rotated access and refresh tokens in `~/.config/strava-mcp/auth.json` by default. Set `STRAVA_DATA_DIR` to move all local Strava state elsewhere, or set `STRAVA_TOKEN_FILE` only when the credential cache must live at a specific path.

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

Use absolute paths for your clone:

```toml
[mcp_servers.strava]
command = "node"
args = ["/absolute/path/to/strava-mcp/dist/server.js"]
```

Keep this read-only unless you intentionally add write scopes and write tools.

`STRAVA_TOKEN_FILE` is optional. Strava can rotate refresh tokens, and the server writes the newest token to `STRAVA_DATA_DIR/auth.json` by default.

`STRAVA_GRANTED_SCOPES` is optional but recommended. Copy the comma-separated `scope` value from the OAuth callback URL so scope errors fail locally with a clear message.

Private local data lives outside the repository:

- `auth.json`: rotated OAuth token cache.
- `cache/activities.json`: local activity-history cache.
- `exports/*.json` and `exports/*.csv`: raw and compact audit exports.

By default these are under `~/.config/strava-mcp`. Use them for local audits, but do not add them to Git.

## Development

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for project scope and contribution guidance.
