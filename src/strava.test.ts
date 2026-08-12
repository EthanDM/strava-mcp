import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import type { StravaEnv } from "./env.js";
import { StravaClient } from "./strava.js";

function environment(tokenFile: string): StravaEnv {
  return {
    clientId: "client-id",
    clientSecret: "client-secret",
    refreshToken: "initial-refresh-token",
    tokenFile,
    grantedScopes: ["activity:read", "profile:read_all"],
  };
}

describe("StravaClient", () => {
  it("refreshes, persists rotated credentials, and sends the access token", async () => {
    const directory = await mkdtemp(join(tmpdir(), "strava-mcp-test-"));
    const tokenFile = join(directory, "nested", "auth.json");
    const originalFetch = globalThis.fetch;
    const requests: Array<{ url: string; authorization?: string }> = [];
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;

    globalThis.fetch = async (input, init) => {
      const url = String(input);
      requests.push({
        url,
        authorization:
          new Headers(init?.headers).get("authorization") ?? undefined,
      });

      if (url === "https://www.strava.com/oauth/token") {
        return Response.json({
          access_token: "fresh-access-token",
          refresh_token: "rotated-refresh-token",
          expires_at: expiresAt,
        });
      }

      return Response.json([{ id: 123 }], {
        headers: {
          "x-ratelimit-limit": "200,2000",
          "x-ratelimit-usage": "3,10",
          "x-readratelimit-limit": "100,1000",
          "x-readratelimit-usage": "2,8",
        },
      });
    };

    try {
      const client = new StravaClient(environment(tokenFile));
      assert.deepEqual(await client.getRecentActivities({ after: 1 }), [
        { id: 123 },
      ]);

      assert.equal(requests[1].authorization, "Bearer fresh-access-token");
      assert.deepEqual(client.getRateLimitStatus(), {
        overall: {
          shortWindow: { limit: 200, usage: 3 },
          day: { limit: 2000, usage: 10 },
        },
        read: {
          shortWindow: { limit: 100, usage: 2 },
          day: { limit: 1000, usage: 8 },
        },
      });
      assert.deepEqual(JSON.parse(await readFile(tokenFile, "utf8")), {
        accessToken: "fresh-access-token",
        refreshToken: "rotated-refresh-token",
        expiresAt,
      });
    } finally {
      globalThis.fetch = originalFetch;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("surfaces Strava API failures with observed rate-limit context", async () => {
    const directory = await mkdtemp(join(tmpdir(), "strava-mcp-test-"));
    const originalFetch = globalThis.fetch;

    globalThis.fetch = async (input) => {
      if (String(input) === "https://www.strava.com/oauth/token") {
        return Response.json({
          access_token: "access-token",
          refresh_token: "refresh-token",
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        });
      }

      return new Response("Too many requests", {
        status: 429,
        headers: {
          "x-ratelimit-limit": "100,1000",
          "x-ratelimit-usage": "100,201",
        },
      });
    };

    try {
      const client = new StravaClient(
        environment(join(directory, "auth.json")),
      );
      await assert.rejects(
        client.getAthleteProfile(),
        /429 Too many requests.*100\/100/,
      );
    } finally {
      globalThis.fetch = originalFetch;
      await rm(directory, { recursive: true, force: true });
    }
  });
});
