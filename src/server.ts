import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  getActivityCacheStatus,
  getCachedActivities,
  getCoveredBefore,
  isRangeCovered,
  loadActivityCache,
  recordSyncWindow,
  resolveActivityRange,
  saveActivityCache,
  type ActivityRange,
  type ActivitySource,
  upsertActivities,
} from "./activity-cache.js";
import { exportActivities, searchActivities, summarizeActivities, summarizeGearUsage } from "./analysis.js";
import { getStravaEnv } from "./env.js";
import { StravaClient } from "./strava.js";

/** Shared Strava adapter for the MCP process; it handles token refresh across tool calls. */
const strava = new StravaClient(getStravaEnv());

/** Stdio MCP server exposing read-only personal Strava data tools. */
const server = new McpServer({
  name: "strava-mcp",
  version: "0.1.0",
});

server.registerTool(
  "strava_recent_activities",
  {
    description: "List the authenticated athlete's recent Strava activities.",
    inputSchema: {
      before: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Unix timestamp. Return activities before this time."),
      after: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Unix timestamp. Return activities after this time."),
      page: z.number().int().positive().optional().describe("Result page. Defaults to 1."),
      perPage: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("Results per page. Defaults to 20."),
    },
    annotations: {
      readOnlyHint: true,
    },
  },
  async (input) => jsonResult(await strava.getRecentActivities(input)),
);

server.registerTool(
  "strava_athlete_profile",
  {
    description: "Fetch the authenticated Strava athlete profile.",
    annotations: {
      readOnlyHint: true,
    },
  },
  async () => jsonResult(await strava.getAthleteProfile()),
);

server.registerTool(
  "strava_activity_detail",
  {
    description: "Fetch detailed data for one Strava activity.",
    inputSchema: {
      id: z.number().int().positive().describe("Strava activity id."),
      includeAllEfforts: z.boolean().optional().describe("Include all segment efforts when Strava exposes them."),
    },
    annotations: {
      readOnlyHint: true,
    },
  },
  async ({ id, includeAllEfforts }) => jsonResult(await strava.getActivity(id, includeAllEfforts)),
);

server.registerTool(
  "strava_activity_streams",
  {
    description:
      "Fetch activity stream samples such as time, distance, altitude, heartrate, cadence, watts, and lat/lng.",
    inputSchema: {
      id: z.number().int().positive().describe("Strava activity id."),
      keys: z
        .array(z.string())
        .optional()
        .describe("Optional stream keys. Defaults to time,distance,altitude,heartrate,cadence,watts,latlng."),
      keyByType: z.boolean().optional().describe("Return streams keyed by type. Defaults to true."),
      maxPoints: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Optional maximum points per stream. Omit for Strava's full raw stream payload."),
      includeRaw: z
        .boolean()
        .optional()
        .describe("When maxPoints is set, also include the full raw stream payload. Defaults to false."),
    },
    annotations: {
      readOnlyHint: true,
    },
  },
  async (input) => jsonResult(await strava.getActivityStreams(input)),
);

server.registerTool(
  "strava_athlete_stats",
  {
    description: "Fetch aggregate stats for a Strava athlete id.",
    inputSchema: {
      athleteId: z.number().int().positive().describe("Strava athlete id."),
    },
    annotations: {
      readOnlyHint: true,
    },
  },
  async ({ athleteId }) => jsonResult(await strava.getAthleteStats(athleteId)),
);

server.registerTool(
  "strava_gear_detail",
  {
    description: "Fetch detail for one Strava gear id.",
    inputSchema: {
      id: z.string().min(1).describe("Strava gear id, such as b123456."),
    },
    annotations: {
      readOnlyHint: true,
    },
  },
  async ({ id }) => jsonResult(await strava.getGear(id)),
);

server.registerTool(
  "strava_athlete_zones",
  {
    description: "Fetch the authenticated athlete's heart-rate and power zones.",
    annotations: {
      readOnlyHint: true,
    },
  },
  async () => jsonResult(await strava.getAthleteZones()),
);

