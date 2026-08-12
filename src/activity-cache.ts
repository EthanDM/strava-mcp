import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { filterActivities, type StravaActivity } from "./analysis.js";
import { getStravaDataDir } from "./env.js";

const CACHE_SCHEMA_VERSION = 1;

/** Private local cache path, outside the repository so activity history cannot be committed accidentally. */
export const ACTIVITY_CACHE_PATH = `${getStravaDataDir()}/cache/activities.json`;

/** Cache-backed tools either trust local history, force Strava, or fill gaps before analysis. */
export type ActivitySource = "cache_then_api" | "cache" | "api";

/** Completed list-fetch window; `before` is resolved at sync time so open-ended syncs do not imply future coverage. */
export type ActivitySyncWindow = {
  after: number;
  before: number;
  fetchedAt: string;
  count: number;
};

/** Persisted activity cache keyed by Strava activity id. */
export type ActivityCache = {
  schemaVersion: number;
  updatedAt: string | null;
  activitiesById: Record<string, StravaActivity>;
  syncWindows: ActivitySyncWindow[];
};

/** Range used for cache coverage checks and local activity selection. */
export type ActivityRange = {
  after: number;
  before?: number;
};

/** Summary payload returned by cache status and sync tools. */
export type ActivityCacheStatus = {
  cachePath: string;
  activityCount: number;
  oldestActivityDate: string | null;
  newestActivityDate: string | null;
  updatedAt: string | null;
  syncWindows: ActivitySyncWindow[];
};

/** Load the cache, returning an empty schema-compatible document when it has not been created yet. */
export async function loadActivityCache(): Promise<ActivityCache> {
  try {
    const parsed = JSON.parse(
      await readFile(ACTIVITY_CACHE_PATH, "utf8"),
    ) as ActivityCache;
    if (parsed.schemaVersion !== CACHE_SCHEMA_VERSION) {
      throw new Error(
        `Unsupported Strava activity cache schema version: ${parsed.schemaVersion}`,
      );
    }

    return {
      schemaVersion: parsed.schemaVersion,
      updatedAt: parsed.updatedAt ?? null,
      activitiesById: parsed.activitiesById ?? {},
      syncWindows: parsed.syncWindows ?? [],
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return emptyActivityCache();
    }

    throw error;
  }
}

/** Write the cache through a temp file so interrupted syncs do not leave partial JSON behind. */
export async function saveActivityCache(cache: ActivityCache) {
  const tmpPath = `${ACTIVITY_CACHE_PATH}.${process.pid}.${Date.now()}.tmp`;
  const serialized = `${JSON.stringify(cache, null, 2)}\n`;

  await mkdir(dirname(ACTIVITY_CACHE_PATH), { recursive: true });
  await writeFile(tmpPath, serialized, { mode: 0o600 });
  await rename(tmpPath, ACTIVITY_CACHE_PATH);
}

/** Upsert activities by Strava id and return how many rows were inserted or replaced. */
export function upsertActivities(
  cache: ActivityCache,
  activities: StravaActivity[],
): number {
  let changed = 0;

  for (const activity of activities) {
    cache.activitiesById[String(activity.id)] = activity;
    changed += 1;
  }

  if (changed) {
    cache.updatedAt = new Date().toISOString();
  }

  return changed;
}

/** Record a completed API sync window after all fetched activities have been merged. */
export function recordSyncWindow(
  cache: ActivityCache,
  range: Required<ActivityRange>,
  count: number,
) {
  cache.syncWindows.push({
    after: range.after,
    before: range.before,
    fetchedAt: new Date().toISOString(),
    count,
  });
  cache.updatedAt = new Date().toISOString();
}

/** Return true when any completed sync window fully covers the requested range. */
export function isRangeCovered(
  cache: ActivityCache,
  range: Required<ActivityRange>,
): boolean {
  return getCoveredBefore(cache, range.after) >= range.before;
}

/** Return the furthest timestamp covered by sync windows that start at or before the requested lower bound. */
export function getCoveredBefore(cache: ActivityCache, after: number): number {
  let coveredBefore = after;
  let extended = true;

  while (extended) {
    extended = false;

    for (const window of cache.syncWindows) {
      if (window.after <= coveredBefore && window.before > coveredBefore) {
        coveredBefore = window.before;
        extended = true;
      }
    }
  }

  return coveredBefore;
}

/** Return cached activities in the requested range, newest first. */
export function getCachedActivities(
  cache: ActivityCache,
  range: Required<ActivityRange>,
): StravaActivity[] {
  return filterActivities(Object.values(cache.activitiesById), range).sort(
    compareActivityNewestFirst,
  );
}

/** Summarize cache contents without exposing all activity payloads. */
export function getActivityCacheStatus(
  cache: ActivityCache,
): ActivityCacheStatus {
  const activities = Object.values(cache.activitiesById).sort(
    compareActivityOldestFirst,
  );

  return {
    cachePath: ACTIVITY_CACHE_PATH,
    activityCount: activities.length,
    oldestActivityDate: activityStartDate(activities[0]) ?? null,
    newestActivityDate: activityStartDate(activities.at(-1)) ?? null,
    updatedAt: cache.updatedAt,
    syncWindows: cache.syncWindows,
  };
}

/** Resolve an open-ended request to the current moment so cache windows never claim future coverage. */
export function resolveActivityRange(
  range: ActivityRange,
): Required<ActivityRange> {
  return {
    after: range.after,
    before: range.before ?? Math.floor(Date.now() / 1000),
  };
}

/** Build a new empty cache document at the current schema version. */
function emptyActivityCache(): ActivityCache {
  return {
    schemaVersion: CACHE_SCHEMA_VERSION,
    updatedAt: null,
    activitiesById: {},
    syncWindows: [],
  };
}

/** Sort by canonical Strava start time newest first; missing dates sink to the bottom. */
function compareActivityNewestFirst(
  a: StravaActivity,
  b: StravaActivity,
): number {
  return activityStartMillis(b) - activityStartMillis(a);
}

/** Sort by canonical Strava start time oldest first; missing dates sink to the top. */
function compareActivityOldestFirst(
  a: StravaActivity,
  b: StravaActivity,
): number {
  return activityStartMillis(a) - activityStartMillis(b);
}

/** Use Strava's UTC start when present so cache ordering matches range filtering. */
function activityStartDate(
  activity: StravaActivity | undefined,
): string | undefined {
  return activity?.start_date ?? activity?.start_date_local;
}

/** Convert missing or invalid dates to zero so cache status remains total-orderable. */
function activityStartMillis(activity: StravaActivity): number {
  const value = activityStartDate(activity);
  const millis = value ? new Date(value).getTime() : 0;

  return Number.isFinite(millis) ? millis : 0;
}
