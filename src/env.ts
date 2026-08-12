import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { config } from "dotenv";

/** Load Strava credentials from this package's `.env` no matter which cwd starts the MCP process. */
config({ path: fileURLToPath(new URL("../.env", import.meta.url)) });

/** Runtime credentials used by the Strava client; `tokenFile` persists rotated refresh tokens between MCP restarts. */
export type StravaEnv = {
  /** OAuth app client id from the Strava developer settings page. */
  clientId: string;
  /** OAuth app client secret; keep this local because every tool call can refresh tokens with it. */
  clientSecret: string;
  /** Initial refresh token from the one-time OAuth approval flow. */
  refreshToken: string;
  /** JSON cache path that becomes the source of truth after Strava rotates refresh tokens. */
  tokenFile: string;
  /** Optional granted OAuth scopes from the auth callback; used for clearer endpoint errors. */
  grantedScopes?: string[];
};

/**
 * Read and validate Strava MCP configuration from process env.
 *
 * @throws Error when required credentials are missing before the MCP server can service any tool call.
 */
export function getStravaEnv(): StravaEnv {
  return {
    clientId: requireEnv("STRAVA_CLIENT_ID"),
    clientSecret: requireEnv("STRAVA_CLIENT_SECRET"),
    refreshToken: requireEnv("STRAVA_REFRESH_TOKEN"),
    tokenFile:
      process.env.STRAVA_TOKEN_FILE?.trim() ||
      join(getStravaDataDir(), "auth.json"),
    grantedScopes: parseScopes(process.env.STRAVA_GRANTED_SCOPES),
  };
}

/** Return the private local directory used for credentials, cache data, and exports. */
export function getStravaDataDir() {
  return (
    process.env.STRAVA_DATA_DIR?.trim() ||
    join(homedir(), ".config", "strava-mcp")
  );
}

/** Parse comma- or space-separated OAuth scopes copied from Strava's callback URL. */
function parseScopes(value: string | undefined): string[] | undefined {
  const scopes = value
    ?.split(/[\s,]+/)
    .map((scope) => scope.trim())
    .filter(Boolean);

  return scopes?.length ? scopes : undefined;
}

/**
 * Return a configured environment value after converting blank strings into actionable startup errors.
 *
 * @throws Error when the variable is unset or blank.
 */
function requireEnv(name: string): string {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }

  return value;
}