server.registerTool(
  "strava_activity_zones",
  {
    description: "Fetch zone distribution for one Strava activity.",
    inputSchema: {
      id: z.number().int().positive().describe("Strava activity id."),
    },
    annotations: {
      readOnlyHint: true,
    },
  },
  async ({ id }) => jsonResult(await strava.getActivityZones(id)),
);

server.registerTool(
  "strava_activity_laps",
  {
    description: "Fetch laps for one Strava activity.",
    inputSchema: {
      id: z.number().int().positive().describe("Strava activity id."),
    },
    annotations: {
      readOnlyHint: true,
    },
  },
  async ({ id }) => jsonResult(await strava.getActivityLaps(id)),
);

server.registerTool(
  "strava_rate_limit_status",
  {
    description: "Show Strava API rate-limit headers last observed by this MCP process.",
    annotations: {
      readOnlyHint: true,
    },
  },
  async () => jsonResult(strava.getRateLimitStatus()),
);

server.registerTool(
  "strava_sync_activities",
  {
    description: "Fetch bounded Strava activity history into the local ignored activity cache.",
    inputSchema: {
      after: z
        .number()
        .int()
        .positive()
        .describe("Unix timestamp lower bound for the sync window."),
      before: z.number().int().positive().optional().describe("Optional Unix timestamp upper bound."),
      maxPages: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe("Maximum Strava activity-list pages to fetch. Defaults to 20."),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
  },
  async ({ after, before, maxPages }) => jsonResult(await syncActivities({ after, before }, maxPages)),
);

server.registerTool(
  "strava_cache_status",
  {
    description: "Show local Strava activity cache coverage and metadata.",
    annotations: {
      readOnlyHint: true,
    },
  },
  async () => {
    const cache = await loadActivityCache();
    return jsonResult({
      ...getActivityCacheStatus(cache),
      rateLimitStatus: strava.getRateLimitStatus(),
    });
  },
);

server.registerResource(
  "strava-cache-status",
  "strava://cache/status",
  {
    title: "Strava Cache Status",
    description: "Metadata-only status for the local Strava activity cache and latest observed rate limits.",
    mimeType: "application/json",
  },
  async (uri) => {
    const cache = await loadActivityCache();

    return {
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(
            {
              ...getActivityCacheStatus(cache),
              rateLimitStatus: strava.getRateLimitStatus(),
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

const activitySourceSchema = z
  .enum(["cache_then_api", "cache", "api"])
  .optional()
  .describe("Activity source. Defaults to cache_then_api.");
const OPEN_ENDED_CACHE_FRESH_SECONDS = 15 * 60;

const activityFilterSchema = {
  after: z
    .number()
    .int()
    .positive()
    .describe("Unix timestamp lower bound. Required so summaries do not accidentally fetch full history."),
  before: z.number().int().positive().optional().describe("Optional Unix timestamp upper bound."),
  sportTypes: z
    .array(z.string())
    .optional()
    .describe("Optional Strava sport_type allowlist, such as Run, TrailRun, Ride, or MountainBikeRide."),
  gearIds: z.array(z.string()).optional().describe("Optional Strava gear_id allowlist."),
  maxPages: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe("Maximum Strava activity-list pages to fetch. Defaults to 20."),
  source: activitySourceSchema,
};

server.registerTool(
  "strava_activity_summary",
  {
    description: "Summarize activities by day, Monday-start week, or month for a bounded date range.",
    inputSchema: {
      ...activityFilterSchema,
      groupBy: z.enum(["day", "week", "month"]).describe("Time bucket for grouped totals."),
      includeEmptyBuckets: z.boolean().optional().describe("Include zero-mile buckets inside the date range."),
    },
    annotations: {
      readOnlyHint: true,
    },
  },
  async ({ maxPages, source, ...input }) => {
    const activities = await resolveActivities(input, source, maxPages);
    return jsonResult(summarizeActivities(activities, input));
  },
);

server.registerTool(
  "strava_gear_usage",
  {
    description: "Group activity mileage, hours, and elevation by gear id for service-interval audits.",
    inputSchema: activityFilterSchema,
    annotations: {
      readOnlyHint: true,
    },
  },
  async ({ maxPages, source, ...input }) => {
    const activities = await resolveActivities(input, source, maxPages);
    return jsonResult(summarizeGearUsage(activities, input));
  },
);

server.registerTool(
  "strava_activity_search",
  {
    description: "Search bounded activity history by name, sport type, gear, distance, and elevation.",
    inputSchema: {
      ...activityFilterSchema,
      query: z.string().optional().describe("Case-insensitive search over activity name and sport type."),
      minDistanceMiles: z.number().nonnegative().optional().describe("Minimum activity distance in miles."),
      maxDistanceMiles: z.number().nonnegative().optional().describe("Maximum activity distance in miles."),
      minElevationFeet: z.number().nonnegative().optional().describe("Minimum elevation gain in feet."),
      limit: z.number().int().min(1).max(100).optional().describe("Maximum compact rows returned. Defaults to 25."),
    },
    annotations: {
      readOnlyHint: true,
    },
  },
  async ({ maxPages, source, ...input }) => {
    const activities = await resolveActivities(input, source, maxPages);
    return jsonResult(searchActivities(activities, input));
  },
);

server.registerTool(
  "strava_export_activities",
  {
    description: "Export bounded activity history to ignored local raw JSON, compact JSON, and CSV audit files.",
    inputSchema: activityFilterSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
  },
  async ({ maxPages, source, ...input }) => {
    const activities = await resolveActivities(input, source, maxPages);
    return jsonResult(await exportActivities(activities, input));
  },
);

/** Format Strava payloads as readable JSON text because Codex currently consumes these tools conversationally. */
function jsonResult(data: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}

/** Build the Strava page-fetch request while keeping local filters out of API parameters. */
function inputWithMaxPages(after: number, before: number | undefined, maxPages: number | undefined) {
  return {
    after,
    before,
    maxPages,
  };
}

/** Resolve bounded activity history from cache, Strava, or cache-backed sync depending on caller intent. */
async function resolveActivities(
  input: ActivityRange,
  source: ActivitySource | undefined,
  maxPages: number | undefined,
) {
  const selectedSource = source ?? "cache_then_api";
  const range = resolveActivityRange(input);

  if (selectedSource === "api") {
    return strava.fetchActivities(inputWithMaxPages(range.after, range.before, maxPages));
  }

  const cache = await loadActivityCache();
  const coveredBefore = getCoveredBefore(cache, range.after);
  const cacheRange =
    input.before === undefined && coveredBefore > range.after ? { after: range.after, before: coveredBefore } : range;
  if (isRangeCovered(cache, cacheRange) && (input.before !== undefined || selectedSource === "cache")) {
    return getCachedActivities(cache, cacheRange);
  }
  if (
    input.before === undefined &&
    selectedSource === "cache_then_api" &&
    isRangeCovered(cache, cacheRange) &&
    range.before - cacheRange.before <= OPEN_ENDED_CACHE_FRESH_SECONDS
  ) {
    return getCachedActivities(cache, cacheRange);
  }

  if (selectedSource === "cache") {
    throw new Error(
      `Local Strava activity cache does not cover ${range.after}-${range.before}. Run strava_sync_activities or use source=cache_then_api.`,
    );
  }

  const syncAfter = coveredBefore > range.after ? coveredBefore : range.after;
  await syncActivities({ after: syncAfter, before: range.before }, maxPages);
  return getCachedActivities(await loadActivityCache(), range);
}

/** Fetch a bounded activity range, merge it into the local cache, and return sync metadata. */
async function syncActivities(input: ActivityRange, maxPages: number | undefined) {
  const range = resolveActivityRange(input);
  const activities = await strava.fetchActivities(inputWithMaxPages(range.after, range.before, maxPages));
  const cache = await loadActivityCache();
  const changed = upsertActivities(cache, activities);
  recordSyncWindow(cache, range, activities.length);
  await saveActivityCache(cache);

  return {
    fetchedCount: activities.length,
    upsertedCount: changed,
    ...getActivityCacheStatus(cache),
    rateLimitStatus: strava.getRateLimitStatus(),
  };
}

/** Stdio transport lets Codex launch this process on demand from `~/.codex/config.toml`. */
const transport = new StdioServerTransport();
await server.connect(transport);
