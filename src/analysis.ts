import { mkdir, writeFile } from "node:fs/promises";

import { getStravaDataDir } from "./env.js";

/** Minimal activity shape used by local summaries while preserving raw Strava payloads for export. */
export type StravaActivity = {
  id: number;
  name?: string;
  sport_type?: string;
  type?: string;
  start_date?: string;
  start_date_local?: string;
  distance?: number;
  moving_time?: number;
  elapsed_time?: number;
  total_elevation_gain?: number;
  gear_id?: string | null;
  average_heartrate?: number;
  max_heartrate?: number;
  suffer_score?: number;
  average_temp?: number;
};

/** Date range and filter inputs shared by local summary tools. */
export type ActivityFilterInput = {
  after: number;
  before?: number;
  sportTypes?: string[];
  gearIds?: string[];
};

/** Supported bucket sizes for local activity aggregation. */
export type ActivityGroupBy = "day" | "week" | "month";

/** Summary request that groups filtered activities into time buckets. */
export type ActivitySummaryInput = ActivityFilterInput & {
  groupBy: ActivityGroupBy;
  includeEmptyBuckets?: boolean;
};

/** Activity search request for auditing suspicious or hard-to-classify entries. */
export type ActivitySearchInput = ActivityFilterInput & {
  query?: string;
  minDistanceMiles?: number;
  maxDistanceMiles?: number;
  minElevationFeet?: number;
  limit?: number;
};

/** Compact row returned by search and export helpers. */
export type CompactActivity = {
  id: number;
  name: string;
  sport_type: string;
  start_date_local: string;
  distance_miles: number;
  moving_minutes: number;
  elevation_feet: number;
  gear_id: string | null;
  average_heartrate?: number;
  max_heartrate?: number;
  suffer_score?: number;
  average_temp_f?: number;
};

/** Filter activities by date, sport, and gear using Strava's canonical UTC start for boundary checks. */
export function filterActivities(
  activities: StravaActivity[],
  input: ActivityFilterInput,
): StravaActivity[] {
  return activities.filter((activity) => {
    const startTime = activity.start_date ?? activity.start_date_local;
    const unixTime = startTime
      ? Math.floor(new Date(startTime).getTime() / 1000)
      : undefined;

    if (!unixTime || unixTime < input.after) return false;
    if (input.before && unixTime >= input.before) return false;
    if (
      input.sportTypes?.length &&
      !input.sportTypes.includes(activity.sport_type ?? activity.type ?? "")
    ) {
      return false;
    }
    if (
      input.gearIds?.length &&
      !input.gearIds.includes(activity.gear_id ?? "")
    )
      return false;

    return true;
  });
}

/** Summarize filtered activities into ordered buckets plus overall totals. */
export function summarizeActivities(
  activities: StravaActivity[],
  input: ActivitySummaryInput,
) {
  const filtered = filterActivities(activities, input);
  const buckets = new Map<string, ReturnType<typeof emptyBucket>>();

  for (const activity of filtered) {
    const key = bucketKey(
      activity.start_date_local ?? activity.start_date ?? "",
      input.groupBy,
    );
    const bucket = buckets.get(key) ?? emptyBucket(key);
    addActivityToBucket(bucket, activity);
    buckets.set(key, bucket);
  }

  if (input.includeEmptyBuckets) {
    for (const key of bucketRange(input.after, input.before, input.groupBy)) {
      buckets.set(key, buckets.get(key) ?? emptyBucket(key));
    }
  }

  const rows = Array.from(buckets.values()).sort((a, b) =>
    a.bucket.localeCompare(b.bucket),
  );

  return {
    filters: input,
    total: rows.reduce(
      (total, row) => ({
        activities: total.activities + row.activities,
        miles: round(total.miles + row.miles),
        moving_hours: round(total.moving_hours + row.moving_hours),
        elapsed_hours: round(total.elapsed_hours + row.elapsed_hours),
        elevation_feet: Math.round(total.elevation_feet + row.elevation_feet),
      }),
      {
        activities: 0,
        miles: 0,
        moving_hours: 0,
        elapsed_hours: 0,
        elevation_feet: 0,
      },
    ),
    buckets: rows,
  };
}

/** Group filtered activities by gear id to support service-interval and equipment-use audits. */
export function summarizeGearUsage(
  activities: StravaActivity[],
  input: ActivityFilterInput,
) {
  const filtered = filterActivities(activities, input);
  const gear = new Map<string, ReturnType<typeof emptyGearBucket>>();

  for (const activity of filtered) {
    const key = activity.gear_id || "none";
    const bucket = gear.get(key) ?? emptyGearBucket(key);
    addActivityToGearBucket(bucket, activity);
    gear.set(key, bucket);
  }

  return Array.from(gear.values()).sort((a, b) => b.miles - a.miles);
}

