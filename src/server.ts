import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

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
    },
    annotations: {
      readOnlyHint: true,
    },
  },
  async ({ id }) => jsonResult(await strava.getActivity(id)),
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

/** Stdio transport lets Codex launch this process on demand from `~/.codex/config.toml`. */
const transport = new StdioServerTransport();
await server.connect(transport);
