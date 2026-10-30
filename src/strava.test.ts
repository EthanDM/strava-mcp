import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
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

  it("coordinates concurrent clients using the same token file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "strava-mcp-test-"));
    const tokenFile = join(directory, "auth.json");
    const originalFetch = globalThis.fetch;
    let refreshes = 0;
    globalThis.fetch = async (input) => {
      if (String(input) === "https://www.strava.com/oauth/token") {
        refreshes += 1;
        await new Promise((resolve) => setTimeout(resolve, 150));
        return Response.json({
          access_token: "shared-access",
          refresh_token: "rotated-refresh",
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        });
      }
      return Response.json({ id: 123 });
    };
    try {
      const first = new StravaClient(environment(tokenFile));
      const second = new StravaClient(environment(tokenFile));
      await Promise.all([
        first.getAthleteProfile(),
        second.getAthleteProfile(),
      ]);
      assert.equal(refreshes, 1);
      assert.equal(
        JSON.parse(await readFile(tokenFile, "utf8")).refreshToken,
        "rotated-refresh",
      );
    } finally {
      globalThis.fetch = originalFetch;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("serializes token refresh across separate server processes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "strava-mcp-process-"));
    const tokenFile = join(directory, "auth.json");
    const callsFile = join(directory, "refresh-calls");
    const worker = `
      import { appendFile } from "node:fs/promises";
      import { StravaClient } from ${JSON.stringify(new URL("./strava.js", import.meta.url).href)};
      const [tokenFile, callsFile] = process.argv.slice(1);
      globalThis.fetch = async (input) => {
        if (String(input).endsWith("/oauth/token")) {
          await appendFile(callsFile, "refresh\\n");
          await new Promise(resolve => setTimeout(resolve, 250));
          return Response.json({access_token: "access", refresh_token: "rotated", expires_at: Math.floor(Date.now()/1000)+3600});
        }
        return Response.json({id: 1});
      };
      await new StravaClient({clientId:"id",clientSecret:"secret",refreshToken:"initial",tokenFile}).getAthleteProfile();
    `;
    try {
      const run = promisify(execFile);
      await Promise.all([
        run(process.execPath, [
          "--input-type=module",
          "-e",
          worker,
          tokenFile,
          callsFile,
        ]),
        run(process.execPath, [
          "--input-type=module",
          "-e",
          worker,
          tokenFile,
          callsFile,
        ]),
      ]);
      assert.equal(await readFile(callsFile, "utf8"), "refresh\n");
      assert.equal(
        JSON.parse(await readFile(tokenFile, "utf8")).refreshToken,
        "rotated",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("retains the lock when a token exchange has an uncertain outcome", async () => {
    const directory = await mkdtemp(join(tmpdir(), "strava-mcp-test-"));
    const tokenFile = join(directory, "auth.json");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error("connection lost");
    };
    try {
      const client = new StravaClient(environment(tokenFile));
      await assert.rejects(client.getAthleteProfile(), /connection lost/);
      assert.equal(
        (await stat(`${tokenFile}.refresh-lock`)).isDirectory(),
        true,
      );
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