/** Return compact activity rows matching audit-oriented filters, newest first. */
export function searchActivities(
  activities: StravaActivity[],
  input: ActivitySearchInput,
): CompactActivity[] {
  const query = input.query?.trim().toLowerCase();

  return filterActivities(activities, input)
    .filter((activity) => {
      const miles = metersToMiles(activity.distance ?? 0);
      const elevationFeet = metersToFeet(activity.total_elevation_gain ?? 0);

      if (
        query &&
        !`${activity.name ?? ""} ${activity.sport_type ?? ""}`
          .toLowerCase()
          .includes(query)
      ) {
        return false;
      }
      if (
        input.minDistanceMiles !== undefined &&
        miles < input.minDistanceMiles
      )
        return false;
      if (
        input.maxDistanceMiles !== undefined &&
        miles > input.maxDistanceMiles
      )
        return false;
      if (
        input.minElevationFeet !== undefined &&
        elevationFeet < input.minElevationFeet
      )
        return false;

      return true;
    })
    .sort((a, b) =>
      (b.start_date_local ?? b.start_date ?? "").localeCompare(
        a.start_date_local ?? a.start_date ?? "",
      ),
    )
    .slice(0, input.limit ?? 25)
    .map(compactActivity);
}

/** Write raw and compact activity exports into private local storage outside the repository. */
export async function exportActivities(
  activities: StravaActivity[],
  input: ActivityFilterInput,
) {
  const filtered = filterActivities(activities, input);
  const compact = filtered.map(compactActivity);
  const exportDir = `${getStravaDataDir()}/exports`;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const baseName = `strava-activities-${input.after}-${stamp}`;
  const rawPath = `${exportDir}/${baseName}.raw.json`;
  const compactPath = `${exportDir}/${baseName}.compact.json`;
  const csvPath = `${exportDir}/${baseName}.compact.csv`;

  await mkdir(exportDir, { recursive: true });
  await writeFile(rawPath, `${JSON.stringify(filtered, null, 2)}\n`);
  await writeFile(compactPath, `${JSON.stringify(compact, null, 2)}\n`);
  await writeFile(csvPath, compactCsv(compact));

  return {
    count: filtered.length,
    rawPath,
    compactPath,
    csvPath,
  };
}

/** Convert a Strava activity into a stable review row without losing the raw export path. */
function compactActivity(activity: StravaActivity): CompactActivity {
  return {
    id: activity.id,
    name: activity.name ?? "",
    sport_type: activity.sport_type ?? activity.type ?? "",
    start_date_local: activity.start_date_local ?? activity.start_date ?? "",
    distance_miles: round(metersToMiles(activity.distance ?? 0), 2),
    moving_minutes: round((activity.moving_time ?? 0) / 60, 1),
    elevation_feet: Math.round(
      metersToFeet(activity.total_elevation_gain ?? 0),
    ),
    gear_id: activity.gear_id ?? null,
    average_heartrate: activity.average_heartrate,
    max_heartrate: activity.max_heartrate,
    suffer_score: activity.suffer_score,
    average_temp_f:
      activity.average_temp === undefined
        ? undefined
        : Math.round((activity.average_temp * 9) / 5 + 32),
  };
}

/** Create an empty time bucket with fields ordered for readable MCP output. */
function emptyBucket(bucket: string) {
  return {
    bucket,
    activities: 0,
    miles: 0,
    moving_hours: 0,
    elapsed_hours: 0,
    elevation_feet: 0,
  };
}

/** Create an empty gear bucket with nested sport totals for mixed-use bikes. */
function emptyGearBucket(gear_id: string) {
  return {
    gear_id,
    activities: 0,
    miles: 0,
    moving_hours: 0,
    elapsed_hours: 0,
    elevation_feet: 0,
    sport_types: {} as Record<
      string,
      { activities: number; miles: number; moving_hours: number }
    >,
  };
}

/** Accumulate one activity into a time bucket using miles, hours, and elevation. */
function addActivityToBucket(
  bucket: ReturnType<typeof emptyBucket>,
  activity: StravaActivity,
) {
  bucket.activities += 1;
  bucket.miles = round(bucket.miles + metersToMiles(activity.distance ?? 0));
  bucket.moving_hours = round(
    bucket.moving_hours + (activity.moving_time ?? 0) / 3600,
  );
  bucket.elapsed_hours = round(
    bucket.elapsed_hours + (activity.elapsed_time ?? 0) / 3600,
  );
  bucket.elevation_feet = Math.round(
    bucket.elevation_feet + metersToFeet(activity.total_elevation_gain ?? 0),
  );
}

