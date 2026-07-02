import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

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
  async ({ maxPages, ...input }) => {
    const activities = await strava.fetchActivities(inputWithMaxPages(input.after, input.before, maxPages));
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
  async ({ maxPages, ...input }) => {
    const activities = await strava.fetchActivities(inputWithMaxPages(input.after, input.before, maxPages));
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
  async ({ maxPages, ...input }) => {
    const activities = await strava.fetchActivities(inputWithMaxPages(input.after, input.before, maxPages));
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
  async ({ maxPages, ...input }) => {
    const activities = await strava.fetchActivities(inputWithMaxPages(input.after, input.before, maxPages));
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

/** Stdio transport lets Codex launch this process on demand from `~/.codex/config.toml`. */
const transport = new StdioServerTransport();
await server.connect(transport);
