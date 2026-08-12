import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { StravaActivity } from "./analysis.js";
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

/** Latest Strava rate-limit headers observed by this process. */
export type RateLimitStatus = {
  overall?: {
    shortWindow: {
      limit: number;
      usage: number;
    };
    day: {
      limit: number;
      usage: number;
    };
  };
  read?: {
    shortWindow: {
      limit: number;
      usage: number;
    };
    day: {
      limit: number;
      usage: number;
    };
  };
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

/** Paginated date-range fetch options for tools that need local aggregation. */
export type FetchActivitiesInput = {
  /** Unix timestamp lower bound; required to avoid accidental full-history pulls. */
  after: number;
  /** Optional Unix timestamp upper bound. */
  before?: number;
  /** Safety stop for large backfills; defaults to enough pages for ordinary personal analysis. */
  maxPages?: number;
};

/** Stream lookup options for activity samples. */
export type ActivityStreamsInput = {
  /** Strava activity id visible to the authenticated athlete. */
  id: number;
  /** Optional stream key allowlist; an empty or omitted value uses the training-analysis defaults. */
  keys?: string[];
  /** Keep enabled when callers want stable object keys instead of positional stream arrays. */
  keyByType?: boolean;
  /** Optional point cap per stream; omitted preserves Strava's raw stream payload. */
  maxPoints?: number;
  /** Include the raw stream payload alongside compacted output when `maxPoints` is set. */
  includeRaw?: boolean;
};

/** Metadata describing how one stream was compacted for MCP output. */
type CompactedStreamMetadata = {
  type: string;
  originalPoints: number;
  returnedPoints: number;
  downsampled: boolean;
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
  /** Last rate-limit snapshot observed on a Strava API response. */
  private rateLimitStatus: RateLimitStatus | undefined;

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
    this.requireScopes(["activity:read"]);

    const params = new URLSearchParams();

    if (input.before) params.set("before", String(input.before));
    if (input.after) params.set("after", String(input.after));
    params.set("page", String(input.page ?? 1));
    params.set("per_page", String(input.perPage ?? 20));

    return this.get(`/athlete/activities?${params.toString()}`);
  }

  /**
   * Fetch every visible activity in a bounded date range for local summarization.
   *
   * @throws Error when token refresh fails, Strava rejects a page, or `maxPages` is exhausted.
   */
  async fetchActivities(
    input: FetchActivitiesInput,
  ): Promise<StravaActivity[]> {
    const activities: StravaActivity[] = [];
    const maxPages = input.maxPages ?? 20;

    for (let page = 1; page <= maxPages; page += 1) {
      this.assertReadRateLimitAvailable();
      const batch = (await this.getRecentActivities({
        after: input.after,
        before: input.before,
        page,
        perPage: 100,
      })) as StravaActivity[];

      activities.push(...batch);

      if (batch.length < 100) {
        return activities;
      }
    }

    throw new Error(
      `Stopped after ${maxPages} pages; narrow the date range or raise maxPages.`,
    );
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
  async getActivity(id: number, includeAllEfforts = false) {
    this.requireScopes(["activity:read"]);

    const params = new URLSearchParams();
    if (includeAllEfforts) params.set("include_all_efforts", "true");
    const query = params.size ? `?${params.toString()}` : "";

    return this.get(`/activities/${id}${query}`);
  }

  /**
   * Fetch sample streams for one activity, defaulting to the streams most useful for training analysis.
   *
   * @throws Error when token refresh fails, the activity is inaccessible, or requested stream keys are invalid.
   */
  async getActivityStreams(input: ActivityStreamsInput) {
    this.requireScopes(["activity:read"]);

    const keys = input.keys?.length
      ? input.keys
      : [
          "time",
          "distance",
          "altitude",
          "heartrate",
          "cadence",
          "watts",
          "latlng",
        ];

    const params = new URLSearchParams({
      keys: keys.join(","),
      key_by_type: String(input.keyByType ?? true),
    });

    const streams = await this.get(
      `/activities/${input.id}/streams?${params.toString()}`,
    );

    if (!input.maxPoints) {
      return streams;
    }

    return compactStreams(streams, input.maxPoints, input.includeRaw ?? false);
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
   * Fetch detail for a Strava gear id, useful when activity payloads only include `gear_id`.
   *
   * @throws Error when token refresh fails or the gear is inaccessible to the authenticated athlete.
   */
  async getGear(id: string) {
    return this.get(`/gear/${encodeURIComponent(id)}`);
  }

  /**
   * Fetch the authenticated athlete's configured heart-rate and power zones.
   *
   * @throws Error when `profile:read_all` was not granted or Strava rejects the request.
   */
  async getAthleteZones() {
    this.requireScopes(["profile:read_all"]);

    return this.get("/athlete/zones");
  }

  /**
   * Fetch Strava's zone distribution for one visible activity.
   *
   * @throws Error when the activity is inaccessible, zones are unavailable, or Strava rejects the request.
   */
  async getActivityZones(id: number) {
    this.requireScopes(["activity:read"]);

    return this.get(`/activities/${id}/zones`);
  }

  /**
   * Fetch laps for one visible activity.
   *
   * @throws Error when the activity is inaccessible or Strava rejects the request.
   */
  async getActivityLaps(id: number) {
    this.requireScopes(["activity:read"]);

    return this.get(`/activities/${id}/laps`);
  }

  /** Return the latest rate-limit headers observed by this MCP process. */
  getRateLimitStatus() {
    return this.rateLimitStatus ?? null;
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
    this.rateLimitStatus = parseRateLimitHeaders(response.headers);

    if (!response.ok) {
      throw new Error(
        `Strava API request failed: ${response.status} ${await response.text()}${formatRateLimitStatus(
          this.rateLimitStatus,
        )}`,
      );
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
    if (this.loadedTokenFile) return;

    this.loadedTokenFile = true;

    try {
      const stored = JSON.parse(
        await readFile(this.env.tokenFile, "utf8"),
      ) as StoredToken;
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
    const stored: StoredToken = {
      accessToken: this.accessToken,
      refreshToken: this.refreshToken,
      expiresAt: this.expiresAt,
    };

    await mkdir(dirname(this.env.tokenFile), { recursive: true });
    await writeFile(
      this.env.tokenFile,
      `${JSON.stringify(stored, null, 2)}\n`,
      {
        mode: 0o600,
      },
    );
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
      throw new Error(
        `Strava token refresh failed: ${response.status} ${await response.text()}`,
      );
    }

    return response.json();
  }

  /**
   * Fail before calling Strava when the copied auth callback proves a required scope is absent.
   *
   * Scopes are optional in config because older local setups may not have recorded the callback URL.
   */
  private requireScopes(requiredScopes: string[]) {
    if (!this.env.grantedScopes?.length) return;

    const missing = requiredScopes.filter(
      (scope) => !this.env.grantedScopes?.includes(scope),
    );
    if (!missing.length) return;

    throw new Error(
      `Missing Strava OAuth scope(s): ${missing.join(", ")}. Re-run auth with the required scope(s).`,
    );
  }

  /**
   * Stop paginated backfills before the next request would likely cross Strava's short read window.
   *
   * Strava still counts rejected short-window requests toward daily usage, so the client fails fast instead of
   * probing into a 429.
   */
  private assertReadRateLimitAvailable() {
    const readWindow = this.rateLimitStatus?.read?.shortWindow;
    if (!readWindow?.limit) return;

    if (readWindow.usage / readWindow.limit < 0.95) return;

    throw new Error(
      `Strava read rate limit is near exhausted (${readWindow.usage}/${readWindow.limit}). Retry after the next 15-minute boundary.`,
    );
  }
}

/** Return compact stream data plus per-stream point counts while preserving raw output when requested. */
function compactStreams(
  streams: unknown,
  maxPoints: number,
  includeRaw: boolean,
) {
  const metadata: CompactedStreamMetadata[] = [];
  const compacted = Array.isArray(streams)
    ? streams.map((stream, index) =>
        compactStream(stream, String(index), maxPoints, metadata),
      )
    : Object.fromEntries(
        Object.entries(streams as Record<string, unknown>).map(
          ([type, stream]) => [
            type,
            compactStream(stream, type, maxPoints, metadata),
          ],
        ),
      );

  return {
    streams: compacted,
    metadata,
    ...(includeRaw ? { rawStreams: streams } : {}),
  };
}

/** Compact only the `data` array; keep Strava's surrounding stream fields intact for caller compatibility. */
function compactStream(
  stream: unknown,
  fallbackType: string,
  maxPoints: number,
  metadata: CompactedStreamMetadata[],
): unknown {
  if (
    !stream ||
    typeof stream !== "object" ||
    !Array.isArray((stream as { data?: unknown }).data)
  ) {
    metadata.push({
      type: fallbackType,
      originalPoints: 0,
      returnedPoints: 0,
      downsampled: false,
    });
    return stream;
  }

  const typedStream = stream as { type?: string; data: unknown[] };
  const data = downsampleEvenly(typedStream.data, maxPoints);

  metadata.push({
    type: typedStream.type ?? fallbackType,
    originalPoints: typedStream.data.length,
    returnedPoints: data.length,
    downsampled: data.length < typedStream.data.length,
  });

  return {
    ...typedStream,
    data,
  };
}

/** Evenly sample arrays while retaining endpoints so long activities keep their full span. */
function downsampleEvenly<T>(values: T[], maxPoints: number): T[] {
  if (values.length <= maxPoints) return values;
  if (maxPoints <= 1) return values.slice(0, 1);

  const lastIndex = values.length - 1;
  const indexes = new Set<number>();

  for (let index = 0; index < maxPoints; index += 1) {
    indexes.add(Math.round((index * lastIndex) / (maxPoints - 1)));
  }

  return Array.from(indexes)
    .sort((a, b) => a - b)
    .map((index) => values[index]);
}

/** Parse a Strava limit header value like `200,2000` or usage value like `14,91`. */
function parseLimitPair(value: string | null): [number, number] | undefined {
  if (!value) return undefined;

  const [shortWindow, dayWindow] = value.split(",").map((part) => Number(part));
  if (!Number.isFinite(shortWindow) || !Number.isFinite(dayWindow))
    return undefined;

  return [shortWindow, dayWindow];
}

/** Capture Strava's standard overall and read-specific rate-limit headers. */
function parseRateLimitHeaders(headers: Headers): RateLimitStatus | undefined {
  const overallLimit = parseLimitPair(headers.get("x-ratelimit-limit"));
  const overallUsage = parseLimitPair(headers.get("x-ratelimit-usage"));
  const readLimit = parseLimitPair(headers.get("x-readratelimit-limit"));
  const readUsage = parseLimitPair(headers.get("x-readratelimit-usage"));

  return {
    overall:
      overallLimit && overallUsage
        ? {
            shortWindow: {
              limit: overallLimit[0],
              usage: overallUsage[0],
            },
            day: {
              limit: overallLimit[1],
              usage: overallUsage[1],
            },
          }
        : undefined,
    read:
      readLimit && readUsage
        ? {
            shortWindow: {
              limit: readLimit[0],
              usage: readUsage[0],
            },
            day: {
              limit: readLimit[1],
              usage: readUsage[1],
            },
          }
        : undefined,
  };
}

/** Add compact rate-limit context to API errors without exposing response payloads twice. */
function formatRateLimitStatus(status: RateLimitStatus | undefined): string {
  const parts = [];
  if (status?.overall) {
    parts.push(
      `overall ${status.overall.shortWindow.usage}/${status.overall.shortWindow.limit}`,
    );
  }
  if (status?.read)
    parts.push(
      `read ${status.read.shortWindow.usage}/${status.read.shortWindow.limit}`,
    );

  return parts.length ? `; rate limit: ${parts.join(", ")}` : "";
}