/** Accumulate one activity into a gear bucket and preserve sport-type split for audits. */
function addActivityToGearBucket(
  bucket: ReturnType<typeof emptyGearBucket>,
  activity: StravaActivity,
) {
  const sportType = activity.sport_type ?? activity.type ?? "unknown";
  const sport = bucket.sport_types[sportType] ?? {
    activities: 0,
    miles: 0,
    moving_hours: 0,
  };

  bucket.activities += 1;
  bucket.miles = round(bucket.miles + metersToMiles(activity.distance ?? 0));
  bucket.moving_hours = round(
    bucket.moving_hours + (activity.moving_time ?? 0) / 3600,
  );
  bucket.elapsed_hours = round(
    bucket.elapsed_hours + (activity.elapsed_time ?? 0) / 3600,
  );
  bucket.elevation_feet = Math.round(
    bucket.elevation_feet + metersToFeet(activity.total_elevation_gain ?? 0),
  );
  sport.activities += 1;
  sport.miles = round(sport.miles + metersToMiles(activity.distance ?? 0));
  sport.moving_hours = round(
    sport.moving_hours + (activity.moving_time ?? 0) / 3600,
  );
  bucket.sport_types[sportType] = sport;
}

/** Return the local-date bucket key for day, Monday-start week, or month aggregation. */
function bucketKey(localDateTime: string, groupBy: ActivityGroupBy): string {
  const localDate = localDateTime.slice(0, 10);

  if (groupBy === "day") return localDate;
  if (groupBy === "month") return localDate.slice(0, 7);

  return mondayStart(localDate);
}

/** Generate all bucket keys in a date range so zero weeks/months can be shown explicitly. */
function bucketRange(
  after: number,
  before: number | undefined,
  groupBy: ActivityGroupBy,
): string[] {
  const keys: string[] = [];
  const cursor = new Date(after * 1000);
  const end = new Date((before ?? Math.floor(Date.now() / 1000)) * 1000);

  cursor.setUTCHours(0, 0, 0, 0);
  end.setUTCHours(0, 0, 0, 0);

  while (cursor <= end) {
    keys.push(bucketKey(isoDate(cursor), groupBy));
    if (groupBy === "day") cursor.setUTCDate(cursor.getUTCDate() + 1);
    else if (groupBy === "week") cursor.setUTCDate(cursor.getUTCDate() + 7);
    else cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }

  return Array.from(new Set(keys)).sort();
}

/** Return the Monday-start week containing a `YYYY-MM-DD` date. */
function mondayStart(localDate: string): string {
  const date = dateFromYmd(localDate);
  const day = date.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  date.setUTCDate(date.getUTCDate() + diff);

  return isoDate(date);
}

/** Parse a local date as UTC midnight so grouping does not inherit the server timezone. */
function dateFromYmd(value: string): Date {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

/** Format a date as `YYYY-MM-DD` using UTC fields. */
function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Convert Strava's meter distances to miles. */
function metersToMiles(meters: number): number {
  return meters / 1609.344;
}

/** Convert Strava's meter elevation gain to feet. */
function metersToFeet(meters: number): number {
  return meters * 3.28084;
}

/** Round numeric output to keep MCP responses scannable. */
function round(value: number, decimals = 1): number {
  return Number(value.toFixed(decimals));
}

/** Build a compact CSV that opens cleanly in spreadsheet tools. */
function compactCsv(rows: CompactActivity[]): string {
  const columns = [
    "id",
    "name",
    "sport_type",
    "start_date_local",
    "distance_miles",
    "moving_minutes",
    "elevation_feet",
    "gear_id",
    "average_heartrate",
    "max_heartrate",
    "suffer_score",
    "average_temp_f",
  ] satisfies Array<keyof CompactActivity>;

  return `${columns.join(",")}\n${rows
    .map((row) => columns.map((column) => csvEscape(row[column])).join(","))
    .join("\n")}\n`;
}

/** Escape CSV cells without changing numeric values before stringification. */
function csvEscape(value: unknown): string {
  const stringValue = String(value ?? "");
  return /[",\n]/.test(stringValue)
    ? `"${stringValue.replace(/"/g, '""')}"`
    : stringValue;
}
