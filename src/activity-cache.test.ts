import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  getActivityCacheStatus,
  getCachedActivities,
  getCoveredBefore,
  isRangeCovered,
  recordSyncWindow,
  resolveActivityRange,
  type ActivityCache,
} from "./activity-cache.js";

function cache(): ActivityCache {
  return {
    schemaVersion: 1,
    updatedAt: null,
    activitiesById: {},
    syncWindows: [],
  };
}

describe("activity cache coverage", () => {
  it("treats adjacent sync windows as one covered range", () => {
    const activityCache = cache();
    recordSyncWindow(activityCache, { after: 100, before: 200 }, 1);
    recordSyncWindow(activityCache, { after: 200, before: 300 }, 1);

    assert.equal(getCoveredBefore(activityCache, 100), 300);
    assert.equal(
      isRangeCovered(activityCache, { after: 100, before: 300 }),
      true,
    );
  });

  it("does not bridge gaps between sync windows", () => {
    const activityCache = cache();
    recordSyncWindow(activityCache, { after: 100, before: 150 }, 1);
    recordSyncWindow(activityCache, { after: 200, before: 300 }, 1);

    assert.equal(getCoveredBefore(activityCache, 100), 150);
    assert.equal(
      isRangeCovered(activityCache, { after: 100, before: 300 }),
      false,
    );
  });

  it("resolves open-ended ranges to a concrete timestamp", () => {
    const resolved = resolveActivityRange({ after: 100 });

    assert.equal(resolved.after, 100);
    assert.equal(typeof resolved.before, "number");
    assert.ok(resolved.before >= 100);
  });
});

describe("activity cache status and filtering", () => {
  it("reports oldest/newest dates without exposing activity payloads", () => {
    const activityCache = cache();
    activityCache.activitiesById = {
      "1": { id: 1, start_date: "2026-01-02T00:00:00Z" },
      "2": { id: 2, start_date: "2026-01-01T00:00:00Z" },
    };

    const status = getActivityCacheStatus(activityCache);

    assert.equal(status.activityCount, 2);
    assert.equal(status.oldestActivityDate, "2026-01-01T00:00:00Z");
    assert.equal(status.newestActivityDate, "2026-01-02T00:00:00Z");
    assert.equal("activitiesById" in status, false);
  });

  it("returns cached activities newest first inside the requested range", () => {
    const activityCache = cache();
    activityCache.activitiesById = {
      "1": { id: 1, start_date: "2026-01-01T00:00:00Z" },
      "2": { id: 2, start_date: "2026-01-03T00:00:00Z" },
      "3": { id: 3, start_date: "2025-12-01T00:00:00Z" },
    };

    const rows = getCachedActivities(activityCache, {
      after: Date.UTC(2026, 0, 1) / 1000,
      before: Date.UTC(2026, 0, 4) / 1000,
    });

    assert.deepEqual(
      rows.map((activity) => activity.id),
      [2, 1],
    );
  });
});
