import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, it } from "node:test";

describe("MCP server", () => {
  it("starts over stdio and exposes the documented read-only tools", async () => {
    const client = new Client({ name: "strava-mcp-test", version: "0.1.0" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["dist/server.js"],
      env: {
        STRAVA_CLIENT_ID: "test-client-id",
        STRAVA_CLIENT_SECRET: "test-client-secret",
        STRAVA_REFRESH_TOKEN: "test-refresh-token",
        STRAVA_DATA_DIR: "/tmp/strava-mcp-test-data",
      },
    });

    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      const toolNames = tools.map((tool) => tool.name);

      assert.ok(toolNames.includes("strava_recent_activities"));
      assert.ok(toolNames.includes("strava_activity_search"));
      assert.ok(toolNames.includes("strava_export_activities"));
    } finally {
      await client.close();
    }
  });
});
