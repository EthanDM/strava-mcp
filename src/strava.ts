import { readFile, writeFile } from "node:fs/promises";

import type { StravaEnv } from "./env.js";

/** Base URL for Strava's read API; OAuth refresh uses a separate endpoint. */
const STRAVA_API_BASE_URL = "https://www.strava.com/api/v3";

/** Token refresh payload fields the client persists or uses for subsequent API calls. */
type TokenResponse = {
  access_token: string;
  refresh_token: string;
  expires_at: number;
};

/** Local token cache format; missing access tokens force a refresh while preserving the newest refresh token. */
type StoredToken = {
  accessToken?: string;
  refreshToken: string;
  expiresAt?: number;
};

/** Cursor inputs for Strava's paginated activity list endpoint. */
export type RecentActivitiesInput = {
  /** Unix timestamp upper bound; omitted means Strava's default latest-first window. */
  before?: number;
  /** Unix timestamp lower bound; use this for date-range summaries to avoid fetching full history. */
  after?: number;
  /** One-based Strava page number. */
  page?: number;
  /** Strava allows up to 100 activities per page. */
  perPage?: number;
};

/** Stream lookup options for activity samples. */
export type ActivityStreamsInput = {
  /** Strava activity id visible to the authenticated athlete. */
  id: number;
  /** Optional stream key allowlist; an empty or omitted value uses the training-analysis defaults. */
  keys?: string[];
  /** Keep enabled when callers want stable object keys instead of positional stream arrays. */
  keyByType?: boolean;
};

/**
 * Small read-only Strava API adapter for MCP tools.
 *
 * The client owns token refresh and rotated-token persistence so tool handlers can stay stateless.
 */
export class StravaClient {
  /** Cached bearer token for the current MCP process; refreshed before expiry. */
  private accessToken: string | undefined;
  /** Unix expiry for `accessToken`; zero forces an immediate refresh. */
  private expiresAt = 0;
  /** Newest known refresh token, initially from env and later from `tokenFile` or refresh responses. */
  private refreshToken: string;
  /** Prevents repeatedly reading `tokenFile` on every tool call after startup. */
  private loadedTokenFile = false;

  /** Create a client around already-validated Strava credentials. */
  constructor(private readonly env: StravaEnv) {
    this.refreshToken = env.refreshToken;
  }

  /**
   * Fetch recent activities in Strava's default reverse-chronological order.
   *
   * @throws Error when token refresh or the Strava activity endpoint fails.
   */
  async getRecentActivities(input: RecentActivitiesInput) {
    const params = new URLSearchParams();

    if (input.before) params.set("before", String(input.before));
    if (input.after) params.set("after", String(input.after));
    params.set("page", String(input.page ?? 1));
    params.set("per_page", String(input.perPage ?? 20));

    return this.get(`/athlete/activities?${params.toString()}`);
  }

  /**
   * Fetch the authenticated athlete profile.
   *
   * @throws Error when token refresh or the Strava profile endpoint fails.
   */
  async getAthleteProfile() {
    return this.get("/athlete");
  }

  /**
   * Fetch detailed activity metadata for one activity visible to the authenticated athlete.
   *
   * @throws Error when token refresh fails, the id is inaccessible, or Strava rejects the request.
   */
  async getActivity(id: number) {
    return this.get(`/activities/${id}`);
  }

  /**
   * Fetch sample streams for one activity, defaulting to the streams most useful for training analysis.
   *
   * @throws Error when token refresh fails, the activity is inaccessible, or requested stream keys are invalid.
   */
  async getActivityStreams(input: ActivityStreamsInput) {
    const keys = input.keys?.length
      ? input.keys
      : ["time", "distance", "altitude", "heartrate", "cadence", "watts", "latlng"];

    const params = new URLSearchParams({
      keys: keys.join(","),
      key_by_type: String(input.keyByType ?? true),
    });

    return this.get(`/activities/${input.id}/streams?${params.toString()}`);
  }

  /**
   * Fetch Strava's aggregate athlete stats for an athlete id.
   *
   * @throws Error when token refresh fails or the authenticated athlete cannot access the requested stats.
   */
  async getAthleteStats(athleteId: number) {
    return this.get(`/athletes/${athleteId}/stats`);
  }

  /**
   * Perform an authenticated Strava GET and surface API failures as MCP-visible errors.
   *
   * @throws Error when Strava returns a non-2xx response or token refresh fails.
   */
  private async get(path: string) {
    const token = await this.getAccessToken();
    const response = await fetch(`${STRAVA_API_BASE_URL}${path}`, {
      headers: {
        authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      throw new Error(`Strava API request failed: ${response.status} ${await response.text()}`);
    }

    return response.json();
  }

  /**
   * Return a usable access token, refreshing and persisting rotated credentials when needed.
   *
   * @throws Error when the token cache is invalid JSON or Strava rejects the refresh token.
   */
  private async getAccessToken() {
    await this.loadStoredToken();

    const now = Math.floor(Date.now() / 1000);

    if (this.accessToken && this.expiresAt - 60 > now) {
      return this.accessToken;
    }

    const token = await this.refreshAccessToken();
    this.accessToken = token.access_token;
    this.expiresAt = token.expires_at;
    this.refreshToken = token.refresh_token;
    await this.saveStoredToken();

    return this.accessToken;
  }

  /**
   * Load the optional token cache once per process so refreshed tokens survive Codex restarts.
   *
   * @throws Error when the configured cache exists but cannot be read or parsed.
   */
  private async loadStoredToken() {
    if (this.loadedTokenFile || !this.env.tokenFile) return;

    this.loadedTokenFile = true;

    try {
      const stored = JSON.parse(await readFile(this.env.tokenFile, "utf8")) as StoredToken;
      this.accessToken = stored.accessToken;
      this.refreshToken = stored.refreshToken;
      this.expiresAt = stored.expiresAt ?? 0;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  /**
   * Persist the newest token set with owner-only file permissions.
   *
   * @throws Error when the configured cache path cannot be written.
   */
  private async saveStoredToken() {
    if (!this.env.tokenFile) return;

    const stored: StoredToken = {
      accessToken: this.accessToken,
      refreshToken: this.refreshToken,
      expiresAt: this.expiresAt,
    };

    await writeFile(this.env.tokenFile, `${JSON.stringify(stored, null, 2)}\n`, {
      mode: 0o600,
    });
  }

  /**
   * Exchange the newest refresh token for a short-lived access token.
   *
   * @throws Error when Strava rejects the client credentials or refresh token.
   */
  private async refreshAccessToken(): Promise<TokenResponse> {
    const response = await fetch("https://www.strava.com/oauth/token", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: this.env.clientId,
        client_secret: this.env.clientSecret,
        refresh_token: this.refreshToken,
        grant_type: "refresh_token",
      }),
    });

    if (!response.ok) {
      throw new Error(`Strava token refresh failed: ${response.status} ${await response.text()}`);
    }

    return response.json();
  }
}
